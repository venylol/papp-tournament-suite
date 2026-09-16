from __future__ import annotations

import json
import math
import pickle
import re
import shutil
import zipfile
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ModuleNotFoundError:
    plt = None
import numpy as np
import pandas as pd
try:
    from catboost import CatBoostRegressor, Pool
except ModuleNotFoundError:
    CatBoostRegressor = None
    Pool = None
from scipy.stats import spearmanr
from sklearn.metrics import r2_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split


RANDOM_STATE = 42
MAX_ROWS = None
MODEL_NAME = "game_context_unified_pre_move_time_model"

DATA_CANDIDATES = [
    Path("/mnt/data/oq_human_time_database_package_20260701_unpacked/research/oq_reversi_5min_elo2000_hints/position_hints.csv"),
    Path("oq_reversi_5min_elo2000_hints/position_hints.csv"),
]
OUT_DIR = Path("/mnt/data/unified_time_model_outputs")
ZIP_PATH = Path("/mnt/data/unified_time_model_outputs.zip")


def find_data_path() -> Path:
    for path in DATA_CANDIDATES:
        if path.exists():
            return path
    raise FileNotFoundError("position_hints.csv not found in expected locations")


def parse_depth_value(value):
    if pd.isna(value):
        return np.nan
    if isinstance(value, (int, float, np.integer, np.floating)):
        return float(value)
    match = re.search(r"\d+(?:\.\d+)?", str(value))
    return float(match.group(0)) if match else np.nan


