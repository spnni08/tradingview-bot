"""
forex_sr_fib_rsi — mirrors forex_sr_fib_rsi.pine

Trigger: price enters Fibonacci retracement zone (38.2/50/61.8%)
         within trading session AND RSI > 50 (Long) / < 50 (Short).
Broad candidate = any fib zone touch within session (RSI/EMA context included).
"""
import pandas as pd
import numpy as np
from indicators.core import rsi as calc_rsi, ema as calc_ema
from config import FOREX_SWING_LEN, FOREX_FIB_TOL_PCT, FOREX_SESSIONS_UTC


STRATEGY_KEY = "forex_sr_fib_rsi"


def _in_session(ts: pd.Timestamp) -> bool:
    h = ts.tz_convert("UTC").hour
    return any(start <= h < end for start, end in FOREX_SESSIONS_UTC)


def compute_features(df: pd.DataFrame, swing_len: int = FOREX_SWING_LEN,
                     fib_tol_pct: float = FOREX_FIB_TOL_PCT) -> pd.DataFrame:
    df = df.copy()
    df["rsi"]    = calc_rsi(df["close"], 14)
    df["ema50"]  = calc_ema(df["close"], 50)
    df["ema200"] = calc_ema(df["close"], 200)

    # Pine: swingHigh = ta.highest(high, swingLen) — includes current bar
    df["swing_high"] = df["high"].rolling(swing_len).max()
    df["swing_low"]  = df["low"].rolling(swing_len).min()
    df["range_size"] = df["swing_high"] - df["swing_low"]

    # Fibonacci levels (Long = retracement from high; Short = from low)
    df["fib_382_up"] = df["swing_high"] - df["range_size"] * 0.382
    df["fib_500_up"] = df["swing_high"] - df["range_size"] * 0.500
    df["fib_618_up"] = df["swing_high"] - df["range_size"] * 0.618

    df["fib_382_dn"] = df["swing_low"] + df["range_size"] * 0.382
    df["fib_500_dn"] = df["swing_low"] + df["range_size"] * 0.500
    df["fib_618_dn"] = df["swing_low"] + df["range_size"] * 0.618

    tol = fib_tol_pct / 100.0

    def near(close_s: pd.Series, lvl: pd.Series) -> pd.Series:
        return (df["range_size"] > 0) & ((close_s - lvl).abs() / close_s <= tol)

    df["in_fib_long"]  = (near(df["close"], df["fib_382_up"]) |
                           near(df["close"], df["fib_500_up"]) |
                           near(df["close"], df["fib_618_up"]))
    df["in_fib_short"] = (near(df["close"], df["fib_382_dn"]) |
                           near(df["close"], df["fib_500_dn"]) |
                           near(df["close"], df["fib_618_dn"]))

    # Session filter
    df["in_session"] = pd.array([_in_session(ts) for ts in df.index],
                                  dtype=bool)

    # Trend
    df["trend_up"]   = df["close"] > df["ema200"]
    df["trend_down"]  = df["close"] < df["ema200"]

    # Min distance to any fib level (for scoring context)
    fib_levels_long = df[["fib_382_up", "fib_500_up", "fib_618_up"]]
    fib_levels_short = df[["fib_382_dn", "fib_500_dn", "fib_618_dn"]]
    df["dist_to_fib_long"] = (
        (fib_levels_long.sub(df["close"], axis=0)).abs().div(df["close"], axis=0) * 100
    ).min(axis=1).round(4)
    df["dist_to_fib_short"] = (
        (fib_levels_short.sub(df["close"], axis=0)).abs().div(df["close"], axis=0) * 100
    ).min(axis=1).round(4)

    # reclaimVAL / breakdownVAH analogs for forex (fib zone reclaim)
    # reclaim_fib_long = close entered fib long zone AND rsi > 50 (matches scoring context)
    df["reclaim_val"]   = df["in_fib_long"]  & (df["rsi"] > 50) & df["trend_up"]
    df["breakdown_vah"] = df["in_fib_short"] & (df["rsi"] < 50) & df["trend_down"]

    return df


def detect_candidates(df: pd.DataFrame, swing_len: int = FOREX_SWING_LEN,
                       fib_tol_pct: float = FOREX_FIB_TOL_PCT) -> pd.DataFrame:
    df = compute_features(df, swing_len, fib_tol_pct)

    long_mask  = df["in_session"] & df["in_fib_long"]  & (df["rsi"] > 50) & df["trend_up"]
    short_mask = df["in_session"] & df["in_fib_short"] & (df["rsi"] < 50) & df["trend_down"]

    candidates = []
    for direction, mask in [("LONG", long_mask), ("SHORT", short_mask)]:
        bars = df[mask].copy()
        bars["direction"] = direction
        bars["trigger"]   = "FIB_SR_RSI_LONG" if direction == "LONG" else "FIB_SR_RSI_SHORT"
        bars["strategy"]  = STRATEGY_KEY
        bars["bar_index"] = df.index.get_indexer(bars.index)

        if direction == "LONG":
            bars["fib_382"] = bars["fib_382_up"]
            bars["fib_500"] = bars["fib_500_up"]
            bars["fib_618"] = bars["fib_618_up"]
            bars["dist_to_val"] = bars["dist_to_fib_long"]
            bars["dist_to_vah"] = np.nan
            bars["reclaim_val"]  = bars["reclaim_val"].astype(int)
            bars["breakdown_vah"] = 0
        else:
            bars["fib_382"] = bars["fib_382_dn"]
            bars["fib_500"] = bars["fib_500_dn"]
            bars["fib_618"] = bars["fib_618_dn"]
            bars["dist_to_vah"] = bars["dist_to_fib_short"]
            bars["dist_to_val"] = np.nan
            bars["breakdown_vah"] = bars["breakdown_vah"].astype(int)
            bars["reclaim_val"]  = 0

        candidates.append(bars)

    if not candidates:
        return pd.DataFrame()

    cols = [
        "strategy", "direction", "trigger", "bar_index",
        "close", "rsi", "ema50", "ema200",
        "swing_high", "swing_low",
        "fib_382", "fib_500", "fib_618",
        "reclaim_val", "breakdown_vah",
        "dist_to_val", "dist_to_vah",
    ]
    result = pd.concat(candidates).sort_index()
    return result[[c for c in cols if c in result.columns]]
