#!/usr/bin/env python3
"""Sample, recompute, stress-test, and audit Egaroucid hint provenance.

This is the production successor to the disabled server analyzer.  It consumes only
an explicit frozen CSV or a fixed sample manifest, never performs network access, and
writes immutable UTF-8 JSONL batches containing each request's native Console board
and full raw command responses.
"""

from __future__ import annotations

import argparse
import ctypes
import csv
import hashlib
import itertools
import json
import os
import platform
import queue
import random
import shutil
import statistics
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.egaroucid_safe import (  # noqa: E402
    AtomicEgaroucid,
    EgaroucidTransactionError,
    HintTransaction,
    legal_moves_from_setboard,
    normalize_setboard,
    validate_hint_transaction,
)


COMMAND_MATRIX = Path(
    os.environ.get("PAPP_COMMAND_MATRIX", "console_command_matrix.md")
)
STAGE_CONFIGS = {
    "hint1": {"level": 2, "threads": 1, "use_book": False, "count": 1},
    "hint6": {"level": 18, "threads": 16, "use_book": True, "count": 6},
}


@dataclass(frozen=True)
class NodeTask:
    game_id: str
    move_index: int
    ply: int
    source_ply_including_pass: int
    global_placement_ply: int
    side_to_move: str
    player_id: str
    actual_move: str
    board: str
    board_setboard: str
    n_legal_moves: int
    legal_moves: list[str]

    @property
    def key(self) -> tuple[str, int]:
        return self.game_id, self.move_index


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    body = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{time.time_ns()}")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def task_from_row(row: dict[str, str]) -> NodeTask | None:
    actual_move = str(row.get("actual_move", "")).strip().lower()
    is_pass = actual_move == "-" or str(row.get("is_pass_record", "")).strip() == "1"
    if is_pass:
        if actual_move != "-":
            raise ValueError(f"pass flag conflicts with actual_move for {row.get('game_id')}")
        return None
    board_setboard = normalize_setboard(row["board_setboard"])
    board = str(row["board"]).strip().upper().replace(".", "-")
    if board != board_setboard[:64]:
        raise ValueError(f"board and board_setboard disagree for {(row['game_id'], row['move_index'])}")
    side_to_move = str(row["side_to_move"]).strip().lower()
    expected_side = {"black": "X", "white": "O"}.get(side_to_move)
    if expected_side is None or board_setboard[64] != expected_side:
        raise ValueError(f"side_to_move conflicts with setboard for {(row['game_id'], row['move_index'])}")
    legal_moves = [move.lower() for move in str(row["legal_moves"]).split()]
    if len(legal_moves) != len(set(legal_moves)):
        raise ValueError(f"duplicate source legal moves for {(row['game_id'], row['move_index'])}")
    derived = legal_moves_from_setboard(board_setboard)
    if set(legal_moves) != set(derived) or len(legal_moves) != len(derived):
        raise ValueError(
            f"source legal moves disagree with board for {(row['game_id'], row['move_index'])}: "
            f"source={legal_moves} derived={derived}"
        )
    n_legal_moves = int(row["n_legal_moves"])
    if n_legal_moves != len(legal_moves):
        raise ValueError(f"n_legal_moves mismatch for {(row['game_id'], row['move_index'])}")
    if actual_move not in legal_moves:
        raise ValueError(f"actual move is illegal for {(row['game_id'], row['move_index'])}: {actual_move}")
    return NodeTask(
        game_id=str(row["game_id"]),
        move_index=int(row["move_index"]),
        ply=int(row["ply"]),
        source_ply_including_pass=int(row["source_ply_including_pass"]),
        global_placement_ply=int(row["global_placement_ply"]),
        side_to_move=side_to_move,
        player_id=str(row["player_id"]),
        actual_move=actual_move,
        board=board,
        board_setboard=board_setboard,
        n_legal_moves=n_legal_moves,
        legal_moves=legal_moves,
    )


def iter_source_tasks(source_csv: Path) -> Iterator[NodeTask]:
    with source_csv.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            task = task_from_row(row)
            if task is not None:
                yield task


def _reservoir_add(
    reservoir: list[dict[str, Any]],
    item: dict[str, Any],
    seen: int,
    capacity: int,
    rng: random.Random,
) -> None:
    if len(reservoir) < capacity:
        reservoir.append(item)
        return
    replacement = rng.randrange(seen)
    if replacement < capacity:
        reservoir[replacement] = item


def task_tags(task: NodeTask) -> list[str]:
    tags = [task.side_to_move]
    if task.global_placement_ply <= 20:
        tags.append("opening")
    elif task.global_placement_ply <= 45:
        tags.append("midgame")
    else:
        tags.append("endgame")
    if task.n_legal_moves < 6:
        tags.append("legal-lt6")
    elif task.n_legal_moves == 6:
        tags.append("legal-eq6")
    else:
        tags.append("legal-gt6")
    return tags


