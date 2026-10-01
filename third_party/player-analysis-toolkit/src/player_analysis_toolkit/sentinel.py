from __future__ import annotations

import bisect
import csv
import hashlib
import json
import math
import random
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable

from .sentinel_resources import resolve_workers

from .analysis_core import (
    account_key,
    disc_loss,
    engine_wld_loss_total,
    quantile,
    rounded,
)


REFERENCE_SCHEMA = "player-anomaly-sentinel-reference-v1"
TARGET_RECORD_SCHEMA = "player-anomaly-sentinel-target-records-v1"
SCORE_SCHEMA = "player-anomaly-sentinel-per-game-scores-v1"
SCAN_SCHEMA = "player-anomaly-sentinel-scan-v1"
SELECTION_SCHEMA = "player-anomaly-sentinel-selection-v1"
MIN_ELO = 1600
MAX_ELO = 2486
ELO_WIDTH = 100
WLD_FROM_PLY = 39
DEFAULT_REPLICATES = 10_000
DEFAULT_BOOTSTRAP = 10_000
DEFAULT_SEED = 20260814
SCOPES = ("post_offbook_inclusive", "full_game_fallback_no_offbook")
COLORS = ("black", "white")


def read_json(path: str | Path) -> Any:
    with Path(path).open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def write_json(path: str | Path, value: Any, *, refuse_existing: bool = True) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def write_jsonl(
    path: str | Path,
    rows: Iterable[dict[str, Any]],
    *,
    refuse_existing: bool = True,
) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_csv(
    path: str | Path,
    rows: list[dict[str, Any]],
    *,
    refuse_existing: bool = True,
) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with target.open("w", encoding="utf-8", newline="") as handle:
        if not fields:
            return
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _csv_value(row.get(key)) for key in fields})


def _csv_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if value is None:
        return ""
    return value


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def band_specs() -> list[dict[str, Any]]:
    result = []
    for lower in range(MIN_ELO, 2401, ELO_WIDTH):
        upper = MAX_ELO if lower == 2400 else lower + ELO_WIDTH
        result.append({
            "lower": lower,
            "upper": upper,
            "center": (lower + upper) / 2.0,
            "label": f"[{lower},{upper}{']' if upper == MAX_ELO else ')'}",
        })
    return result


BANDS = band_specs()
BAND_BY_LOWER = {int(item["lower"]): item for item in BANDS}


def configure_elo_bounds(minimum: int, maximum: int, width: int) -> None:
    global MIN_ELO, MAX_ELO, ELO_WIDTH, BANDS, BAND_BY_LOWER
    if minimum != 1600 or width != 100 or maximum < 2400:
        raise ValueError("sentinel Reference requires minimum=1600, width=100, maximum>=2400")
    MIN_ELO = int(minimum)
    MAX_ELO = int(maximum)
    ELO_WIDTH = int(width)
    BANDS = band_specs()
    BAND_BY_LOWER = {int(item["lower"]): item for item in BANDS}


def configure_from_reference_config(path: str | Path) -> None:
    value = read_json(path)
    if value.get("schema") != "player-anomaly-sentinel-reference-config-v1":
        raise ValueError("unsupported sentinel Reference config schema")
    configure_elo_bounds(
        int(value["formalEloMinimum"]),
        int(value["formalEloMaximum"]),
        int(value["eloBandWidth"]),
    )


_ACTIVE_REFERENCE_CONFIG = Path(__file__).resolve().parents[2] / "sentinel_reference_config.json"
if _ACTIVE_REFERENCE_CONFIG.is_file():
    configure_from_reference_config(_ACTIVE_REFERENCE_CONFIG)


