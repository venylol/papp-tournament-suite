#!/usr/bin/env python3
"""Resumable end-to-end Othello Quest player investigation orchestrator.

The main Agent selects the reported and control groups. After audited Level22
analysis, all off-book labels are assigned by the repository's deterministic
algorithm; no manual off-book review checkpoint is used.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np

TOOLKIT_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit.egaroucid_worker_budget import max_background_egaroucid_workers
from player_analysis_toolkit.investigation_eligibility import (
    FIRST_ELIGIBLE_DECISION_PLY,
    MINIMUM_ACTUAL_PLACEMENTS,
    actual_placement_count,
    eligibility_contract,
    validate_eligible_details,
)

try:
    import torch
except ModuleNotFoundError:
    torch = None


MODEL_ROOT = TOOLKIT_ROOT / "research" / "tcn_loss_model"
PROJECT_ROOT = TOOLKIT_ROOT.parent
# The source toolkit sits beside the PAPP checkout; the bundled toolkit sits
# under third_party inside the PAPP package.
PAPP_ROOT = (
    PROJECT_ROOT.parent
    if (PROJECT_ROOT.parent / "vendor").is_dir()
    else PROJECT_ROOT / "papp"
)
DEFAULT_ELO_V4_CONFIG = TOOLKIT_ROOT / "sentinel_elo_reference_config_v4_matchup600_20260911.json"
# Retain the historical symbol for callers that imported it; the formal
# default used by the lifecycle is explicitly v4 below.
DEFAULT_ELO_V3_CONFIG = TOOLKIT_ROOT / "sentinel_elo_reference_config_v3_20260829.json"
DEFAULT_ELO_CONFIG = DEFAULT_ELO_V4_CONFIG

SCHEMA_CONFIG = "player-investigation-run-config-v1"
SCHEMA_PROGRESS = "player-investigation-progress-v1"
WAITING_EXIT_CODE = 0
MINIMUM_MODEL_CONTROL_GAMES = 8
STAGE_ORDER = (
    "fetch_games",
    "select_groups",
    "fetch_profiles",
    "level22",
    "offbook_detection",
    "hint_source",
    "hint1",
    "hint6",
    "hint_assembly",
    "model_materialization",
    "profile_materialization",
    "adapt_models",
    "evaluate_reported",
    "non_model_statistics",
    "final_report",
)
SENTINEL_STAGE_ORDER = (
    "acquisition",
    "profile",
    "level22",
    "offbook_detection",
    "sentinel_reference_scoring",
    "sentinel_pseudo_scan",
    "sentinel_group_freeze",
    "sentinel_unified_analysis",
    "hint_source",
    "hint1",
    "hint6",
    "hint_assembly",
    "model_materialization",
    "profile_materialization",
    "adapt_models",
    "evaluate_reported",
    "non_model_statistics",
    "final_report",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    if path.is_file():
        return sha256_file(path)
    digest = hashlib.sha256()
    for item in sorted((candidate for candidate in path.rglob("*") if candidate.is_file()), key=str):
        digest.update(item.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(item).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def command_digest(command: list[str]) -> str:
    encoded = json.dumps(command, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label} not found: {resolved}")
    return resolved


def require_directory(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_dir():
        raise FileNotFoundError(f"{label} not found: {resolved}")
    return resolved


def validate_human_opening_book(path: Path) -> Path:
    resolved = require_file(path, "humanOpeningBook")
    try:
        payload = read_json(resolved)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(
            f"humanOpeningBook must be a UTF-8 JSON runtime book: {resolved}"
        ) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list) or not payload["nodes"]:
        raise ValueError(f"humanOpeningBook must contain a non-empty nodes array: {resolved}")
    return resolved


def default_paths() -> dict[str, str]:
    source_snapshot = (
        MODEL_ROOT
        / "data"
        / "oq_elo2000_5min_bilateral_10000_source_only_20260804"
        / "source_snapshot"
    )
    primary = read_json(MODEL_ROOT / "PRIMARY_MODEL.json")
    return {
        "python": str(Path(sys.executable).resolve()),
        "level22Python": str(Path(sys.executable).resolve()),
        "level22Runner": str((PROJECT_ROOT / "wechat-decrypt" / "agent_egaroucid_analysis.py").resolve()),
        "engine": str((
            PAPP_ROOT
            / "vendor"
            / "engines"
            / "Egaroucid_for_Console_7_8_1_Windows_SIMD"
            / "Egaroucid_for_Console_7_8_1_SIMD.exe"
        ).resolve()),
        "baseCheckpoint": str((MODEL_ROOT / primary["baseCheckpoint"]).resolve()),
        "ensembleManifest": str((MODEL_ROOT / primary["ensembleManifest"]).resolve()),
        "preprocessing": str((MODEL_ROOT / "provenance" / "source_snapshot" / "preprocessing.json").resolve()),
        # Keep this path short enough for the bundled Windows runtime.  The
        # historical nested snapshot path exceeds MAX_PATH on some machines
        # and Python then reports existing scripts as missing.
        "sourceResearch": str((TOOLKIT_ROOT / "official_research").resolve()),
        "humanOpeningBook": str((
            MODEL_ROOT / "provenance" / "source_snapshot" / "human-opening-book.json"
        ).resolve()),
        "profileNormalizationReferenceNpz": str((
            MODEL_ROOT
            / "outputs"
            / "oq_tcn_model_ready_11200_oq_profile_wld_ply39_20260808"
            / "model_ready_11200_oq_profile_wld_ply39.npz"
        ).resolve()),
        "personalConfig": str((MODEL_ROOT / "config" / "personal_finetune.json").resolve()),
    }


def initial_progress(
    account: str, run_dir: Path, stage_order: Iterable[str] = STAGE_ORDER
) -> dict[str, Any]:
    return {
        "schema": SCHEMA_PROGRESS,
        "account": account,
        "runDirectory": str(run_dir.resolve()),
        "status": "initialized",
        "currentStage": None,
        "createdAtUtc": utc_now(),
        "updatedAtUtc": utc_now(),
        "stages": {
            name: {"status": "pending", "updatedAtUtc": utc_now()}
            for name in stage_order
        },
    }


class Run:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir.resolve()
        self.config_path = self.run_dir / "run_config.json"
        self.progress_path = self.run_dir / "progress.json"
        self.config = read_json(self.config_path)
        self.progress = read_json(self.progress_path)
        if self.config.get("schema") != SCHEMA_CONFIG:
            raise ValueError("unsupported run_config.json schema")
        if self.progress.get("schema") != SCHEMA_PROGRESS:
            raise ValueError("unsupported progress.json schema")
        source_research = Path(self.config.get("paths", {}).get("sourceResearch", ""))
        short_source_research = TOOLKIT_ROOT / "official_research"
        if source_research != short_source_research and short_source_research.is_dir():
            self.config.setdefault("paths", {})["sourceResearch"] = str(short_source_research.resolve())
            self.save_config()
        parameters = self.config.setdefault("parameters", {})
        configured_device = str(parameters.get("device") or "cpu")
        if configured_device.startswith("cuda") and (torch is None or not torch.cuda.is_available()):
            parameters["device"] = "cpu"
            self.save_config()
        if self.config.get("mode") == "sentinel" and "sentinel_unified_analysis" not in self.progress.get("stages", {}):
            stages = dict(self.progress["stages"])
            migrated: dict[str, dict[str, Any]] = {}
            inserted = False
            for name, value in stages.items():
                migrated[name] = value
                if name == "sentinel_group_freeze":
                    migrated["sentinel_unified_analysis"] = {
                        "status": "pending",
                        "updatedAtUtc": utc_now(),
                        "migration": "added unified sentinel analysis stage",
                    }
                    inserted = True
            if not inserted:
                migrated["sentinel_unified_analysis"] = {
                    "status": "pending",
                    "updatedAtUtc": utc_now(),
                    "migration": "added unified sentinel analysis stage",
                }
            self.progress["stages"] = migrated

    def save_config(self) -> None:
        self.config["updatedAtUtc"] = utc_now()
        atomic_write_json(self.config_path, self.config)

    def save_progress(self) -> None:
        terminal = {"completed", "not_applicable"}
        completed = sum(
            stage.get("status") in terminal
            for stage in self.progress.get("stages", {}).values()
        )
        total = len(self.progress.get("stages", {}))
        self.progress["completedStages"] = completed
        self.progress["totalStages"] = total
        self.progress["percent"] = round(100.0 * completed / total, 2) if total else 0.0
        self.progress["updatedAtUtc"] = utc_now()
        atomic_write_json(self.progress_path, self.progress)

    def set_overall(self, status: str, current_stage: str | None) -> None:
        self.progress["status"] = status
        self.progress["currentStage"] = current_stage
        if status != "failed":
            self.progress.pop("lastError", None)
        self.save_progress()

    def set_stage(self, name: str, status: str, **details: Any) -> None:
        value = self.progress["stages"][name]
        value.update(details)
        value["status"] = status
        value["updatedAtUtc"] = utc_now()
        if status == "running":
            # Persist the orchestrator PID so a frontend restart can
            # distinguish an active child from a stale progress snapshot.
            self.progress["processId"] = os.getpid()
        self.progress["currentStage"] = name
        self.progress["status"] = "running" if status == "running" else self.progress["status"]
        self.save_progress()

    def path(self, name: str) -> Path:
        return self.run_dir / name

    def python(self) -> str:
        return str(self.config["paths"]["python"])

    def run_stage(
        self,
        name: str,
        command: list[str],
        outputs: Iterable[Path],
        *,
        cwd: Path = TOOLKIT_ROOT,
        nested_progress: Path | None = None,
        allow_completed_command_change: bool = False,
    ) -> None:
        output_list = [path.resolve() for path in outputs]
        digest = command_digest(command)
        existing = self.progress["stages"][name]
        if existing.get("status") == "completed":
            if not allow_completed_command_change and existing.get("commandSha256") != digest:
                raise ValueError(f"completed stage {name} command changed; create a new run directory")
            if not all(path.exists() for path in output_list):
                raise FileNotFoundError(f"completed stage {name} is missing an output")
            actual = {str(path): sha256_tree(path) for path in output_list}
            if actual != existing.get("outputSha256"):
                raise ValueError(f"completed stage {name} output hash changed")
            return
        self.set_stage(
            name,
            "running",
            command=command,
            commandSha256=digest,
            startedAtUtc=utc_now(),
            nestedProgress=str(nested_progress.resolve()) if nested_progress else None,
        )
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        completed = subprocess.run(command, cwd=cwd, env=environment, check=False)
        if completed.returncode != 0:
            self.set_stage(name, "failed", returnCode=completed.returncode, failedAtUtc=utc_now())
            self.set_overall("failed", name)
            raise subprocess.CalledProcessError(completed.returncode, command)
        missing = [str(path) for path in output_list if not path.exists()]
        if missing:
            self.set_stage(name, "failed", error=f"missing outputs: {missing}")
            self.set_overall("failed", name)
            raise FileNotFoundError(f"stage {name} did not create outputs: {missing}")
        self.set_stage(
            name,
            "completed",
            completedAtUtc=utc_now(),
            returnCode=0,
            outputs=[str(path) for path in output_list],
            outputSha256={str(path): sha256_tree(path) for path in output_list},
        )


def details(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    value = bundle.get("details")
    if not isinstance(value, list) or not value:
        raise ValueError("account bundle contains no game details")
    return value


def player_ids(detail: dict[str, Any]) -> tuple[str, str]:
    players = detail.get("players") or []
    if len(players) < 2:
        raise ValueError(f"game {detail.get('id')} has fewer than two players")
    return str(players[0].get("id") or ""), str(players[1].get("id") or "")


def account_game_details(bundle: dict[str, Any], account: str) -> list[dict[str, Any]]:
    target = account.casefold()
    return [
        detail for detail in details(bundle)
        if target in {player.casefold() for player in player_ids(detail)}
    ]


def game_result(detail: dict[str, Any], target_color: str) -> str:
    """Return the target player's W/D/L from the public game status."""
    status = str(detail.get("finalStatus") or "").strip()
    moves = (detail.get("position") or {}).get("moves") or []
    if not status and moves and isinstance(moves[-1], dict):
        status = str(moves[-1].get("s") or "").strip()

    upper_status = status.upper()
    if upper_status.startswith("SCORE:"):
        try:
            score = float(status.split(":", 1)[1].strip())
        except (TypeError, ValueError) as exc:
            raise ValueError(f"game {detail.get('id')} has an invalid score status: {status!r}") from exc
        if score == 0:
            return "draw"
        black_result = "win" if score > 0 else "loss"
        return black_result if target_color == "black" else ("loss" if black_result == "win" else "win")

    if upper_status.startswith("DRAW"):
        return "draw"

    if upper_status.startswith("LOSE:"):
        terminal_status_index = len(moves)
        for index in range(len(moves) - 1, -1, -1):
            item = moves[index]
            if isinstance(item, dict) and str(item.get("s") or "").strip().upper().startswith("LOSE:"):
                terminal_status_index = index
                break
        turns_before_loss = sum(
            1
            for item in moves[:terminal_status_index]
            if isinstance(item, dict) and str(item.get("m") or "").strip()
        )
        if terminal_status_index < len(moves):
            terminal_item = moves[terminal_status_index]
            if isinstance(terminal_item, dict) and str(terminal_item.get("m") or "").strip():
                turns_before_loss += 1
        losing_color = "black" if turns_before_loss % 2 == 0 else "white"
        return "loss" if target_color == losing_color else "win"

    # Game eligibility is intentionally independent of terminal status.  Keep
    # the catalog row selectable even when OQ has no recognized final result.
    return "unknown"