def build_sample(source_csv: Path, output: Path, sample_size: int, seed: int) -> dict[str, Any]:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite sample manifest: {output}")
    rng = random.Random(seed)
    categories = [
        "opening", "midgame", "endgame", "black", "white",
        "legal-lt6", "legal-eq6", "legal-gt6", "pass-adjacent",
    ]
    reservoirs: dict[str, list[dict[str, Any]]] = {name: [] for name in categories}
    seen = {name: 0 for name in categories}
    global_reservoir: list[dict[str, Any]] = []
    global_seen = 0
    pass_pair_reservoir: list[list[dict[str, Any]]] = []
    pass_pairs_seen = 0
    previous_placement: NodeTask | None = None
    previous_game = ""
    previous_was_pass = False
    placements = passes = 0
    with source_csv.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            game_id = str(row["game_id"])
            if game_id != previous_game:
                previous_game = game_id
                previous_placement = None
                previous_was_pass = False
            task = task_from_row(row)
            if task is None:
                passes += 1
                if previous_placement is not None:
                    name = "pass-adjacent"
                    seen[name] += 1
                    item = {
                        "task": asdict(previous_placement),
                        "tags": task_tags(previous_placement) + ["pass-adjacent", "before-pass"],
                    }
                    _reservoir_add(reservoirs[name], item, seen[name], 1000, rng)
                previous_was_pass = True
                continue
            placements += 1
            tags = task_tags(task)
            if previous_was_pass:
                tags.extend(["pass-adjacent", "after-pass"])
                if previous_placement is None:
                    raise RuntimeError("pass adjacency lost its preceding placement")
                pass_pairs_seen += 1
                pair = [
                    {
                        "task": asdict(previous_placement),
                        "tags": task_tags(previous_placement) + ["pass-adjacent", "before-pass"],
                    },
                    {"task": asdict(task), "tags": tags},
                ]
                _reservoir_add(pass_pair_reservoir, pair, pass_pairs_seen, 1000, rng)
                name = "pass-adjacent"
                seen[name] += 1
                _reservoir_add(
                    reservoirs[name], {"task": asdict(task), "tags": tags}, seen[name], 1000, rng
                )
            item = {"task": asdict(task), "tags": tags}
            global_seen += 1
            _reservoir_add(global_reservoir, item, global_seen, 20000, rng)
            for name in set(tags) & set(categories):
                seen[name] += 1
                _reservoir_add(reservoirs[name], item, seen[name], 1000, rng)
            previous_placement = task
            previous_was_pass = False

    selected: list[dict[str, Any]] = []
    selected_keys: set[tuple[str, int]] = set()
    selected_games: set[str] = set()

    pair_choices = pass_pair_reservoir[:]
    rng.shuffle(pair_choices)
    selected_pass_pairs = 0
    for pair in pair_choices:
        game_id = pair[0]["task"]["game_id"]
        if game_id in selected_games:
            continue
        pair_keys = {
            (item["task"]["game_id"], int(item["task"]["move_index"])) for item in pair
        }
        if len(pair_keys) != 2:
            raise RuntimeError(f"invalid pass pair in {game_id}")
        selected.extend(pair)
        selected_keys.update(pair_keys)
        selected_games.add(game_id)
        selected_pass_pairs += 1
        if selected_pass_pairs == 5:
            break
    if selected_pass_pairs != 5:
        raise RuntimeError(f"could select only {selected_pass_pairs} complete pass-adjacent pairs")

    def choose(pool: list[dict[str, Any]]) -> bool:
        choices = pool[:]
        rng.shuffle(choices)
        for item in choices:
            task = item["task"]
            key = (task["game_id"], int(task["move_index"]))
            if key in selected_keys or task["game_id"] in selected_games:
                continue
            selected.append(item)
            selected_keys.add(key)
            selected_games.add(task["game_id"])
            return True
        return False

    target_per_category = 5
    for name in categories:
        if name == "pass-adjacent":
            continue
        for _ in range(target_per_category):
            choose(reservoirs[name])
    while len(selected) < sample_size and choose(global_reservoir):
        pass
    if len(selected) != sample_size:
        raise RuntimeError(f"could select only {len(selected)} distinct-game nodes, expected {sample_size}")
    selected.sort(key=lambda item: (item["task"]["game_id"], int(item["task"]["move_index"])))
    coverage: dict[str, int] = {name: 0 for name in categories}
    coverage.update({"before-pass": 0, "after-pass": 0})
    for item in selected:
        for tag in item["tags"]:
            if tag in coverage:
                coverage[tag] += 1
    payload = {
        "schema": "egaroucid-safe-smoke-sample-v1",
        "createdAt": utc_now(),
        "sourceCsv": str(source_csv.resolve()),
        "sourceSha256": sha256_file(source_csv),
        "seed": seed,
        "sampleSize": sample_size,
        "distinctGames": len(selected_games),
        "completePassAdjacentPairs": selected_pass_pairs,
        "sourcePlacements": placements,
        "sourcePassRows": passes,
        "coverage": coverage,
        "tasks": selected,
    }
    write_json(output, payload)
    return payload


def load_sample_tasks(sample_path: Path) -> tuple[list[NodeTask], str]:
    payload = json.loads(sample_path.read_text(encoding="utf-8"))
    if payload.get("schema") != "egaroucid-safe-smoke-sample-v1":
        raise ValueError("unsupported sample manifest schema")
    tasks = [NodeTask(**item["task"]) for item in payload["tasks"]]
    for task in tasks:
        if set(task.legal_moves) != set(legal_moves_from_setboard(task.board_setboard)):
            raise ValueError(f"sample task failed independent legal validation: {task.key}")
    return tasks, sha256_file(sample_path)