def formal_band(rating: float) -> dict[str, Any] | None:
    value = float(rating)
    if value < MIN_ELO or value > MAX_ELO:
        return None
    lower = min(int((value - MIN_ELO) // ELO_WIDTH) * ELO_WIDTH + MIN_ELO, 2400)
    return dict(BAND_BY_LOWER[lower])


def source_band(rating: float) -> dict[str, Any]:
    formal = formal_band(rating)
    if formal is not None:
        return formal
    lower = math.floor(float(rating) / ELO_WIDTH) * ELO_WIDTH
    upper = lower + ELO_WIDTH
    return {"lower": lower, "upper": upper, "center": (lower + upper) / 2.0, "label": f"[{lower},{upper})"}


def axis_weights(rating: float, axis: str) -> tuple[list[tuple[int, float]], str | None]:
    value = float(rating)
    flag = None
    if value < MIN_ELO:
        value = float(MIN_ELO)
        flag = "target_below_reference" if axis == "target" else "nearest_opponent_band"
    elif value > MAX_ELO:
        value = float(MAX_ELO)
        flag = "target_above_reference" if axis == "target" else "nearest_opponent_band"
    centers = [(int(item["lower"]), float(item["center"])) for item in BANDS]
    if value <= centers[0][1]:
        return [(centers[0][0], 1.0)], flag
    if value >= centers[-1][1]:
        return [(centers[-1][0], 1.0)], flag
    for (left_lower, left), (right_lower, right) in zip(centers, centers[1:]):
        if left <= value <= right:
            right_weight = (value - left) / (right - left)
            return [(left_lower, 1.0 - right_weight), (right_lower, right_weight)], flag
    raise AssertionError("Elo interpolation did not find a bracket")


def _player_pair(detail: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    players = detail.get("players")
    if not isinstance(players, list) or len(players) < 2:
        raise ValueError(f"game {detail.get('id')!r} has fewer than two players")
    return players[0], players[1]


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def make_directed_record(
    game: dict[str, Any],
    detail: dict[str, Any],
    target_color: str,
    algorithm_record: dict[str, Any],
    source_path: Path,
    source_sha256: str,
    *,
    in_main_matrix: bool,
    partition_scope: str,
) -> dict[str, Any]:
    if target_color not in COLORS:
        raise ValueError("target color must be black or white")
    black, white = _player_pair(detail)
    target, opponent = (black, white) if target_color == "black" else (white, black)
    target_id = str(target.get("id") or "")
    opponent_id = str(opponent.get("id") or "")
    if not target_id or not opponent_id:
        raise ValueError(f"game {detail.get('id')!r} has an empty player ID")
    target_rating = _number(target.get("oldR"), f"game {detail.get('id')!r} target oldR")
    opponent_rating = _number(opponent.get("oldR"), f"game {detail.get('id')!r} opponent oldR")
    label = algorithm_record.get("algorithmLabel")
    if label not in {"offbook", "no_offbook"}:
        raise ValueError(f"game {detail.get('id')!r} has an invalid off-book label")
    offbook_ply = algorithm_record.get("offBookPly")
    if label == "no_offbook" and offbook_ply is not None:
        raise ValueError("no_offbook record must have offBookPly=null")
    nodes = []
    for node in game.get("nodes", []):
        if str(node.get("playerColor") or "").lower() != target_color:
            continue
        if account_key(node.get("playerAccount")) != account_key(target_id):
            raise ValueError(f"game {detail.get('id')!r} target node belongs to the wrong player")
        nodes.append(node)
    if label == "offbook":
        start = int(offbook_ply)
        if not any(int(node.get("ply") or 0) == start for node in nodes):
            raise ValueError(f"game {detail.get('id')!r} offBookPly is not a target placement")
        eligible = [node for node in nodes if int(node.get("ply") or 0) >= start]
        scope = SCOPES[0]
    else:
        start = min((int(node["ply"]) for node in nodes), default=None)
        eligible = list(nodes)
        scope = SCOPES[1]
    losses = [disc_loss(node["lossClipped"]) for node in eligible if node.get("lossClipped") is not None]
    ge4 = sum(value >= 4 for value in losses)
    ge10 = sum(value >= 10 for value in losses)
    target_band = source_band(target_rating)
    opponent_band = source_band(opponent_rating)
    formal = bool(
        in_main_matrix
        and formal_band(target_rating) is not None
        and formal_band(opponent_rating) is not None
    )
    return {
        "gameId": str(detail.get("id") or game.get("gameId") or ""),
        "targetPlayerId": target_id,
        "opponentPlayerId": opponent_id,
        "targetColor": target_color,
        "targetOldR": target_rating,
        "opponentOldR": opponent_rating,
        "targetEloBand": target_band,
        "opponentEloBand": opponent_band,
        "inMainMatrix": bool(in_main_matrix),
        "formalReferenceEligible": formal,
        "partitionScope": partition_scope,
        "algorithmLabel": label,
        "offBookPly": int(offbook_ply) if offbook_ply is not None else None,
        "postOffBookStartsAtPly": int(offbook_ply) if offbook_ply is not None else None,
        "algorithmEvidence": algorithm_record.get("algorithmEvidence"),
        "anchorSource": algorithm_record.get("anchorSource"),
        "analysisScope": scope,
        "analysisStartPly": start,
        "eligibleTargetNodeCount": len(eligible),
        "validLossNodeCount": len(losses),
        "loss_ge4_count": ge4,
        "loss_ge4_rate": rounded(ge4 / len(losses)) if losses else None,
        "loss_ge10_count": ge10,
        "loss_ge10_rate": rounded(ge10 / len(losses)) if losses else None,
        "game_equal_mean_disc_loss": rounded(statistics.fmean(losses)) if losses else None,
        "engine_wld_loss_total_from_ply39": engine_wld_loss_total(
            [{"nodes": nodes}], WLD_FROM_PLY
        ),
        "sourceLevel22File": source_path.as_posix(),
        "sourceLevel22Sha256": source_sha256,
    }


def build_target_records(
    bundle_path: Path,
    engine_directory: Path,
    offbook_records_path: Path,
    account: str,
) -> list[dict[str, Any]]:
    bundle = read_json(bundle_path)
    details = {str(item.get("id") or ""): item for item in bundle.get("details", [])}
    marks = read_json(offbook_records_path)
    by_game = {str(item.get("gameId") or ""): item for item in marks.get("records", [])}
    records = []
    for path in sorted(engine_directory.glob("game_*.json")):
        game = read_json(path)
        game_id = str(game.get("gameId") or "")
        if game_id not in details or game_id not in by_game:
            raise ValueError(f"target game {game_id!r} is missing bundle detail or off-book record")
        black, white = _player_pair(details[game_id])
        matches = [
            color for color, player in (("black", black), ("white", white))
            if account_key(player.get("id")) == account_key(account)
        ]
        if len(matches) != 1:
            raise ValueError(f"game {game_id!r} does not map target account to exactly one side")
        record = make_directed_record(
            game, details[game_id], matches[0], by_game[game_id], path.resolve(), sha256_file(path),
            in_main_matrix=True, partition_scope="investigation",
        )
        record["created"] = details[game_id].get("created")
        records.append(record)
    if set(details) != {row["gameId"] for row in records}:
        missing = sorted(set(details) - {row["gameId"] for row in records})
        raise ValueError(f"target Level22 outputs are incomplete: {missing}")
    return sorted(records, key=lambda row: row["gameId"])


CellKey = tuple[int, int, str, str]


def cell_key(record: dict[str, Any], *, scope_aware: bool = True) -> CellKey:
    return (
        int(record["targetEloBand"]["lower"]),
        int(record["opponentEloBand"]["lower"]),
        str(record["targetColor"]),
        str(record["analysisScope"]) if scope_aware else "all_scopes",
    )


def reference_index(
    records: list[dict[str, Any]],
    *,
    scope_aware: bool = True,
) -> dict[CellKey, list[dict[str, Any]]]:
    output: dict[CellKey, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        if not record.get("formalReferenceEligible"):
            continue
        if record.get("loss_ge4_rate") is None:
            continue
        output[cell_key(record, scope_aware=scope_aware)].append(record)
    for values in output.values():
        values.sort(key=lambda row: (row["gameId"], row["targetColor"]))
    return dict(output)


def _available_records(
    index: dict[CellKey, list[dict[str, Any]]],
    key: CellKey,
    excluded_game_ids: set[str],
) -> list[dict[str, Any]]:
    return [row for row in index.get(key, []) if row["gameId"] not in excluded_game_ids]


def _resolve_cell(
    intended: CellKey,
    index: dict[CellKey, list[dict[str, Any]]],
    excluded_game_ids: set[str],
) -> tuple[CellKey | None, str | None]:
    if _available_records(index, intended, excluded_game_ids):
        return intended, None
    target_lower, opponent_lower, color, scope = intended
    same_target = [
        key for key in index
        if key[0] == target_lower and key[2:] == (color, scope)
        and _available_records(index, key, excluded_game_ids)
    ]
    if same_target:
        return min(same_target, key=lambda key: (abs(BAND_BY_LOWER[key[1]]["center"] - BAND_BY_LOWER[opponent_lower]["center"]), key[1])), "nearest_opponent_band"
    candidates = [
        key for key in index
        if key[2:] == (color, scope) and _available_records(index, key, excluded_game_ids)
    ]
    if not candidates:
        return None, "not_calibratable"
    target_center = float(BAND_BY_LOWER[target_lower]["center"])
    opponent_center = float(BAND_BY_LOWER[opponent_lower]["center"])
    return min(candidates, key=lambda key: (
        (float(BAND_BY_LOWER[key[0]]["center"]) - target_center) ** 2
        + (float(BAND_BY_LOWER[key[1]]["center"]) - opponent_center) ** 2,
        abs(float(BAND_BY_LOWER[key[1]]["center"]) - opponent_center), key[0], key[1],
    )), "nearest_available_2d_cell"


def match_reference(
    slot: dict[str, Any],
    index: dict[CellKey, list[dict[str, Any]]],
    *,
    metric: str = "loss_ge4_rate",
    excluded_game_ids: set[str] | None = None,
    scope_aware: bool = True,
) -> dict[str, Any]:
    excluded = excluded_game_ids or set()
    target_axis, target_flag = axis_weights(float(slot["targetOldR"]), "target")
    opponent_axis, opponent_flag = axis_weights(float(slot["opponentOldR"]), "opponent")
    scope = str(slot["analysisScope"]) if scope_aware else "all_scopes"
    resolutions = []
    used_weights: dict[CellKey, float] = defaultdict(float)
    for target_lower, target_weight in target_axis:
        for opponent_lower, opponent_weight in opponent_axis:
            weight = target_weight * opponent_weight
            if weight <= 0:
                continue
            intended = (target_lower, opponent_lower, str(slot["targetColor"]), scope)
            used, fallback = _resolve_cell(intended, index, excluded)
            resolutions.append({
                "intendedTargetBandLower": target_lower,
                "intendedOpponentBandLower": opponent_lower,
                "originalWeight": rounded(weight, 12),
                "usedTargetBandLower": used[0] if used else None,
                "usedOpponentBandLower": used[1] if used else None,
                "fallback": fallback,
            })
            if used is not None:
                used_weights[used] += weight
    if not used_weights:
        return {
            "calibratable": False,
            "notCalibratableReason": "no_reference_record_with_same_color_and_analysis_scope",
            "targetBoundaryFlag": target_flag,
            "opponentBoundaryFlag": opponent_flag,
            "fallbackApplied": True,
            "cellResolutions": resolutions,
            "usedCells": [],
            "records": [],
        }
    total_weight = sum(used_weights.values())
    weighted_records = []
    used_cells = []
    for key in sorted(used_weights):
        cell_weight = used_weights[key] / total_weight
        rows = [row for row in _available_records(index, key, excluded) if row.get(metric) is not None]
        if not rows:
            continue
        record_weight = cell_weight / len(rows)
        used_cells.append({
            "targetBandLower": key[0], "opponentBandLower": key[1],
            "targetColor": key[2], "analysisScope": key[3],
            "recordCount": len(rows), "redistributedWeight": rounded(cell_weight, 12),
        })
        weighted_records.extend((row, record_weight) for row in rows)
    normalization = sum(weight for _, weight in weighted_records)
    if normalization <= 0:
        return {
            "calibratable": False,
            "notCalibratableReason": f"no_valid_{metric}_record_after_exclusion",
            "targetBoundaryFlag": target_flag,
            "opponentBoundaryFlag": opponent_flag,
            "fallbackApplied": True,
            "cellResolutions": resolutions,
            "usedCells": used_cells,
            "records": [],
        }
    weighted_records = [(row, weight / normalization) for row, weight in weighted_records]
    values = [(float(row[metric]), weight) for row, weight in weighted_records]
    expected = sum(value * weight for value, weight in values)
    return {
        "calibratable": True,
        "expected": expected,
        "targetBoundaryFlag": target_flag,
        "opponentBoundaryFlag": opponent_flag,
        "fallbackApplied": bool(target_flag or opponent_flag or any(item["fallback"] for item in resolutions)),
        "cellResolutions": resolutions,
        "usedCells": used_cells,
        "records": weighted_records,
    }


def weighted_quantile(values: list[tuple[float, float]], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values, key=lambda item: item[0])
    threshold = min(max(float(probability), 0.0), 1.0)
    cumulative = 0.0
    for value, weight in ordered:
        cumulative += weight
        if cumulative + 1e-15 >= threshold:
            return value
    return ordered[-1][0]


def score_target_records(
    target_records: list[dict[str, Any]],
    reference_records: list[dict[str, Any]],
) -> dict[str, Any]:
    target_game_ids = {row["gameId"] for row in target_records}
    filtered_reference = [row for row in reference_records if row["gameId"] not in target_game_ids]
    ge4_index = reference_index(filtered_reference, scope_aware=True)
    wld_index = reference_index(filtered_reference, scope_aware=False)
    scores = []
    for record in sorted(target_records, key=lambda row: row["gameId"]):
        matched = match_reference(record, ge4_index)
        distinct_matched_games = {
            row["gameId"] for row, _ in matched.get("records", [])
        }
        insufficient_leave_one_pool = matched.get("calibratable") and len(distinct_matched_games) < 2
        if record.get("loss_ge4_rate") is None or not matched["calibratable"] or insufficient_leave_one_pool:
            if insufficient_leave_one_pool:
                reason = "insufficient_distinct_reference_games_for_required_leave_one_pseudo_calibration"
            else:
                reason = matched.get("notCalibratableReason") or "target_has_no_valid_loss_node"
            scores.append({
                **record,
                "calibratable": False,
                "notCalibratableReason": reason,
                "matchedDistinctReferenceGameCount": len(distinct_matched_games),
                "referenceMatch": {key: value for key, value in matched.items() if key != "records"},
            })
            continue
        distribution = [(float(row["loss_ge4_rate"]), weight) for row, weight in matched["records"]]
        actual = float(record["loss_ge4_rate"])
        expected = float(matched["expected"])
        wld_match = match_reference(record, wld_index, metric="engine_wld_loss_total_from_ply39", scope_aware=False)
        wld_expected = float(wld_match["expected"]) if wld_match["calibratable"] else None
        scores.append({
            **record,
            "calibratable": True,
            "referenceExpectedLossGe4Rate": rounded(expected, 12),
            "externalStrengthResidual": rounded(expected - actual, 12),
            "matchedReferenceEmpiricalPosition": {
                "weightedCdfLessOrEqual": rounded(sum(weight for value, weight in distribution if value <= actual), 12),
                "weightedLowerTailStrict": rounded(sum(weight for value, weight in distribution if value < actual), 12),
                "weightedUpperTailInclusive": rounded(sum(weight for value, weight in distribution if value >= actual), 12),
            },
            "matchedReferencePredictionInterval95": [
                rounded(weighted_quantile(distribution, 0.025), 12),
                rounded(weighted_quantile(distribution, 0.975), 12),
            ],
            "referenceMatch": {key: value for key, value in matched.items() if key != "records"},
            "referenceExpectedWldLossTotalFromPly39": rounded(wld_expected, 12),
            "externalWldStrengthResidual": rounded(
                wld_expected - float(record["engine_wld_loss_total_from_ply39"]), 12
            ) if wld_expected is not None else None,
            "wldReferenceMatch": {key: value for key, value in wld_match.items() if key != "records"},
        })
    return {
        "schema": SCORE_SCHEMA,
        "excludedReferenceGameIds": sorted(target_game_ids & {row["gameId"] for row in reference_records}),
        "excludedReferenceGameCount": len(target_game_ids & {row["gameId"] for row in reference_records}),
        "excludedDirectedReferenceRecordCount": len(reference_records) - len(filtered_reference),
        "referenceRecordCountAfterExclusion": len(filtered_reference),
        "targetRecordCount": len(target_records),
        "calibratableGameCount": sum(row.get("calibratable") is True for row in scores),
        "notCalibratableGameCount": sum(row.get("calibratable") is not True for row in scores),
        "scores": scores,
    }


def candidate_ks(n: int) -> list[int]:
    maximum = min(math.floor(n / 2), n - 3)
    return list(range(2, maximum + 1)) if maximum >= 2 else []


def sorted_strength_rows(rows: list[dict[str, Any]], field: str = "externalStrengthResidual") -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: (-float(row[field]), str(row["gameId"])))


def scan_effects(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted_strength_rows(rows)
    residuals = [float(row["externalStrengthResidual"]) for row in ordered]
    per_k = []
    for k in candidate_ks(len(rows)):
        prefix = statistics.fmean(residuals[:k])
        remainder = statistics.fmean(residuals[k:])
        per_k.append({
            "k": k,
            "gameIds": [row["gameId"] for row in ordered[:k]],
            "externalEffect": prefix,
            "internalEffect": prefix - remainder,
        })
    return {
        "orderedGameIds": [row["gameId"] for row in ordered],
        "bestSingleScore": residuals[0],
        "bestSingleGameId": ordered[0]["gameId"],
        "allGamesEffect": statistics.fmean(residuals),
        "perK": per_k,
    }


def _scan_effects_batch(batch: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return [scan_effects(rows) for rows in batch]


def scan_effects_many(
    rows: list[list[dict[str, Any]]], workers: int = 1,
) -> list[dict[str, Any]]:
    """Evaluate independent pseudo samples in parallel, preserving order."""
    if workers <= 1 or len(rows) < 2:
        return [scan_effects(item) for item in rows]
    workers = max(1, min(int(workers), len(rows)))
    chunk_size = max(32, min(256, math.ceil(len(rows) / (workers * 4))))
    batches = [rows[index:index + chunk_size] for index in range(0, len(rows), chunk_size)]
    with ProcessPoolExecutor(max_workers=workers) as executor:
        return [effect for batch in executor.map(_scan_effects_batch, batches) for effect in batch]


def candidate_time_distribution(rows: list[dict[str, Any]], candidate_ids: set[str]) -> dict[str, Any]:
    ordered = sorted(rows, key=lambda row: (str(row.get("created") or ""), str(row["gameId"])))
    flags = [row["gameId"] in candidate_ids for row in ordered]
    runs = 0
    previous = False
    for flag in flags:
        if flag and not previous:
            runs += 1
        previous = flag
    candidate_count = sum(flags)
    if candidate_count <= 1:
        pattern = "isolated"
    elif runs == 1:
        pattern = "continuous"
    elif all(not (left and right) for left, right in zip(flags, flags[1:])):
        pattern = "alternating_or_interleaved"
    else:
        pattern = "discrete_clusters"
    return {
        "selectionUsedTimeOrSession": False,
        "pattern": pattern,
        "candidateRunCount": runs,
        "chronologicalGames": [
            {"gameId": row["gameId"], "created": row.get("created"), "candidate": row["gameId"] in candidate_ids}
            for row in ordered
        ],
    }


def empirical_upper_p(value: float, comparison: Iterable[float], *, plus_one: bool = True) -> tuple[float, int, int]:
    values = list(comparison)
    count = sum(item >= value - 1e-15 for item in values)
    if plus_one:
        return (count + 1) / (len(values) + 1), count + 1, len(values) + 1
    return count / len(values), count, len(values)


def empirical_lower_p(value: float, comparison: Iterable[float], *, plus_one: bool = True) -> tuple[float, int, int]:
    values = list(comparison)
    count = sum(item <= value + 1e-15 for item in values)
    if plus_one:
        return (count + 1) / (len(values) + 1), count + 1, len(values) + 1
    return count / len(values), count, len(values)


def wilson_interval(successes: int, trials: int, z: float = 1.959963984540054) -> list[float]:
    if trials <= 0 or successes < 0 or successes > trials:
        raise ValueError("Wilson interval requires 0 <= successes <= trials and trials > 0")
    p = successes / trials
    denominator = 1.0 + z * z / trials
    center = (p + z * z / (2.0 * trials)) / denominator
    half = z * math.sqrt(p * (1.0 - p) / trials + z * z / (4.0 * trials * trials)) / denominator
    return [max(0.0, center - half), min(1.0, center + half)]


def _draw_weighted(rng: random.Random, weighted_records: list[tuple[dict[str, Any], float]]) -> dict[str, Any]:
    point = rng.random()
    cumulative = 0.0
    for record, weight in weighted_records:
        cumulative += weight
        if point <= cumulative + 1e-15:
            return record
    return weighted_records[-1][0]


def _rank_upper_leave_one(value: float, sorted_values: list[float]) -> float:
    # Remove the current value and compare to the remaining R-1 values, with a plus-one numerator.
    lower = bisect.bisect_left(sorted_values, value - 1e-15)
    count_including_self = len(sorted_values) - lower
    return count_including_self / len(sorted_values)


def _bootstrap_fixed_candidate(
    rows: list[dict[str, Any]], candidate_ids: set[str], repetitions: int, seed: int
) -> dict[str, Any]:
    candidate = [row for row in rows if row["gameId"] in candidate_ids]
    remainder = [row for row in rows if row["gameId"] not in candidate_ids]
    if not candidate:
        return {}
    rng = random.Random(seed)
    external_values = []
    internal_values = []
    wld_external_values = []
    wld_internal_values = []
    for _ in range(repetitions):
        left = [rng.choice(candidate) for _ in candidate]
        external_values.append(statistics.fmean(float(row["externalStrengthResidual"]) for row in left))
        if remainder:
            right = [rng.choice(remainder) for _ in remainder]
            internal_values.append(
                statistics.fmean(float(row["externalStrengthResidual"]) for row in left)
                - statistics.fmean(float(row["externalStrengthResidual"]) for row in right)
            )
        if all(row.get("externalWldStrengthResidual") is not None for row in left):
            wld_external_values.append(statistics.fmean(float(row["externalWldStrengthResidual"]) for row in left))
        if remainder and all(row.get("engine_wld_loss_total_from_ply39") is not None for row in left + right):
            wld_internal_values.append(
                statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in right)
                - statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in left)
            )
    interval = lambda values: [rounded(quantile(values, 0.025), 12), rounded(quantile(values, 0.975), 12)] if values else [None, None]
    return {
        "policy": "fixed-candidate whole-game cluster bootstrap; selection correction is provided by the full pseudo-player scan",
        "repetitions": repetitions,
        "seed": seed,
        "externalEffect95CI": interval(external_values),
        "internalEffect95CI": interval(internal_values),
        "wldExternalEffect95CI": interval(wld_external_values),
        "wldInternalEffect95CI": interval(wld_internal_values),
    }


_PSEUDO_MATCH_CONTEXT: tuple[Any, ...] | None = None


def _initialize_pseudo_match_worker(
    slots: list[dict[str, Any]], reference: list[dict[str, Any]], elo_bounds: tuple[int, int, int],
) -> None:
    global _PSEUDO_MATCH_CONTEXT
    configure_elo_bounds(*elo_bounds)
    _PSEUDO_MATCH_CONTEXT = (
        slots, reference_index(reference, scope_aware=True),
        reference_index(reference, scope_aware=False),
    )


def _match_pseudo_batch(tasks: list[tuple[int, str]]) -> list[tuple[int, str, float, float]]:
    if _PSEUDO_MATCH_CONTEXT is None:
        raise RuntimeError("pseudo matching worker has not been initialized")
    slots, ge4_index, wld_index = _PSEUDO_MATCH_CONTEXT
    results = []
    for slot_index, game_id in tasks:
        slot = slots[slot_index]
        loo = match_reference(slot, ge4_index, excluded_game_ids={game_id})
        if not loo["calibratable"]:
            raise ValueError(f"leave-one-game matching failed for slot {slot['gameId']} and reference game {game_id}")
        loo_wld = match_reference(
            slot, wld_index, metric="engine_wld_loss_total_from_ply39",
            excluded_game_ids={game_id}, scope_aware=False,
        )
        results.append((slot_index, game_id, float(loo["expected"]),
                        float(loo_wld["expected"]) if loo_wld["calibratable"] else math.nan))
    return results


def sample_pseudo_rows_parallel(
    slot_matches: list[tuple[dict[str, Any], list[tuple[dict[str, Any], float]]]],
    reference: list[dict[str, Any]], rng: random.Random, replicates: int, workers: int,
) -> list[list[dict[str, Any]]]:
    """Keep MT19937 draws in the parent; match each unique slot/game in workers."""
    samples = []
    unique_tasks: dict[tuple[int, str], None] = {}
    for _ in range(replicates):
        sampled = []
        for slot_index, (_, pool) in enumerate(slot_matches):
            record = _draw_weighted(rng, pool)
            sampled.append(record)
            unique_tasks[(slot_index, str(record["gameId"]))] = None
        samples.append(sampled)
    tasks = list(unique_tasks)
    batches = [tasks[index:index + 64] for index in range(0, len(tasks), 64)]
    expected = {}
    with ProcessPoolExecutor(
        max_workers=min(workers, len(tasks)), initializer=_initialize_pseudo_match_worker,
        initargs=([slot for slot, _ in slot_matches], reference, (MIN_ELO, MAX_ELO, ELO_WIDTH)),
    ) as executor:
        for batch in executor.map(_match_pseudo_batch, batches):
            for slot_index, game_id, ge4, wld in batch:
                expected[(slot_index, game_id)] = (ge4, wld)
    pseudo_rows = []
    for sampled in samples:
        rows = []
        for slot_index, record in enumerate(sampled):
            game_id = str(record["gameId"])
            ge4, wld = expected[(slot_index, game_id)]
            rows.append({
                "gameId": game_id,
                "sourceTargetPlayerId": record["targetPlayerId"],
                "sourceTargetColor": record["targetColor"],
                "externalStrengthResidual": ge4 - float(record["loss_ge4_rate"]),
                "engine_wld_loss_total_from_ply39": float(record["engine_wld_loss_total_from_ply39"]),
                "externalWldStrengthResidual": (
                    wld - float(record["engine_wld_loss_total_from_ply39"])
                    if math.isfinite(wld) else None
                ),
            })
        pseudo_rows.append(rows)
    return pseudo_rows


def run_pseudo_scan(
    score_payload: dict[str, Any],
    reference_records: list[dict[str, Any]],
    *,
    replicates: int = DEFAULT_REPLICATES,
    bootstrap: int = DEFAULT_BOOTSTRAP,
    seed: int = DEFAULT_SEED,
    workers: int | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    if replicates < 1 or bootstrap < 1 or (workers is not None and workers < 1):
        raise ValueError("replicate, bootstrap and worker counts must be positive")
    actual_rows = [row for row in score_payload["scores"] if row.get("calibratable")]
    if not actual_rows:
        replicate_output = [{
            "replicate": index, "bestSingleScore": None, "bestK": None,
            "bestExternalEffect": None, "bestInternalEffect": None,
            "bestJointResult": None, "allGamesEffect": None,
            "allGamesWldResult": None, "selectedWldResult": None,
        } for index in range(1, replicates + 1)]
        scan = {
            "schema": SCAN_SCHEMA,
            "selectionPolicy": "stable descending external residual prefixes only; no arbitrary combinations; time/session excluded",
            "calibratableGameCount": 0, "testedK": [], "orderedGameIds": [],
            "bestSingle": None, "allGames": None, "perK": [], "selectedK": None,
            "selectedGameIds": [], "selectedCandidateTimeDistribution": None,
            "scanCorrectedNormalExceedanceRate": None,
            "scanCorrectedWilson95Interval": [None, None],
            "internalOnlyScan": {"selectedK": None, "normalExceedanceRate": None, "wilson95Interval": [None, None]},
            "fixedCandidateEffectBootstrap": {}, "secondaryWld": None,
            "classification": "no_clear_signal", "reportedGameIds": [],
            "statisticalControlGameIds": [], "modelControlGameIds": [], "modelReviewReady": False,
            "notCalibratableReason": "no_calibratable_target_games",
        }
        pseudo_summary = {
            "schema": "player-anomaly-sentinel-pseudo-scan-summary-v1",
            "rngAlgorithm": "Python random.Random MT19937", "seed": seed,
            "replicates": replicates, "bootstrapReplicates": bootstrap,
            "referenceRecordOrderSha256": canonical_sha256([]),
            "referencePoolSha256": canonical_sha256([]),
            "samplingPolicy": "no slots sampled because no target game was calibratable",
            "scanPolicy": scan["selectionPolicy"], "softwareSchema": SCAN_SCHEMA,
        }
        return scan, replicate_output, pseudo_summary
    excluded = set(score_payload.get("excludedReferenceGameIds", []))
    reference = [row for row in reference_records if row["gameId"] not in excluded]
    ge4_index = reference_index(reference, scope_aware=True)
    wld_index = reference_index(reference, scope_aware=False)
    slot_matches = []
    for row in sorted(actual_rows, key=lambda item: item["gameId"]):
        match = match_reference(row, ge4_index)
        if not match["calibratable"]:
            raise ValueError(f"previously calibratable game {row['gameId']} is no longer calibratable")
        slot_matches.append((row, match["records"]))

    automatic_workers = workers is None
    workers = resolve_workers(workers)
    if automatic_workers:
        print(f"[sentinel] automatic scan workers={workers}; memory budget=50% of installed physical RAM", file=sys.stderr)
    rng = random.Random(seed)
    if workers > 1:
        pseudo_rows = sample_pseudo_rows_parallel(slot_matches, reference, rng, replicates, workers)
    else:
        leave_one_cache: dict[tuple[int, str, str], float] = {}
        pseudo_rows: list[list[dict[str, Any]]] = []
        for _ in range(replicates):
            sampled_rows = []
            for slot_index, (slot, pool) in enumerate(slot_matches):
                sampled = _draw_weighted(rng, pool)
                game_id = str(sampled["gameId"])
                cache_key = (slot_index, game_id, "ge4")
                if cache_key not in leave_one_cache:
                    loo = match_reference(slot, ge4_index, excluded_game_ids={game_id})
                    if not loo["calibratable"]:
                        raise ValueError(f"leave-one-game matching failed for slot {slot['gameId']} and reference game {game_id}")
                    leave_one_cache[cache_key] = float(loo["expected"])
                wld_key = (slot_index, game_id, "wld")
                if wld_key not in leave_one_cache:
                    loo_wld = match_reference(
                        slot, wld_index, metric="engine_wld_loss_total_from_ply39",
                        excluded_game_ids={game_id}, scope_aware=False,
                    )
                    leave_one_cache[wld_key] = float(loo_wld["expected"]) if loo_wld["calibratable"] else math.nan
                sampled_rows.append({
                    "gameId": game_id,
                    "sourceTargetPlayerId": sampled["targetPlayerId"],
                    "sourceTargetColor": sampled["targetColor"],
                    "externalStrengthResidual": leave_one_cache[cache_key] - float(sampled["loss_ge4_rate"]),
                    "engine_wld_loss_total_from_ply39": float(sampled["engine_wld_loss_total_from_ply39"]),
                    "externalWldStrengthResidual": (
                        leave_one_cache[wld_key] - float(sampled["engine_wld_loss_total_from_ply39"])
                        if math.isfinite(leave_one_cache[wld_key]) else None
                    ),
                })
            pseudo_rows.append(sampled_rows)
    pseudo_effects = scan_effects_many(pseudo_rows, workers)

    actual_effects = scan_effects(actual_rows)
    ks = candidate_ks(len(actual_rows))
    per_k_results = []
    pseudo_ext_by_k: dict[int, list[float]] = {}
    pseudo_int_by_k: dict[int, list[float]] = {}
    for k in ks:
        pseudo_ext_by_k[k] = [next(item for item in effect["perK"] if item["k"] == k)["externalEffect"] for effect in pseudo_effects]
        pseudo_int_by_k[k] = [next(item for item in effect["perK"] if item["k"] == k)["internalEffect"] for effect in pseudo_effects]
        actual = next(item for item in actual_effects["perK"] if item["k"] == k)
        ext_p, _, _ = empirical_upper_p(actual["externalEffect"], pseudo_ext_by_k[k])
        int_p, _, _ = empirical_upper_p(actual["internalEffect"], pseudo_int_by_k[k])
        per_k_results.append({
            **actual,
            "externalNormalExceedanceRate": rounded(ext_p, 12),
            "internalNormalExceedanceRate": rounded(int_p, 12),
            "jointNormalExceedanceRate": rounded(max(ext_p, int_p), 12),
        })

    def real_tie(item: dict[str, Any]) -> tuple[Any, ...]:
        return (
            float(item["jointNormalExceedanceRate"]),
            -float(item["externalEffect"]), -float(item["internalEffect"]), int(item["k"]),
            tuple(str(value) for value in item["gameIds"]),
        )

    selected = min(per_k_results, key=real_tie) if per_k_results else None
    pseudo_best_joint = []
    pseudo_best_internal = []
    selected_pseudo: list[dict[str, Any] | None] = []
    sorted_ext = {k: sorted(values) for k, values in pseudo_ext_by_k.items()}
    sorted_int = {k: sorted(values) for k, values in pseudo_int_by_k.items()}
    for replicate_index, effect in enumerate(pseudo_effects):
        ranked = []
        ranked_internal = []
        for item in effect["perK"]:
            k = int(item["k"])
            ext_p = _rank_upper_leave_one(float(item["externalEffect"]), sorted_ext[k])
            int_p = _rank_upper_leave_one(float(item["internalEffect"]), sorted_int[k])
            ranked.append({**item, "joint": max(ext_p, int_p), "externalP": ext_p, "internalP": int_p})
            ranked_internal.append({**item, "internalP": int_p})
        best = min(ranked, key=lambda item: (
            item["joint"], -item["externalEffect"], -item["internalEffect"], item["k"], tuple(item["gameIds"])
        )) if ranked else None
        best_internal = min(ranked_internal, key=lambda item: (
            item["internalP"], -item["internalEffect"], -item["externalEffect"], item["k"], tuple(item["gameIds"])
        )) if ranked_internal else None
        selected_pseudo.append(best)
        pseudo_best_joint.append(float(best["joint"]) if best else 1.0)
        pseudo_best_internal.append(float(best_internal["internalP"]) if best_internal else 1.0)

    if selected is not None:
        scan_p, scan_successes, scan_trials = empirical_lower_p(
            float(selected["jointNormalExceedanceRate"]), pseudo_best_joint
        )
        scan_ci = wilson_interval(scan_successes, scan_trials)
        real_best_internal = min(per_k_results, key=lambda item: (
            item["internalNormalExceedanceRate"], -item["internalEffect"], -item["externalEffect"], item["k"], tuple(item["gameIds"])
        ))
        internal_scan_p, internal_successes, internal_trials = empirical_lower_p(
            float(real_best_internal["internalNormalExceedanceRate"]), pseudo_best_internal
        )
        internal_scan_ci = wilson_interval(internal_successes, internal_trials)
    else:
        scan_p, scan_ci, real_best_internal = 1.0, [1.0, 1.0], None
        internal_scan_p, internal_scan_ci = 1.0, [1.0, 1.0]

    single_p, single_successes, single_trials = empirical_upper_p(
        float(actual_effects["bestSingleScore"]), [float(item["bestSingleScore"]) for item in pseudo_effects]
    )
    single_ci = wilson_interval(single_successes, single_trials)
    all_p, all_successes, all_trials = empirical_upper_p(
        float(actual_effects["allGamesEffect"]), [float(item["allGamesEffect"]) for item in pseudo_effects]
    )
    all_ci = wilson_interval(all_successes, all_trials)

    selected_ids = set(selected["gameIds"]) if selected else set()
    fixed_bootstrap = _bootstrap_fixed_candidate(actual_rows, selected_ids, bootstrap, seed + 1) if selected else {}
    concentrated = bool(
        selected
        and scan_p <= 0.05 and scan_ci[1] <= 0.05
        and float(selected["externalEffect"]) > 0 and float(selected["internalEffect"]) > 0
        and fixed_bootstrap["externalEffect95CI"][0] is not None
        and fixed_bootstrap["externalEffect95CI"][0] > 0
        and fixed_bootstrap["internalEffect95CI"][0] is not None
        and fixed_bootstrap["internalEffect95CI"][0] > 0
    )
    isolated = bool(single_ci[1] <= 0.05 and actual_effects["bestSingleScore"] > 0)
    uniform = bool(all_ci[1] <= 0.05 and actual_effects["allGamesEffect"] > 0)
    internal_only = bool(
        real_best_internal
        and internal_scan_ci[1] <= 0.05
        and float(real_best_internal["internalEffect"]) > 0
        and not concentrated
    )
    if concentrated:
        classification = "concentrated_external_internal_anomaly"
        reported_ids = list(selected["gameIds"])
    elif uniform:
        classification = "external_uniform_anomaly"
        reported_ids = []
    elif isolated:
        classification = "isolated_external_anomaly"
        reported_ids = [str(actual_effects["bestSingleGameId"])]
    elif internal_only:
        classification = "internal_variation_only"
        reported_ids = []
    else:
        classification = "no_clear_signal"
        reported_ids = []

    report_set = set(reported_ids)
    statistical_controls = [row["gameId"] for row in actual_rows if row["gameId"] not in report_set] if report_set else []
    all_target_ids = [row["gameId"] for row in score_payload["scores"]]
    model_controls = [game_id for game_id in all_target_ids if game_id not in report_set] if report_set else []

    # WLD is evaluated only on the final GE4 group, never used to choose it.
    selected_wld = None
    if report_set:
        wld_candidate_ids = report_set
    elif classification == "external_uniform_anomaly":
        wld_candidate_ids = {str(row["gameId"]) for row in actual_rows}
    else:
        wld_candidate_ids = selected_ids
    if wld_candidate_ids:
        selected_rows = [row for row in actual_rows if row["gameId"] in wld_candidate_ids]
        remaining_rows = [row for row in actual_rows if row["gameId"] not in wld_candidate_ids]
        wld_bootstrap = (
            fixed_bootstrap
            if wld_candidate_ids == selected_ids
            else _bootstrap_fixed_candidate(actual_rows, wld_candidate_ids, bootstrap, seed + 2)
        )
        selected_wld = {
            "candidateGameIds": [row["gameId"] for row in sorted_strength_rows(selected_rows)],
            "externalEffect": rounded(statistics.fmean(float(row["externalWldStrengthResidual"]) for row in selected_rows), 12),
            "internalEffect": rounded(
                statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in remaining_rows)
                - statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in selected_rows), 12
            ) if remaining_rows else None,
            "externalEffect95CI": wld_bootstrap.get("wldExternalEffect95CI"),
            "internalEffect95CI": wld_bootstrap.get("wldInternalEffect95CI"),
        }

    replicate_output = []
    for replicate_index, (effect, rows, best) in enumerate(zip(pseudo_effects, pseudo_rows, selected_pseudo, strict=True), start=1):
        wld_result = None
        if best:
            ordered = sorted_strength_rows(rows)
            left = ordered[: int(best["k"])]
            right = ordered[int(best["k"]):]
            wld_result = {
                "externalEffect": rounded(statistics.fmean(float(row["externalWldStrengthResidual"]) for row in left), 12),
                "internalEffect": rounded(
                    statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in right)
                    - statistics.fmean(float(row["engine_wld_loss_total_from_ply39"]) for row in left), 12
                ) if right else None,
            }
        replicate_output.append({
            "replicate": replicate_index,
            "bestSingleScore": rounded(effect["bestSingleScore"], 12),
            "bestK": int(best["k"]) if best else None,
            "bestExternalEffect": rounded(best["externalEffect"], 12) if best else None,
            "bestInternalEffect": rounded(best["internalEffect"], 12) if best else None,
            "bestJointResult": rounded(best["joint"], 12) if best else None,
            "allGamesEffect": rounded(effect["allGamesEffect"], 12),
            "allGamesWldResult": rounded(
                statistics.fmean(float(row["externalWldStrengthResidual"]) for row in rows), 12
            ),
            "selectedWldResult": wld_result,
        })

    if selected_wld is not None:
        if classification == "external_uniform_anomaly":
            pseudo_wld = [float(row["allGamesWldResult"]) for row in replicate_output]
        else:
            pseudo_wld = [
                float(row["selectedWldResult"]["externalEffect"])
                for row in replicate_output if row["selectedWldResult"] is not None
            ]
        selected_wld["selectionAdjustedEmpiricalPosition"] = {
            "normalUpperTailInclusive": rounded(empirical_upper_p(float(selected_wld["externalEffect"]), pseudo_wld)[0], 12)
        }
        needs_wld_support = classification in {
            "concentrated_external_internal_anomaly", "isolated_external_anomaly",
            "external_uniform_anomaly",
        }
        external_support = bool(selected_wld["externalEffect95CI"] and selected_wld["externalEffect95CI"][0] is not None and selected_wld["externalEffect95CI"][0] > 0)
        internal_support = bool(selected_wld["internalEffect95CI"] and selected_wld["internalEffect95CI"][0] is not None and selected_wld["internalEffect95CI"][0] > 0)
        selected_wld["supportStatus"] = (
            "secondary_metric_supportive"
            if external_support and (classification != "concentrated_external_internal_anomaly" or internal_support)
            else "secondary_metric_not_supportive"
        ) if needs_wld_support else "secondary_metric_diagnostic_only"

    scan = {
        "schema": SCAN_SCHEMA,
        "selectionPolicy": "stable descending external residual prefixes only; no arbitrary combinations; time/session excluded",
        "calibratableGameCount": len(actual_rows),
        "testedK": ks,
        "orderedGameIds": actual_effects["orderedGameIds"],
        "bestSingle": {
            "gameId": actual_effects["bestSingleGameId"], "effect": rounded(actual_effects["bestSingleScore"], 12),
            "scanCorrectedNormalExceedanceRate": rounded(single_p, 12),
            "wilson95Interval": [rounded(value, 12) for value in single_ci],
        },
        "allGames": {
            "effect": rounded(actual_effects["allGamesEffect"], 12),
            "normalExceedanceRate": rounded(all_p, 12),
            "wilson95Interval": [rounded(value, 12) for value in all_ci],
        },
        "perK": [{key: rounded(value, 12) if isinstance(value, float) else value for key, value in row.items()} for row in per_k_results],
        "selectedK": int(selected["k"]) if selected else None,
        "selectedGameIds": list(selected["gameIds"]) if selected else [],
        "selectedCandidateTimeDistribution": candidate_time_distribution(
            actual_rows, wld_candidate_ids
        ) if wld_candidate_ids else None,
        "scanCorrectedNormalExceedanceRate": rounded(scan_p, 12),
        "scanCorrectedWilson95Interval": [rounded(value, 12) for value in scan_ci],
        "internalOnlyScan": {
            "selectedK": int(real_best_internal["k"]) if real_best_internal else None,
            "normalExceedanceRate": rounded(internal_scan_p, 12),
            "wilson95Interval": [rounded(value, 12) for value in internal_scan_ci],
        },
        "fixedCandidateEffectBootstrap": fixed_bootstrap,
        "secondaryWld": selected_wld,
        "classification": classification,
        "reportedGameIds": reported_ids,
        "statisticalControlGameIds": statistical_controls,
        "modelControlGameIds": model_controls,
        "modelReviewReady": bool(reported_ids and len(model_controls) >= 8),
    }
    pseudo_summary = {
        "schema": "player-anomaly-sentinel-pseudo-scan-summary-v1",
        "rngAlgorithm": "Python random.Random MT19937",
        "seed": seed,
        "replicates": replicates,
        "bootstrapReplicates": bootstrap,
        "referenceRecordOrderSha256": canonical_sha256([
            (row["gameId"], row["targetColor"], row["analysisScope"]) for row in reference
        ]),
        "referencePoolSha256": canonical_sha256(reference),
        "samplingPolicy": "slot-preserving weighted complete directed-game records with replacement; sampled gameId excluded globally for leave-one expected residual",
        "scanPolicy": scan["selectionPolicy"],
        "softwareSchema": SCAN_SCHEMA,
    }
    return scan, replicate_output, pseudo_summary


def selection_manifest(
    scan: dict[str, Any], score_payload: dict[str, Any], *,
    reference_config_path: Path, reference_manifest_path: Path,
    target_bundle_path: Path, level22_audit_path: Path, offbook_records_path: Path,
    seed: int, pseudo_replicates: int, bootstrap_replicates: int,
) -> dict[str, Any]:
    payload = {
        "schema": SELECTION_SCHEMA,
        "allInvestigationGameIds": [row["gameId"] for row in score_payload["scores"]],
        "perGameExternalResiduals": [
            {"gameId": row["gameId"], "calibratable": row.get("calibratable"), "externalStrengthResidual": row.get("externalStrengthResidual")}
            for row in score_payload["scores"]
        ],
        "testedK": scan["testedK"],
        "perK": scan["perK"],
        "selectedK": scan["selectedK"],
        "reportedGameIds": scan["reportedGameIds"],
        "statisticalControlGameIds": scan["statisticalControlGameIds"],
        "modelControlGameIds": scan["modelControlGameIds"],
        "classification": scan["classification"],
        "modelReviewReady": scan["modelReviewReady"],
        "excludedReferenceGameIds": score_payload["excludedReferenceGameIds"],
        "reference": {
            "configPath": str(reference_config_path.resolve()),
            "configSha256": sha256_file(reference_config_path),
            "manifestPath": str(reference_manifest_path.resolve()),
            "manifestSha256": sha256_file(reference_manifest_path),
        },
        "targetBundleSha256": sha256_file(target_bundle_path),
        "level22AuditSha256": sha256_file(level22_audit_path),
        "offbookRecordsSha256": sha256_file(offbook_records_path),
        "randomSeed": seed,
        "pseudoPlayerReplicates": pseudo_replicates,
        "bootstrapReplicates": bootstrap_replicates,
        "selectionPolicy": scan["selectionPolicy"],
        "freezePolicy": "model results cannot modify this selection manifest",
    }
    payload["payloadSha256"] = canonical_sha256(payload)
    return payload


def cell_summary(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    formal = [row for row in records if row.get("formalReferenceEligible")]
    output = []
    for target in BANDS:
        for opponent in BANDS:
            for color in COLORS:
                for scope in SCOPES:
                    values = [
                        row for row in formal
                        if row["targetEloBand"]["lower"] == target["lower"]
                        and row["opponentEloBand"]["lower"] == opponent["lower"]
                        and row["targetColor"] == color and row["analysisScope"] == scope
                    ]
                    ge4 = [float(row["loss_ge4_rate"]) for row in values if row["loss_ge4_rate"] is not None]
                    wld = [float(row["engine_wld_loss_total_from_ply39"]) for row in values]
                    output.append({
                        "targetBandLower": target["lower"], "targetBandUpper": target["upper"],
                        "targetBandCenter": target["center"], "opponentBandLower": opponent["lower"],
                        "opponentBandUpper": opponent["upper"], "opponentBandCenter": opponent["center"],
                        "targetColor": color, "analysisScope": scope,
                        "algorithmLabel": "offbook" if scope == SCOPES[0] else "no_offbook",
                        "recordCount": len(values), "validLossRateRecordCount": len(ge4),
                        "meanLossGe4Rate": rounded(statistics.fmean(ge4), 12) if ge4 else None,
                        "meanWldLossTotalFromPly39": rounded(statistics.fmean(wld), 12) if wld else None,
                    })
    return output


def manifest_for_files(directory: Path, names: Iterable[str], schema: str) -> dict[str, Any]:
    rows = []
    for name in names:
        path = directory / name
        rows.append({"path": name, "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    return {"schema": schema, "fileCount": len(rows), "files": rows}
