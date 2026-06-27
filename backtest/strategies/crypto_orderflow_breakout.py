"""
crypto_orderflow_breakout — mirrors crypto_orderflow_breakout.pine

Trigger: close breaks above/below N-bar range with volume > volMult × avg vol.
Pine uses high[1]/low[1] for range (previous N bars, excluding current).
"""
import pandas as pd
import numpy as np
from indicators.core import rsi as calc_rsi, ema as calc_ema
from config import BREAKOUT_N, BREAKOUT_VOL_MULT


STRATEGY_KEY = "crypto_orderflow_breakout"


def compute_features(df: pd.DataFrame, N: int = BREAKOUT_N,
                     vol_mult: float = BREAKOUT_VOL_MULT) -> pd.DataFrame:
    df = df.copy()
    df["rsi"]    = calc_rsi(df["close"], 14)
    df["ema50"]  = calc_ema(df["close"], 50)
    df["ema200"] = calc_ema(df["close"], 200)

    # Pine: rangeHigh = ta.highest(high[1], N)  → shift(1) then rolling max
    df["range_high"] = df["high"].shift(1).rolling(N).max()
    df["range_low"]  = df["low"].shift(1).rolling(N).min()
    df["avg_volume"] = df["volume"].shift(1).rolling(N).mean()

    df["vol_ratio"]  = (df["volume"] / df["avg_volume"]).round(4)
    df["vol_ok"]     = df["avg_volume"].notna() & (df["volume"] > vol_mult * df["avg_volume"])

    df["break_up"]   = (df["close"] > df["range_high"]) & df["vol_ok"]
    df["break_down"] = (df["close"] < df["range_low"])  & df["vol_ok"]

    df["trend_ok_long"]  = df["close"] > df["ema200"]
    df["trend_ok_short"] = df["close"] < df["ema200"]

    # breakoutAboveRange / breakoutBelowRange for scoring
    df["breakout_above_range"] = df["break_up"]
    df["breakout_below_range"] = df["break_down"]

    return df


def detect_candidates(df: pd.DataFrame, N: int = BREAKOUT_N,
                       vol_mult: float = BREAKOUT_VOL_MULT) -> pd.DataFrame:
    df = compute_features(df, N, vol_mult)

    candidates = []
    for direction, mask in [("LONG", df["break_up"]), ("SHORT", df["break_down"])]:
        bars = df[mask].copy()
        bars["direction"] = direction
        bars["trigger"]   = "RANGE_BREAK_UP" if direction == "LONG" else "RANGE_BREAK_DOWN"
        bars["strategy"]  = STRATEGY_KEY
        bars["bar_index"] = df.index.get_indexer(bars.index)

        bars["trend_ok"] = (bars["trend_ok_long"] if direction == "LONG"
                             else bars["trend_ok_short"]).astype(int)
        bars["breakout_above_range"] = (direction == "LONG")
        bars["breakout_below_range"] = (direction == "SHORT")
        candidates.append(bars)

    if not candidates:
        return pd.DataFrame()

    cols = [
        "strategy", "direction", "trigger", "bar_index",
        "close", "rsi", "ema50", "ema200",
        "range_high", "range_low", "vol_ratio", "avg_volume",
        "breakout_above_range", "breakout_below_range",
        "trend_ok",
    ]
    result = pd.concat(candidates).sort_index()
    return result[[c for c in cols if c in result.columns]]