def resource_hashes(engine: Path, use_book: bool, hash_level: int) -> dict[str, str | None]:
    resources = engine.resolve().parent / "resources"
    paths = {
        "book": resources / "book.egbk3" if use_book else None,
        "eval": resources / "eval.egev2",
        "moveOrderingEval": resources / "eval_move_ordering_end.egev",
        "hashFile": resources / "hash" / f"hash{hash_level}.eghs",
    }
    hashes: dict[str, str | None] = {}
    for name, path in paths.items():
        if path is None:
            hashes[name] = None
        elif path.is_file():
            hashes[name] = sha256_file(path)
        else:
            raise FileNotFoundError(f"required engine resource is missing: {path}")
    return hashes


def stage_contract(
    stage: str,
    engine: Path,
    hash_level: int,
    source_identity: dict[str, Any],
    *,
    workers: int,
    batch_size: int,
    timeout: float,
    max_attempts: int,
) -> dict[str, Any]:
    fixed = STAGE_CONFIGS[stage]
    command_matrix_hash = sha256_file(COMMAND_MATRIX) if COMMAND_MATRIX.is_file() else None
    return {
        "schema": "egaroucid-safe-stage-contract-v1",
        "stage": stage,
        **fixed,
        "hashLevel": hash_level,
        "workerCount": workers,
        "batchSize": batch_size,
        "timeoutSeconds": timeout,
        "maxAttempts": max_attempts,
        "noAutoCacheClear": True,
        "quietFlag": False,
        "noBoardFlag": False,
        "engine": str(engine.resolve()),
        "engineSha256": sha256_file(engine),
        "engineResources": resource_hashes(engine, bool(fixed["use_book"]), hash_level),
        "source": source_identity,
        "commandMatrix": str(COMMAND_MATRIX),
        "commandMatrixSha256": command_matrix_hash,
        "scriptSha256": sha256_file(Path(__file__).resolve()),
    }


def load_committed(output_dir: Path, stage: str, contract_hash: str) -> tuple[set[tuple[str, int]], int]:
    completed: set[tuple[str, int]] = set()
    maximum_batch = -1
    batches = output_dir / "batches"
    if not batches.exists():
        return completed, maximum_batch
    for path in sorted(batches.glob("batch_*.jsonl")):
        try:
            maximum_batch = max(maximum_batch, int(path.stem.split("_")[1]))
        except (IndexError, ValueError) as exc:
            raise ValueError(f"unexpected batch filename: {path}") from exc
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                record = json.loads(line)
                if record.get("stage") != stage or record.get("contractHash") != contract_hash:
                    raise ValueError(f"batch contract mismatch: {path}:{line_number}")
                key = (str(record["game_id"]), int(record["move_index"]))
                if key in completed:
                    raise ValueError(f"duplicate committed key {key} in {path}")
                completed.add(key)
    return completed, maximum_batch


def flattened_hint_fields(stage: str, hints: list[dict[str, Any]]) -> dict[str, Any]:
    if stage == "hint1":
        item = hints[0]
        return {
            "hint1_level": 2,
            **{f"hint1_{name}": item[name] for name in ("move", "score", "nodes", "depth", "is_book")},
        }
    fields: dict[str, Any] = {}
    for rank in range(1, 7):
        item = hints[rank - 1] if rank <= len(hints) else None
        for name in ("move", "score", "nodes", "depth", "is_book"):
            fields[f"hint6_{rank}_{name}"] = item[name] if item is not None else None
    return fields


def make_result_record(
    task: NodeTask,
    transaction: HintTransaction,
    *,
    stage: str,
    worker_id: int,
    request_id: str,
    contract_hash: str,
    engine_args: tuple[str, ...],
    started_at: str,
    finished_at: str,
) -> dict[str, Any]:
    response_board_field = f"{stage}_board_setboard"
    request_board_field = f"{stage}_request_board_setboard"
    return {
        "schema": "egaroucid-safe-hint-result-v1",
        "stage": stage,
        "contractHash": contract_hash,
        "requestId": request_id,
        "workerId": worker_id,
        "startedAt": started_at,
        "finishedAt": finished_at,
        **asdict(task),
        request_board_field: transaction.request_board_setboard,
        response_board_field: transaction.hint_response_board_setboard,
        "setboard_response_board_setboard": transaction.setboard_response_board_setboard,
        "setboardResponseBoardCount": transaction.setboard_response_board_count,
        "hintResponseBoardCount": transaction.hint_response_board_count,
        "hints": transaction.hints,
        **flattened_hint_fields(stage, transaction.hints),
        "setboardRawResponse": transaction.setboard_raw_response,
        "hintRawResponse": transaction.hint_raw_response,
        "elapsedSeconds": transaction.elapsed_seconds,
        "engineArgs": list(engine_args),
    }


def commit_batch(output_dir: Path, batch_id: int, records: list[dict[str, Any]]) -> Path:
    path = output_dir / "batches" / f"batch_{batch_id:08d}.jsonl"
    if path.exists():
        raise FileExistsError(f"refusing to overwrite committed batch: {path}")
    for index, record in enumerate(records):
        record["batchId"] = batch_id
        record["batchIndex"] = index
    text = "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records)
    atomic_write_text(path, text)
    return path


