"""
Main backtest loop: for each strategy and symbol, detect candidates,
simulate outcomes, return a combined DataFrame.
"""
import pandas as pd
import numpy as np
from tqdm import tqdm

from simulation.exit_logic import simulate_trade
from config import EXIT_CONFIG, FOREX_EXIT_OVERRIDE


STRATEGY_EXIT_OVERRIDES = {
    "forex_sr_fib_rsi": FOREX_EXIT_OVERRIDE,
}


def exit_cfg_for(strategy_key: str) -> dict:
    cfg = EXIT_CONFIG.copy()
    cfg.update(STRATEGY_EXIT_OVERRIDES.get(strategy_key, {}))
    return cfg


def run_backtest(df: pd.DataFrame, candidates: pd.DataFrame,
                 symbol: str, strategy_key: str,
                 show_progress: bool = True) -> pd.DataFrame:
    """
    For each candidate row, simulate the trade outcome.

    Args:
        df: full OHLCV DataFrame for the symbol (DatetimeIndex, UTC).
        candidates: output from a strategy's detect_candidates().
        symbol: e.g. "BTC/USDT".
        strategy_key: e.g. "crypto_baseline".
        show_progress: show tqdm bar.

    Returns:
        DataFrame with all candidate context fields + outcome columns.
    """
    if candidates.empty:
        return pd.DataFrame()

    exit_cfg = exit_cfg_for(strategy_key)
    records  = []
    df_reset = df.reset_index(drop=False)   # preserve timestamp as column

    rows = list(candidates.iterrows())
    if show_progress:
        rows = tqdm(rows, desc=f"  {symbol} [{strategy_key}]", unit="cand")

    for ts, row in rows:
        bar_idx = int(row["bar_index"])

        # Guard: need enough future bars for simulation
        if bar_idx >= len(df) - 2:
            continue

        result = simulate_trade(df, bar_idx, row["direction"], exit_cfg)

        record = row.to_dict()
        record.update({
            "symbol":      symbol,
            "timestamp":   ts,
            "entry_price": df["close"].iloc[bar_idx],
            "outcome":     result.outcome,
            "pnl_pct":     round(result.pnl_pct, 4),
            "tp1_hit":     int(result.tp1_hit),
            "bars_held":   result.bars_held,
            "exit_price":  result.exit_price,
            "tp1_price":   result.tp1_price,
            "tp2_price":   result.tp2_price,
            "sl_price":    result.sl_price,
            "win":         int(result.pnl_pct > 0),
        })
        records.append(record)

    if not records:
        return pd.DataFrame()

    result_df = pd.DataFrame(records)

    # Coerce boolean context columns to int for clean CSV/Parquet output
    bool_cols = result_df.select_dtypes(include=["bool"]).columns
    result_df[bool_cols] = result_df[bool_cols].astype(int)

    return result_df