def game_catalog(bundle: dict[str, Any], account: str) -> list[dict[str, Any]]:
    rows = []
    target = account.casefold()
    for detail in sorted(account_game_details(bundle, account), key=lambda item: (str(item.get("created") or ""), str(item.get("id") or ""))):
        placement_count = actual_placement_count(detail)
        if placement_count < MINIMUM_ACTUAL_PLACEMENTS:
            continue
        players = detail.get("players") or []
        black, white = player_ids(detail)
        target_color = "black" if black.casefold() == target else "white"
        opponent = players[1] if target_color == "black" else players[0]
        rows.append({
            "gameId": str(detail.get("id") or ""),
            "created": detail.get("created"),
            "timeLimitMs": int(detail.get("tcb", 0) or 0),
            "targetColor": target_color,
            "opponentAccount": white if target_color == "black" else black,
            "opponentName": str(opponent.get("name") or opponent.get("id") or ""),
            "blackAccount": black,
            "whiteAccount": white,
            "result": game_result(detail, target_color),
            "sourceMoveCount": placement_count,
            "actualPlacementCount": placement_count,
        })
    if not rows:
        raise ValueError(
            f"bundle contains no games for account {account!r} with at least "
            f"{MINIMUM_ACTUAL_PLACEMENTS} actual placements (reaching ply "
            f"{FIRST_ELIGIBLE_DECISION_PLY})"
        )
    return rows


def write_games_metadata(path: Path, selected_details: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=("game_id", "created", "black_id", "white_id"))
        writer.writeheader()
        for detail in sorted(selected_details, key=lambda item: str(item.get("created") or "")):
            black, white = player_ids(detail)
            writer.writerow({
                "game_id": str(detail["id"]),
                "created": str(detail.get("created") or ""),
                "black_id": black,
                "white_id": white,
            })


def selected_bundle(source: dict[str, Any], selected_ids: set[str]) -> dict[str, Any]:
    selected_details = [item for item in details(source) if str(item.get("id") or "") in selected_ids]
    selected_index = [item for item in source.get("index", []) if str(item.get("id") or "") in selected_ids]
    result = dict(source)
    result["schema"] = "oq-account-bundle-selected-investigation-v1"
    result["selection"] = {
        "gameIds": sorted(selected_ids),
        "sourceBundleSchema": source.get("schema"),
        **eligibility_contract(),
    }
    result["details"] = selected_details
    result["index"] = selected_index
    return result


def create_run(args: argparse.Namespace) -> Run:
    run_dir = args.output_dir.resolve()
    if run_dir.exists() and any(run_dir.iterdir()):
        raise FileExistsError(f"run directory is not empty: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "schema": SCHEMA_CONFIG,
        "account": args.account,
        "mode": "sentinel" if args.command == "start-sentinel" else args.mode,
        "createdAtUtc": utc_now(),
        "updatedAtUtc": utc_now(),
        "reportedGameIds": [],
        "controlGameIds": [],
        "excludedGameIds": [],
        "parameters": {
            "bootstrapReplicates": args.bootstrap,
            "modelBootstrapReplicates": args.model_bootstrap,
            "bootstrapSeed": args.seed,
            "modelBootstrapSeed": args.model_seed,
            "effectiveTimeLimitMs": 300000,
            "profilePolicy": "retrospective-current-profile-trusted-temporal-leakage-v1",
            "device": args.device,
            "level22Threads": args.level22_threads,
            "level22Hash": args.level22_hash,
            "level22Workers": args.level22_workers or max_background_egaroucid_workers(),
            "hint1Workers": args.hint1_workers,
            "hint6Workers": args.hint6_workers,
            "hintHashLevel": 25,
            "featureWorkers": args.feature_workers,
        },
        "paths": default_paths(),
    }
    if args.command == "start-sentinel":
        config["referenceConfig"] = str(args.reference_config.resolve())
        config["eloReferenceConfig"] = str(args.elo_reference_config.resolve())
        config["sourceBundle"] = str(args.bundle.resolve()) if args.bundle else None
        config["parameters"]["oqMode"] = args.mode
        config["parameters"]["pseudoPlayerReplicates"] = args.pseudo_replicates
        config["parameters"]["pseudoScanWorkers"] = args.pseudo_workers
        config["parameters"]["sentinelBootstrapReplicates"] = args.sentinel_bootstrap
        config["parameters"]["sentinelSeed"] = args.sentinel_seed
    for key in (
        "engine", "level22_python", "level22_runner", "base_checkpoint",
        "ensemble_manifest", "profile_normalization_reference_npz",
    ):
        value = getattr(args, key, None)
        if value:
            config["paths"][{
                "level22_python": "level22Python",
                "level22_runner": "level22Runner",
                "base_checkpoint": "baseCheckpoint",
                "ensemble_manifest": "ensembleManifest",
                "profile_normalization_reference_npz": "profileNormalizationReferenceNpz",
            }.get(key, key)] = str(value.resolve())
    atomic_write_json(run_dir / "run_config.json", config)
    stage_order = SENTINEL_STAGE_ORDER if args.command == "start-sentinel" else STAGE_ORDER
    atomic_write_json(run_dir / "progress.json", initial_progress(args.account, run_dir, stage_order))
    return Run(run_dir)


