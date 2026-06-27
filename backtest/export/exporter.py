"""
Export results to Parquet and CSV.

One file per strategy (e.g. candidates_crypto_baseline.parquet).
A combined all-strategies file is also written.
Column order is stable for reproducibility.
"""
from pathlib import Path
import pandas as pd

OUTPUT_DIR = Path(__file__).parent.parent / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Columns that go first (key identifiers + outcome)
LEAD_COLS = [
    "timestamp", "symbol", "strategy", "direction", "trigger",
    "entry_price", "outcome", "pnl_pct", "win", "tp1_hit", "bars_held",
    "tp1_price", "tp2_price", "sl_price", "exit_price",
]


def _ordered_cols(df: pd.DataFrame) -> list[str]:
    lead = [c for c in LEAD_COLS if c in df.columns]
    rest = [c for c in df.columns if c not in lead and c != "bar_index"]
    return lead + rest


def export_strategy(df: pd.DataFrame, strategy_key: str,
                    fmt: str = "parquet") -> Path:
    """Write a single-strategy result DataFrame to output/."""
    if df.empty:
        print(f"  [export] {strategy_key}: no rows — skipped")
        return None

    df = df[_ordered_cols(df)].copy()
    stem = f"candidates_{strategy_key}"

    if fmt == "parquet":
        path = OUTPUT_DIR / f"{stem}.parquet"
        df.to_parquet(path, index=False)
    else:
        path = OUTPUT_DIR / f"{stem}.csv"
        df.to_csv(path, index=False)

    print(f"  [export] {strategy_key}: {len(df)} rows → {path.name}")
    return path


def export_combined(frames: dict[str, pd.DataFrame], fmt: str = "parquet") -> Path:
    """Write all strategies into a single file with a strategy_key column."""
    dfs = [df for df in frames.values() if not df.empty]
    if not dfs:
        print("  [export] combined: nothing to write")
        return None

    combined = pd.concat(dfs, ignore_index=True)
    combined = combined[_ordered_cols(combined)].copy()

    if fmt == "parquet":
        path = OUTPUT_DIR / "candidates_all.parquet"
        combined.to_parquet(path, index=False)
    else:
        path = OUTPUT_DIR / "candidates_all.csv"
        combined.to_csv(path, index=False)

    print(f"  [export] combined: {len(combined)} rows → {path.name}")
    return path


def export_json_summary(frames: dict[str, pd.DataFrame], output_path: Path) -> dict:
    """
    Write a structured JSON summary of backtest results and return the dict.
    Used by the GitHub Actions workflow to commit a timestamped report.
    """
    import json
    from datetime import datetime, timezone

    summary: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_candidates": 0,
        "strategies": {},
    }

    for strategy_key, df in frames.items():
        if df.empty:
            summary["strategies"][strategy_key] = {"candidates": 0}
            continue

        n           = len(df)
        wins        = int(df["win"].sum())
        win_rate    = round(wins / n * 100, 2) if n else 0.0
        avg_pnl     = round(float(df["pnl_pct"].mean()), 4)
        tp1_rate    = round(float(df["tp1_hit"].mean() * 100), 2)
        timeout_pct = round(float((df["outcome"] == "TIMEOUT").mean() * 100), 2)
        outcomes    = df["outcome"].value_counts().to_dict()
        symbols     = df["symbol"].value_counts().to_dict() if "symbol" in df.columns else {}

        summary["strategies"][strategy_key] = {
            "candidates": n,
            "wins":       wins,
            "win_rate":   win_rate,
            "avg_pnl":    avg_pnl,
            "tp1_rate":   tp1_rate,
            "timeout_pct": timeout_pct,
            "outcomes":   outcomes,
            "symbols":    symbols,
        }
        summary["total_candidates"] += n

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2))
    print(f"  [export] JSON summary → {output_path}")
    return summary


def print_validation_report(frames: dict[str, pd.DataFrame]) -> None:
    """Print a human-readable summary after the first run (Aufgabe 5)."""
    print("\n" + "=" * 65)
    print("  BACKTEST VALIDATION REPORT")
    print("=" * 65)

    all_dfs = [df for df in frames.values() if not df.empty]
    if not all_dfs:
        print("  No results to report.")
        return

    total_cands = sum(len(df) for df in all_dfs)
    print(f"\n  Total candidates: {total_cands:,}")

    for strategy_key, df in frames.items():
        if df.empty:
            print(f"\n  {strategy_key}: 0 candidates")
            continue

        n      = len(df)
        wins   = df["win"].sum()
        wr     = wins / n * 100 if n else 0
        avg_pnl = df["pnl_pct"].mean()
        med_pnl = df["pnl_pct"].median()
        tp1_rate = df["tp1_hit"].mean() * 100
        timeout_rate = (df["outcome"] == "TIMEOUT").mean() * 100

        outcomes = df["outcome"].value_counts()

        print(f"\n  ── {strategy_key} ────────────────────────────────")
        print(f"     Candidates : {n:,}")
        if "symbol" in df.columns:
            for sym, cnt in df["symbol"].value_counts().items():
                print(f"       {sym:<15} {cnt:,}")
        if "direction" in df.columns:
            for d, cnt in df["direction"].value_counts().items():
                print(f"       {d:<15} {cnt:,}")
        print(f"     Win rate   : {wr:.1f}%")
        print(f"     Avg PnL    : {avg_pnl:+.3f}%")
        print(f"     Median PnL : {med_pnl:+.3f}%")
        print(f"     TP1 rate   : {tp1_rate:.1f}%")
        print(f"     Timeout    : {timeout_rate:.1f}%")
        print(f"     Outcomes   : {dict(outcomes)}")

    print("\n" + "=" * 65)