def parse_time_limit_ms(series: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().any():
        return numeric
    extracted = series.astype(str).str.extract(r"(\d+(?:\.\d+)?)", expand=False)
    return pd.to_numeric(extracted, errors="coerce")


def add_history_features(df: pd.DataFrame) -> pd.DataFrame:
    sort_cols = [c for c in ["game_id", "ply", "move_index"] if c in df.columns]
    if sort_cols:
        df = df.sort_values(sort_cols).reset_index(drop=True)

    if "game_id" not in df.columns or "actual_thinking_time_ms" not in df.columns:
        return df

    time_ms = pd.to_numeric(df["actual_thinking_time_ms"], errors="coerce")
    g = time_ms.groupby(df["game_id"], sort=False)

    for lag in [1, 2, 3, 4, 5, 6, 7, 8]:
        df[f"lag_{lag}_time_ms"] = g.shift(lag)

    df["prev_opponent_time_ms"] = df["lag_1_time_ms"]
    if "player_id" in df.columns:
        player_keys = [df["game_id"], df["player_id"]]
        gp = time_ms.groupby(player_keys, sort=False)
        df["prev_same_player_time_ms"] = gp.shift(1)
        if "cum_time_before_ms" not in df.columns:
            df["cum_time_before_ms"] = gp.cumsum() - time_ms
    else:
        df["prev_same_player_time_ms"] = g.shift(2)
        if "cum_time_before_ms" not in df.columns:
            df["cum_time_before_ms"] = g.cumsum() - time_ms

    if "time_limit_ms" in df.columns and "remaining_before_ms" not in df.columns:
        df["remaining_before_ms"] = (
            pd.to_numeric(df["time_limit_ms"], errors="coerce")
            - pd.to_numeric(df["cum_time_before_ms"], errors="coerce")
        ).clip(lower=0)

    for window in [2, 4, 8]:
        shifted = g.shift(1)
        df[f"last_{window}_time_avg_ms"] = (
            shifted.groupby(df["game_id"], sort=False)
            .rolling(window, min_periods=1)
            .mean()
            .reset_index(level=0, drop=True)
        )
        df[f"last_{window}_time_median_ms"] = (
            shifted.groupby(df["game_id"], sort=False)
            .rolling(window, min_periods=1)
            .median()
            .reset_index(level=0, drop=True)
        )
        df[f"last_{window}_slow_count_5s"] = (
            shifted.gt(5000)
            .groupby(df["game_id"], sort=False)
            .rolling(window, min_periods=1)
            .sum()
            .reset_index(level=0, drop=True)
        )
        df[f"last_{window}_slow_count_10s"] = (
            shifted.gt(10000)
            .groupby(df["game_id"], sort=False)
            .rolling(window, min_periods=1)
            .sum()
            .reset_index(level=0, drop=True)
        )

    shifted = g.shift(1)
    df["last_8_time_std_ms"] = (
        shifted.groupby(df["game_id"], sort=False)
        .rolling(8, min_periods=2)
        .std()
        .reset_index(level=0, drop=True)
    )
    df["recent_max_time_ms"] = (
        shifted.groupby(df["game_id"], sort=False)
        .rolling(8, min_periods=1)
        .max()
        .reset_index(level=0, drop=True)
    )
    df["prev_move_was_slow_5s"] = df["prev_opponent_time_ms"].gt(5000).astype(int)
    df["prev_move_was_slow_10s"] = df["prev_opponent_time_ms"].gt(10000).astype(int)
    df["prev_same_player_was_slow_5s"] = df["prev_same_player_time_ms"].gt(5000).astype(int)
    df["prev_same_player_was_slow_10s"] = df["prev_same_player_time_ms"].gt(10000).astype(int)

    for window in [2, 4, 8]:
        if "player_id" in df.columns:
            same_shifted = pd.to_numeric(df["actual_thinking_time_ms"], errors="coerce").groupby(
                [df["game_id"], df["player_id"]], sort=False
            ).shift(1)
            df[f"same_player_last_{window}_time_avg_ms"] = (
                same_shifted.groupby([df["game_id"], df["player_id"]], sort=False)
                .rolling(window, min_periods=1)
                .mean()
                .reset_index(level=[0, 1], drop=True)
            )
            df[f"same_player_last_{window}_time_median_ms"] = (
                same_shifted.groupby([df["game_id"], df["player_id"]], sort=False)
                .rolling(window, min_periods=1)
                .median()
                .reset_index(level=[0, 1], drop=True)
            )
            df[f"same_player_last_{window}_time_max_ms"] = (
                same_shifted.groupby([df["game_id"], df["player_id"]], sort=False)
                .rolling(window, min_periods=1)
                .max()
                .reset_index(level=[0, 1], drop=True)
            )

    opponent_lags = [c for c in ["lag_1_time_ms", "lag_3_time_ms", "lag_5_time_ms", "lag_7_time_ms"] if c in df.columns]
    if opponent_lags:
        df["opponent_last_4_time_avg_ms"] = df[opponent_lags].mean(axis=1)
        df["opponent_last_4_time_median_ms"] = df[opponent_lags].median(axis=1)
        df["opponent_last_4_time_max_ms"] = df[opponent_lags].max(axis=1)

    complexity_sources = [
        c
        for c in [
            "n_legal_moves",
            "hint1_nodes",
            "hint1_nodes_sum",
            "hint1_nodes_mean",
            "hint6_nodes_sum",
            "hint6_nodes_mean",
            "hint6_score_std",
            "hint6_score_gap_1_2",
            "hint6_score_gap_1_3",
            "hint_best_score_abs_diff",
            "hint6_book_count",
            "hint1_book_count",
        ]
        if c in df.columns
    ]
    for col in complexity_sources:
        values = pd.to_numeric(df[col], errors="coerce")
        shifted_values = values.groupby(df["game_id"], sort=False).shift(1)
        for window in [4, 8]:
            df[f"recent_{window}_{col}_avg"] = (
                shifted_values.groupby(df["game_id"], sort=False)
                .rolling(window, min_periods=1)
                .mean()
                .reset_index(level=0, drop=True)
            )

    return df


def add_engine_features(df: pd.DataFrame) -> pd.DataFrame:
    if "tcb" in df.columns:
        df["time_limit_ms"] = parse_time_limit_ms(df["tcb"])

    if "remaining_before_ms" in df.columns:
        df["remaining_before_s"] = pd.to_numeric(df["remaining_before_ms"], errors="coerce") / 1000.0
    elif "time_limit_ms" in df.columns and "cum_time_before_ms" in df.columns:
        df["remaining_before_s"] = (
            pd.to_numeric(df["time_limit_ms"], errors="coerce")
            - pd.to_numeric(df["cum_time_before_ms"], errors="coerce")
        ) / 1000.0

    if "cum_time_before_ms" in df.columns:
        df["cum_time_before_s"] = pd.to_numeric(df["cum_time_before_ms"], errors="coerce") / 1000.0

    for col in [c for c in df.columns if c.endswith("_time_ms") or c in {"cum_time_before_ms", "remaining_before_ms", "time_limit_ms"}]:
        df[col.replace("_ms", "_s")] = pd.to_numeric(df[col], errors="coerce") / 1000.0

    if "time_limit_ms" in df.columns:
        limit = pd.to_numeric(df["time_limit_ms"], errors="coerce")
        if "cum_time_before_ms" in df.columns:
            df["used_ratio"] = pd.to_numeric(df["cum_time_before_ms"], errors="coerce") / limit.replace(0, np.nan)
        if "remaining_before_ms" in df.columns:
            df["remaining_ratio"] = pd.to_numeric(df["remaining_before_ms"], errors="coerce") / limit.replace(0, np.nan)

    if "remaining_before_s" in df.columns:
        df["time_pressure"] = 1.0 / (pd.to_numeric(df["remaining_before_s"], errors="coerce") + 1.0)

    depth_cols = [c for c in df.columns if c.endswith("_depth")]
    for col in depth_cols:
        df[f"{col}_num"] = df[col].map(parse_depth_value)

    hint1_scores = [c for c in ["hint1_score"] if c in df.columns]
    hint1_nodes = [c for c in ["hint1_nodes"] if c in df.columns]
    hint1_depths = [c for c in ["hint1_depth_num"] if c in df.columns]
    hint1_books = [c for c in ["hint1_is_book"] if c in df.columns]

    hint6_scores = [f"hint6_{i}_score" for i in range(1, 7) if f"hint6_{i}_score" in df.columns]
    hint6_nodes = [f"hint6_{i}_nodes" for i in range(1, 7) if f"hint6_{i}_nodes" in df.columns]
    hint6_depths = [f"hint6_{i}_depth_num" for i in range(1, 7) if f"hint6_{i}_depth_num" in df.columns]
    hint6_books = [f"hint6_{i}_is_book" for i in range(1, 7) if f"hint6_{i}_is_book" in df.columns]

    add_agg(df, "hint1", hint1_scores, hint1_nodes, hint1_depths, hint1_books)
    add_agg(df, "hint6", hint6_scores, hint6_nodes, hint6_depths, hint6_books)

    if "hint1_move" in df.columns and "hint6_1_move" in df.columns:
        df["hint_best_move_same"] = (df["hint1_move"].astype(str) == df["hint6_1_move"].astype(str)).astype(int)

    if "hint1_score" in df.columns and "hint6_1_score" in df.columns:
        df["hint_best_score_diff"] = (
            pd.to_numeric(df["hint1_score"], errors="coerce")
            - pd.to_numeric(df["hint6_1_score"], errors="coerce")
        )
        df["hint_best_score_abs_diff"] = df["hint_best_score_diff"].abs()

    hint6_moves = [f"hint6_{i}_move" for i in range(1, 7) if f"hint6_{i}_move" in df.columns]
    if "hint1_move" in df.columns and hint6_moves:
        h1 = df["hint1_move"].astype(str)
        in_top6 = np.zeros(len(df), dtype=bool)
        for col in hint6_moves:
            in_top6 |= h1.eq(df[col].astype(str)).to_numpy()
        df["hint1_best_in_hint6_top6"] = in_top6.astype(int)

    return df


def add_agg(df: pd.DataFrame, prefix: str, score_cols, node_cols, depth_cols, book_cols) -> None:
    if score_cols:
        scores = df[score_cols].apply(pd.to_numeric, errors="coerce")
        df[f"{prefix}_score_max"] = scores.max(axis=1)
        df[f"{prefix}_score_min"] = scores.min(axis=1)
        df[f"{prefix}_score_mean"] = scores.mean(axis=1)
        df[f"{prefix}_score_std"] = scores.std(axis=1).fillna(0)
        ordered_cols = score_cols[:3]
        if len(ordered_cols) >= 2:
            df[f"{prefix}_score_gap_1_2"] = scores[ordered_cols[0]] - scores[ordered_cols[1]]
        else:
            df[f"{prefix}_score_gap_1_2"] = 0.0
        if len(ordered_cols) >= 3:
            df[f"{prefix}_score_gap_1_3"] = scores[ordered_cols[0]] - scores[ordered_cols[2]]
        else:
            df[f"{prefix}_score_gap_1_3"] = df[f"{prefix}_score_gap_1_2"]

    if node_cols:
        nodes = df[node_cols].apply(pd.to_numeric, errors="coerce")
        df[f"{prefix}_nodes_max"] = nodes.max(axis=1)
        df[f"{prefix}_nodes_sum"] = nodes.sum(axis=1)
        df[f"{prefix}_nodes_mean"] = nodes.mean(axis=1)
        df[f"{prefix}_nodes_std"] = nodes.std(axis=1).fillna(0)

    if depth_cols:
        depths = df[depth_cols].apply(pd.to_numeric, errors="coerce")
        df[f"{prefix}_depth_max"] = depths.max(axis=1)
        df[f"{prefix}_depth_mean"] = depths.mean(axis=1)

    if book_cols:
        book_mapping = {True: 1, False: 0, "True": 1, "False": 0, "true": 1, "false": 0}
        books = df[book_cols].apply(lambda column: column.map(book_mapping))
        books = books.apply(pd.to_numeric, errors="coerce")
        df[f"{prefix}_book_count"] = books.sum(axis=1)


def select_features(df: pd.DataFrame):
    forbidden_exact = {
        "actual_move",
        "actual_thinking_time_ms",
        "board",
        "legal_moves",
        "finalStatus",
        "analyzed_at",
        "created",
        "game_id",
    }
    forbidden_prefix = ("actual_", "score_loss", "actual_rank", "actual_is")

    features = []
    categorical = []
    for col in df.columns:
        if col in forbidden_exact or col == "target_log":
            continue
        if any(col.startswith(p) for p in forbidden_prefix):
            continue
        if df[col].dtype == "object" or str(df[col].dtype) == "category":
            if col.endswith("_depth"):
                continue
            features.append(col)
            categorical.append(col)
        elif pd.api.types.is_bool_dtype(df[col]) or pd.api.types.is_numeric_dtype(df[col]):
            features.append(col)
            if pd.api.types.is_bool_dtype(df[col]):
                categorical.append(col)

    return features, categorical


def clean_feature_frame(X: pd.DataFrame, categorical: list[str]) -> pd.DataFrame:
    X = X.copy()
    cat_set = set(categorical)
    for col in X.columns:
        if col in cat_set:
            X[col] = X[col].astype("string").fillna("__MISSING__").astype(str)
        else:
            X[col] = pd.to_numeric(X[col], errors="coerce")
            X[col] = X[col].replace([np.inf, -np.inf], np.nan)
    return X


def capped_seconds(pred_log: np.ndarray, remaining_before_s=None) -> np.ndarray:
    pred_s = np.expm1(pred_log)
    if remaining_before_s is not None:
        rem = pd.to_numeric(remaining_before_s, errors="coerce").to_numpy()
        cap = rem * 0.95
        pred_s = np.where(np.isfinite(cap), np.minimum(pred_s, cap), pred_s)
    return np.maximum(pred_s, 0.05)


def frame_to_markdown(df: pd.DataFrame) -> str:
    view = df.copy()
    for col in view.columns:
        if pd.api.types.is_float_dtype(view[col]):
            view[col] = view[col].map(lambda x: "" if pd.isna(x) else f"{x:.6g}")
        else:
            view[col] = view[col].astype(str)
    header = "| " + " | ".join(view.columns.astype(str)) + " |"
    sep = "| " + " | ".join(["---"] * len(view.columns)) + " |"
    rows = ["| " + " | ".join(row) + " |" for row in view.astype(str).to_numpy()]
    return "\n".join([header, sep, *rows])


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old_path in OUT_DIR.iterdir():
        if old_path.is_file():
            old_path.unlink()
    data_path = find_data_path()

    df = pd.read_csv(data_path, low_memory=False)
    df = df[pd.to_numeric(df["actual_thinking_time_ms"], errors="coerce").notna()].copy()
    df["actual_thinking_time_ms"] = pd.to_numeric(df["actual_thinking_time_ms"], errors="coerce").clip(lower=0)
    df["target_log"] = np.log1p(df["actual_thinking_time_ms"] / 1000.0)

    df = add_engine_features(df)
    df = add_history_features(df)
    df = add_engine_features(df)

    if MAX_ROWS and len(df) > MAX_ROWS:
        df = df.sample(n=MAX_ROWS, random_state=RANDOM_STATE).reset_index(drop=True)

    features, categorical = select_features(df)
    X = clean_feature_frame(df[features], categorical)
    y = df["target_log"].to_numpy()

    if "game_id" in df.columns:
        splitter = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=RANDOM_STATE)
        train_idx, test_idx = next(splitter.split(X, y, groups=df["game_id"]))
    else:
        train_idx, test_idx = train_test_split(np.arange(len(df)), test_size=0.2, random_state=RANDOM_STATE)

    cat_idx = [X.columns.get_loc(c) for c in categorical if c in X.columns]
    train_pool = Pool(X.iloc[train_idx], y[train_idx], cat_features=cat_idx)
    test_pool = Pool(X.iloc[test_idx], y[test_idx], cat_features=cat_idx)

    model = CatBoostRegressor(
        loss_function="RMSE",
        eval_metric="RMSE",
        iterations=700,
        learning_rate=0.07,
        depth=8,
        l2_leaf_reg=6,
        random_seed=RANDOM_STATE,
        od_type="Iter",
        od_wait=60,
        verbose=100,
        allow_writing_files=False,
        thread_count=-1,
    )
    model.fit(train_pool, eval_set=test_pool, use_best_model=True)

    pred_log = model.predict(test_pool)
    remaining = X.iloc[test_idx]["remaining_before_s"] if "remaining_before_s" in X.columns else None
    pred_s = capped_seconds(pred_log, remaining)
    actual_s = df.iloc[test_idx]["actual_thinking_time_ms"].to_numpy() / 1000.0

    mae_s = float(np.mean(np.abs(pred_s - actual_s)))
    medae_s = float(np.median(np.abs(pred_s - actual_s)))
    rmse_log = float(math.sqrt(np.mean((pred_log - y[test_idx]) ** 2)))
    r2_seconds = float(r2_score(actual_s, pred_s))
    r2_log = float(r2_score(y[test_idx], pred_log))
    spear = spearmanr(pred_s, actual_s, nan_policy="omit").statistic
    spearman_value = float(spear) if pd.notna(spear) else np.nan

    metrics = pd.DataFrame(
        [
            {"metric": "MAE_seconds", "value": mae_s},
            {"metric": "Median_AE_seconds", "value": medae_s},
            {"metric": "RMSE_log", "value": rmse_log},
            {"metric": "R2_seconds", "value": r2_seconds},
            {"metric": "R2_log", "value": r2_log},
            {"metric": "Spearman_pred_seconds_vs_actual_seconds", "value": spearman_value},
            {"metric": "n_train", "value": int(len(train_idx))},
            {"metric": "n_test", "value": int(len(test_idx))},
            {"metric": "n_features", "value": int(len(features))},
            {"metric": "train_games", "value": int(df.iloc[train_idx]["game_id"].nunique()) if "game_id" in df.columns else np.nan},
            {"metric": "test_games", "value": int(df.iloc[test_idx]["game_id"].nunique()) if "game_id" in df.columns else np.nan},
        ]
    )

    pred_df = pd.DataFrame(
        {
            "pred_s": pred_s,
            "actual_s": actual_s,
            "pred_log": pred_log,
            "actual_log": y[test_idx],
        }
    )
    pred_df["pred_decile"] = pd.qcut(pred_df["pred_s"], q=10, labels=False, duplicates="drop")
    bins = (
        pred_df.groupby("pred_decile", dropna=False)
        .agg(
            count=("actual_s", "size"),
            pred_mean_s=("pred_s", "mean"),
            actual_mean_s=("actual_s", "mean"),
            actual_median_s=("actual_s", "median"),
        )
        .reset_index()
    )

    importance = pd.DataFrame(
        {
            "feature": X.columns,
            "importance": model.get_feature_importance(train_pool, type="FeatureImportance"),
        }
    ).sort_values("importance", ascending=False)

    sample_cols = [c for c in ["game_id", "ply", "move_index", "player_id", "side_to_move", "remaining_before_s"] if c in df.columns]
    all_predictions = df.iloc[test_idx][sample_cols].reset_index(drop=True)
    all_predictions = pd.concat([all_predictions, pred_df.reset_index(drop=True)], axis=1)
    sample = all_predictions.head(1000)

    plot_df = all_predictions[["actual_s", "pred_s"]].replace([np.inf, -np.inf], np.nan).dropna()
    if len(plot_df) > 25000:
        plot_df = plot_df.sample(25000, random_state=RANDOM_STATE)
    max_s = float(np.nanpercentile(np.r_[plot_df["actual_s"].to_numpy(), plot_df["pred_s"].to_numpy()], 99.5))
    max_s = max(max_s, 1.0)
    fig, ax = plt.subplots(figsize=(7.2, 6.0), dpi=160)
    ax.scatter(plot_df["actual_s"], plot_df["pred_s"], s=7, alpha=0.22, linewidths=0)
    ax.plot([0, max_s], [0, max_s], color="black", linewidth=1.2)
    ax.set_xlim(0, max_s)
    ax.set_ylim(0, max_s)
    ax.set_xlabel("Actual thinking time (s)")
    ax.set_ylabel("Predicted thinking time (s)")
    ax.set_title(
        f"Unified pre-move time model: pred vs actual\n"
        f"R2 seconds={r2_seconds:.4f}, R2 log={r2_log:.4f}, Spearman={spearman_value:.4f}"
    )
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "scatter_pred_vs_actual_seconds.png")
    plt.close(fig)

    metrics.to_csv(OUT_DIR / "metrics.csv", index=False)
    metrics.to_csv(OUT_DIR / "metrics_with_r2.csv", index=False)
    bins.to_csv(OUT_DIR / "prediction_bins.csv", index=False)
    importance.to_csv(OUT_DIR / "feature_importance.csv", index=False)
    sample.to_csv(OUT_DIR / "sample_predictions.csv", index=False)
    all_predictions.to_csv(OUT_DIR / "test_predictions_full.csv", index=False)
    model.save_model(OUT_DIR / f"{MODEL_NAME}.cbm")
    with open(OUT_DIR / f"{MODEL_NAME}.pkl", "wb") as f:
        pickle.dump({"model": model, "features": features, "categorical": categorical}, f)

    summary = [
        f"# {MODEL_NAME}",
        "",
        f"- data: `{data_path}`",
        "- model: `CatBoostRegressor`",
        f"- rows used: `{len(df)}`",
        f"- train rows: `{len(train_idx)}`",
        f"- test rows: `{len(test_idx)}`",
        f"- features: `{len(features)}`",
        "",
        "## Metrics",
        frame_to_markdown(metrics),
        "",
        "## Top 30 Feature Importance",
        frame_to_markdown(importance.head(30)),
        "",
        "## Prediction Bins",
        frame_to_markdown(bins),
        "",
        "Inference cap: `pred_s = max(min(expm1(pred_log), remaining_before_s * 0.95), 0.05)` when `remaining_before_s` exists.",
    ]
    (OUT_DIR / "summary.md").write_text("\n".join(summary), encoding="utf-8")
    shutil.copy2(Path(__file__), OUT_DIR / "train_unified_model.py")

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in OUT_DIR.rglob("*"):
            zf.write(path, path.relative_to(OUT_DIR.parent))

    print("\nMODEL METRICS")
    print(metrics.to_string(index=False))
    print("\nTOP 30 FEATURE IMPORTANCE")
    print(importance.head(30).to_string(index=False))
    print("\nPREDICTION BINS")
    print(bins.to_string(index=False))
    print(f"\nZIP PATH\n{ZIP_PATH}")


if __name__ == "__main__":
    main()