def fetch_games(run: Run, source_bundle: Path | None = None) -> None:
    bundle_path = run.path("account_bundle.json")
    if source_bundle is not None:
        if bundle_path.exists():
            raise FileExistsError(bundle_path)
        source = read_json(require_file(source_bundle, "source account bundle"))
        atomic_write_json(bundle_path, source)
        run.set_stage(
            "fetch_games", "completed", source="provided-bundle", outputs=[str(bundle_path)],
            outputSha256={str(bundle_path.resolve()): sha256_file(bundle_path)}, completedAtUtc=utc_now(),
        )
    else:
        command = [
            run.python(), str(TOOLKIT_ROOT / "scripts" / "data" / "oq_account_bundle.py"),
            "--account", run.config["account"], "--mode", run.config["mode"],
            "--output", str(bundle_path), "--timeout", "20",
            "--concurrency", "20", "--max-attempts", "3",
        ]
        run.run_stage("fetch_games", command, [bundle_path])
    bundle = read_json(bundle_path)
    account_details = account_game_details(bundle, run.config["account"])
    excluded_short_game_ids = sorted(
        str(item.get("id") or "")
        for item in account_details
        if actual_placement_count(item) < MINIMUM_ACTUAL_PLACEMENTS
    )
    acquisition_report_path = run.path("acquisition_report.json")
    if not acquisition_report_path.is_file():
        acquisition = bundle.get("acquisition") if isinstance(bundle.get("acquisition"), dict) else {}
        listed_count = int(acquisition.get("listedGameCount") or len(bundle.get("index", [])))
        detail_count = int(acquisition.get("detailFetchedGameCount") or len(bundle.get("details", [])))
        failure_ids = [str(value) for value in acquisition.get("detailFailureGameIds", []) if str(value)]
        warning = None if detail_count >= listed_count else (
            f"only {detail_count} of {listed_count} listed games have usable details; "
            f"detail failures: {len(failure_ids)}"
        )
        atomic_write_json(acquisition_report_path, {
            "schema": "player-investigation-acquisition-report-v1",
            "createdAtUtc": utc_now(),
            "account": run.config["account"],
            "listedGameCount": listed_count,
            "detailFetchedGameCount": detail_count,
            "detailFailureGameCount": len(failure_ids),
            "detailFailureGameIds": failure_ids,
            **eligibility_contract(),
            "eligibleGameCount": len(account_details) - len(excluded_short_game_ids),
            "excludedShortGameCount": len(excluded_short_game_ids),
            "excludedShortGameIds": excluded_short_game_ids,
            "coverageStatus": "complete" if warning is None else "partial",
            "coverageWarning": warning,
            "source": "provided-bundle",
        })
    catalog = game_catalog(bundle, run.config["account"])
    atomic_write_json(run.path("game_catalog.json"), {
        "schema": "player-investigation-game-catalog-v1",
        "account": run.config["account"],
        **eligibility_contract(),
        "sourceGameCount": len(account_details),
        "excludedShortGameCount": len(excluded_short_game_ids),
        "excludedShortGameIds": excluded_short_game_ids,
        "gameCount": len(catalog),
        "games": catalog,
    })
    fetch_stage = run.progress["stages"]["fetch_games"]
    fetch_outputs = [
        bundle_path.resolve(), run.path("game_catalog.json").resolve(), acquisition_report_path.resolve(),
    ]
    fetch_stage["gameCount"] = len(catalog)
    fetch_stage["outputs"] = [str(path) for path in fetch_outputs]
    fetch_stage["outputSha256"] = {str(path): sha256_file(path) for path in fetch_outputs}
    run.save_progress()
    run.set_stage("select_groups", "awaiting_agent", instructions={
        "catalog": str(run.path("game_catalog.json")),
        "commands": [
            "select-groups --run-dir ... --reported-game-id ID --control-game-id ID",
            "select-groups --run-dir ... --reported-from ISO8601 --reported-to ISO8601",
        ],
        "policy": (
            "Only games with at least 16 actual placements (reaching ply 17) are eligible. "
            "Both groups must be non-empty and disjoint. Explicit selection excludes unselected games; "
            "time-range selection reports every eligible game in the inclusive created-time range and controls "
            "every other eligible game."
        ),
    })
    run.set_overall("awaiting_group_selection", "select_groups")


def parse_aware_datetime(value: str, label: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must include Z or an explicit UTC offset")
    return parsed.astimezone(timezone.utc)


def groups_from_time_range(run: Run, start: str, stop: str) -> tuple[list[str], list[str], dict[str, Any]]:
    lower = parse_aware_datetime(start, "--reported-from")
    upper = parse_aware_datetime(stop, "--reported-to")
    if lower > upper:
        raise ValueError("--reported-from must not be later than --reported-to")
    catalog = read_json(run.path("game_catalog.json"))["games"]
    reported, control = [], []
    for game in catalog:
        created = parse_aware_datetime(str(game.get("created") or ""), f"game {game['gameId']} created")
        (reported if lower <= created <= upper else control).append(str(game["gameId"]))
    return reported, control, {
        "method": "inclusive-created-time-range",
        "reportedFrom": lower.isoformat().replace("+00:00", "Z"),
        "reportedTo": upper.isoformat().replace("+00:00", "Z"),
        "boundaryPolicy": "reportedFrom <= game.created <= reportedTo",
        "sourceTimeField": "created",
    }


def validate_group_placements(bundle: dict[str, Any], selected_ids: set[str]) -> None:
    validate_eligible_details(
        (item for item in details(bundle) if str(item.get("id") or "") in selected_ids),
        label="reported and control games",
    )


def select_groups(
    run: Run,
    reported: list[str],
    control: list[str],
    selection: dict[str, Any] | None = None,
) -> None:
    reported_ids, control_ids = set(reported), set(control)
    if not reported_ids or not control_ids:
        raise ValueError("reported and control groups must both be non-empty")
    if len(control_ids) < MINIMUM_MODEL_CONTROL_GAMES:
        raise ValueError(
            f"样本不足：模型分析至少需要 {MINIMUM_MODEL_CONTROL_GAMES} 局合格对照局，"
            f"当前只有 {len(control_ids)} 局"
        )
    overlap = sorted(reported_ids & control_ids)
    if overlap:
        raise ValueError(f"reported/control groups overlap: {overlap}")
    previous = run.progress["stages"]["select_groups"]
    retryable_failed_selection = (
        run.progress.get("status") == "failed"
        and run.progress.get("currentStage") in {"select_groups", "fetch_profiles"}
    )
    if previous.get("status") == "completed" and not retryable_failed_selection:
        same = (
            sorted(reported_ids) == previous.get("reportedGameIds")
            and sorted(control_ids) == previous.get("controlGameIds")
        )
        if same:
            return
        raise ValueError("groups are already frozen; create a new run directory to change them")
    source = read_json(run.path("account_bundle.json"))
    available = {str(item.get("id") or "") for item in details(source)}
    missing = sorted((reported_ids | control_ids) - available)
    if missing:
        raise ValueError(f"selected game IDs are absent from account bundle: {missing}")
    selected_ids = reported_ids | control_ids
    validate_group_placements(source, selected_ids)
    filtered = selected_bundle(source, selected_ids)
    filtered_path = run.path("selected_account_bundle.json")
    atomic_write_json(filtered_path, filtered)
    write_games_metadata(run.path("games_metadata.csv"), details(filtered))
    run.config["reportedGameIds"] = sorted(reported_ids)
    run.config["controlGameIds"] = sorted(control_ids)
    run.config["excludedGameIds"] = sorted(available - selected_ids)
    run.config["groupSelection"] = selection or {
        "method": "explicit-game-ids",
        "reportedGameIds": sorted(reported_ids),
        "controlGameIds": sorted(control_ids),
    }
    run.save_config()
    run.set_stage(
        "select_groups", "completed", reportedGameIds=sorted(reported_ids),
        controlGameIds=sorted(control_ids), excludedGameIds=sorted(available - selected_ids),
        selection=run.config["groupSelection"],
        outputs=[str(filtered_path), str(run.path("games_metadata.csv"))],
        outputSha256={
            str(filtered_path.resolve()): sha256_file(filtered_path),
            str(run.path("games_metadata.csv").resolve()): sha256_file(run.path("games_metadata.csv")),
        },
        completedAtUtc=utc_now(),
    )
    run.set_overall("ready", "fetch_profiles")


def selected_accounts(run: Run) -> list[str]:
    bundle = read_json(run.path("selected_account_bundle.json"))
    accounts = {value for item in details(bundle) for value in player_ids(item) if value}
    return sorted(accounts, key=str.casefold)


def resumable_attempt_directory(run: Run, config_key: str, preferred_name: str, stage: str) -> Path:
    runtime = run.config.setdefault("runtimePaths", {})
    if config_key in runtime:
        current = Path(runtime[config_key])
        if run.progress["stages"][stage].get("status") != "failed":
            return current
        if not current.exists():
            return current
    else:
        current = run.path(preferred_name)
        if not current.exists():
            runtime[config_key] = str(current)
            run.save_config()
            return current
    index = 2
    while True:
        candidate = run.path(f"{preferred_name}_attempt_{index}")
        if not candidate.exists():
            runtime[config_key] = str(candidate)
            run.save_config()
            return candidate
        index += 1


def run_pre_model_stages(run: Run) -> None:
    if not run.config.get("reportedGameIds") or not run.config.get("controlGameIds"):
        run.set_overall("awaiting_group_selection", "select_groups")
        raise RuntimeError("explicit groups have not been selected")
    paths, parameters = run.config["paths"], run.config["parameters"]
    selected = run.path("selected_account_bundle.json")

    profiles = run.path("profiles")
    profile_command = [
        run.python(), str(MODEL_ROOT / "scripts" / "data" / "fetch_oq_player_profiles.py"),
        "fetch", "--output-dir", str(profiles), "--concurrency", "1", "--resume", "--allow-failures",
    ]
    for account in selected_accounts(run):
        profile_command.extend(["--account", account])
    # Profile fetching gained --allow-failures after older runs were created.
    # Their completed profile output remains valid; permit that command-line
    # migration so resume does not brick the run before Level22 can continue.
    run.run_stage(
        "fetch_profiles", profile_command, [profiles],
        allow_completed_command_change=True,
    )

    engine_dir = run.path("engine_level22")
    # Normalize stale task configs to the current machine memory budget.
    worker_budget = max_background_egaroucid_workers()
    configured_workers = int(parameters.get("level22Workers") or worker_budget)
    if configured_workers > worker_budget:
        parameters["level22Workers"] = worker_budget
        run.config["parameters"] = parameters
        run.save_config()
    level_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "data" / "run_egaroucid_bundle.py"),
        "--bundle", str(selected), "--output-dir", str(engine_dir),
        "--runner", paths["level22Runner"], "--python", paths["level22Python"],
        "--engine", paths["engine"], "--level", "22",
        "--threads", str(parameters["level22Threads"]), "--hash", str(parameters["level22Hash"]),
        "--workers", str(parameters["level22Workers"]), "--background",
        "--wld-from-ply", "39", "--resume",
    ]
    run.run_stage("level22", level_command, [engine_dir], nested_progress=engine_dir / "progress.json")

    records = run.path("offbook_records.json")
    detection_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "detect_offbook.py"),
        "--engine-directory", str(engine_dir),
        "--bundle", str(selected),
        "--account", run.config["account"],
        "--output", str(records),
    ]
    run.run_stage("offbook_detection", detection_command, [records])

    run_safe_hints(run)
    run.set_overall("ready", "model_materialization")