def run_stage(args: argparse.Namespace) -> dict[str, Any]:
    output_dir = args.output_dir.resolve()
    if output_dir.exists() and any(output_dir.iterdir()) and not args.resume:
        raise FileExistsError(f"output directory is not empty; use a new path or --resume: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    engine = args.engine.resolve()
    if args.sample_manifest:
        sample_path = args.sample_manifest.resolve()
        sample_tasks, sample_hash = load_sample_tasks(sample_path)
        source_identity = {"kind": "sample", "path": str(sample_path), "sha256": sample_hash}
        task_factory = lambda: iter(sample_tasks)
    else:
        source_csv = args.source_csv.resolve()
        source_identity = {"kind": "frozen-csv", "path": str(source_csv), "sha256": sha256_file(source_csv)}
        task_factory = lambda: iter_source_tasks(source_csv)
    contract = stage_contract(
        args.stage,
        engine,
        args.hash_level,
        source_identity,
        workers=args.workers,
        batch_size=args.batch_size,
        timeout=args.timeout,
        max_attempts=args.max_attempts,
    )
    contract_hash = canonical_hash(contract)
    contract["contractHash"] = contract_hash
    manifest_path = output_dir / "run_manifest.json"
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("contractHash") != contract_hash:
            raise ValueError("resume contract differs from existing run manifest")
    else:
        write_json(
            manifest_path,
            {
                **contract,
                "createdAt": utc_now(),
                "python": sys.version,
                "platform": platform.platform(),
            },
        )
    completed, maximum_batch = load_committed(output_dir, args.stage, contract_hash)
    fixed = STAGE_CONFIGS[args.stage]
    attempt_id = f"{datetime.now().strftime('%Y%m%dT%H%M%S')}_{uuid.uuid4().hex[:8]}"
    task_queue: queue.Queue[NodeTask | None] = queue.Queue(maxsize=max(8, args.workers * 4))
    result_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    stop = threading.Event()
    producer_stats = {"scanned": 0, "queued": 0, "skippedCompleted": 0}

    def producer() -> None:
        try:
            for task in task_factory():
                producer_stats["scanned"] += 1
                if task.key in completed:
                    producer_stats["skippedCompleted"] += 1
                    continue
                if args.limit and producer_stats["queued"] >= args.limit:
                    break
                if stop.is_set():
                    break
                while True:
                    try:
                        task_queue.put(task, timeout=0.5)
                        break
                    except queue.Full:
                        if stop.is_set():
                            break
                if stop.is_set():
                    break
                producer_stats["queued"] += 1
        except Exception as exc:
            stop.set()
            result_queue.put({"kind": "fatal", "where": "producer", "error": repr(exc), "traceback": traceback.format_exc()})
        finally:
            for _ in range(args.workers):
                while True:
                    try:
                        task_queue.put(None, timeout=0.5)
                        break
                    except queue.Full:
                        continue

    def worker(worker_index: int) -> None:
        engine_instance: AtomicEgaroucid | None = None
        lifecycle = {
            "schema": "egaroucid-safe-worker-lifecycle-v1",
            "attemptId": attempt_id,
            "workerId": worker_index,
            "stage": args.stage,
            "startedAt": utc_now(),
            "engineStarts": 0,
            "completed": 0,
            "failedAttempts": 0,
        }
        try:
            while True:
                task = task_queue.get()
                if task is None:
                    break
                if stop.is_set():
                    continue
                request_id = hashlib.sha256(
                    f"{contract_hash}|{task.game_id}|{task.move_index}|{task.board_setboard}".encode("utf-8")
                ).hexdigest()
                success = False
                for attempt in range(1, args.max_attempts + 1):
                    started_at = utc_now()
                    try:
                        if engine_instance is None:
                            engine_instance = AtomicEgaroucid(
                                engine,
                                level=int(fixed["level"]),
                                threads=int(fixed["threads"]),
                                hash_level=args.hash_level,
                                use_book=bool(fixed["use_book"]),
                            )
                            lifecycle["engineStarts"] += 1
                            lifecycle.setdefault("engineSessions", []).append(
                                {
                                    "startedAt": utc_now(),
                                    "args": list(engine_instance.args),
                                    "startupRawResponse": engine_instance.startup_raw_response,
                                }
                            )
                        transaction = engine_instance.hint_for_board(
                            task.board_setboard,
                            int(fixed["count"]),
                            timeout=args.timeout,
                        )
                        validate_hint_transaction(transaction, task.legal_moves, int(fixed["count"]))
                        record = make_result_record(
                            task,
                            transaction,
                            stage=args.stage,
                            worker_id=worker_index,
                            request_id=request_id,
                            contract_hash=contract_hash,
                            engine_args=engine_instance.args,
                            started_at=started_at,
                            finished_at=utc_now(),
                        )
                        result_queue.put({"kind": "result", "record": record})
                        lifecycle["completed"] += 1
                        success = True
                        break
                    except Exception as exc:
                        lifecycle["failedAttempts"] += 1
                        failure = {
                            "schema": "egaroucid-safe-failed-attempt-v1",
                            "attemptId": attempt_id,
                            "requestId": request_id,
                            "workerId": worker_index,
                            "requestAttempt": attempt,
                            "stage": args.stage,
                            "contractHash": contract_hash,
                            "task": asdict(task),
                            "error": repr(exc),
                            "traceback": traceback.format_exc(),
                            "failedAt": utc_now(),
                        }
                        if isinstance(exc, EgaroucidTransactionError):
                            failure["transactionEvidence"] = exc.evidence()
                        elif engine_instance is not None:
                            failure["engineDiagnostic"] = engine_instance.diagnostic_snapshot()
                        failure_path = output_dir / "failures" / f"{request_id}_w{worker_index:02d}_a{attempt}_{time.time_ns()}.json"
                        write_json(failure_path, failure)
                        if engine_instance is not None:
                            engine_instance.close()
                            engine_instance = None
                if not success:
                    stop.set()
                    result_queue.put({"kind": "fatal", "where": f"worker-{worker_index}", "requestId": request_id, "error": "request exhausted retries"})
        except Exception as exc:
            stop.set()
            result_queue.put({"kind": "fatal", "where": f"worker-{worker_index}", "error": repr(exc), "traceback": traceback.format_exc()})
        finally:
            if engine_instance is not None:
                engine_instance.close()
            lifecycle["finishedAt"] = utc_now()
            write_json(output_dir / "worker_lifecycle" / f"{attempt_id}_worker_{worker_index:02d}.json", lifecycle)
            result_queue.put({"kind": "done", "workerId": worker_index})

    started = time.monotonic()
    producer_thread = threading.Thread(target=producer, name="safe-hint-producer")
    workers = [
        threading.Thread(target=worker, args=(index + 1,), name=f"safe-hint-worker-{index + 1}")
        for index in range(args.workers)
    ]
    for thread in workers:
        thread.start()
    producer_thread.start()

    batch_id = maximum_batch + 1
    buffer: list[dict[str, Any]] = []
    committed_this_attempt = 0
    done_workers = 0
    errors: list[dict[str, Any]] = []
    progress_path = output_dir / "progress.json"

    def flush() -> None:
        nonlocal batch_id, committed_this_attempt
        if not buffer:
            return
        commit_batch(output_dir, batch_id, buffer)
        committed_this_attempt += len(buffer)
        buffer.clear()
        batch_id += 1
        elapsed = time.monotonic() - started
        write_json(
            progress_path,
            {
                "schema": "egaroucid-safe-progress-v1",
                "status": "running",
                "attemptId": attempt_id,
                "stage": args.stage,
                "contractHash": contract_hash,
                "previouslyCommitted": len(completed),
                "committedThisAttempt": committed_this_attempt,
                "lastBatchId": batch_id - 1,
                "producer": producer_stats,
                "elapsedSeconds": elapsed,
                "positionsPerSecond": committed_this_attempt / elapsed if elapsed else None,
                "errors": errors,
                "updatedAt": utc_now(),
            },
        )

    while done_workers < args.workers:
        item = result_queue.get()
        if item["kind"] == "done":
            done_workers += 1
        elif item["kind"] == "fatal":
            errors.append(item)
            stop.set()
        else:
            buffer.append(item["record"])
            if len(buffer) >= args.batch_size:
                flush()
    flush()
    producer_thread.join()
    for thread in workers:
        thread.join()
    elapsed = time.monotonic() - started
    status = "failed" if errors else "complete"
    report = {
        "schema": "egaroucid-safe-progress-v1",
        "status": status,
        "attemptId": attempt_id,
        "stage": args.stage,
        "contractHash": contract_hash,
        "previouslyCommitted": len(completed),
        "committedThisAttempt": committed_this_attempt,
        "totalCommitted": len(completed) + committed_this_attempt,
        "lastBatchId": batch_id - 1,
        "producer": producer_stats,
        "elapsedSeconds": elapsed,
        "positionsPerSecond": committed_this_attempt / elapsed if elapsed else None,
        "errors": errors,
        "updatedAt": utc_now(),
    }
    write_json(progress_path, report)
    return report


def iter_committed_records(output_dir: Path) -> Iterator[dict[str, Any]]:
    for path in sorted((output_dir / "batches").glob("batch_*.jsonl")):
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                yield json.loads(line)


def transaction_from_record(record: dict[str, Any]) -> HintTransaction:
    stage = str(record["stage"])
    return HintTransaction(
        request_board_setboard=record[f"{stage}_request_board_setboard"],
        setboard_response_board_setboard=record["setboard_response_board_setboard"],
        hint_response_board_setboard=record[f"{stage}_board_setboard"],
        setboard_response_board_count=int(record["setboardResponseBoardCount"]),
        hint_response_board_count=int(record["hintResponseBoardCount"]),
        hints=record["hints"],
        setboard_raw_response=record["setboardRawResponse"],
        hint_raw_response=record["hintRawResponse"],
        elapsed_seconds=float(record["elapsedSeconds"]),
    )


def audit_output(output_dir: Path, expected: int | None) -> dict[str, Any]:
    manifest = json.loads((output_dir / "run_manifest.json").read_text(encoding="utf-8"))
    stage = str(manifest["stage"])
    requested_count = int(manifest["count"])
    keys: set[tuple[str, int]] = set()
    count = board_mismatches = legality_errors = 0
    raw_response_bytes = 0
    for record in iter_committed_records(output_dir):
        count += 1
        key = (str(record["game_id"]), int(record["move_index"]))
        if key in keys:
            raise ValueError(f"duplicate key during audit: {key}")
        keys.add(key)
        task = NodeTask(**{name: record[name] for name in NodeTask.__dataclass_fields__})
        transaction = transaction_from_record(record)
        try:
            validate_hint_transaction(transaction, task.legal_moves, requested_count)
            if task.board_setboard != transaction.request_board_setboard:
                board_mismatches += 1
        except Exception:
            legality_errors += 1
        raw_response_bytes += len(record["setboardRawResponse"].encode("utf-8"))
        raw_response_bytes += len(record["hintRawResponse"].encode("utf-8"))
    ok = board_mismatches == 0 and legality_errors == 0 and (expected is None or count == expected)
    report = {
        "schema": "egaroucid-safe-audit-v1",
        "auditedAt": utc_now(),
        "stage": stage,
        "rows": count,
        "uniqueKeys": len(keys),
        "expectedRows": expected,
        "boardMismatches": board_mismatches,
        "legalityOrCompletenessErrors": legality_errors,
        "rawResponseBytes": raw_response_bytes,
        "ok": ok,
    }
    write_json(output_dir / "audit.json", report)
    if not ok:
        raise RuntimeError(f"stage audit failed: {report}")
    return report


def records_by_key(output_dir: Path) -> dict[tuple[str, int], dict[str, Any]]:
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for record in iter_committed_records(output_dir):
        key = (str(record["game_id"]), int(record["move_index"]))
        if key in result:
            raise ValueError(f"duplicate comparison key: {key}")
        result[key] = record
    return result


def hint_signature(record: dict[str, Any], metric: str) -> Any:
    hints = record["hints"]
    if metric == "hint1_move":
        return hints[0]["move"]
    if metric == "hint1_score":
        return hints[0]["score"]
    if metric == "hint1_depth":
        return hints[0]["depth"]
    if metric == "top1_move":
        return hints[0]["move"]
    if metric == "top1_move_score":
        return hints[0]["move"], hints[0]["score"]
    if metric == "ordered_moves":
        return tuple(item["move"] for item in hints)
    if metric == "unordered_moves":
        return frozenset(item["move"] for item in hints)
    if metric == "scores_by_move":
        return frozenset((item["move"], item["score"]) for item in hints)
    if metric == "ordered_move_scores":
        return tuple((item["move"], item["score"]) for item in hints)
    raise KeyError(metric)


def mismatch_keys(
    left: dict[tuple[str, int], dict[str, Any]],
    right: dict[tuple[str, int], dict[str, Any]],
    metric: str,
) -> set[tuple[str, int]]:
    return {key for key in left if hint_signature(left[key], metric) != hint_signature(right[key], metric)}


def numeric_summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "median": None, "p95": None, "max": None, "mean": None}
    ordered = sorted(values)
    p95_index = min(len(ordered) - 1, int(0.95 * (len(ordered) - 1)))
    return {
        "count": len(values),
        "min": ordered[0],
        "median": statistics.median(ordered),
        "p95": ordered[p95_index],
        "max": ordered[-1],
        "mean": statistics.fmean(ordered),
    }


