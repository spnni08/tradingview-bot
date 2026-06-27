"""
crypto_baseline — mirrors crypto_baseline.pine

Broad candidate trigger: RSI crosses below RSI_LONG_THRESH (Long)
                         or crosses above RSI_SHORT_THRESH (Short).
No EMA trend filter on the trigger (generates more candidates for ML).
All context fields included as columns for scoring/ML.
"""
import pandas as pd
import numpy as np
from indicators.core import rsi as calc_rsi, ema as calc_ema
from config import BASELINE_RSI_LONG_THRESH, BASELINE_RSI_SHORT_THRESH


STRATEGY_KEY = "crypto_baseline"


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add indicator columns to df (in-place copy). No look-ahead."""
    df = df.copy()
    df["rsi"]   = calc_rsi(df["close"], 14)
    df["ema50"]  = calc_ema(df["close"], 50)
    df["ema200"] = calc_ema(df["close"], 200)

    # EMA distance (%) — key context field for scoring
    df["ema_dist_pct"] = ((df["close"] - df["ema200"]).abs() / df["ema200"] * 100).round(4)

    # Trend
    df["trend_up"]   = (df["close"] > df["ema200"]) & (df["ema50"] > df["ema200"])
    df["trend_down"]  = (df["close"] < df["ema200"]) & (df["ema50"] < df["ema200"])
    df["trend"] = np.where(df["trend_up"], "BULLISH",
                  np.where(df["trend_down"], "BEARISH", "NEUTRAL"))

    # RSI dead-zone (55-65 for LONG, 35-45 for SHORT)
    df["rsi_dead_zone_long"]  = (df["rsi"] >= 55) & (df["rsi"] <= 65)
    df["rsi_dead_zone_short"] = (df["rsi"] >= 35) & (df["rsi"] <= 45)

    # Simple S/R proximity: rolling 20-bar high/low within 0.5%
    roll20_high = df["high"].rolling(20).max().shift(1)
    roll20_low  = df["low"].rolling(20).min().shift(1)
    df["near_res"] = (roll20_high - df["close"]).abs() / df["close"] < 0.005
    df["near_sup"] = (df["close"] - roll20_low).abs()  / df["close"] < 0.005

    return df


def detect_candidates(df: pd.DataFrame) -> pd.DataFrame:
    """
    Find candidate bars where the broad trigger fires.
    Returns a DataFrame of candidates with all context fields.
    One row per signal bar.
    """
    df = compute_features(df)

    # Broad trigger: RSI crossover (was above threshold, now below / vice versa)
    rsi_was_above_long  = df["rsi"].shift(1) >= BASELINE_RSI_LONG_THRESH
    rsi_now_below_long  = df["rsi"] < BASELINE_RSI_LONG_THRESH
    long_trigger        = rsi_was_above_long & rsi_now_below_long

    rsi_was_below_short = df["rsi"].shift(1) <= BASELINE_RSI_SHORT_THRESH
    rsi_now_above_short = df["rsi"] > BASELINE_RSI_SHORT_THRESH
    short_trigger       = rsi_was_below_short & rsi_now_above_short

    candidates = []
    for direction, mask in [("LONG", long_trigger), ("SHORT", short_trigger)]:
        bars = df[mask].copy()
        bars["direction"]  = direction
        bars["trigger"]    = "BASELINE_RSI_EMA"
        bars["strategy"]   = STRATEGY_KEY
        bars["bar_index"]  = df.index.get_indexer(bars.index)

        # Context fields (for candidate scoring)
        if direction == "LONG":
            bars["rsi_dead_zone"] = bars["rsi_dead_zone_long"].astype(int)
        else:
            bars["rsi_dead_zone"] = bars["rsi_dead_zone_short"].astype(int)

        candidates.append(bars)

    if not candidates:
        return pd.DataFrame()

    cols = [
        "strategy", "direction", "trigger", "bar_index",
        "close", "rsi", "ema50", "ema200",
        "ema_dist_pct", "near_sup", "near_res", "rsi_dead_zone", "trend",
    ]
    result = pd.concat(candidates).sort_index()
    return result[[c for c in cols if c in result.columns]]