def resolved_sentinel_reference(run: Run) -> dict[str, Path | dict[str, Any]]:
    config_path = require_file(Path(run.config["referenceConfig"]), "sentinel reference config")
    config = read_json(config_path)
    if config.get("schema") != "player-anomaly-sentinel-reference-config-v1":
        raise ValueError("unsupported sentinel reference config schema")
    base = config_path.parent

    def resolve(key: str) -> Path:
        raw = Path(str(config[key]))
        return raw.resolve() if raw.is_absolute() else (base / raw).resolve()

    records = require_file(resolve("directedTargetRecords"), "sentinel directed target records")
    manifest = require_file(resolve("referenceManifest"), "sentinel reference manifest")
    derived = require_directory(resolve("derivedDirectory"), "sentinel derived reference")
    manifest_value = read_json(manifest)
    for item in manifest_value.get("files", []):
        path = derived / str(item["path"])
        if not path.is_file() or sha256_file(path) != item.get("sha256"):
            raise ValueError(f"sentinel Reference manifest mismatch: {path}")
    audit = read_json(derived / "reference_build_audit.json")
    if audit.get("ok") is not True:
        raise ValueError("sentinel derived Reference audit is not successful")
    return {
        "config": config,
        "configPath": config_path,
        "records": records,
        "manifest": manifest,
        "derived": derived,
    }


def run_sentinel_pre_scan_stages(run: Run) -> None:
    paths, parameters = run.config["paths"], run.config["parameters"]
    acquisition = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "sentinel_unified_analysis.py"),
        "acquire", "--account", run.config["account"],
        "--mode", str(parameters["oqMode"]), "--output-dir", str(run.run_dir),
    ]
    source_bundle = run.config.get("sourceBundle")
    if source_bundle:
        acquisition.extend(["--bundle", str(source_bundle)])
    run.run_stage("acquisition", acquisition, [
        run.path("account_bundle.json"), run.path("selected_account_bundle.json"),
        run.path("game_catalog.json"), run.path("games_metadata.csv"),
        run.path("acquisition_report.json"),
    ])

    selected = run.path("selected_account_bundle.json")
    selected_value = read_json(selected)
    validate_eligible_details(
        details(selected_value),
        label="Sentinel investigation games",
    )
    elo_config_path = require_file(
        Path(run.config.get("eloReferenceConfig", DEFAULT_ELO_CONFIG)),
        "Sentinel Elo reference config",
    )
    minimum_games = int(read_json(elo_config_path)["minimumTargetGames"])
    selected_game_count = len(details(selected_value))
    if selected_game_count < minimum_games:
        raise ValueError(
            f"样本不足：Sentinel 正式分析至少需要 {minimum_games} 局合格棋局，"
            f"按每局至少 {MINIMUM_ACTUAL_PLACEMENTS} 个坐标落子筛选后只有 "
            f"{selected_game_count} 局"
        )
    profiles = run.path("profiles")
    profile_command = [
        run.python(), str(MODEL_ROOT / "scripts" / "data" / "fetch_oq_player_profiles.py"),
        "fetch", "--output-dir", str(profiles), "--concurrency", "1", "--resume",
        "--allow-failures",
    ]
    for account in selected_accounts(run):
        profile_command.extend(["--account", account])
    run.run_stage("profile", profile_command, [profiles])

    engine_dir = run.path("engine_level22")
    level_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "data" / "run_egaroucid_bundle.py"),
        "--bundle", str(selected), "--output-dir", str(engine_dir),
        "--runner", paths["level22Runner"], "--python", paths["level22Python"],
        "--engine", paths["engine"], "--level", "22",
        "--threads", str(parameters["level22Threads"]), "--hash", str(parameters["level22Hash"]),
        "--workers", str(parameters["level22Workers"]), "--background",
        "--wld-from-ply", "39", "--resume",
    ]
    run.run_stage("level22", level_command, [engine_dir], nested_progress=engine_dir / "progress.json")
    records = run.path("offbook_records.json")
    detection_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "detect_offbook.py"),
        "--engine-directory", str(engine_dir), "--bundle", str(selected),
        "--account", run.config["account"],
        "--output", str(records),
    ]
    run.run_stage("offbook_detection", detection_command, [records])


def run_sentinel_scan_stages(run: Run) -> dict[str, Any]:
    reference = resolved_sentinel_reference(run)
    parameters = run.config["parameters"]
    script = TOOLKIT_ROOT / "scripts" / "analysis" / "sentinel_unified_analysis.py"
    score_json = run.path("per_game_reference_scores.json")
    score_csv = run.path("per_game_reference_scores.csv")
    score_command = [
        run.python(), str(script), "score",
        "--bundle", str(run.path("selected_account_bundle.json")),
        "--engine-dir", str(run.path("engine_level22")),
        "--offbook-records", str(run.path("offbook_records.json")),
        "--account", run.config["account"],
        "--reference-records", str(reference["records"]),
        "--output-json", str(score_json), "--output-csv", str(score_csv),
    ]
    run.run_stage("sentinel_reference_scoring", score_command, [score_json, score_csv])

    replicate_csv = run.path("pseudo_scan_replicates.csv")
    pseudo_summary = run.path("pseudo_scan_summary.json")
    scan_json = run.path("sentinel_scan_results.json")
    scan_command = [
        run.python(), str(script), "scan", "--scores", str(score_json),
        "--reference-records", str(reference["records"]),
        "--replicate-output", str(replicate_csv),
        "--summary-output", str(pseudo_summary), "--scan-output", str(scan_json),
        "--replicates", str(parameters["pseudoPlayerReplicates"]),
        "--bootstrap", str(parameters["sentinelBootstrapReplicates"]),
        "--seed", str(parameters["sentinelSeed"]),
        "--workers", str(parameters.get("pseudoScanWorkers", 1)),
    ]
    run.run_stage("sentinel_pseudo_scan", scan_command, [replicate_csv, pseudo_summary, scan_json])

    selection = run.path("selection_manifest.json")
    model_groups = run.path("model_review_groups.json")
    freeze_command = [
        run.python(), str(script), "freeze", "--scan", str(scan_json), "--scores", str(score_json),
        "--reference-config", str(reference["configPath"]),
        "--reference-manifest", str(reference["manifest"]),
        "--bundle", str(run.path("selected_account_bundle.json")),
        "--level22-audit", str(run.path("engine_level22") / "audit.json"),
        "--offbook-records", str(run.path("offbook_records.json")),
        "--output", str(selection), "--model-groups-output", str(model_groups),
        "--replicates", str(parameters["pseudoPlayerReplicates"]),
        "--bootstrap", str(parameters["sentinelBootstrapReplicates"]),
        "--seed", str(parameters["sentinelSeed"]),
    ]
    run.run_stage("sentinel_group_freeze", freeze_command, [selection, model_groups])
    frozen = read_json(selection)
    if frozen["reportedGameIds"] and len(frozen["modelControlGameIds"]) < MINIMUM_MODEL_CONTROL_GAMES:
        raise ValueError(
            f"样本不足：模型复核至少需要 {MINIMUM_MODEL_CONTROL_GAMES} 局合格对照局，"
            f"Sentinel 分组后只有 {len(frozen['modelControlGameIds'])} 局"
        )
    run.config["reportedGameIds"] = list(frozen["reportedGameIds"])
    run.config["controlGameIds"] = list(frozen["modelControlGameIds"])
    run.config["excludedGameIds"] = []
    run.config["groupSelection"] = {
        "method": "sentinel-v1-frozen-statistical-scan",
        "selectionManifest": str(selection.resolve()),
        "selectionManifestPayloadSha256": frozen["payloadSha256"],
    }
    run.save_config()
    return frozen