def node_difference_summary(
    left: dict[tuple[str, int], dict[str, Any]],
    right: dict[tuple[str, int], dict[str, Any]],
) -> dict[str, Any]:
    absolute: list[float] = []
    relative: list[float] = []
    for key in left:
        left_nodes = float(left[key]["hints"][0]["nodes"])
        right_nodes = float(right[key]["hints"][0]["nodes"])
        absolute.append(abs(right_nodes - left_nodes))
        denominator = max(abs(left_nodes), 1.0)
        relative.append(abs(right_nodes - left_nodes) / denominator)
    return {"absolute": numeric_summary(absolute), "relative": numeric_summary(relative)}


def compare_smoke(args: argparse.Namespace) -> dict[str, Any]:
    roots = {
        "referenceA": args.reference_a.resolve(),
        "referenceB": args.reference_b.resolve(),
        "production": args.production.resolve(),
    }
    for index, path in enumerate(args.additional_reference, start=3):
        roots[f"reference{index}"] = path.resolve()
    reference_names = [name for name in roots if name != "production"]
    audits: dict[str, Any] = {}
    records: dict[str, dict[str, dict[tuple[str, int], dict[str, Any]]]] = {}
    for name, root in roots.items():
        records[name] = {}
        for stage in ("hint1", "hint6"):
            stage_dir = root / stage
            audits[f"{name}.{stage}"] = audit_output(stage_dir, args.expected)
            records[name][stage] = records_by_key(stage_dir)
    expected_keys = set(records["referenceA"]["hint1"])
    key_errors: dict[str, int] = {}
    for name in records:
        for stage in records[name]:
            keys = set(records[name][stage])
            if keys != expected_keys:
                key_errors[f"{name}.{stage}"] = len(keys.symmetric_difference(expected_keys))

    metrics_by_stage = {
        "hint1": ["hint1_move", "hint1_score", "hint1_depth"],
        "hint6": [
            "top1_move", "top1_move_score", "ordered_moves", "unordered_moves",
            "scores_by_move", "ordered_move_scores",
        ],
    }
    comparisons: dict[str, Any] = {}
    gate_errors: dict[str, Any] = {}
    for stage, metrics in metrics_by_stage.items():
        stage_report: dict[str, Any] = {"metrics": {}}
        for metric in metrics:
            baseline_pairs: dict[str, int] = {}
            for left_name, right_name in itertools.combinations(reference_names, 2):
                baseline_pairs[f"{left_name}::{right_name}"] = len(
                    mismatch_keys(records[left_name][stage], records[right_name][stage], metric)
                )
            production_pairs = {
                f"production::{name}": len(
                    mismatch_keys(records["production"][stage], records[name][stage], metric)
                )
                for name in reference_names
            }
            baseline_max = max(baseline_pairs.values())
            production_max = max(production_pairs.values())
            stage_report["metrics"][metric] = {
                "referencePairMismatchCounts": baseline_pairs,
                "referencePairMaximum": baseline_max,
                "productionVsReferenceMismatchCounts": production_pairs,
                "productionPairMaximum": production_max,
                "productionWithinReferencePairEnvelope": production_max <= baseline_max,
            }
            if production_max > baseline_max:
                gate_errors[f"{stage}.{metric}"] = {
                    "referencePairMaximum": baseline_max,
                    "productionPairMaximum": production_max,
                }
        stage_report["nodesReferencePairs"] = {
            f"{left_name}::{right_name}": node_difference_summary(
                records[left_name][stage], records[right_name][stage]
            )
            for left_name, right_name in itertools.combinations(reference_names, 2)
        }
        stage_report["nodesProductionVsReferences"] = {
            f"production::{name}": node_difference_summary(
                records["production"][stage], records[name][stage]
            )
            for name in reference_names
        }
        comparisons[stage] = stage_report

    ok = not key_errors and not gate_errors and all(item["ok"] for item in audits.values())
    report = {
        "schema": "egaroucid-safe-smoke-comparison-v1",
        "createdAt": utc_now(),
        "expectedRowsPerStage": args.expected,
        "referenceRuns": reference_names,
        "keys": len(expected_keys),
        "audits": audits,
        "keyErrors": key_errors,
        "comparisons": comparisons,
        "gateErrors": gate_errors,
        "ok": ok,
    }
    write_json(args.output.resolve(), report)
    if not ok:
        raise RuntimeError(f"smoke comparison failed; report preserved at {args.output.resolve()}")
    return report


