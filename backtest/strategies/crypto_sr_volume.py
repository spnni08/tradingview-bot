"""
crypto_sr_volume — mirrors crypto_sr_volume.pine

Trigger: price bounces off VAL (Long) or VAH (Short) within VP tolerance.
Broad candidate = any bounce touch (RSI/trend context included but not filtered).
"""
import pandas as pd
import numpy as np
from indicators.core import rsi as calc_rsi, ema as calc_ema, volume_profile
from config import (
    VP_LOOKBACK, VP_BINS, VP_VA_PCT, VP_TOL_PCT,
    SR_VOL_RSI_NO_DOWN, SR_VOL_RSI_NO_UP,
)


STRATEGY_KEY = "crypto_sr_volume"


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["rsi"]    = calc_rsi(df["close"], 14)
    df["ema50"]  = calc_ema(df["close"], 50)
    df["ema200"] = calc_ema(df["close"], 200)

    vp = volume_profile(df, VP_LOOKBACK, VP_BINS, VP_VA_PCT)
    df["poc"] = vp["poc"]
    df["vah"] = vp["vah"]
    df["val"] = vp["val"]

    df["trend_up"]   = df["close"] > df["ema200"]
    df["trend_down"]  = df["close"] < df["ema200"]

    # Zone proximity (matches Pine nearVAL / nearVAH)
    tol = VP_TOL_PCT / 100.0
    df["near_val"] = (df["val"].notna() &
                      ((df["close"] - df["val"]).abs() / df["close"] <= tol))
    df["near_vah"] = (df["vah"].notna() &
                      ((df["close"] - df["vah"]).abs() / df["close"] <= tol))

    # Bounce: low touched zone, close above (VAL) / below (VAH)
    df["bounce_up"]   = df["near_val"] & (df["low"] <= df["val"]) & (df["close"] > df["val"])
    df["bounce_down"] = df["near_vah"] & (df["high"] >= df["vah"]) & (df["close"] < df["vah"])

    # rsiWasOversold: RSI was < 30 within last 5 bars
    df["rsi_was_oversold"]  = df["rsi"].rolling(5).min().shift(1) < 30
    df["rsi_was_overbought"] = df["rsi"].rolling(5).max().shift(1) > 70

    # rsiRising / rsiFalling: RSI slope over last 3 bars
    df["rsi_rising"]  = df["rsi"] > df["rsi"].shift(3)
    df["rsi_falling"] = df["rsi"] < df["rsi"].shift(3)

    # trendOk for each direction
    df["trend_ok_long"]  = df["trend_up"]
    df["trend_ok_short"] = df["trend_down"]

    # reclaim / breakdown (used as context field for scoring)
    # reclaim = bounce_up with close firmly above VAL (not just touching)
    df["reclaim"]   = df["bounce_up"]   & (df["close"] > df["val"]  * 1.001)
    df["breakdown"] = df["bounce_down"] & (df["close"] < df["vah"] * 0.999)

    # dist to VAL/VAH (%)
    df["dist_to_val"] = ((df["close"] - df["val"]).abs()  / df["close"] * 100).round(4)
    df["dist_to_vah"] = ((df["close"] - df["vah"]).abs()  / df["close"] * 100).round(4)

    return df


def detect_candidates(df: pd.DataFrame) -> pd.DataFrame:
    df = compute_features(df)

    candidates = []
    for direction, mask in [("LONG", df["bounce_up"]), ("SHORT", df["bounce_down"])]:
        bars = df[mask].copy()
        bars["direction"] = direction
        bars["trigger"]   = "VAL_BOUNCE" if direction == "LONG" else "VAH_BOUNCE"
        bars["strategy"]  = STRATEGY_KEY
        bars["vp_zone"]   = "VAL" if direction == "LONG" else "VAH"
        bars["bar_index"] = df.index.get_indexer(bars.index)

        bars["trend_ok"] = (bars["trend_ok_long"] if direction == "LONG"
                             else bars["trend_ok_short"]).astype(int)
        candidates.append(bars)

    if not candidates:
        return pd.DataFrame()

    cols = [
        "strategy", "direction", "trigger", "bar_index",
        "close", "rsi", "ema50", "ema200",
        "poc", "vah", "val", "vp_zone",
        "reclaim", "breakdown",
        "rsi_was_oversold", "rsi_was_overbought",
        "rsi_rising", "rsi_falling",
        "trend_ok",
        "dist_to_val", "dist_to_vah",
    ]
    result = pd.concat(candidates).sort_index()
    return result[[c for c in cols if c in result.columns]]