def run_sentinel_unified_analysis(run: Run) -> None:
    output = run.path("sentinel_unified_analysis.json")
    elo_config = Path(run.config.get(
        "eloReferenceConfig", DEFAULT_ELO_CONFIG
    )).resolve()
    command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "sentinel_unified_analysis.py"),
        "run",
        "--account", run.config["account"],
        "--bundle", str(run.path("selected_account_bundle.json")),
        "--engine-dir", str(run.path("engine_level22")),
        "--offbook-records", str(run.path("offbook_records.json")),
        "--elo-reference-config", str(elo_config),
        "--output-dir", str(run.run_dir),
    ]
    run.run_stage(
        "sentinel_unified_analysis",
        command,
        [
            output,
            run.path("estimated_elo"),
            run.path("player_phase_analysis.json"),
            run.path("player_phase_analysis.csv"),
        ],
    )
    estimated_elo = read_json(run.path("estimated_elo") / "estimated_elo.json")
    if estimated_elo.get("status") == "insufficient_target_games":
        selected_count = int(estimated_elo.get("selectedGameCount") or 0)
        minimum_count = int(estimated_elo.get("formalMinimumGameCount") or 10)
        raise ValueError(
            f"样本不足：Sentinel 正式 Elo 至少需要 {minimum_count} 局可用棋局，"
            f"当前只有 {selected_count} 局"
        )


def set_stages_not_applicable(run: Run, stages: Iterable[str], reason: str) -> None:
    for stage in stages:
        if run.progress["stages"][stage].get("status") not in {"completed", "not_applicable"}:
            run.set_stage(stage, "not_applicable", reason=reason)


def run_non_model_statistics(run: Run) -> None:
    paths, parameters = run.config["paths"], run.config["parameters"]
    del paths
    selected = run.path("selected_account_bundle.json")
    analysis_dir = run.path("non_model")
    analysis_dir.mkdir(parents=True, exist_ok=True)
    analysis_config = {
        "outputDirectory": str(analysis_dir), "bundle": str(selected),
        "engineDirectory": str(run.path("engine_level22")), "account": run.config["account"],
        "reportedGameIds": run.config["reportedGameIds"],
        "bootstrap": parameters["bootstrapReplicates"],
        "modelBootstrap": parameters["modelBootstrapReplicates"],
        "seed": parameters["bootstrapSeed"], "wldFromPly": 39,
    }
    analysis_config_path = run.path("non_model_analysis_config.json")
    if not analysis_config_path.exists():
        atomic_write_json(analysis_config_path, analysis_config)
    elif read_json(analysis_config_path) != analysis_config:
        raise ValueError("non-model analysis config changed after it was materialized")
    non_model_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "player_analysis.py"),
        "run-all", "--config", str(analysis_config_path),
    ]
    run.run_stage("non_model_statistics", non_model_command, [analysis_dir])


def build_sentinel_report_without_model(run: Run) -> None:
    selection = read_json(run.path("selection_manifest.json"))
    non_model = run.path("non_model")
    report = {
        "schema": "player-anomaly-sentinel-report-v1",
        "status": "completed",
        "generatedAtUtc": utc_now(),
        "account": run.config["account"],
        "acquisition": read_json(run.path("acquisition_report.json")),
        "classification": selection["classification"],
        "selection": selection,
        "perGameReferenceScores": read_json(run.path("per_game_reference_scores.json")),
        "sentinelScan": read_json(run.path("sentinel_scan_results.json")),
        "pseudoScanSummary": read_json(run.path("pseudo_scan_summary.json")),
        "estimatedElo": read_json(run.path("estimated_elo") / "estimated_elo.json"),
        "playerPhaseAnalysis": read_json(run.path("player_phase_analysis.json")),
        "playerPhaseAnalysisArtifacts": {
            "json": artifact_entry(run.path("player_phase_analysis.json")),
            "csv": artifact_entry(run.path("player_phase_analysis.csv")),
        },
        "unifiedSentinelAnalysis": read_json(run.path("sentinel_unified_analysis.json")),
        "model": {
            "modelReviewReady": selection["modelReviewReady"],
            "status": "not_run",
            "reason": "No formal reported group, or fewer than eight model control games.",
        },
        "nonModel": {
            "lossAndWld": read_json(non_model / "loss-analysis.json") if (non_model / "loss-analysis.json").is_file() else None,
            "thinkingTime": read_json(non_model / "time-analysis.json") if (non_model / "time-analysis.json").is_file() else None,
        },
        "limitations": [
            "Normal exceedance rates and intervals are not cheating probabilities.",
            "WLD is a secondary metric and cannot create or replace a GE4-selected reported group.",
            "Model output, when present, cannot modify the frozen selection manifest.",
        ],
    }
    atomic_write_json(run.path("report.json"), report)
    run.set_stage(
        "final_report", "completed", outputs=[str(run.path("report.json"))],
        outputSha256={str(run.path("report.json").resolve()): sha256_file(run.path("report.json"))},
        completedAtUtc=utc_now(),
    )
    run.set_overall("completed", None)


def run_sentinel(run: Run) -> None:
    run_sentinel_pre_scan_stages(run)
    frozen = run_sentinel_scan_stages(run)
    run_sentinel_unified_analysis(run)
    conditional_model_stages = (
        "hint_source", "hint1", "hint6", "hint_assembly", "model_materialization",
        "profile_materialization", "adapt_models", "evaluate_reported",
    )
    if frozen["reportedGameIds"] and frozen["modelReviewReady"]:
        validate_paths(run.config)
        run_safe_hints(run)
        run_model_and_report_stages(run)
        return
    reason = (
        "Sentinel classification produced no formal reported game IDs."
        if not frozen["reportedGameIds"]
        else "Fewer than eight model control games; personal adaptation is not review-ready."
    )
    set_stages_not_applicable(run, conditional_model_stages, reason)
    if frozen["reportedGameIds"]:
        run_non_model_statistics(run)
    else:
        set_stages_not_applicable(run, ("non_model_statistics",), reason)
    build_sentinel_report_without_model(run)


def hint_source_game_count(source_csv: Path, bundle_path: Path) -> int:
    """Require the hint source to cover every eligible selected game."""
    bundle = read_json(bundle_path)
    validate_eligible_details(bundle["details"], label="selected hint-source games")
    expected_ids = {str(item["id"]) for item in bundle["details"]}
    with source_csv.open("r", encoding="utf-8", newline="") as handle:
        actual_ids = {row["game_id"] for row in csv.DictReader(handle)}
    if actual_ids != expected_ids:
        raise ValueError(
            f"hint source game IDs mismatch: missing={sorted(expected_ids - actual_ids)} "
            f"unexpected={sorted(actual_ids - expected_ids)}"
        )
    if not actual_ids:
        raise ValueError("selected games contain no transcript moves for hint analysis")
    return len(actual_ids)


