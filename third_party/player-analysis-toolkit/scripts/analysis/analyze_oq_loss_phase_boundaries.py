#!/usr/bin/env python3
"""Analyze fixed global-ply phase boundaries for OQ 5-minute loss data.

The primary loss definition uses consecutive level-18 hint-6 best values:

* normal turn change: current_best + next_side_best
* implicit pass (same side moves again): current_best - next_same_side_best

The current data only contains positions whose side to move appeared in the
rating>=2000 leaderboard snapshot.  Consequently, the primary analysis uses
games in which both players are in that snapshot, so consecutive positions are
actually present.  Resampling is clustered by whole game.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


SOURCE_RESEARCH_ROOT = Path(os.environ.get("PAPP_RESEARCH_ROOT", "research"))
DEFAULT_USERS = SOURCE_RESEARCH_ROOT / "oq_reversi_5min_rating_2000_users.csv"
DEFAULT_GAMES = SOURCE_RESEARCH_ROOT / "oq_reversi_5min_elo2000_games/games.csv"
DEFAULT_SUMMARIES = SOURCE_RESEARCH_ROOT / "oq_reversi_5min_elo2000_games/game_player_summaries.csv"
DEFAULT_MOVES = SOURCE_RESEARCH_ROOT / "oq_reversi_5min_elo2000_games/move_times.csv"
DEFAULT_HINTS = SOURCE_RESEARCH_ROOT / "oq_reversi_5min_elo2000_hints/position_hints.csv"
DEFAULT_OUTPUT = Path(__file__).resolve().parent

LOSS_THRESHOLDS = (4, 10)
# Keep the archived partition-fitting features unchanged so adding the rarer
# >=10 descriptive metric cannot silently move the established boundaries.
METRIC_NAMES = ["mean_log1p_loss", "zero_rate", "loss_ge4_rate", "positive_mean_log1p"]
PLOT_METRICS = (
    ("mean_loss", "Mean disc loss"),
    ("median_loss", "Median disc loss"),
    ("zero_rate", "Zero-loss rate"),
    ("loss_ge4_rate", "Loss >= 4 rate"),
    ("loss_ge10_rate", "Loss >= 10 rate"),
)
ENGINE_WLD_TOTAL_FIELD = "engine_wld_loss_total_from_ply39"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=Path, default=DEFAULT_USERS)
    parser.add_argument("--games", type=Path, default=DEFAULT_GAMES)
    parser.add_argument("--summaries", type=Path, default=DEFAULT_SUMMARIES)
    parser.add_argument("--moves", type=Path, default=DEFAULT_MOVES)
    parser.add_argument("--hints", type=Path, default=DEFAULT_HINTS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--bootstrap-reps", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20260803)
    parser.add_argument("--min-stage-width", type=int, default=6)
    parser.add_argument("--min-ply-games", type=int, default=30)
    parser.add_argument("--max-ply", type=int, default=60)
    parser.add_argument(
        "--wld-from-ply",
        type=int,
        choices=(39,),
        help="write WLD loss totals from inclusive pass-free global placement ply 39",
    )
    parser.add_argument(
        "--plot-metric",
        action="append",
        choices=[name for name, _ in PLOT_METRICS],
        help="metric to include in the diagnostic plot; repeat to select several",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_manifest(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "size_bytes": stat.st_size,
        "modified_utc": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "sha256": sha256_file(path),
    }


def bool_series(values: pd.Series) -> pd.Series:
    return values.astype("string").str.strip().str.lower().eq("true")


def scan_csv_keys(path: Path, key_fields: list[str]) -> dict[str, Any]:
    total = 0
    duplicate_rows = 0
    seen: set[tuple[str, ...]] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [field for field in key_fields if field not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path} missing key fields: {missing}")
        for row in reader:
            total += 1
            key = tuple(str(row[field]) for field in key_fields)
            if key in seen:
                duplicate_rows += 1
            else:
                seen.add(key)
    return {
        "path": str(path.resolve()),
        "key_fields": key_fields,
        "rows": total,
        "unique_keys": len(seen),
        "duplicate_rows": duplicate_rows,
    }


def quantile(values: pd.Series, q: float) -> float:
    if values.empty:
        return math.nan
    return float(values.quantile(q))


def summarize_loss_frame(frame: pd.DataFrame) -> dict[str, Any]:
    loss = frame["disc_loss"].dropna()
    positive = loss[loss > 0]
    return {
        "nodes": int(len(loss)),
        "games": int(frame.loc[loss.index, "game_id"].nunique()),
        "players": int(frame.loc[loss.index, "player_id"].nunique()),
        "mean_loss": float(loss.mean()) if len(loss) else math.nan,
        "median_loss": float(loss.median()) if len(loss) else math.nan,
        "q10_loss": quantile(loss, 0.10),
        "q25_loss": quantile(loss, 0.25),
        "q75_loss": quantile(loss, 0.75),
        "q90_loss": quantile(loss, 0.90),
        "q95_loss": quantile(loss, 0.95),
        "q99_loss": quantile(loss, 0.99),
        "zero_rate": float((loss == 0).mean()) if len(loss) else math.nan,
        "positive_mean_loss": float(positive.mean()) if len(positive) else math.nan,
        "loss_ge4_count": int((loss >= 4).sum()),
        "loss_ge10_count": int((loss >= 10).sum()),
        "loss_ge4_rate": float((loss >= 4).mean()) if len(loss) else math.nan,
        "loss_ge10_rate": float((loss >= 10).mean()) if len(loss) else math.nan,
        "loss_ge8_rate": float((loss >= 8).mean()) if len(loss) else math.nan,
        "raw_negative_nodes": int((frame.loc[loss.index, "raw_loss"] < 0).sum()),
        "raw_negative_rate": float((frame.loc[loss.index, "raw_loss"] < 0).mean()) if len(loss) else math.nan,
    }


def describe_by_ply(nodes: pd.DataFrame, max_ply: int) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    for ply in range(1, max_ply + 1):
        view = nodes[nodes["ply"] == ply]
        row = {"ply": ply, **summarize_loss_frame(view)}
        row["eligible_games_reaching_ply"] = int(view["game_id"].nunique())
        records.append(row)
    return pd.DataFrame(records)


def build_game_ply_matrices(
    nodes: pd.DataFrame,
    game_ids: list[str],
    max_ply: int,
) -> dict[str, np.ndarray]:
    game_index = {game_id: idx for idx, game_id in enumerate(game_ids)}
    shape = (len(game_ids), max_ply)
    matrices = {
        "count": np.zeros(shape, dtype=np.float32),
        "log_sum": np.zeros(shape, dtype=np.float32),
        "zero_count": np.zeros(shape, dtype=np.float32),
        "ge4_count": np.zeros(shape, dtype=np.float32),
        "ge10_count": np.zeros(shape, dtype=np.float32),
        "positive_count": np.zeros(shape, dtype=np.float32),
        "positive_log_sum": np.zeros(shape, dtype=np.float32),
    }
    for row in nodes[["game_id", "ply", "disc_loss"]].itertuples(index=False):
        ply_index = int(row.ply) - 1
        if ply_index < 0 or ply_index >= max_ply:
            continue
        game_idx = game_index[str(row.game_id)]
        loss = float(row.disc_loss)
        log_loss = math.log1p(loss)
        matrices["count"][game_idx, ply_index] += 1.0
        matrices["log_sum"][game_idx, ply_index] += log_loss
        matrices["zero_count"][game_idx, ply_index] += float(loss == 0)
        matrices["ge4_count"][game_idx, ply_index] += float(loss >= 4)
        matrices["ge10_count"][game_idx, ply_index] += float(loss >= 10)
        if loss > 0:
            matrices["positive_count"][game_idx, ply_index] += 1.0
            matrices["positive_log_sum"][game_idx, ply_index] += log_loss
    return matrices


def aggregate_matrices(matrices: dict[str, np.ndarray], weights: np.ndarray | None = None) -> dict[str, np.ndarray]:
    if weights is None:
        return {name: matrix.sum(axis=0, dtype=np.float64) for name, matrix in matrices.items()}
    return {name: weights @ matrix for name, matrix in matrices.items()}


def curve_from_aggregates(agg: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    count = agg["count"].astype(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        mean_log = agg["log_sum"] / count
        zero_rate = agg["zero_count"] / count
        ge4_rate = agg["ge4_count"] / count
        positive_mean_log = agg["positive_log_sum"] / agg["positive_count"]
    features = np.column_stack([mean_log, zero_rate, ge4_rate, positive_mean_log])
    return features, count


def weighted_standardize(features: np.ndarray, counts: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    weights = np.sqrt(np.maximum(counts, 0.0))
    use = valid & np.all(np.isfinite(features), axis=1)
    if not np.any(use):
        raise ValueError("no valid ply metrics for phase fitting")
    w = weights[use]
    x = features[use]
    mean = np.average(x, axis=0, weights=w)
    variance = np.average((x - mean) ** 2, axis=0, weights=w)
    scale = np.sqrt(np.maximum(variance, 1e-12))
    return (features - mean) / scale, mean, scale


def segment_cost_table(features: np.ndarray, counts: np.ndarray, valid: np.ndarray) -> np.ndarray:
    n = len(counts)
    weights = np.where(valid, np.sqrt(np.maximum(counts, 0.0)), 0.0)
    safe_x = np.where(np.isfinite(features), features, 0.0)
    prefix_w = np.concatenate([[0.0], np.cumsum(weights)])
    prefix_wx = np.vstack([np.zeros(features.shape[1]), np.cumsum(weights[:, None] * safe_x, axis=0)])
    prefix_wx2 = np.vstack([np.zeros(features.shape[1]), np.cumsum(weights[:, None] * safe_x**2, axis=0)])
    cost = np.full((n, n), np.inf, dtype=float)
    for start in range(n):
        for end in range(start, n):
            w = prefix_w[end + 1] - prefix_w[start]
            if w <= 0:
                continue
            sx = prefix_wx[end + 1] - prefix_wx[start]
            sx2 = prefix_wx2[end + 1] - prefix_wx2[start]
            value = float(np.sum(sx2 - (sx * sx) / w))
            cost[start, end] = max(0.0, value)
    return cost


def fit_partition(
    agg: dict[str, np.ndarray],
    k: int,
    min_stage_width: int,
    min_ply_games: int,
) -> dict[str, Any]:
    features, counts = curve_from_aggregates(agg)
    valid = (counts >= min_ply_games) & np.all(np.isfinite(features), axis=1)
    standardized, _, _ = weighted_standardize(features, counts, valid)
    cost = segment_cost_table(standardized, counts, valid)
    n = len(counts)
    dp = np.full((k + 1, n + 1), np.inf)
    previous = np.full((k + 1, n + 1), -1, dtype=int)
    dp[0, 0] = 0.0
    for stages in range(1, k + 1):
        min_end = stages * min_stage_width
        for end_exclusive in range(min_end, n + 1):
            first_start = (stages - 1) * min_stage_width
            last_start = end_exclusive - min_stage_width
            for start in range(first_start, last_start + 1):
                if not np.isfinite(dp[stages - 1, start]):
                    continue
                seg_cost = cost[start, end_exclusive - 1]
                value = dp[stages - 1, start] + seg_cost
                if value < dp[stages, end_exclusive]:
                    dp[stages, end_exclusive] = value
                    previous[stages, end_exclusive] = start
    if not np.isfinite(dp[k, n]):
        raise ValueError(f"unable to fit {k} phases")
    ends: list[int] = []
    end_exclusive = n
    for stages in range(k, 0, -1):
        start = int(previous[stages, end_exclusive])
        if stages > 1:
            ends.append(start)
        end_exclusive = start
    boundaries = list(reversed(ends))
    weighted_observations = int(valid.sum() * features.shape[1])
    parameter_count = k * features.shape[1] + (k - 1)
    sse = float(dp[k, n])
    bic = (
        weighted_observations * math.log(max(sse / max(weighted_observations, 1), 1e-12))
        + parameter_count * math.log(max(weighted_observations, 2))
    )
    return {
        "k": k,
        "boundaries": boundaries,
        "sse": sse,
        "bic": bic,
        "valid_ply_count": int(valid.sum()),
        "min_valid_ply": int(np.flatnonzero(valid)[0] + 1),
        "max_valid_ply": int(np.flatnonzero(valid)[-1] + 1),
    }


def bootstrap_partitions(
    matrices: dict[str, np.ndarray],
    ks: Iterable[int],
    reps: int,
    seed: int,
    min_stage_width: int,
    min_ply_games: int,
) -> tuple[pd.DataFrame, np.ndarray]:
    game_count = next(iter(matrices.values())).shape[0]
    rng = np.random.default_rng(seed)
    bootstrap_weights = rng.multinomial(
        game_count,
        np.full(game_count, 1.0 / game_count),
        size=reps,
    ).astype(np.float32)
    names = list(matrices)
    combined = np.concatenate([matrices[name] for name in names], axis=1)
    aggregated = bootstrap_weights @ combined
    max_ply = next(iter(matrices.values())).shape[1]
    records: list[dict[str, Any]] = []
    for rep in range(reps):
        agg = {
            name: aggregated[rep, idx * max_ply : (idx + 1) * max_ply]
            for idx, name in enumerate(names)
        }
        for k in ks:
            fit = fit_partition(agg, k, min_stage_width, min_ply_games)
            records.append(
                {
                    "replicate": rep + 1,
                    "k": k,
                    "boundaries": "|".join(str(value) for value in fit["boundaries"]),
                    **{f"boundary_{i + 1}": value for i, value in enumerate(fit["boundaries"])},
                    "sse": fit["sse"],
                    "bic": fit["bic"],
                }
            )
    return pd.DataFrame(records), bootstrap_weights


def phase_ranges(boundaries: list[int], max_ply: int) -> list[tuple[int, int]]:
    starts = [1] + [boundary + 1 for boundary in boundaries]
    ends = boundaries + [max_ply]
    return list(zip(starts, ends))


def summarize_candidate_stages(
    nodes: pd.DataFrame,
    candidates: list[dict[str, Any]],
    max_ply: int,
) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    total_games = nodes["game_id"].nunique()
    for candidate in candidates:
        for stage_index, (start, end) in enumerate(phase_ranges(candidate["boundaries"], max_ply), start=1):
            view = nodes[nodes["ply"].between(start, end)]
            row = {
                "k": candidate["k"],
                "stage": stage_index,
                "start_ply": start,
                "end_ply": end,
                **summarize_loss_frame(view),
            }
            row["game_coverage_rate"] = row["games"] / total_games if total_games else math.nan
            records.append(row)
    return pd.DataFrame(records)


def add_stage_bootstrap_intervals(
    stage_table: pd.DataFrame,
    nodes: pd.DataFrame,
    candidates: list[dict[str, Any]],
    game_ids: list[str],
    bootstrap_weights: np.ndarray,
    max_ply: int,
) -> pd.DataFrame:
    game_index = {game_id: idx for idx, game_id in enumerate(game_ids)}
    interval_columns = [
        "mean_loss_boot_q025",
        "mean_loss_boot_q975",
        "zero_rate_boot_q025",
        "zero_rate_boot_q975",
        "loss_ge4_rate_boot_q025",
        "loss_ge4_rate_boot_q975",
        "loss_ge10_rate_boot_q025",
        "loss_ge10_rate_boot_q975",
        "positive_mean_loss_boot_q025",
        "positive_mean_loss_boot_q975",
    ]
    for column in interval_columns:
        stage_table[column] = np.nan
    for candidate in candidates:
        for stage_index, (start, end) in enumerate(phase_ranges(candidate["boundaries"], max_ply), start=1):
            view = nodes[nodes["ply"].between(start, end)]
            per_game = np.zeros((len(game_ids), 7), dtype=np.float32)
            for row in view[["game_id", "disc_loss"]].itertuples(index=False):
                idx = game_index[str(row.game_id)]
                loss = float(row.disc_loss)
                per_game[idx, 0] += 1.0
                per_game[idx, 1] += loss
                per_game[idx, 2] += float(loss == 0)
                per_game[idx, 3] += float(loss >= 4)
                per_game[idx, 4] += float(loss >= 10)
                if loss > 0:
                    per_game[idx, 5] += 1.0
                    per_game[idx, 6] += loss
            boot = bootstrap_weights @ per_game
            with np.errstate(divide="ignore", invalid="ignore"):
                metrics = {
                    "mean_loss": boot[:, 1] / boot[:, 0],
                    "zero_rate": boot[:, 2] / boot[:, 0],
                    "loss_ge4_rate": boot[:, 3] / boot[:, 0],
                    "loss_ge10_rate": boot[:, 4] / boot[:, 0],
                    "positive_mean_loss": boot[:, 6] / boot[:, 5],
                }
            mask = (stage_table["k"] == candidate["k"]) & (stage_table["stage"] == stage_index)
            for metric, values in metrics.items():
                finite = values[np.isfinite(values)]
                stage_table.loc[mask, f"{metric}_boot_q025"] = float(np.quantile(finite, 0.025))
                stage_table.loc[mask, f"{metric}_boot_q975"] = float(np.quantile(finite, 0.975))
    return stage_table


def engine_diagnostics_by_ply(nodes: pd.DataFrame, max_ply: int) -> pd.DataFrame:
    view = nodes.copy()
    depth_parts = view["hint6_1_depth"].astype("string").str.extract(r"^(\d+)(?:@(\d+)%)?$")
    view["depth_number"] = pd.to_numeric(depth_parts[0], errors="coerce")
    view["selectivity_percent"] = pd.to_numeric(depth_parts[1], errors="coerce")
    records: list[dict[str, Any]] = []
    for ply in range(1, max_ply + 1):
        part = view[view["ply"] == ply]
        depth_counts = part["hint6_1_depth"].value_counts(dropna=False)
        records.append(
            {
                "ply": ply,
                "nodes": len(part),
                "book_rate": float(part["hint6_1_is_book_bool"].mean()) if len(part) else math.nan,
                "hint6_1_nodes_median": float(part["hint6_1_nodes"].median()) if len(part) else math.nan,
                "depth_number_median": float(part["depth_number"].median()) if len(part) else math.nan,
                "selectivity_percent_median": float(part["selectivity_percent"].median()) if len(part) else math.nan,
                "depth_mode": str(depth_counts.index[0]) if len(depth_counts) else "",
                "depth_mode_rate": float(depth_counts.iloc[0] / len(part)) if len(part) else math.nan,
                "first_not_max_rate": float((~part["hint6_first_is_max"]).mean()) if len(part) else math.nan,
                "raw_negative_rate": float((part["raw_loss"] < 0).mean()) if len(part) else math.nan,
            }
        )
    return pd.DataFrame(records)


def loss_definition_sensitivity(
    primary_postbook: pd.DataFrame,
    max_ply: int,
    min_stage_width: int,
    min_ply_games: int,
) -> pd.DataFrame:
    scenarios: list[tuple[str, pd.DataFrame]] = []
    scenarios.append(("adjacent_clipped_at_zero", primary_postbook.copy()))
    scenarios.append(("adjacent_raw_nonnegative_only", primary_postbook[primary_postbook["raw_loss"] >= 0].copy()))
    direct = primary_postbook[primary_postbook["direct_top6_loss"].notna()].copy()
    direct["disc_loss"] = direct["direct_top6_loss"].clip(lower=0)
    scenarios.append(("same_root_actual_in_hint6", direct))
    strict = primary_postbook[~primary_postbook["hint6_1_is_book_bool"]].copy()
    scenarios.append(("current_position_nonbook_only", strict))
    records: list[dict[str, Any]] = []
    for name, view in scenarios:
        scenario_games = sorted(view["game_id"].astype(str).unique())
        matrices = build_game_ply_matrices(view, scenario_games, max_ply)
        agg = aggregate_matrices(matrices)
        for k in (3, 4, 5):
            fit = fit_partition(agg, k, min_stage_width, min_ply_games)
            records.append(
                {
                    "scenario": name,
                    "nodes": len(view),
                    "games": len(scenario_games),
                    "k": k,
                    "boundaries": "|".join(str(value) for value in fit["boundaries"]),
                    "sse": fit["sse"],
                    "bic": fit["bic"],
                }
            )
    return pd.DataFrame(records)


def search_parameter_sensitivity(aggregate: dict[str, np.ndarray]) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    for min_width, min_games in itertools.product((4, 5, 6, 7, 8), (30, 100, 300, 500)):
        for k in (3, 4, 5):
            fit = fit_partition(aggregate, k, min_width, min_games)
            records.append(
                {
                    "min_stage_width": min_width,
                    "min_ply_games": min_games,
                    "k": k,
                    "boundaries": "|".join(str(value) for value in fit["boundaries"]),
                    "sse": fit["sse"],
                    "bic": fit["bic"],
                    "valid_ply_count": fit["valid_ply_count"],
                }
            )
    return pd.DataFrame(records)


def candidate_table(candidates: list[dict[str, Any]], boot: pd.DataFrame) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    previous_sse: float | None = None
    for candidate in candidates:
        k = candidate["k"]
        view = boot[boot["k"] == k]
        exact = "|".join(str(value) for value in candidate["boundaries"])
        record: dict[str, Any] = {
            **candidate,
            "boundaries": exact,
            "sse_improvement_from_previous_k": (
                (previous_sse - candidate["sse"]) / previous_sse if previous_sse else math.nan
            ),
            "bootstrap_exact_partition_rate": float((view["boundaries"] == exact).mean()),
        }
        for index in range(1, k):
            values = pd.to_numeric(view[f"boundary_{index}"], errors="coerce")
            record[f"boundary_{index}_bootstrap_q025"] = float(values.quantile(0.025))
            record[f"boundary_{index}_bootstrap_median"] = float(values.quantile(0.5))
            record[f"boundary_{index}_bootstrap_q975"] = float(values.quantile(0.975))
            record[f"boundary_{index}_within_1_rate"] = float((values - candidate["boundaries"][index - 1]).abs().le(1).mean())
        records.append(record)
        previous_sse = candidate["sse"]
    return pd.DataFrame(records)


def player_contributions(nodes: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    node_counts = nodes.groupby("player_id", observed=True).size().rename("nodes")
    game_counts = nodes.groupby("player_id", observed=True)["game_id"].nunique().rename("games_with_loss_nodes")
    ratings = pd.concat(
        [
            games[["black_id", "black_rating_in_seed"]].rename(columns={"black_id": "player_id", "black_rating_in_seed": "rating"}),
            games[["white_id", "white_rating_in_seed"]].rename(columns={"white_id": "player_id", "white_rating_in_seed": "rating"}),
        ],
        ignore_index=True,
    ).dropna(subset=["rating"])
    ratings = ratings.groupby("player_id", observed=True)["rating"].first()
    result = pd.concat([node_counts, game_counts, ratings], axis=1).fillna(0).reset_index()
    result = result.sort_values(["nodes", "games_with_loss_nodes", "player_id"], ascending=[False, False, True])
    total_nodes = result["nodes"].sum()
    result["node_share"] = result["nodes"] / total_nodes
    result["cumulative_node_share"] = result["node_share"].cumsum()
    result["rank_by_nodes"] = np.arange(1, len(result) + 1)
    return result


def sensitivity_partitions(
    nodes: pd.DataFrame,
    games: pd.DataFrame,
    top_players: list[str],
    ks: Iterable[int],
    max_ply: int,
    min_stage_width: int,
    min_ply_games: int,
) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    scenarios: list[tuple[str, set[str]]] = [("all_primary_games", set())]
    scenarios.append(("remove_top5_together", set(top_players[:5])))
    for player in top_players[:10]:
        scenarios.append((f"leave_out_{player}", {player}))
    for name, excluded in scenarios:
        if excluded:
            excluded_games = games.loc[
                games["black_id"].isin(excluded) | games["white_id"].isin(excluded), "game_id"
            ]
            view = nodes[~nodes["game_id"].isin(excluded_games)]
        else:
            view = nodes
        game_ids = sorted(view["game_id"].unique())
        matrices = build_game_ply_matrices(view, game_ids, max_ply)
        agg = aggregate_matrices(matrices)
        for k in ks:
            fit = fit_partition(agg, k, min_stage_width, min_ply_games)
            records.append(
                {
                    "scenario": name,
                    "excluded_players": "|".join(sorted(excluded)),
                    "games": len(game_ids),
                    "nodes": len(view),
                    "k": k,
                    "boundaries": "|".join(str(value) for value in fit["boundaries"]),
                    "sse": fit["sse"],
                    "bic": fit["bic"],
                }
            )
    return pd.DataFrame(records)


def repeated_pairs(games: pd.DataFrame) -> pd.DataFrame:
    pair = games.apply(lambda row: "|".join(sorted([str(row["black_id"]), str(row["white_id"])])), axis=1)
    table = (
        games.assign(unordered_pair=pair)
        .groupby("unordered_pair", observed=True)
        .agg(
            games=("game_id", "nunique"),
            first_created=("created", "min"),
            last_created=("created", "max"),
        )
        .reset_index()
        .sort_values(["games", "unordered_pair"], ascending=[False, True])
    )
    return table


def plot_ply_metrics(
    ply_stats: pd.DataFrame,
    candidates: list[dict[str, Any]],
    output: Path,
    selected_metrics: list[str] | None = None,
) -> None:
    selected = selected_metrics or [name for name, _ in PLOT_METRICS]
    titles = dict(PLOT_METRICS)
    series = [(name, titles[name]) for name in selected]
    rows = math.ceil(len(series) / 2)
    fig, axes = plt.subplots(rows, 2, figsize=(13, 4 * rows), sharex=True, squeeze=False)
    colors = {3: "#1f77b4", 4: "#d62728", 5: "#2ca02c"}
    for axis, (column, title) in zip(axes.ravel(), series):
        axis.plot(ply_stats["ply"], ply_stats[column], color="black", linewidth=1.4)
        for candidate in candidates:
            for boundary in candidate["boundaries"]:
                axis.axvline(boundary + 0.5, color=colors[candidate["k"]], alpha=0.45, linewidth=1)
        axis.set_title(title)
        axis.grid(alpha=0.2)
    for axis in axes.ravel()[len(series):]:
        axis.set_visible(False)
    for axis in axes[-1]:
        if axis.get_visible():
            axis.set_xlabel("Global ply")
    fig.suptitle("Post-book consecutive level-18 loss metrics; lines show 3/4/5-phase fits")
    handles = [plt.Line2D([0], [0], color=colors[k], label=f"{k} phases") for k in colors]
    fig.legend(handles=handles, loc="upper right")
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    fig.savefig(output, dpi=160)
    plt.close(fig)


def plot_tail_coverage(ply_stats: pd.DataFrame, output: Path) -> None:
    fig, axis = plt.subplots(figsize=(10, 4.5))
    axis.plot(ply_stats["ply"], ply_stats["games"], color="#4c78a8", linewidth=2)
    axis.set_xlabel("Global ply")
    axis.set_ylabel("Games contributing a loss node")
    axis.set_title("Effective whole-game coverage by global ply")
    axis.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(output, dpi=160)
    plt.close(fig)


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if not math.isfinite(float(value)) else float(value)
    return value


def write_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(json_safe(payload), handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    args = parse_args()
    if args.bootstrap_reps <= 0:
        raise ValueError("--bootstrap-reps must be positive")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    input_paths = [args.users, args.games, args.summaries, args.moves, args.hints]
    for path in input_paths:
        if not path.exists():
            raise FileNotFoundError(path)

    users = pd.read_csv(args.users, dtype={"id": "string", "name": "string"})
    games = pd.read_csv(
        args.games,
        dtype={"game_id": "string", "black_id": "string", "white_id": "string", "recorded_sides": "string"},
    )
    games["black_rating_in_seed"] = pd.to_numeric(games["black_rating_in_seed"], errors="coerce")
    games["white_rating_in_seed"] = pd.to_numeric(games["white_rating_in_seed"], errors="coerce")
    games["tcb"] = pd.to_numeric(games["tcb"], errors="coerce")
    games["created_dt"] = pd.to_datetime(games["created"], utc=True, errors="coerce")

    hint_columns = [
        "game_id",
        "mode",
        "gtype",
        "tcb",
        "created",
        "finalStatus",
        "move_index",
        "ply",
        "side_to_move",
        "player_id",
        "actual_move",
        "board",
        "n_legal_moves",
        "hint6_1_nodes",
        "hint6_1_depth",
        "hint6_1_is_book",
    ]
    for rank in range(1, 7):
        hint_columns.extend([f"hint6_{rank}_move", f"hint6_{rank}_score"])
    hints = pd.read_csv(
        args.hints,
        usecols=hint_columns,
        dtype={
            "game_id": "string",
            "side_to_move": "string",
            "player_id": "string",
            "actual_move": "string",
            "board": "string",
            "hint6_1_depth": "string",
            "hint6_1_is_book": "string",
            **{f"hint6_{rank}_move": "string" for rank in range(1, 7)},
        },
        low_memory=False,
    )
    for column in [
        "move_index",
        "ply",
        "tcb",
        "n_legal_moves",
        "hint6_1_nodes",
        *[f"hint6_{rank}_score" for rank in range(1, 7)],
    ]:
        hints[column] = pd.to_numeric(hints[column], errors="coerce")
    hints["hint6_1_is_book_bool"] = bool_series(hints["hint6_1_is_book"])
    hints = hints.sort_values(["game_id", "move_index"], kind="stable").reset_index(drop=True)
    hints["source_ply_including_pass"] = hints["ply"]
    hints["is_pass_record"] = hints["actual_move"].eq("-").fillna(False)
    hints["global_placement_ply"] = (
        (~hints["is_pass_record"]).astype(int).groupby(hints["game_id"], observed=True).cumsum()
    )

    next_game = hints["game_id"].shift(-1)
    hints["next_move_index"] = hints["move_index"].shift(-1)
    hints["next_source_ply"] = hints["source_ply_including_pass"].shift(-1)
    hints["next_side_to_move"] = hints["side_to_move"].shift(-1)
    hints["next_best_score"] = hints["hint6_1_score"].shift(-1)
    hints["has_consecutive_child"] = (
        hints["game_id"].eq(next_game)
        & hints["next_move_index"].eq(hints["move_index"] + 1)
        & hints["next_source_ply"].eq(hints["source_ply_including_pass"] + 1)
    )
    hints["same_side_after_move"] = (
        hints["side_to_move"].eq(hints["next_side_to_move"]).fillna(False).astype(bool)
    )
    complete_score = hints["hint6_1_score"].notna() & hints["next_best_score"].notna()
    hints["raw_loss"] = np.where(
        hints["has_consecutive_child"] & complete_score,
        np.where(
            hints["same_side_after_move"],
            hints["hint6_1_score"] - hints["next_best_score"],
            hints["hint6_1_score"] + hints["next_best_score"],
        ),
        np.nan,
    )
    hints["disc_loss"] = hints["raw_loss"].clip(lower=0)
    hints["actual_move_score"] = np.where(
        hints["has_consecutive_child"] & complete_score,
        np.where(
            hints["same_side_after_move"],
            hints["next_best_score"],
            -hints["next_best_score"],
        ),
        np.nan,
    )
    before_rank = np.where(
        hints["hint6_1_score"] > 0,
        2,
        np.where(hints["hint6_1_score"] < 0, 0, 1),
    )
    after_rank = np.where(
        hints["actual_move_score"] > 0,
        2,
        np.where(hints["actual_move_score"] < 0, 0, 1),
    )
    hints["wld_loss"] = np.where(
        hints["has_consecutive_child"] & complete_score,
        np.maximum(0, before_rank - after_rank) / 2.0,
        np.nan,
    )

    hints["actual_hint_rank"] = np.nan
    hints["actual_hint_score"] = np.nan
    for rank in range(1, 7):
        match = hints["actual_move"].str.lower().eq(hints[f"hint6_{rank}_move"].str.lower()).fillna(False)
        unresolved = hints["actual_hint_rank"].isna()
        hints.loc[match & unresolved, "actual_hint_rank"] = rank
        hints.loc[match & unresolved, "actual_hint_score"] = hints.loc[match & unresolved, f"hint6_{rank}_score"]
    hints["direct_top6_loss"] = hints["hint6_1_score"] - hints["actual_hint_score"]
    hint_score_columns = [f"hint6_{rank}_score" for rank in range(1, 7)]
    hints["hint6_max_score"] = hints[hint_score_columns].max(axis=1, skipna=True)
    hints["hint6_first_is_max"] = hints["hint6_1_score"].eq(hints["hint6_max_score"])

    # From this point onward, "ply" means a placed-disc ply. Explicit pass
    # records remain available as child evaluations but are not decision nodes.
    hints["ply"] = hints["global_placement_ply"]

    first_nonbook = (
        hints.loc[
            ~hints["is_pass_record"]
            & ~hints["hint6_1_is_book_bool"]
            & hints["hint6_1_score"].notna()
        ]
        .groupby("game_id", observed=True)["ply"]
        .min()
        .rename("first_nonbook_ply")
    )
    hints = hints.join(first_nonbook, on="game_id")
    hints["post_book"] = hints["first_nonbook_ply"].notna() & hints["ply"].ge(hints["first_nonbook_ply"])

    games["both_players_in_seed"] = games["black_rating_in_seed"].notna() & games["white_rating_in_seed"].notna()
    both_game_ids = set(games.loc[games["both_players_in_seed"], "game_id"].astype(str))
    hints["both_players_in_seed"] = hints["game_id"].astype(str).isin(both_game_ids)

    exact_all = hints[~hints["is_pass_record"] & hints["disc_loss"].notna()].copy()
    primary_all = exact_all[exact_all["both_players_in_seed"]].copy()
    primary_postbook = primary_all[primary_all["post_book"]].copy()
    if primary_postbook.empty:
        raise ValueError("primary post-book loss sample is empty")

    game_ids = sorted(primary_postbook["game_id"].astype(str).unique())
    matrices = build_game_ply_matrices(primary_postbook, game_ids, args.max_ply)
    aggregate = aggregate_matrices(matrices)
    candidates = [
        fit_partition(aggregate, k, args.min_stage_width, args.min_ply_games)
        for k in (3, 4, 5)
    ]
    boot, bootstrap_weights = bootstrap_partitions(
        matrices,
        (3, 4, 5),
        args.bootstrap_reps,
        args.seed,
        args.min_stage_width,
        args.min_ply_games,
    )
    candidate_comparison = candidate_table(candidates, boot)

    ply_stats = describe_by_ply(primary_postbook, args.max_ply)
    candidate_stages = summarize_candidate_stages(primary_postbook, candidates, args.max_ply)
    candidate_stages = add_stage_bootstrap_intervals(
        candidate_stages,
        primary_postbook,
        candidates,
        game_ids,
        bootstrap_weights,
        args.max_ply,
    )
    engine_diagnostics = engine_diagnostics_by_ply(primary_postbook, args.max_ply)
    loss_sensitivity = loss_definition_sensitivity(
        primary_postbook,
        args.max_ply,
        args.min_stage_width,
        args.min_ply_games,
    )
    parameter_sensitivity = search_parameter_sensitivity(aggregate)
    primary_games = games[games["game_id"].astype(str).isin(game_ids)].copy()
    primary_placement_lengths = (
        hints.loc[
            hints["game_id"].astype(str).isin(game_ids) & ~hints["is_pass_record"],
            ["game_id", "global_placement_ply"],
        ]
        .groupby("game_id", observed=True)["global_placement_ply"]
        .max()
    )
    contributions = player_contributions(primary_postbook, primary_games)
    sensitivity = sensitivity_partitions(
        primary_postbook,
        primary_games,
        contributions["player_id"].astype(str).tolist(),
        (3, 4, 5),
        args.max_ply,
        args.min_stage_width,
        args.min_ply_games,
    )
    pairs = repeated_pairs(games)

    wld_game_player_totals: pd.DataFrame | None = None
    wld_player_totals: pd.DataFrame | None = None
    if args.wld_from_ply is not None:
        wld_nodes = primary_all[
            primary_all["global_placement_ply"].ge(args.wld_from_ply)
            & primary_all["wld_loss"].notna()
        ].copy()
        summed_game_players = (
            wld_nodes.groupby(
                ["game_id", "player_id", "side_to_move"], observed=True, dropna=False
            )["wld_loss"]
            .sum()
            .rename(ENGINE_WLD_TOTAL_FIELD)
            .reset_index()
            .rename(columns={"side_to_move": "side"})
        )
        base_game_players = (
            primary_all[["game_id", "player_id", "side_to_move"]]
            .drop_duplicates()
            .rename(columns={"side_to_move": "side"})
        )
        wld_game_player_totals = base_game_players.merge(
            summed_game_players,
            on=["game_id", "player_id", "side"],
            how="left",
        )
        wld_game_player_totals[ENGINE_WLD_TOTAL_FIELD] = wld_game_player_totals[
            ENGINE_WLD_TOTAL_FIELD
        ].fillna(0.0)
        summed_players = (
            wld_nodes.groupby(["player_id"], observed=True, dropna=False)["wld_loss"]
            .sum()
            .rename(ENGINE_WLD_TOTAL_FIELD)
            .reset_index()
        )
        wld_player_totals = primary_all[["player_id"]].drop_duplicates().merge(
            summed_players,
            on="player_id",
            how="left",
        )
        wld_player_totals[ENGINE_WLD_TOTAL_FIELD] = wld_player_totals[
            ENGINE_WLD_TOTAL_FIELD
        ].fillna(0.0)

    current_duplicate_scans = {
        "games": scan_csv_keys(args.games, ["game_id"]),
        "summaries": scan_csv_keys(args.summaries, ["game_id", "color", "player_id"]),
        "moves": scan_csv_keys(args.moves, ["game_id", "move_index", "player_id"]),
        "hints": scan_csv_keys(args.hints, ["game_id", "move_index"]),
    }
    backup_specs = [
        (args.games.with_name("games.before_dedupe_20260702_1818.csv"), ["game_id"]),
        (args.games.with_name("games.before_score_filter_dedupe_20260702_1822.csv"), ["game_id"]),
        (args.moves.with_name("move_times.before_score_filter_dedupe_20260702_1822.csv"), ["game_id", "move_index", "player_id"]),
        (args.hints.with_name("position_hints.before_dedupe_20260702_1818.csv"), ["game_id", "move_index"]),
        (args.hints.with_name("position_hints.before_score_filter_dedupe_20260702_1822.csv"), ["game_id", "move_index"]),
    ]
    backup_duplicate_scans = {
        path.name: scan_csv_keys(path, fields)
        for path, fields in backup_specs
        if path.exists()
    }

    repeated_pair_counts = pairs["games"]
    input_summary = {
        "leaderboard_snapshot": {
            "users": int(len(users)),
            "unique_user_ids": int(users["id"].nunique()),
            "rating_min": int(pd.to_numeric(users["rating"], errors="coerce").min()),
            "rating_max": int(pd.to_numeric(users["rating"], errors="coerce").max()),
        },
        "games_current": {
            "rows": int(len(games)),
            "unique_games": int(games["game_id"].nunique()),
            "unique_all_players": int(pd.unique(pd.concat([games["black_id"], games["white_id"]], ignore_index=True)).size),
            "both_players_in_seed_games": int(games["both_players_in_seed"].sum()),
            "one_player_in_seed_games": int((~games["both_players_in_seed"]).sum()),
            "tcb_counts": {str(key): int(value) for key, value in games["tcb"].value_counts(dropna=False).items()},
            "final_status_score_rate": float(games["finalStatus"].astype("string").str.startswith("SCORE:").mean()),
            "created_min": games["created_dt"].min().isoformat() if games["created_dt"].notna().any() else None,
            "created_max": games["created_dt"].max().isoformat() if games["created_dt"].notna().any() else None,
            "distinct_pairs": int(len(pairs)),
            "pairs_with_repeated_games": int((repeated_pair_counts > 1).sum()),
            "games_in_repeated_pairs": int(repeated_pair_counts[repeated_pair_counts > 1].sum()),
            "max_games_for_one_pair": int(repeated_pair_counts.max()),
        },
        "hints_current": {
            "rows": int(len(hints)),
            "unique_games": int(hints["game_id"].nunique()),
            "unique_players": int(hints["player_id"].nunique()),
            "level18_hint1_score_present": int(hints["hint6_1_score"].notna().sum()),
            "level18_hint1_depth_counts": {str(key): int(value) for key, value in hints["hint6_1_depth"].value_counts(dropna=False).head(20).items()},
            "level18_hint1_book_rate": float(hints["hint6_1_is_book_bool"].mean()),
            "hint6_first_is_max_rate_when_scored": float(
                hints.loc[hints["hint6_1_score"].notna(), "hint6_first_is_max"].mean()
            ),
            "hint6_first_not_max_nodes": int(
                (hints["hint6_1_score"].notna() & ~hints["hint6_first_is_max"]).sum()
            ),
            "actual_move_in_hint6_rate": float(hints["actual_hint_rank"].notna().mean()),
            "actual_move_in_hint6_rate_primary_postbook": float(primary_postbook["actual_hint_rank"].notna().mean()),
            "actual_move_rank_counts_primary_postbook": {
                str(key): int(value)
                for key, value in primary_postbook["actual_hint_rank"].value_counts(dropna=False).sort_index().items()
            },
            "consecutive_child_nodes_all_games": int(hints["has_consecutive_child"].sum()),
            "exact_loss_nodes_all_games": int(len(exact_all)),
            "exact_loss_nodes_both_seed_games": int(len(primary_all)),
            "exact_loss_nodes_primary_postbook": int(len(primary_postbook)),
            "implicit_pass_transitions_primary_postbook": int(primary_postbook["same_side_after_move"].sum()),
            "raw_negative_nodes_primary_postbook": int((primary_postbook["raw_loss"] < 0).sum()),
            "raw_negative_rate_primary_postbook": float((primary_postbook["raw_loss"] < 0).mean()),
            "raw_loss_quantiles_primary_postbook": {
                str(q): float(primary_postbook["raw_loss"].quantile(q))
                for q in (0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1)
            },
            "raw_loss_value_counts_primary_postbook": {
                str(key): int(value)
                for key, value in primary_postbook["raw_loss"].value_counts().sort_index().items()
            },
            "direct_top6_comparison_primary_postbook": {
                "nodes": int(primary_postbook["direct_top6_loss"].notna().sum()),
                "exact_equal_rate": float(
                    primary_postbook.loc[primary_postbook["direct_top6_loss"].notna(), "raw_loss"]
                    .eq(primary_postbook.loc[primary_postbook["direct_top6_loss"].notna(), "direct_top6_loss"])
                    .mean()
                ),
                "raw_minus_direct_quantiles": {
                    str(q): float((primary_postbook["raw_loss"] - primary_postbook["direct_top6_loss"]).dropna().quantile(q))
                    for q in (0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1)
                },
            },
            "source_ply_including_pass_min": int(hints["source_ply_including_pass"].min()),
            "source_ply_including_pass_max": int(hints["source_ply_including_pass"].max()),
            "global_placement_ply_min": int(hints.loc[~hints["is_pass_record"], "global_placement_ply"].min()),
            "global_placement_ply_max": int(hints.loc[~hints["is_pass_record"], "global_placement_ply"].max()),
            "actual_pass_rows": int(hints["actual_move"].eq("-").sum()),
            "primary_game_placement_length_counts": {
                str(key): int(value)
                for key, value in primary_placement_lengths.value_counts().sort_index().items()
            },
            "primary_games_ending_before_60_placements": int((primary_placement_lengths < 60).sum()),
            "primary_games_reaching_60_placements": int((primary_placement_lengths >= 60).sum()),
            "first_nonbook_ply_quantiles_both_seed": {
                str(q): float(primary_all.groupby("game_id", observed=True)["first_nonbook_ply"].first().quantile(q))
                for q in (0, 0.1, 0.25, 0.5, 0.75, 0.9, 1)
            },
        },
        "primary_postbook": summarize_loss_frame(primary_postbook),
        "current_duplicate_scans": current_duplicate_scans,
        "backup_duplicate_scans": backup_duplicate_scans,
        "player_concentration": {
            "top1_node_share": float(contributions.head(1)["node_share"].sum()),
            "top5_node_share": float(contributions.head(5)["node_share"].sum()),
            "top10_node_share": float(contributions.head(10)["node_share"].sum()),
            "hhi_node_share": float((contributions["node_share"] ** 2).sum()),
        },
    }

    run_manifest = {
        "generated_at": utc_now_iso(),
        "command": " ".join([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]),
        "python": sys.version,
        "parameters": {
            "bootstrap_reps": args.bootstrap_reps,
            "seed": args.seed,
            "min_stage_width": args.min_stage_width,
            "min_ply_games": args.min_ply_games,
            "max_ply": args.max_ply,
            "phase_search_sample": "both-seed games, exact consecutive level18 hint6_1 losses, chronologically post-book",
            "loss_formula": "different next side: current_best + next_best; same next side/pass: current_best - next_best",
            "negative_loss_handling": "retain raw_loss for audit; disc_loss=max(0, raw_loss)",
            "bootstrap_unit": "whole game",
            "reported_loss_thresholds": list(LOSS_THRESHOLDS),
            "segmentation_features": METRIC_NAMES,
            "segmentation_ply_weight": "sqrt(number of contributing games)",
            "plot_metrics": args.plot_metric or [name for name, _ in PLOT_METRICS],
        },
        "inputs": [file_manifest(path) for path in input_paths],
    }
    if args.wld_from_ply is not None:
        run_manifest["parameters"]["wld_from_ply"] = args.wld_from_ply
        run_manifest["parameters"]["wld_ply_coordinate"] = (
            "global_placement_ply counts actual coordinate placements only; pass rows do not consume ply"
        )

    ply_stats.to_csv(args.output_dir / "ply_statistics_postbook.csv", index=False, encoding="utf-8")
    candidate_comparison.to_csv(args.output_dir / "candidate_partitions.csv", index=False, encoding="utf-8")
    candidate_stages.to_csv(args.output_dir / "candidate_stage_statistics.csv", index=False, encoding="utf-8")
    boot.to_csv(args.output_dir / "bootstrap_partition_replicates.csv", index=False, encoding="utf-8")
    contributions.to_csv(args.output_dir / "player_contributions.csv", index=False, encoding="utf-8")
    sensitivity.to_csv(args.output_dir / "player_sensitivity_partitions.csv", index=False, encoding="utf-8")
    loss_sensitivity.to_csv(args.output_dir / "loss_definition_sensitivity_partitions.csv", index=False, encoding="utf-8")
    engine_diagnostics.to_csv(args.output_dir / "engine_diagnostics_by_ply.csv", index=False, encoding="utf-8")
    parameter_sensitivity.to_csv(args.output_dir / "search_parameter_sensitivity.csv", index=False, encoding="utf-8")
    pairs.to_csv(args.output_dir / "repeated_player_pairs.csv", index=False, encoding="utf-8")
    write_json(args.output_dir / "data_inventory.json", input_summary)
    write_json(args.output_dir / "run_manifest.json", run_manifest)
    write_json(
        args.output_dir / "analysis_summary.json",
        {
            "input_summary": input_summary,
            "candidate_partitions": candidates,
            "candidate_comparison": candidate_comparison.to_dict(orient="records"),
            **(
                {
                    "wldFromPly": args.wld_from_ply,
                    "engineWldLossTotals": {
                        "gamePlayerTotals": wld_game_player_totals.to_dict(orient="records"),
                        "playerTotals": wld_player_totals.to_dict(orient="records"),
                    },
                }
                if args.wld_from_ply is not None
                else {}
            ),
        },
    )
    if args.wld_from_ply is not None:
        assert wld_game_player_totals is not None and wld_player_totals is not None
        wld_game_player_totals.to_csv(
            args.output_dir / "engine_wld_loss_totals_by_game_player_from_ply39.csv",
            index=False,
            encoding="utf-8",
        )
        wld_player_totals.to_csv(
            args.output_dir / "engine_wld_loss_totals_by_player_from_ply39.csv",
            index=False,
            encoding="utf-8",
        )
        write_json(
            args.output_dir / "engine_wld_loss_totals_from_ply39.json",
            {
                "wldFromPly": args.wld_from_ply,
                "gamePlayerTotals": wld_game_player_totals.to_dict(orient="records"),
                "playerTotals": wld_player_totals.to_dict(orient="records"),
            },
        )
    plot_ply_metrics(
        ply_stats,
        candidates,
        args.output_dir / "ply_loss_metrics.png",
        args.plot_metric,
    )
    plot_tail_coverage(ply_stats, args.output_dir / "ply_game_coverage.png")

    terminal_summary = {
        "output_dir": str(args.output_dir.resolve()),
        "candidates": candidates,
        "primary": input_summary["primary_postbook"],
    }
    if args.wld_from_ply is not None:
        terminal_summary["engineWldLossTotals"] = {
            "gamePlayerTotals": wld_game_player_totals.to_dict(orient="records"),
            "playerTotals": wld_player_totals.to_dict(orient="records"),
        }
    print(json.dumps(json_safe(terminal_summary), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