def stress_shared_engine(args: argparse.Namespace) -> dict[str, Any]:
    tasks, sample_hash = load_sample_tasks(args.sample_manifest.resolve())
    fixed = STAGE_CONFIGS[args.stage]
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite stress output: {output}")
    work = [(cycle, task) for cycle in range(args.cycles) for task in tasks]
    engine = AtomicEgaroucid(
        args.engine.resolve(),
        level=int(fixed["level"]),
        threads=int(fixed["threads"]),
        hash_level=args.hash_level,
        use_book=bool(fixed["use_book"]),
    )
    records: list[dict[str, Any]] = []

    def run(item: tuple[int, NodeTask]) -> dict[str, Any]:
        cycle, task = item
        transaction = engine.hint_for_board(task.board_setboard, int(fixed["count"]), args.timeout)
        validate_hint_transaction(transaction, task.legal_moves, int(fixed["count"]))
        return {
            "cycle": cycle,
            "game_id": task.game_id,
            "move_index": task.move_index,
            "requestBoard": task.board_setboard,
            "consoleBoard": transaction.hint_response_board_setboard,
            "moves": [row["move"] for row in transaction.hints],
            "scores": [row["score"] for row in transaction.hints],
            "hintRawResponse": transaction.hint_raw_response,
            "setboardRawResponse": transaction.setboard_raw_response,
            "setboardConsoleBoard": transaction.setboard_response_board_setboard,
            "legalMoves": task.legal_moves,
            "hintCount": len(transaction.hints),
        }

    started = time.monotonic()
    try:
        with ThreadPoolExecutor(max_workers=args.callers) as executor:
            futures = [executor.submit(run, item) for item in work]
            for future in as_completed(futures):
                records.append(future.result())
    finally:
        engine.close()
    report = {
        "schema": "egaroucid-shared-engine-stress-v1",
        "createdAt": utc_now(),
        "stage": args.stage,
        "sampleManifest": str(args.sample_manifest.resolve()),
        "sampleSha256": sample_hash,
        "cycles": args.cycles,
        "callers": args.callers,
        "requests": len(records),
        "boardMismatches": sum(item["requestBoard"] != item["consoleBoard"] for item in records),
        "setboardBoardMismatches": sum(
            item["requestBoard"] != item["setboardConsoleBoard"] for item in records
        ),
        "engine": str(args.engine.resolve()),
        "engineSha256": sha256_file(args.engine.resolve()),
        "engineConfig": {**fixed, "hashLevel": args.hash_level, "noAutoCacheClear": True},
        "commandMatrix": str(COMMAND_MATRIX),
        "commandMatrixSha256": sha256_file(COMMAND_MATRIX),
        "scriptSha256": sha256_file(Path(__file__).resolve()),
        "elapsedSeconds": time.monotonic() - started,
        "records": records,
    }
    write_json(output, report)
    return report