def run_safe_hints(run: Run) -> None:
    paths, parameters = run.config["paths"], run.config["parameters"]
    selected = run.path("selected_account_bundle.json")
    hint_source = run.path("hint_source")
    source_command = [
        run.python(), str(MODEL_ROOT / "scripts" / "data" / "build_personal_hint_source_from_bundle.py"),
        "--account-bundle", str(selected), "--target-player", run.config["account"],
        "--analyzer-module", str(TOOLKIT_ROOT / "scripts" / "data" / "pass_aware_othello_board.py"),
        "--output-dir", str(hint_source),
    ]
    for game_id in run.config["reportedGameIds"]:
        source_command.extend(["--reported-game", game_id])
    run.run_stage(
        "hint_source", source_command,
        [hint_source],
    )
    shape = read_json(hint_source / "source_manifest.json")["shape"]
    source_csv = hint_source / "raw_nodes_with_pass.csv"
    expected_games = hint_source_game_count(source_csv, selected)
    safe_runner = MODEL_ROOT / "scripts" / "pipeline" / "safe_recompute_egaroucid_hints.py"
    safe_stage_runner = TOOLKIT_ROOT / "scripts" / "data" / "run_safe_hint_stage.py"
    hints = run.path("hints")

    def run_hint(stage: str, workers: int, batch_size: int, timeout: int) -> None:
        output = hints / stage
        command = [
            run.python(), str(safe_stage_runner), "--runner", str(safe_runner),
            "--source-csv", str(source_csv),
            "--stage", stage, "--engine", paths["engine"], "--output-dir", str(output),
            "--workers", str(workers), "--hash-level", str(parameters["hintHashLevel"]),
            "--batch-size", str(batch_size), "--timeout", str(timeout), "--max-attempts", "2",
            "--expected", str(shape["placements"]), "--resume",
        ]
        run.run_stage(stage, command, [output], nested_progress=output / "progress.json")

    run_hint("hint1", int(parameters["hint1Workers"]), 64, 60)
    run_hint("hint6", int(parameters["hint6Workers"]), 128, 900)

    assembled = hints / "assembled_nodes.csv"
    assembly_manifest = hints / "assembly_manifest.json"
    assembly_command = [
        run.python(), str(MODEL_ROOT / "scripts" / "pipeline" / "assemble_safe_hint_recompute.py"),
        "--source-csv", str(source_csv), "--hint1-dir", str(hints / "hint1"),
        "--hint6-dir", str(hints / "hint6"), "--output-csv", str(assembled),
        "--output-manifest", str(assembly_manifest), "--merge-index", str(hints / "merge_index.sqlite3"),
        "--expected-rows", str(shape["rows"]), "--expected-placements", str(shape["placements"]),
        "--expected-passes", str(shape["passes"]), "--expected-games", str(expected_games),
    ]
    run.run_stage("hint_assembly", assembly_command, [assembled, assembly_manifest, hints / "merge_index.sqlite3"])


def offbook_map(run: Run) -> tuple[dict[str, int], list[str]]:
    records = read_json(run.path("offbook_records.json"))["records"]
    reported = set(run.config["reportedGameIds"])
    anchors = {
        str(row["gameId"]): int(row["offBookPly"])
        for row in records
        if row["gameId"] in reported and row["judgment"] == "offbook"
    }
    no_anchor = sorted(reported - set(anchors))
    return anchors, no_anchor


def run_model_and_report_stages(run: Run) -> None:
    validate_group_placements(
        read_json(run.path("selected_account_bundle.json")),
        set(run.config["reportedGameIds"]) | set(run.config["controlGameIds"]),
    )
    if not run.path("offbook_records.json").is_file():
        raise RuntimeError("algorithmic off-book records are required")
    paths, parameters = run.config["paths"], run.config["parameters"]
    anchors, no_anchor = offbook_map(run)
    selected = run.path("selected_account_bundle.json")
    model_base = resumable_attempt_directory(
        run, "modelBaseDirectory", "model_data_base", "model_materialization"
    )
    materialize = [
        run.python(), str(MODEL_ROOT / "scripts" / "data" / "materialize_personal_oq_tcn_model_ready.py"),
        "--account-bundle", str(selected), "--target-player", run.config["account"],
        "--output-dir", str(model_base), "--base-checkpoint", paths["baseCheckpoint"],
        "--preprocessing", paths["preprocessing"], "--source-research", paths["sourceResearch"],
        "--human-opening-book", paths["humanOpeningBook"],
        "--safe-assembled-raw", str(run.path("hints") / "assembled_nodes.csv"),
        "--safe-assembly-manifest", str(run.path("hints") / "assembly_manifest.json"),
        "--feature-workers", str(parameters["featureWorkers"]),
    ]
    for game_id in run.config["reportedGameIds"]:
        materialize.extend(["--reported-game", game_id])
    run.run_stage(
        "model_materialization", materialize,
        [model_base / "personal_model_ready.npz", model_base / "personal_model_ready_manifest.json"],
    )

    profile_dir = resumable_attempt_directory(
        run, "profileModelDirectory", "model_data_profile", "profile_materialization"
    )
    profile_name = "personal_model_ready_profile.npz"
    profile_command = [
        run.python(), str(MODEL_ROOT / "scripts" / "data" / "materialize_oq_profile_context.py"),
        "--input-npz", str(model_base / "personal_model_ready.npz"),
        "--games", str(run.path("hint_source") / "games.csv"), "--snapshots-dir", str(run.path("profiles")),
        "--output-dir", str(profile_dir), "--output-name", profile_name,
        "--policy", parameters["profilePolicy"], "--allow-temporal-leakage",
        "--normalization-reference-npz", paths["profileNormalizationReferenceNpz"],
    ]
    profile_npz = profile_dir / profile_name
    run.run_stage(
        "profile_materialization", profile_command,
        [profile_dir],
    )

    adapters = run.path("model") / "adapters"
    adapt_command = [
        run.python(), str(MODEL_ROOT / "train.py"), "personalize-ensemble",
        "--data", str(profile_npz), "--ensemble-manifest", paths["ensembleManifest"],
        "--base-checkpoint", paths["baseCheckpoint"], "--config", paths["personalConfig"],
        "--output-dir", str(adapters),
    ]
    run.run_stage(
        "adapt_models", adapt_command, [adapters],
        cwd=MODEL_ROOT, nested_progress=adapters / "personal_ensemble_progress.json",
    )

    evaluation_dir = run.path("model") / "evaluation"
    eligible = sorted(anchors)
    if run.config["reportedGameIds"]:
        evaluation = [
            run.python(), str(MODEL_ROOT / "scripts" / "modeling" / "evaluate_personal_tcn_ensemble.py"),
            "--data", str(profile_npz),
            "--personal-ensemble-manifest", str(adapters / "personal_ensemble_manifest.json"),
            "--base-checkpoint", paths["baseCheckpoint"],
            "--node-output", str(evaluation_dir / "reported_node_predictions.csv"),
            "--summary-output", str(evaluation_dir / "reported_bootstrap_summary.json"),
            "--control-calibration-output", str(evaluation_dir / "control_adaptation_calibration.json"),
            "--bootstrap-replicates", str(parameters["bootstrapReplicates"]),
            "--bootstrap-seed", str(parameters["modelBootstrapSeed"]),
            "--device", parameters["device"],
        ]
        for game_id in run.config["reportedGameIds"]:
            evaluation.extend(["--reported-game", game_id])
        run.run_stage(
            "evaluate_reported", evaluation,
            [evaluation_dir],
        )
        run.progress["stages"]["evaluate_reported"]["modelEligibleReportedGameIds"] = sorted(run.config["reportedGameIds"])
        run.progress["stages"]["evaluate_reported"]["fullGameFallbackNoOffbookGameIds"] = no_anchor
        run.progress["stages"]["evaluate_reported"]["excludedNoOffbookGameIds"] = []
        run.save_progress()
    else:
        run.set_stage(
            "evaluate_reported", "not_applicable", modelEligibleReportedGameIds=[],
            excludedNoOffbookGameIds=no_anchor,
            reason="No reported game received a defensible off-book anchor; model evaluation was not fabricated.",
        )

    analysis_dir = run.path("non_model")
    analysis_dir.mkdir(parents=True, exist_ok=True)
    analysis_config = {
        "outputDirectory": str(analysis_dir), "bundle": str(selected),
        "engineDirectory": str(run.path("engine_level22")), "account": run.config["account"],
        "reportedGameIds": run.config["reportedGameIds"],
        "bootstrap": parameters["bootstrapReplicates"],
        "modelBootstrap": parameters["modelBootstrapReplicates"],
        "seed": parameters["bootstrapSeed"], "wldFromPly": 39,
    }
    analysis_config_path = run.path("non_model_analysis_config.json")
    atomic_write_json(analysis_config_path, analysis_config)
    non_model_command = [
        run.python(), str(TOOLKIT_ROOT / "scripts" / "analysis" / "player_analysis.py"),
        "run-all", "--config", str(analysis_config_path),
    ]
    run.run_stage(
        "non_model_statistics", non_model_command,
        [analysis_dir],
    )
    build_final_report(run, anchors, no_anchor)


def artifact_entry(path: Path) -> dict[str, Any]:
    return {"path": str(path.resolve()), "sha256": sha256_tree(path)}


def level18_tcn_feature_summary(profile_npz: Path, reported_game_ids: list[str]) -> dict[str, Any]:
    """Read the already-materialized Level18 arrays for report disclosure only."""
    with np.load(profile_npz, allow_pickle=False) as data:
        game_ids = data["game_id"].astype(str)
        mask = data["mask"].astype(bool)
        present = data["offbook_present"].astype(bool)
        ply = data["offbook_ply"].astype(int)
        anchors: dict[str, int] = {}
        no_anchor: list[str] = []
        for game_id in reported_game_ids:
            values = np.unique(ply[(game_ids == game_id)[:, None] & mask & present])
            if len(values) > 1:
                raise ValueError(f"Level18 TCN report anchor is not unique for {game_id}: {values.tolist()}")
            if len(values):
                anchors[game_id] = int(values[0])
            else:
                no_anchor.append(game_id)
        return {
            "schema": str(data["offbook_schema"].item()),
            "labelSource": str(data["offbook_label_source"].item()),
            "algorithmVersion": str(data["offbook_algorithm_version"].item()),
            "sourceEngineLevel": int(data["offbook_source_engine_level"].item()),
            "engineContract": str(data["offbook_engine_contract"].item()),
            "normalization": str(data["offbook_normalization"].item()),
            "timeLimitMs": int(data["offbook_time_limit_ms"].item()),
            "sourceDataSha256": str(data["offbook_source_data_sha256"].item()),
            "sourceCheckpointSha256": str(data["offbook_source_checkpoint_sha256"].item()),
            "recordsSha256": str(data["offbook_records_sha256"].item()),
            "materializationSha256": str(data["offbook_materialization_sha256"].item()),
            "anchorGlobalPlacementPlyInclusive": anchors,
            "reportedGamesWithoutAnchor": no_anchor,
            "postOffbookSelectionUsesSameMaterializedArray": True,
            "retrospectiveDisclosure": str(data["offbook_retrospective_disclosure"].item()),
        }


