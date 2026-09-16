from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import pandas as pd


METADATA_PATH = Path("oq_reversi_5min_elo2000_hints/position_context_metadata.csv")
FREQUENCY_LOOKUP_PATH = Path("oq_reversi_5min_elo2000_hints/human_opening_frequency_lookup.csv")
FREQUENCY_SUMMARY_PATH = Path("oq_reversi_5min_elo2000_hints/human_opening_frequency_summary.json")
DEFAULT_BOOK_PATH = Path(
    os.environ.get(
        "PAPP_HUMAN_FREQUENCY_BOOK",
        "othelloquest_human_frequency_nodes_ply1_30_min5.runtime.json",
    )
)


def normalize_board(board: Any) -> str:
    text = str(board).upper().replace(".", "-")
    chars = [(ch if ch in {"X", "O"} else "-") for ch in text[:64].ljust(64, "-")]
    return "".join(chars)


def normalize_side(side: Any) -> str:
    text = str(side).strip().upper()
    if text in {"BLACK", "B", "X"}:
        return "X"
    if text in {"WHITE", "W", "O"}:
        return "O"
    return "X"


def to_current_player_view(board: str, side: str) -> str:
    if side == "X":
        return board
    return "".join("X" if ch == "O" else "O" if ch == "X" else "-" for ch in board)


def transform_board64(board: str, mode: int) -> str:
    out = ["-"] * 64
    for r in range(8):
        for c in range(8):
            if mode == 0:
                dst = r * 8 + c
            elif mode == 1:
                dst = (7 - r) * 8 + c
            elif mode == 2:
                dst = r * 8 + (7 - c)
            elif mode == 3:
                dst = (7 - r) * 8 + (7 - c)
            elif mode == 4:
                dst = c * 8 + r
            elif mode == 5:
                dst = (7 - c) * 8 + (7 - r)
            elif mode == 6:
                dst = c * 8 + (7 - r)
            else:
                dst = (7 - c) * 8 + r
            out[dst] = board[r * 8 + c]
    return "".join(out)


def canonicalize_board64(board: str) -> str:
    return min(transform_board64(board, mode) for mode in range(8))


def metadata_key(board: Any, side: Any) -> str:
    board64 = normalize_board(board)
    side_disc = normalize_side(side)
    return canonicalize_board64(to_current_player_view(board64, side_disc))


def load_human_opening_book(path: Path) -> tuple[dict[str, int], dict[int, int], dict[int, int], int]:
    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    counts: dict[str, int] = {}
    ply_frequency: dict[int, int] = {}
    ply_node_count: dict[int, int] = {}
    total_frequency = 0
    for node in payload.get("nodes", []):
        if not isinstance(node, list) or len(node) < 3:
            continue
        board_string, count, ply = node[0], node[1], node[2]
        if not isinstance(board_string, str) or len(board_string) != 64:
            continue
        count_int = int(count)
        ply_int = int(ply)
        counts[board_string] = count_int
        ply_frequency[ply_int] = ply_frequency.get(ply_int, 0) + count_int
        ply_node_count[ply_int] = ply_node_count.get(ply_int, 0) + 1
        total_frequency += count_int
    return counts, ply_frequency, ply_node_count, total_frequency