def windows_memory_status() -> dict[str, int]:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memoryLoad", ctypes.c_ulong),
            ("totalPhysical", ctypes.c_ulonglong),
            ("availablePhysical", ctypes.c_ulonglong),
            ("totalPageFile", ctypes.c_ulonglong),
            ("availablePageFile", ctypes.c_ulonglong),
            ("totalVirtual", ctypes.c_ulonglong),
            ("availableVirtual", ctypes.c_ulonglong),
            ("availableExtendedVirtual", ctypes.c_ulonglong),
        ]
    status = MemoryStatus()
    status.length = ctypes.sizeof(MemoryStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError("GlobalMemoryStatusEx failed")
    return {
        "totalPhysicalBytes": status.totalPhysical,
        "availablePhysicalBytes": status.availablePhysical,
        "memoryLoadPercent": status.memoryLoad,
    }


def environment_manifest(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite environment manifest: {output}")
    engine = args.engine.resolve()
    disk = shutil.disk_usage(output.parent.resolve())
    tasklist = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
    ).stdout.splitlines()
    matching_processes: list[dict[str, str]] = []
    for row in csv.reader(tasklist):
        if len(row) >= 2 and any(token in row[0].lower() for token in ("egaroucid", "python")):
            matching_processes.append({"image": row[0], "pid": row[1]})
    nvidia = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
    ).stdout.strip()
    import torch

    evidence = []
    for path in args.evidence:
        resolved = path.resolve()
        evidence.append(
            {"path": str(resolved), "sizeBytes": resolved.stat().st_size, "sha256": sha256_file(resolved)}
        )
    report = {
        "schema": "egaroucid-safe-environment-v1",
        "createdAt": utc_now(),
        "platform": platform.platform(),
        "processor": platform.processor(),
        "logicalCpuCount": os.cpu_count(),
        "memory": windows_memory_status(),
        "disk": {"path": str(output.parent.resolve()), "totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
        "python": sys.version,
        "torch": {
            "version": torch.__version__,
            "cudaAvailable": torch.cuda.is_available(),
            "cudaVersion": torch.version.cuda,
            "deviceCount": torch.cuda.device_count(),
            "deviceName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        },
        "nvidiaSmi": nvidia,
        "matchingProcesses": matching_processes,
        "engine": {"path": str(engine), "sizeBytes": engine.stat().st_size, "sha256": sha256_file(engine)},
        "commandMatrix": {"path": str(COMMAND_MATRIX), "sha256": sha256_file(COMMAND_MATRIX)},
        "safeModule": {"path": str((ROOT / 'src' / 'egaroucid_safe.py').resolve()), "sha256": sha256_file(ROOT / 'src' / 'egaroucid_safe.py')},
        "runner": {"path": str(Path(__file__).resolve()), "sha256": sha256_file(Path(__file__).resolve())},
        "evidence": evidence,
    }
    write_json(output, report)
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    sample = commands.add_parser("sample", help="build the fixed, coverage-aware smoke sample")
    sample.add_argument("--source-csv", required=True, type=Path)
    sample.add_argument("--output", required=True, type=Path)
    sample.add_argument("--sample-size", type=int, default=100)
    sample.add_argument("--seed", type=int, default=20260804)

    run = commands.add_parser("run", help="run or resume one immutable hint stage")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-csv", type=Path)
    source.add_argument("--sample-manifest", type=Path)
    run.add_argument("--stage", required=True, choices=sorted(STAGE_CONFIGS))
    run.add_argument("--engine", required=True, type=Path)
    run.add_argument("--output-dir", required=True, type=Path)
    run.add_argument("--workers", type=int, default=1)
    run.add_argument("--hash-level", type=int, default=25)
    run.add_argument("--batch-size", type=int, default=64)
    run.add_argument("--timeout", type=float, default=900.0)
    run.add_argument("--max-attempts", type=int, default=2)
    run.add_argument("--limit", type=int, default=0)
    run.add_argument("--resume", action="store_true")

    audit = commands.add_parser("audit", help="audit all committed batches")
    audit.add_argument("--output-dir", required=True, type=Path)
    audit.add_argument("--expected", type=int)

    stress = commands.add_parser("stress", help="hammer one shared engine through its atomic API")
    stress.add_argument("--sample-manifest", required=True, type=Path)
    stress.add_argument("--stage", required=True, choices=sorted(STAGE_CONFIGS))
    stress.add_argument("--engine", required=True, type=Path)
    stress.add_argument("--output", required=True, type=Path)
    stress.add_argument("--cycles", type=int, default=3)
    stress.add_argument("--callers", type=int, default=8)
    stress.add_argument("--hash-level", type=int, default=25)
    stress.add_argument("--timeout", type=float, default=900.0)

    compare = commands.add_parser("compare", help="compare repeated reference and production smoke runs")
    compare.add_argument("--reference-a", required=True, type=Path)
    compare.add_argument("--reference-b", required=True, type=Path)
    compare.add_argument("--production", required=True, type=Path)
    compare.add_argument("--additional-reference", action="append", default=[], type=Path)
    compare.add_argument("--output", required=True, type=Path)
    compare.add_argument("--expected", type=int, default=100)

    environment = commands.add_parser("environment", help="freeze hardware, CUDA, process, and evidence hashes")
    environment.add_argument("--engine", required=True, type=Path)
    environment.add_argument("--output", required=True, type=Path)
    environment.add_argument("--evidence", action="append", default=[], type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    if getattr(args, "workers", 1) <= 0:
        raise ValueError("--workers must be positive")
    if args.command == "sample":
        report = build_sample(args.source_csv.resolve(), args.output.resolve(), args.sample_size, args.seed)
    elif args.command == "run":
        report = run_stage(args)
    elif args.command == "audit":
        report = audit_output(args.output_dir.resolve(), args.expected)
    elif args.command == "compare":
        report = compare_smoke(args)
    elif args.command == "environment":
        report = environment_manifest(args)
    else:
        report = stress_shared_engine(args)
    printed = report
    if args.command == "stress" and "records" in report:
        printed = {key: value for key, value in report.items() if key != "records"}
        printed["recordsStoredIn"] = str(args.output.resolve())
    print(json.dumps(printed, ensure_ascii=False, indent=2))
    return 1 if report.get("status") == "failed" or report.get("ok") is False else 0


if __name__ == "__main__":
    raise SystemExit(main())