def build_final_report(run: Run, anchors: dict[str, int], no_anchor: list[str]) -> None:
    report_path = run.path("report.json")
    evaluation = run.path("model") / "evaluation"
    model_summary = evaluation / "reported_bootstrap_summary.json"
    calibration = evaluation / "control_adaptation_calibration.json"
    model_base_dir = Path(run.config.get("runtimePaths", {}).get(
        "modelBaseDirectory", str(run.path("model_data_base"))
    ))
    profile_dir = Path(run.config.get("runtimePaths", {}).get(
        "profileModelDirectory", str(run.path("model_data_profile"))
    ))
    profile_manifest = profile_dir / "oq_profile_materialization_manifest.json"
    profile_npz = profile_dir / "personal_model_ready_profile.npz"
    level18_summary = level18_tcn_feature_summary(profile_npz, run.config["reportedGameIds"])
    estimated_elo_path = run.path("estimated_elo") / "estimated_elo.json"
    unified_sentinel_path = run.path("sentinel_unified_analysis.json")
    report = {
        "schema": "player-investigation-json-report-v1",
        "status": "completed",
        "generatedAtUtc": utc_now(),
        "account": run.config["account"],
        "acquisition": read_json(run.path("acquisition_report.json")),
        "groups": {
            "reportedGameIds": run.config["reportedGameIds"],
            "controlGameIds": run.config["controlGameIds"],
            "excludedGameIds": run.config["excludedGameIds"],
            "selection": run.config.get("groupSelection"),
        },
        "offbook": {
            "level22SentinelStatistical": {
                "labelSource": "first-log-time-or-abs6-with-post-fast-v5",
                "anchorsInclusiveGlobalPlacementPly": anchors,
                "reportedGamesWithoutAnchor": no_anchor,
                "records": read_json(run.path("offbook_records.json")),
                "usedAsTcnInput": False,
            },
            "level18TcnFeature": level18_summary,
        },
        "nonModel": {
            "lossAndWld": read_json(run.path("non_model") / "loss-analysis.json"),
            "thinkingTime": read_json(run.path("non_model") / "time-analysis.json"),
        },
        "estimatedElo": read_json(estimated_elo_path) if estimated_elo_path.is_file() else None,
        "unifiedSentinelAnalysis": read_json(unified_sentinel_path) if unified_sentinel_path.is_file() else None,
        "model": {
            "eligibleReportedGameIds": sorted(run.config["reportedGameIds"]),
            "fullGameFallbackNoOffbookGameIds": no_anchor,
            "excludedNoOffbookGameIds": [],
            "reportedBootstrap": read_json(model_summary) if model_summary.is_file() else None,
            "controlAdaptationCalibration": read_json(calibration) if calibration.is_file() else None,
            "profileMaterialization": read_json(profile_manifest),
            "level18OffbookMaterialization": artifact_entry(model_base_dir / "offbook_materialization_manifest.json"),
        },
        "parameters": run.config["parameters"],
        "artifacts": {
            "sourceBundle": artifact_entry(run.path("account_bundle.json")),
            "selectedBundle": artifact_entry(run.path("selected_account_bundle.json")),
            "acquisitionReport": artifact_entry(run.path("acquisition_report.json")),
            "profiles": artifact_entry(run.path("profiles")),
            "level22": artifact_entry(run.path("engine_level22")),
            "safeHints": artifact_entry(run.path("hints")),
            "modelReady": artifact_entry(profile_dir / "personal_model_ready_profile.npz"),
            "personalEnsemble": artifact_entry(run.path("model") / "adapters" / "personal_ensemble_manifest.json"),
            "sentinelUnifiedAnalysis": artifact_entry(run.path("sentinel_unified_analysis.json")),
            "estimatedElo": artifact_entry(run.path("estimated_elo")) if run.path("estimated_elo").is_dir() else None,
        },
        "limitations": [
            "Statistical intervals and p-values are not cheating probabilities.",
            "Current cumulative Player profiles are retrospective and may include information accumulated after the games.",
            "Reported games without a defensible off-book anchor use all target-player moves in model evaluation; no synthetic anchor is assigned.",
        ],
    }
    if run.config.get("mode") == "sentinel":
        selection = read_json(run.path("selection_manifest.json"))
        report["schema"] = "player-anomaly-sentinel-report-v1"
        report["classification"] = selection["classification"]
        report["selection"] = selection
        report["perGameReferenceScores"] = read_json(run.path("per_game_reference_scores.json"))
        report["sentinelScan"] = read_json(run.path("sentinel_scan_results.json"))
        report["pseudoScanSummary"] = read_json(run.path("pseudo_scan_summary.json"))
        report["estimatedElo"] = read_json(run.path("estimated_elo") / "estimated_elo.json")
        report["playerPhaseAnalysis"] = read_json(run.path("player_phase_analysis.json"))
        report["playerPhaseAnalysisArtifacts"] = {
            "json": artifact_entry(run.path("player_phase_analysis.json")),
            "csv": artifact_entry(run.path("player_phase_analysis.csv")),
        }
        report["unifiedSentinelAnalysis"] = read_json(run.path("sentinel_unified_analysis.json"))
        report["model"]["modelReviewReady"] = selection["modelReviewReady"]
        report["model"]["selectionManifestPayloadSha256"] = selection["payloadSha256"]
        model_result = report["model"].get("reportedBootstrap") or {}
        ge4_interval = (((model_result.get("groups") or {}).get("combined") or {}).get(
            "bootstrap95PercentIntervals", {}
        ) or {}).get("ge4") or {}
        lower, upper = ge4_interval.get("lower"), ge4_interval.get("upper")
        if lower is not None and upper is not None and float(upper) < 0:
            relationship = "supportive"
        elif lower is not None and upper is not None and float(lower) > 0:
            relationship = "conflicting"
        else:
            relationship = "not_supportive"
        report["model"]["relationshipToPrimarySelection"] = relationship
        report["model"]["relationshipPolicy"] = (
            "GE4 actual-minus-personal-model-expected whole-game bootstrap: upper<0 supportive; "
            "lower>0 conflicting; otherwise not_supportive; never changes selection"
        )
        report["limitations"].extend([
            "WLD is a secondary metric and cannot create or replace a GE4-selected reported group.",
            "Model results are supporting, non-supporting, or conflicting evidence and cannot modify the frozen selection manifest.",
        ])
    atomic_write_json(report_path, report)
    run.set_stage(
        "final_report", "completed", outputs=[str(report_path)],
        outputSha256={str(report_path.resolve()): sha256_file(report_path)}, completedAtUtc=utc_now(),
    )
    run.set_overall("completed", None)


def validate_paths(config: dict[str, Any]) -> None:
    paths = config["paths"]
    for key in (
        "python", "level22Python", "level22Runner", "engine",
        "baseCheckpoint", "ensembleManifest", "preprocessing",
        "profileNormalizationReferenceNpz", "personalConfig",
    ):
        require_file(Path(paths[key]), key)
    validate_human_opening_book(Path(paths["humanOpeningBook"]))
    require_directory(Path(paths["sourceResearch"]), "sourceResearch")
    ensemble = read_json(Path(paths["ensembleManifest"]))
    members = ensemble.get("members") if isinstance(ensemble.get("members"), list) else []
    if ensemble.get("status") != "completed" or len(members) != 12:
        raise ValueError("the investigation requires one completed 12-member ensemble manifest")
    parameters = config["parameters"]
    for key in (
        "bootstrapReplicates", "modelBootstrapReplicates", "level22Threads", "level22Workers",
        "hint1Workers", "hint6Workers", "featureWorkers",
    ):
        if int(parameters[key]) <= 0:
            raise ValueError(f"{key} must be positive")
    if int(parameters["hintHashLevel"]) != 25:
        raise ValueError("safe personal hint recomputation requires hash level 25")
    fixed_parallel = {
        "level22Workers": max_background_egaroucid_workers(),
        "level22Threads": 16,
        "level22Hash": 25,
        "hint6Workers": 12,
    }
    for key, expected in fixed_parallel.items():
        if int(parameters[key]) != expected:
            raise ValueError(f"player investigation requires {key}={expected}")


def validate_sentinel_execution_paths(config: dict[str, Any]) -> None:
    paths = config["paths"]
    for key in ("python", "level22Python", "level22Runner", "engine"):
        require_file(Path(paths[key]), key)
    parameters = config["parameters"]
    fixed_parallel = {"level22Threads": 16, "level22Hash": 25}
    for key, expected in fixed_parallel.items():
        if int(parameters[key]) != expected:
            raise ValueError(f"sentinel investigation requires {key}={expected}")
    for key in ("pseudoPlayerReplicates", "sentinelBootstrapReplicates"):
        if int(parameters[key]) <= 0:
            raise ValueError(f"{key} must be positive")
    require_file(Path(config.get(
        "eloReferenceConfig", DEFAULT_ELO_CONFIG
    )), "sentinel Elo reference config")
    resolved_sentinel_reference(Run(Path(config["runDirectory"]))) if config.get("runDirectory") else None


