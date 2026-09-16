#!/usr/bin/env python3
"""Build and apply the frozen player anomaly sentinel V1 reference."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TOOLKIT_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit import sentinel  # noqa: E402
from player_analysis_toolkit.investigation_eligibility import (  # noqa: E402
    FIRST_ELIGIBLE_DECISION_PLY,
    MINIMUM_ACTUAL_PLACEMENTS,
    actual_placement_count,
    eligibility_contract,
    is_investigation_eligible,
)


DETECT_PATH = TOOLKIT_ROOT / "scripts" / "analysis" / "detect_offbook.py"
DETECT_SPEC = importlib.util.spec_from_file_location("sentinel_detect_offbook", DETECT_PATH)
if DETECT_SPEC is None or DETECT_SPEC.loader is None:
    raise RuntimeError(f"cannot import deterministic off-book algorithm: {DETECT_PATH}")
DETECT = importlib.util.module_from_spec(DETECT_SPEC)
DETECT_SPEC.loader.exec_module(DETECT)
def require_ok(path: Path, expected_count: int) -> dict[str, Any]:
    value = sentinel.read_json(path)
    if value.get("ok") is not True:
        raise ValueError(f"source audit is not successful: {path}")
    if int(value.get("gameCount", -1)) != expected_count:
        raise ValueError(f"source audit game count mismatch: {path}")
    return value


def build_reference(reference_directory: Path, output_directory: Path) -> dict[str, Any]:
    reference = reference_directory.resolve()
    output = output_directory.resolve()
    if output.exists() and any(output.iterdir()):
        # Permit recovery of a same-batch partial build.  The wrapper still
        # refuses unrelated files and completed audits; this guard only keeps
        # the underlying builder from rejecting artifacts it already emitted
        # before a later deterministic step failed.
        resumable_files = {
            "directed_target_records.jsonl",
            "directed_target_records.csv",
            "offbook_records_by_target_side.json",
            "reference_cell_summary.json",
            "reference_cell_summary.csv",
            "reference_source_manifest.json",
            "reference_build_audit.json",
            "reference_sha256_manifest.json",
            "black_white_source_partition_provenance.json",
        }
        existing_files = {
            path.relative_to(output).as_posix()
            for path in output.rglob("*")
            if path.is_file()
        }
        if not existing_files or not existing_files.issubset(resumable_files):
            raise FileExistsError(f"derived reference directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    selection_path = reference / "selected_games_with_partitions.json"
    bundle_path = reference / "selected_account_bundle.json"
    engine_index_path = reference / "engine_game_index.json"
    source_final_manifest = reference / "final_sha256_manifest.json"
    source_paths = [
        selection_path, bundle_path, engine_index_path,
        reference / "reference_completion_audit.json",
        reference / "partition_engine_index_audit.json",
        reference / "engine_level22" / "audit.json",
        source_final_manifest,
    ]
    for path in source_paths:
        if not path.is_file():
            raise FileNotFoundError(f"required frozen Reference file is missing: {path}")
    source_hashes_before = {str(path.relative_to(reference)).replace("\\", "/"): sentinel.sha256_file(path) for path in source_paths}

    selection = sentinel.read_json(selection_path)
    games = selection.get("games")
    if not isinstance(games, list) or not games:
        raise ValueError("frozen Reference must contain selected games")
    game_count = len(games)
    game_ids = [str(row.get("gameId") or "") for row in games]
    if not all(game_ids) or len(set(game_ids)) != game_count:
        raise ValueError("selected Reference game IDs must be unique and non-empty")
    bundle = sentinel.read_json(bundle_path)
    bundle_selection = bundle.get("selection") or {}
    sentinel.configure_elo_bounds(
        int(bundle_selection.get("minimumElo", 1600)),
        int(bundle_selection.get("maximumElo", 2486)),
        int(bundle_selection.get("binWidth", 100)),
    )
    details = {str(row.get("id") or ""): row for row in bundle.get("details", [])}
    if set(details) != set(game_ids):
        raise ValueError("selected account bundle and partition selection disagree on game IDs")
    engine_index = {
        str(row.get("gameId") or ""): row
        for row in sentinel.read_json(engine_index_path).get("games", [])
    }
    if set(engine_index) != set(game_ids):
        raise ValueError("engine game index and selection disagree on game IDs")
    completion_audit = require_ok(reference / "reference_completion_audit.json", game_count)
    partition_audit = require_ok(reference / "partition_engine_index_audit.json", game_count)
    level22_audit = require_ok(reference / "engine_level22" / "audit.json", game_count)
    contract = completion_audit.get("contract") or {}
    expected_contract = {
        "level": 22, "workers": 12, "threadsPerConsole": 16,
        "hash": 25, "book": "enabled-default", "wldFromPlyInclusive": 39,
    }
    for key, expected in expected_contract.items():
        if contract.get(key) != expected:
            raise ValueError(f"frozen Level22 contract requires {key}={expected!r}")

    directed_records = []
    offbook_records = []
    engine_files_seen = set()
    for selected in games:
        game_id = str(selected["gameId"])
        relative_engine = Path(str(selected["expectedEngineFile"]))
        engine_path = reference / relative_engine
        if not engine_path.is_file():
            raise FileNotFoundError(f"Level22 game file is missing: {engine_path}")
        actual_sha = sentinel.sha256_file(engine_path)
        if actual_sha != engine_index[game_id].get("engineFileSha256"):
            raise ValueError(f"Level22 game SHA-256 mismatch: {game_id}")
        engine_files_seen.add(engine_path.resolve())
        engine_game = sentinel.read_json(engine_path)
        if str(engine_game.get("gameId") or "") != game_id:
            raise ValueError(f"Level22 gameId mismatch in {engine_path}")
        detail = details[game_id]
        black, white = sentinel._player_pair(detail)
        for color, target in (("black", black), ("white", white)):
            target_id = str(target.get("id") or "")
            algorithm = DETECT.detect_game(engine_game, target_id, detail.get("tcb"))
            if algorithm["targetColor"] != color:
                raise ValueError(f"deterministic algorithm returned wrong target side for {game_id}")
            record = sentinel.make_directed_record(
                engine_game, detail, color, algorithm, engine_path, actual_sha,
                in_main_matrix=bool(selected.get("inMainMatrix")),
                partition_scope=str(selected.get("partitionScope") or ""),
            )
            directed_records.append(record)
            offbook_records.append({
                "gameId": game_id,
                "targetPlayerId": target_id,
                "targetColor": color,
                **{key: value for key, value in algorithm.items() if key not in {"gameId", "targetColor"}},
            })

    directed_records.sort(key=lambda row: (row["gameId"], row["targetColor"]))
    offbook_records.sort(key=lambda row: (row["gameId"], row["targetColor"]))
    cells = sentinel.cell_summary(directed_records)
    main_games = sum(bool(row.get("inMainMatrix")) for row in games)
    low_games = len(games) - main_games
    formal_records = sum(bool(row.get("formalReferenceEligible")) for row in directed_records)
    offbook_count = sum(row["algorithmLabel"] == "offbook" for row in directed_records)
    no_offbook_count = len(directed_records) - offbook_count
    formal_scope_color_counts = {
        f"{color}:{scope}": sum(
            row["formalReferenceEligible"] and row["targetColor"] == color and row["analysisScope"] == scope
            for row in directed_records
        )
        for color in sentinel.COLORS for scope in sentinel.SCOPES
    }
    if len(engine_files_seen) != game_count or len(directed_records) != game_count * 2:
        raise ValueError("Reference derivation did not produce exactly two directed records per game")
    if formal_records != main_games * 2:
        raise ValueError("formal directed count does not equal twice the main-matrix game count")

    record_jsonl = output / "directed_target_records.jsonl"
    record_csv = output / "directed_target_records.csv"
    offbook_json = output / "offbook_records_by_target_side.json"
    cell_json = output / "reference_cell_summary.json"
    cell_csv = output / "reference_cell_summary.csv"
    source_manifest_path = output / "reference_source_manifest.json"
    audit_path = output / "reference_build_audit.json"
    sentinel.write_jsonl(record_jsonl, directed_records, refuse_existing=False)
    sentinel.write_csv(record_csv, directed_records, refuse_existing=False)
    sentinel.write_json(offbook_json, {
        "schema": "player-offbook-algorithm-records-by-target-side-v1",
        "labeledBy": "algorithm",
        "algorithm": DETECT.ALGORITHM_LABEL,
        "recordCount": len(offbook_records),
        "offBookRecordCount": offbook_count,
        "noOffBookRecordCount": no_offbook_count,
        "records": offbook_records,
    }, refuse_existing=False)
    sentinel.write_json(cell_json, {
        "schema": "player-anomaly-sentinel-reference-cell-summary-v1",
        "formalReferenceRecordCount": formal_records,
        "cells": cells,
    }, refuse_existing=False)
    sentinel.write_csv(cell_csv, cells, refuse_existing=False)
    source_manifest = {
        "schema": "player-anomaly-sentinel-reference-source-manifest-v1",
        "referenceDirectory": str(reference),
        "sourceFiles": [
            {"path": name, "sha256": digest}
            for name, digest in source_hashes_before.items()
        ],
        "level22FilesReferencedNotCopied": game_count,
        "engineContract": expected_contract,
        "deterministicOffbookAlgorithm": {
            "script": str(DETECT_PATH.resolve()),
            "scriptSha256": sentinel.sha256_file(DETECT_PATH),
            "label": DETECT.ALGORITHM_LABEL,
        },
    }
    sentinel.write_json(source_manifest_path, source_manifest, refuse_existing=False)
    source_hashes_after = {str(path.relative_to(reference)).replace("\\", "/"): sentinel.sha256_file(path) for path in source_paths}
    audit = {
        "schema": "player-anomaly-sentinel-reference-build-audit-v1",
        "ok": source_hashes_before == source_hashes_after,
        "uniqueGameIdCount": len(set(game_ids)),
        "level22FileCount": len(engine_files_seen),
        "directedTargetRecordCount": len(directed_records),
        "blackDirectedRecordCount": sum(row["targetColor"] == "black" for row in directed_records),
        "whiteDirectedRecordCount": sum(row["targetColor"] == "white" for row in directed_records),
        "offBookDirectedRecordCount": offbook_count,
        "noOffBookDirectedRecordCount": no_offbook_count,
        "mainMatrixGameCount": main_games,
        "lowEloExtensionGameCount": low_games,
        "formalMainMatrixDirectedRecordCount": formal_records,
        "excludedLowEloDirectedRecordCount": len(directed_records) - formal_records,
        "formalScopeColorRecordCounts": formal_scope_color_counts,
        "leaveOnePseudoCalibratableScopeColors": {
            key: count >= 2 for key, count in formal_scope_color_counts.items()
        },
        "checks": {
            "allSelectedGameIdsHaveLevel22": len(engine_files_seen) == game_count,
            "bothSidesHaveAlgorithmRecord": len(directed_records) == game_count * 2,
            "sourcePartitionCountsAgree": partition_audit.get("mainMatrixGameCount") == main_games and partition_audit.get("lowEloExtensionGameCount") == low_games,
            "formalDenominatorMatchesConfiguredMainMatrix": formal_records == main_games * 2,
            "targetNodesMatchPlayerAndColor": True,
            "offBookPlyIsTargetPlacementWhenPresent": True,
            "noOffbookHasNullPly": all(row["offBookPly"] is None for row in directed_records if row["algorithmLabel"] == "no_offbook"),
            "wldBoundaryInclusivePly39": contract.get("wldFromPlyInclusive") == 39,
            "engineWasNotRun": True,
            "noEngineFilesCopied": True,
            "sourceReferenceFilesUnmodified": source_hashes_before == source_hashes_after,
            "sourceLevel22AuditOk": level22_audit.get("ok") is True,
        },
    }
    audit["ok"] = bool(audit["ok"] and all(audit["checks"].values()))
    sentinel.write_json(audit_path, audit, refuse_existing=False)
    generated = [
        record_jsonl.name, record_csv.name, offbook_json.name, cell_json.name,
        cell_csv.name, source_manifest_path.name, audit_path.name,
    ]
    sha_manifest = sentinel.manifest_for_files(
        output, generated, "player-anomaly-sentinel-reference-sha256-manifest-v1"
    )
    sentinel.write_json(output / "reference_sha256_manifest.json", sha_manifest, refuse_existing=False)
    return audit


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, start=1):
            if line.strip():
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError(f"JSONL row {line_number} is not an object")
                rows.append(value)
    return rows


def command_acquire(args: argparse.Namespace) -> int:
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    account_bundle = output / "account_bundle.json"
    if args.bundle is not None:
        source = sentinel.read_json(args.bundle.resolve())
        sentinel.write_json(account_bundle, source)
    else:
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        subprocess.run([
            sys.executable, str(TOOLKIT_ROOT / "scripts" / "data" / "oq_account_bundle.py"),
            "--account", args.account, "--mode", args.mode, "--output", str(account_bundle),
            "--timeout", "20", "--concurrency", "20", "--max-attempts", "3",
        ], cwd=TOOLKIT_ROOT, env=environment, check=True)
    bundle = sentinel.read_json(account_bundle)
    acquisition = bundle.get("acquisition") if isinstance(bundle.get("acquisition"), dict) else {}
    details = [
        row for row in bundle.get("details", [])
        if any(sentinel.account_key(player.get("id")) == sentinel.account_key(args.account) for player in row.get("players", []))
    ]
    listed_game_count = int(acquisition.get("listedGameCount") or len(bundle.get("index", [])))
    detail_fetched_count = int(acquisition.get("detailFetchedGameCount") or len(bundle.get("details", [])))
    detail_failure_ids = [str(value) for value in acquisition.get("detailFailureGameIds", []) if str(value)]
    requested_maximum = min(30, listed_game_count)
    excluded_short_game_ids = sorted(
        str(row.get("id") or "") for row in details if not is_investigation_eligible(row)
    )
    coverage_warning = acquisition.get("coverageWarning")
    if len(details) < listed_game_count:
        coverage_warning = (
            f"only {detail_fetched_count} of {listed_game_count} listed games have usable fetched details; "
            f"detail failures: {len(detail_failure_ids)}"
        )
    if len(details) > 0 and len(details) - len(excluded_short_game_ids) < requested_maximum:
        placement_warning = (
            f"selected {len(details) - len(excluded_short_game_ids)} of up to "
            f"{requested_maximum} listed games after requiring at least "
            f"{MINIMUM_ACTUAL_PLACEMENTS} actual placements"
        )
        coverage_warning = f"{coverage_warning}; {placement_warning}" if coverage_warning else placement_warning
    acquisition_report = {
        "schema": "player-sentinel-acquisition-report-v1",
        "createdAtUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "account": args.account,
        "listedGameCount": listed_game_count,
        "detailFetchedGameCount": detail_fetched_count,
        "detailFailureGameCount": len(detail_failure_ids),
        "detailFailureGameIds": detail_failure_ids,
        "usableDetailCountForAccount": len(details),
        **eligibility_contract(),
        "eligibleGameCount": len(details) - len(excluded_short_game_ids),
        "excludedShortGameCount": len(excluded_short_game_ids),
        "excludedShortGameIds": excluded_short_game_ids,
        "requestedMaximumGameCount": requested_maximum,
        "coverageStatus": "complete" if not coverage_warning else "partial",
        "coverageWarning": coverage_warning,
        "batchManifest": acquisition.get("batchManifest"),
        "sourceBundle": str(account_bundle.resolve()),
    }
    sentinel.write_json(
        output / "acquisition_report.json",
        acquisition_report,
        refuse_existing=args.bundle is not None,
    )
    if not details:
        raise ValueError(
            f"account bundle contains no usable game details for {args.account!r}; "
            f"see {output / 'acquisition_report.json'}"
        )
    eligible_details = [row for row in details if is_investigation_eligible(row)]
    if not eligible_details:
        raise ValueError(
            f"account bundle contains no games with at least {MINIMUM_ACTUAL_PLACEMENTS} "
            f"actual placements (reaching ply {FIRST_ELIGIBLE_DECISION_PLY}) for {args.account!r}; "
            f"see {output / 'acquisition_report.json'}"
        )
    selected_details = sorted(
        eligible_details,
        key=lambda row: (str(row.get("created") or ""), str(row.get("id") or "")),
        reverse=True,
    )[:30]
    selected_ids = {str(row.get("id") or "") for row in selected_details}
    selected = dict(bundle)
    selected["schema"] = "oq-account-bundle-sentinel-recent-v1"
    selected["selection"] = {
        "policy": "require at least 16 coordinate placements regardless of terminal status, then select most recent at most 30 by created then gameId",
        "maximumGameCount": 30,
        **eligibility_contract(),
        "sourceGameCount": len(details),
        "listedGameCount": listed_game_count,
        "detailFetchedGameCount": detail_fetched_count,
        "detailFailureGameCount": len(detail_failure_ids),
        "detailFailureGameIds": detail_failure_ids,
        "eligibleGameCount": len(eligible_details),
        "excludedShortGameCount": len(excluded_short_game_ids),
        "excludedShortGameIds": excluded_short_game_ids,
        "gameIds": [str(row.get("id") or "") for row in selected_details],
        "coverageStatus": "complete" if not coverage_warning else "partial",
        "coverageWarning": coverage_warning,
    }
    selected["details"] = selected_details
    selected["index"] = [row for row in bundle.get("index", []) if str(row.get("id") or "") in selected_ids]
    sentinel.write_json(output / "selected_account_bundle.json", selected)
    catalog = []
    metadata = []
    for detail in selected_details:
        black, white = sentinel._player_pair(detail)
        target_color = "black" if sentinel.account_key(black.get("id")) == sentinel.account_key(args.account) else "white"
        catalog.append({
            "gameId": str(detail.get("id") or ""), "created": detail.get("created"),
            "targetColor": target_color,
            "targetOldR": black.get("oldR") if target_color == "black" else white.get("oldR"),
            "opponentOldR": white.get("oldR") if target_color == "black" else black.get("oldR"),
            "actualPlacementCount": actual_placement_count(detail),
        })
        metadata.append({
            "game_id": str(detail.get("id") or ""), "created": str(detail.get("created") or ""),
            "black_id": str(black.get("id") or ""), "white_id": str(white.get("id") or ""),
        })
    sentinel.write_json(output / "game_catalog.json", {
        "schema": "player-investigation-game-catalog-v1", "account": args.account,
        **eligibility_contract(),
        "sourceGameCount": len(details),
        "excludedShortGameCount": len(excluded_short_game_ids),
        "excludedShortGameIds": excluded_short_game_ids,
        "gameCount": len(catalog), "games": catalog,
    })
    sentinel.write_csv(output / "games_metadata.csv", metadata)
    print(json.dumps({
        "account": args.account,
        "selectedGameCount": len(selected_details),
        "listedGameCount": listed_game_count,
        "detailFetchedGameCount": detail_fetched_count,
        "detailFailureGameCount": len(detail_failure_ids),
        "detailFailureGameIds": detail_failure_ids,
        **eligibility_contract(),
        "excludedShortGameCount": len(excluded_short_game_ids),
        "excludedShortGameIds": excluded_short_game_ids,
        "coverageStatus": "complete" if not coverage_warning else "partial",
        "coverageWarning": coverage_warning,
        "acquisitionReport": str((output / "acquisition_report.json").resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


def command_build(args: argparse.Namespace) -> int:
    audit = build_reference(args.reference_dir, args.output_dir)
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    return 0


def command_score(args: argparse.Namespace) -> int:
    target = sentinel.build_target_records(
        args.bundle.resolve(), args.engine_dir.resolve(), args.offbook_records.resolve(), args.account
    )
    reference = load_jsonl(args.reference_records.resolve())
    payload = sentinel.score_target_records(target, reference)
    sentinel.write_json(args.output_json, payload)
    sentinel.write_csv(args.output_csv, payload["scores"])
    print(json.dumps({
        "targetRecordCount": payload["targetRecordCount"],
        "calibratableGameCount": payload["calibratableGameCount"],
        "excludedReferenceGameCount": payload["excludedReferenceGameCount"],
    }, ensure_ascii=False, indent=2))
    return 0


def command_scan(args: argparse.Namespace) -> int:
    score_payload = sentinel.read_json(args.scores)
    reference = load_jsonl(args.reference_records.resolve())
    scan, replicates, summary = sentinel.run_pseudo_scan(
        score_payload, reference, replicates=args.replicates,
        bootstrap=args.bootstrap, seed=args.seed, workers=args.workers,
    )
    sentinel.write_csv(args.replicate_output, replicates)
    sentinel.write_json(args.summary_output, summary)
    sentinel.write_json(args.scan_output, scan)
    print(json.dumps({
        "classification": scan["classification"], "selectedK": scan["selectedK"],
        "reportedGameIds": scan["reportedGameIds"],
    }, ensure_ascii=False, indent=2))
    return 0


def command_freeze(args: argparse.Namespace) -> int:
    scan = sentinel.read_json(args.scan)
    scores = sentinel.read_json(args.scores)
    value = sentinel.selection_manifest(
        scan, scores,
        reference_config_path=args.reference_config.resolve(),
        reference_manifest_path=args.reference_manifest.resolve(),
        target_bundle_path=args.bundle.resolve(),
        level22_audit_path=args.level22_audit.resolve(),
        offbook_records_path=args.offbook_records.resolve(),
        seed=args.seed, pseudo_replicates=args.replicates,
        bootstrap_replicates=args.bootstrap,
    )
    sentinel.write_json(args.output, value)
    sentinel.write_json(args.model_groups_output, {
        "schema": "player-anomaly-sentinel-model-review-groups-v1",
        "classification": value["classification"],
        "reportedGameIds": value["reportedGameIds"],
        "statisticalControlGameIds": value["statisticalControlGameIds"],
        "modelControlGameIds": value["modelControlGameIds"],
        "modelReviewReady": value["modelReviewReady"],
        "selectionManifestPayloadSha256": value["payloadSha256"],
        "freezePolicy": value["freezePolicy"],
    })
    print(json.dumps({
        "classification": value["classification"],
        "reportedGameIds": value["reportedGameIds"],
        "modelReviewReady": value["modelReviewReady"],
    }, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser("acquire")
    acquire.add_argument("--account", required=True)
    acquire.add_argument("--mode", default="5min", choices=("5min",))
    acquire.add_argument("--bundle", type=Path)
    acquire.add_argument("--output-dir", type=Path, required=True)
    acquire.set_defaults(handler=command_acquire)

    build = commands.add_parser("build-reference")
    build.add_argument("--reference-dir", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.set_defaults(handler=command_build)

    score = commands.add_parser("score")
    score.add_argument("--bundle", type=Path, required=True)
    score.add_argument("--engine-dir", type=Path, required=True)
    score.add_argument("--offbook-records", type=Path, required=True)
    score.add_argument("--account", required=True)
    score.add_argument("--reference-records", type=Path, required=True)
    score.add_argument("--output-json", type=Path, required=True)
    score.add_argument("--output-csv", type=Path, required=True)
    score.set_defaults(handler=command_score)

    scan = commands.add_parser("scan")
    scan.add_argument("--scores", type=Path, required=True)
    scan.add_argument("--reference-records", type=Path, required=True)
    scan.add_argument("--replicate-output", type=Path, required=True)
    scan.add_argument("--summary-output", type=Path, required=True)
    scan.add_argument("--scan-output", type=Path, required=True)
    scan.add_argument("--replicates", type=int, default=sentinel.DEFAULT_REPLICATES)
    scan.add_argument("--bootstrap", type=int, default=sentinel.DEFAULT_BOOTSTRAP)
    scan.add_argument("--seed", type=int, default=sentinel.DEFAULT_SEED)
    scan.add_argument("--workers", type=int, default=1)
    scan.set_defaults(handler=command_scan)

    freeze = commands.add_parser("freeze")
    freeze.add_argument("--scan", type=Path, required=True)
    freeze.add_argument("--scores", type=Path, required=True)
    freeze.add_argument("--reference-config", type=Path, required=True)
    freeze.add_argument("--reference-manifest", type=Path, required=True)
    freeze.add_argument("--bundle", type=Path, required=True)
    freeze.add_argument("--level22-audit", type=Path, required=True)
    freeze.add_argument("--offbook-records", type=Path, required=True)
    freeze.add_argument("--output", type=Path, required=True)
    freeze.add_argument("--model-groups-output", type=Path, required=True)
    freeze.add_argument("--replicates", type=int, default=sentinel.DEFAULT_REPLICATES)
    freeze.add_argument("--bootstrap", type=int, default=sentinel.DEFAULT_BOOTSTRAP)
    freeze.add_argument("--seed", type=int, default=sentinel.DEFAULT_SEED)
    freeze.set_defaults(handler=command_freeze)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