def write_frequency_lookup(
    path: Path,
    summary_path: Path,
    ply_frequency: dict[int, int],
    ply_node_count: dict[int, int],
    total_frequency: int,
    book_path: Path,
) -> None:
    rows = []
    for ply in sorted(ply_frequency):
        frequency = int(ply_frequency[ply])
        rows.append(
            {
                "ply": int(ply),
                "ply_total_frequency": frequency,
                "ply_node_count": int(ply_node_count.get(ply, 0)),
                "all_ply_total_frequency": int(total_frequency),
                "ply_frequency_ratio_of_all": frequency / total_frequency if total_frequency else 0.0,
            }
        )
    lookup = pd.DataFrame(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    lookup.to_csv(tmp, index=False)
    os.replace(tmp, path)

    summary = {
        "book_path": str(book_path),
        "min_ply": int(min(ply_frequency)) if ply_frequency else None,
        "max_ply": int(max(ply_frequency)) if ply_frequency else None,
        "ply_count": int(len(ply_frequency)),
        "total_frequency": int(total_frequency),
        "total_node_count": int(sum(ply_node_count.values())),
        "lookup_path": str(path),
    }
    tmp_summary = summary_path.with_suffix(summary_path.suffix + ".tmp")
    tmp_summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp_summary, summary_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", type=Path, default=METADATA_PATH)
    parser.add_argument("--book", type=Path, default=DEFAULT_BOOK_PATH)
    parser.add_argument("--frequency-lookup-out", type=Path, default=FREQUENCY_LOOKUP_PATH)
    parser.add_argument("--frequency-summary-out", type=Path, default=FREQUENCY_SUMMARY_PATH)
    parser.add_argument("--min-ply", type=int, default=1)
    parser.add_argument("--max-ply", type=int, default=30)
    parser.add_argument("--skip-metadata", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    counts, ply_frequency, ply_node_count, total_frequency = load_human_opening_book(args.book)
    write_frequency_lookup(
        args.frequency_lookup_out,
        args.frequency_summary_out,
        ply_frequency,
        ply_node_count,
        total_frequency,
        args.book,
    )

    if args.skip_metadata:
        print(
            f"Wrote {args.frequency_lookup_out} ply_count={len(ply_frequency)} "
            f"total_frequency={total_frequency} book_nodes={len(counts)}"
        )
        return

    df = pd.read_csv(args.metadata, low_memory=False)
    required = {"board", "normalized_side_to_move", "ply"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"metadata missing required columns: {missing}")

    stale_child_columns = [
        "human_opening_child_candidate_count",
        "human_opening_child_coverage_ratio",
        "human_opening_child_total_count",
        "human_opening_child_max_count",
        "human_opening_child_max_ratio",
        "human_opening_child_entropy",
        "human_opening_child_top1_top2_ratio",
        "human_opening_child_top1_share",
        "human_opening_child_top1_margin_ratio",
        "human_opening_offbook",
    ]
    df = df.drop(columns=[c for c in stale_child_columns if c in df.columns], errors="ignore")

    ply = pd.to_numeric(df["ply"], errors="coerce")
    in_range = ply.between(args.min_ply, args.max_ply, inclusive="both")
    unique = df.loc[in_range, ["board", "normalized_side_to_move"]].drop_duplicates().copy()
    key_counts = {
        (row.board, row.normalized_side_to_move): counts.get(metadata_key(row.board, row.normalized_side_to_move), 0)
        for row in unique.itertuples(index=False)
    }

    df["human_opening_book_count"] = 0
    if not unique.empty:
        pairs = list(zip(df.loc[in_range, "board"], df.loc[in_range, "normalized_side_to_move"]))
        df.loc[in_range, "human_opening_book_count"] = [key_counts[pair] for pair in pairs]
    df["human_opening_book_hit"] = (df["human_opening_book_count"] > 0).astype(int)
    df["human_opening_book_ply"] = df["board"].map(normalize_board).map(lambda board: 64 - board.count("-") - 4)
    df["human_opening_total_frequency"] = int(total_frequency)
    df["human_opening_ply_total_frequency"] = (
        df["human_opening_book_ply"].map(lambda ply_value: int(ply_frequency.get(int(ply_value), 0))).astype("int64")
    )
    df["human_opening_total_frequency_ratio"] = 0.0
    if total_frequency > 0:
        df.loc[in_range, "human_opening_total_frequency_ratio"] = (
            pd.to_numeric(df.loc[in_range, "human_opening_book_count"], errors="coerce").fillna(0.0)
            / float(total_frequency)
        )
    df["human_opening_ply_frequency_ratio"] = 0.0
    ply_total_positive = pd.to_numeric(df["human_opening_ply_total_frequency"], errors="coerce").fillna(0).gt(0)
    ratio_mask = in_range & ply_total_positive
    df.loc[ratio_mask, "human_opening_ply_frequency_ratio"] = (
        pd.to_numeric(df.loc[ratio_mask, "human_opening_book_count"], errors="coerce").fillna(0.0)
        / pd.to_numeric(df.loc[ratio_mask, "human_opening_ply_total_frequency"], errors="coerce").fillna(0.0)
    )

    df["human_opening_parent_book_count"] = 0
    if "game_id" in df.columns:
        sort_cols = [c for c in ["game_id", "move_index", "ply"] if c in df.columns]
        sorted_index = df.sort_values(sort_cols).index
        df.loc[sorted_index, "human_opening_parent_book_count"] = (
            df.loc[sorted_index]
            .groupby("game_id", sort=False)["human_opening_book_count"]
            .shift(1)
            .fillna(0)
            .astype("int64")
        )
    df["human_opening_parent_child_ratio"] = 0.0
    parent_positive = pd.to_numeric(df["human_opening_parent_book_count"], errors="coerce").fillna(0).gt(0)
    parent_ratio_mask = in_range & parent_positive
    df.loc[parent_ratio_mask, "human_opening_parent_child_ratio"] = (
        pd.to_numeric(df.loc[parent_ratio_mask, "human_opening_book_count"], errors="coerce").fillna(0.0)
        / pd.to_numeric(df.loc[parent_ratio_mask, "human_opening_parent_book_count"], errors="coerce").fillna(0.0)
    )
    df["human_opening_parent_child_ratio_capped"] = (
        pd.to_numeric(df["human_opening_parent_child_ratio"], errors="coerce").fillna(0.0).clip(lower=0.0, upper=1.0)
    )

    tmp = args.metadata.with_suffix(args.metadata.suffix + ".tmp")
    df.to_csv(tmp, index=False)
    os.replace(tmp, args.metadata)

    matched = int((df["human_opening_book_count"] > 0).sum())
    print(
        f"Wrote {args.metadata} rows={len(df)} "
        f"ply_range_rows={int(in_range.sum())} matched_rows={matched} "
        f"book_nodes={len(counts)} total_frequency={total_frequency} "
        f"lookup={args.frequency_lookup_out}"
    )


if __name__ == "__main__":
    main()
