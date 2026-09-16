#!/usr/bin/env python3
"""Build a pass-aware, hint-free TCN source table from one OQ account bundle."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
TOOLKIT_SRC = Path(__file__).resolve().parents[4] / "src"
if str(TOOLKIT_SRC) not in sys.path:
    sys.path.insert(0, str(TOOLKIT_SRC))
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from materialize_personal_oq_tcn_model_ready import game_summary, normalize_bundle
from player_analysis_toolkit.investigation_eligibility import (
    eligibility_contract,
    validate_eligible_details,
)
from src.checkpoint import sha256_file

INPUT_POLICY = "uniform-no-current-player-loss-history-v1"
SOURCE_FIELDS = [
    "game_id", "mode", "gtype", "tcb", "created", "finalStatus", "move_index", "ply",
    "source_ply_including_pass", "global_placement_ply", "side_to_move", "player_id",
    "actual_move", "actual_thinking_time_ms", "board", "board_setboard", "n_legal_moves",
    "legal_moves", "is_pass_record", "split", "input_policy",
]
HINT_FIELDS = [
    "hint1_level", "hint1_move", "hint1_score", "hint1_nodes", "hint1_depth", "hint1_is_book",
]
for rank in range(1, 7):
    HINT_FIELDS.extend(
        f"hint6_{rank}_{name}" for name in ("move", "score", "nodes", "depth", "is_book")
    )
SOURCE_FIELDS.extend(HINT_FIELDS)


def load_board_class(module_path: Path):
    spec = importlib.util.spec_from_file_location("personal_hint_source_board", module_path.resolve())
    if spec is None or spec.loader is None:
        raise ImportError(module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.OthelloBoard


def atomic_write_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="",
    )
    os.replace(temporary, path)


def build_source(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output_dir.resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite: {output}")
    source = json.loads(args.account_bundle.read_text(encoding="utf-8"))
    normalized, normalization = normalize_bundle(source, args.effective_time_limit_ms)
    reported = set(args.reported_game)
    details = normalized["details"]
    validate_eligible_details(details, label="personal hint-source games")
    game_ids = {str(item["id"]) for item in details}
    if not reported <= game_ids:
        raise ValueError(f"reported games absent from bundle: {sorted(reported - game_ids)}")

    target = args.target_player.casefold()
    for detail in details:
        player_ids = {str(item.get("id", "")).casefold() for item in detail.get("players", [])}
        if target not in player_ids:
            raise ValueError(f"target player absent from game {detail.get('id')}")

    Board = load_board_class(args.analyzer_module)
    index_by_id = {str(item.get("id")): item for item in normalized.get("index", [])}
    output.mkdir(parents=True)
    raw_path = output / "raw_nodes_with_pass.csv"
    games_path = output / "games.csv"
    split_path = output / "split_manifest.csv"
    normalized_path = output / "normalized_account_bundle.json"

    rows = placements = passes = 0
    node_game_ids: set[str] = set()
    split_counts = {"train": 0, "test": 0}
    with raw_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SOURCE_FIELDS)
        writer.writeheader()
        for detail in sorted(details, key=lambda item: str(item["id"])):
            game = game_summary(detail, index_by_id)
            game_id = game["game_id"]
            split = "test" if game_id in reported else "train"
            board = Board()
            placement_ply = 0
            moves = [item for item in (detail.get("position") or {}).get("moves", []) if "m" in item]
            if moves:
                node_game_ids.add(game_id)
                split_counts[split] += 1
            for move_index, item in enumerate(moves):
                actual = str(item.get("m", "")).strip().lower()
                setboard = board.to_setboard_str()
                side = "black" if board.current == "X" else "white"
                legal = board.legal_moves()
                is_pass = actual == "-"
                if is_pass:
                    if legal:
                        raise ValueError(f"pass with legal moves at {(game_id, move_index)}")
                    passes += 1
                else:
                    if actual not in legal:
                        raise ValueError(
                            f"illegal transcript move at {(game_id, move_index)}: {actual} not in {legal}"
                        )
                    placement_ply += 1
                    placements += 1
                players = detail.get("players") or []
                player = players[0] if board.current == "X" else players[1]
                row = {
                    "game_id": game_id,
                    "mode": game["mode"],
                    "gtype": game["gtype"],
                    "tcb": game["tcb"],
                    "created": game["created"],
                    "finalStatus": game["finalStatus"],
                    "move_index": move_index,
                    "ply": move_index + 1,
                    "source_ply_including_pass": move_index + 1,
                    "global_placement_ply": placement_ply,
                    "side_to_move": side,
                    "player_id": str(player.get("id", "")).casefold(),
                    "actual_move": actual,
                    "actual_thinking_time_ms": int(item.get("t", 0) or 0),
                    "board": setboard[:64],
                    "board_setboard": setboard,
                    "n_legal_moves": len(legal),
                    "legal_moves": " ".join(legal),
                    "is_pass_record": int(is_pass),
                    "split": split,
                    "input_policy": INPUT_POLICY,
                }
                row.update({field: "" for field in HINT_FIELDS})
                writer.writerow(row)
                rows += 1
                board.apply_move(actual)

    with games_path.open("w", encoding="utf-8", newline="") as handle:
        fields = ["game_id", "mode", "gtype", "tcb", "created", "finalStatus", "length", "black_id", "white_id"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for detail in sorted(details, key=lambda item: str(item["id"])):
            writer.writerow(game_summary(detail, index_by_id))
    with split_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["game_id", "split"])
        writer.writeheader()
        for game_id in sorted(game_ids):
            writer.writerow({"game_id": game_id, "split": "test" if game_id in reported else "train"})
    atomic_write_json(normalized_path, normalized)

    if rows != placements + passes or placements > 60 * len(game_ids):
        raise ValueError("invalid pass-aware source shape")
    files = []
    for path in (raw_path, games_path, split_path, normalized_path):
        files.append({"path": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    manifest = {
        "schema": "personal-oq-hint-source-v1",
        "ok": True,
        "targetPlayer": args.target_player,
        "reportedGameIds": sorted(reported),
        "sourceBundle": str(args.account_bundle.resolve()),
        "sourceBundleSha256": sha256_file(args.account_bundle),
        "effectiveTimeLimitMs": args.effective_time_limit_ms,
        "normalizationPolicy": normalization["policy"],
        "inputPolicy": INPUT_POLICY,
        "investigationEligibility": eligibility_contract(),
        "shape": {
            "games": len(node_game_ids),
            "rows": rows,
            "placements": placements,
            "passes": passes,
            "splits": split_counts,
        },
        "analyzerModule": str(args.analyzer_module.resolve()),
        "bundleGames": len(game_ids),
        "zeroMoveGameIds": sorted(game_ids - node_game_ids),
        "analyzerModuleSha256": sha256_file(args.analyzer_module),
        "files": files,
    }
    atomic_write_json(output / "source_manifest.json", manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--account-bundle", type=Path, required=True)
    result.add_argument("--target-player", required=True)
    result.add_argument("--reported-game", action="append", required=True)
    result.add_argument("--analyzer-module", type=Path, required=True)
    result.add_argument("--output-dir", type=Path, required=True)
    result.add_argument("--effective-time-limit-ms", type=int, default=300000)
    return result


def main() -> int:
    report = build_source(parser().parse_args())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