def command_start(args: argparse.Namespace) -> int:
    run = create_run(args)
    validate_paths(run.config)
    fetch_games(run, args.bundle)
    print(json.dumps(read_json(run.progress_path), ensure_ascii=False, indent=2))
    return WAITING_EXIT_CODE


def command_start_sentinel(args: argparse.Namespace) -> int:
    run = create_run(args)
    # Store the run directory for validation without weakening the existing config schema.
    run.config["runDirectory"] = str(run.run_dir)
    run.save_config()
    validate_sentinel_execution_paths(run.config)
    run_sentinel(run)
    print(json.dumps(read_json(run.progress_path), ensure_ascii=False, indent=2))
    return 0


def command_select(args: argparse.Namespace) -> int:
    run = Run(args.run_dir)
    explicit = bool(args.reported_game_id or args.control_game_id or args.control_unselected)
    ranged = bool(args.reported_from or args.reported_to)
    if explicit and ranged:
        raise ValueError("explicit game IDs and the reported time range are mutually exclusive")
    if explicit:
        if not args.reported_game_id:
            raise ValueError("explicit selection requires at least one --reported-game-id")
        if args.control_unselected and args.control_game_id:
            raise ValueError("--control-unselected cannot be combined with --control-game-id")
        reported = args.reported_game_id
        if args.control_unselected:
            catalog = read_json(run.path("game_catalog.json"))
            available = [
                str(item.get("gameId") or "")
                for item in catalog.get("games", [])
                if str(item.get("gameId") or "")
            ]
            reported_set = set(reported)
            control = [game_id for game_id in available if game_id not in reported_set]
        else:
            if not args.control_game_id:
                raise ValueError("explicit selection requires --control-game-id or --control-unselected")
            control = args.control_game_id
        selection = None
    elif ranged:
        if not args.reported_from or not args.reported_to:
            raise ValueError("time-range selection requires both --reported-from and --reported-to")
        reported, control, selection = groups_from_time_range(run, args.reported_from, args.reported_to)
    else:
        raise ValueError("provide explicit game IDs or an inclusive reported time range")
    select_groups(run, reported, control, selection)
    run_pre_model_stages(run)
    run_model_and_report_stages(run)
    print(json.dumps(read_json(run.progress_path), ensure_ascii=False, indent=2))
    return 0


def command_resume(args: argparse.Namespace) -> int:
    run = Run(args.run_dir)
    status = run.progress["status"]
    if status == "completed":
        print(json.dumps(run.progress, ensure_ascii=False, indent=2))
        return 0
    if status == "awaiting_group_selection":
        print(json.dumps(run.progress, ensure_ascii=False, indent=2))
        return WAITING_EXIT_CODE
    if run.config.get("mode") == "sentinel":
        validate_sentinel_execution_paths(run.config)
        run_sentinel(run)
        print(json.dumps(read_json(run.progress_path), ensure_ascii=False, indent=2))
        return 0
    pre_review_stages = (
        "fetch_profiles", "level22", "offbook_detection", "hint_source", "hint1", "hint6", "hint_assembly"
    )
    if any(run.progress["stages"][name].get("status") != "completed" for name in pre_review_stages):
        run_pre_model_stages(run)
        return WAITING_EXIT_CODE
    if not run.path("offbook_records.json").is_file():
        raise FileNotFoundError("completed offbook_detection stage is missing offbook_records.json")
    run_model_and_report_stages(run)
    print(json.dumps(read_json(run.progress_path), ensure_ascii=False, indent=2))
    return 0


def command_status(args: argparse.Namespace) -> int:
    run = Run(args.run_dir)
    print(json.dumps(run.progress, ensure_ascii=False, indent=2))
    return 0


def add_run_dir(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run-dir", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="fetch games and wait for Agent group selection")
    start.add_argument("--account", required=True)
    start.add_argument("--output-dir", type=Path, required=True)
    start.add_argument("--mode", default="5min", choices=("5min",))
    start.add_argument("--bundle", type=Path, help="use an existing account bundle instead of a network fetch")
    start.add_argument("--bootstrap", type=int, default=10_000)
    start.add_argument("--model-bootstrap", type=int, default=1_000)
    start.add_argument("--seed", type=int, default=20260801)
    start.add_argument("--model-seed", type=int, default=20260809)
    start.add_argument("--device", default="cuda:0")
    start.add_argument("--level22-threads", type=int, default=16)
    start.add_argument("--level22-hash", type=int, default=25)
    start.add_argument("--level22-workers", type=int, default=None)
    start.add_argument("--hint1-workers", type=int, default=12)
    start.add_argument("--hint6-workers", type=int, default=12)
    start.add_argument("--feature-workers", type=int, default=12)
    start.add_argument("--engine", type=Path)
    start.add_argument("--level22-python", type=Path)
    start.add_argument("--level22-runner", type=Path)
    start.add_argument("--base-checkpoint", type=Path)
    start.add_argument("--ensemble-manifest", type=Path)
    start.add_argument("--profile-normalization-reference-npz", type=Path)
    start.set_defaults(handler=command_start)

    sentinel_start = commands.add_parser(
        "start-sentinel",
        help="investigate the most recent 30 games with at least 16 actual placements using Sentinel V4",
    )
    sentinel_start.add_argument("--account", required=True)
    sentinel_start.add_argument("--output-dir", type=Path, required=True)
    sentinel_start.add_argument("--reference-config", type=Path, required=True)
    sentinel_start.add_argument(
        "--elo-reference-config", type=Path,
        default=DEFAULT_ELO_CONFIG,
        help="versioned database-calibrated Elo reference configuration",
    )
    sentinel_start.add_argument("--mode", default="5min", choices=("5min",))
    sentinel_start.add_argument("--bundle", type=Path, help="use an existing account bundle instead of a network fetch")
    sentinel_start.add_argument("--bootstrap", type=int, default=10_000)
    sentinel_start.add_argument("--model-bootstrap", type=int, default=1_000)
    sentinel_start.add_argument("--seed", type=int, default=20260801)
    sentinel_start.add_argument("--model-seed", type=int, default=20260809)
    sentinel_start.add_argument("--sentinel-seed", type=int, default=20260814)
    sentinel_start.add_argument("--pseudo-replicates", type=int, default=10_000)
    sentinel_start.add_argument("--pseudo-workers", type=int, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    sentinel_start.add_argument("--sentinel-bootstrap", type=int, default=10_000)
    sentinel_start.add_argument("--device", default="cuda:0")
    sentinel_start.add_argument("--level22-threads", type=int, default=16)
    sentinel_start.add_argument("--level22-hash", type=int, default=25)
    sentinel_start.add_argument("--level22-workers", type=int, default=None)
    sentinel_start.add_argument("--hint1-workers", type=int, default=12)
    sentinel_start.add_argument("--hint6-workers", type=int, default=12)
    sentinel_start.add_argument("--feature-workers", type=int, default=12)
    sentinel_start.add_argument("--engine", type=Path)
    sentinel_start.add_argument("--level22-python", type=Path)
    sentinel_start.add_argument("--level22-runner", type=Path)
    sentinel_start.add_argument("--base-checkpoint", type=Path)
    sentinel_start.add_argument("--ensemble-manifest", type=Path)
    sentinel_start.add_argument("--profile-normalization-reference-npz", type=Path)
    sentinel_start.set_defaults(handler=command_start_sentinel)

    select = commands.add_parser("select-groups", help="freeze the groups and run the automated investigation")
    add_run_dir(select)
    select.add_argument("--reported-game-id", action="append", default=[])
    select.add_argument("--control-game-id", action="append", default=[])
    select.add_argument(
        "--control-unselected",
        action="store_true",
        help="use every catalog game not listed as a reported game as the control group",
    )
    select.add_argument(
        "--reported-from",
        help="inclusive ISO 8601 lower bound with Z or an explicit UTC offset",
    )
    select.add_argument(
        "--reported-to",
        help="inclusive ISO 8601 upper bound with Z or an explicit UTC offset",
    )
    select.set_defaults(handler=command_select)

    resume = commands.add_parser("resume", help="resume the first incomplete automated stage")
    add_run_dir(resume)
    resume.set_defaults(handler=command_resume)

    status = commands.add_parser("status", help="print the top-level progress JSON")
    add_run_dir(status)
    status.set_defaults(handler=command_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except Exception as exc:
        run_dir = getattr(args, "run_dir", None) or getattr(args, "output_dir", None)
        if run_dir and (Path(run_dir) / "progress.json").is_file():
            run = Run(Path(run_dir))
            run.progress["lastError"] = {"type": type(exc).__name__, "message": str(exc), "atUtc": utc_now()}
            if run.progress["status"] != "awaiting_group_selection":
                run.progress["status"] = "failed"
            run.save_progress()
        raise


if __name__ == "__main__":
    raise SystemExit(main())



