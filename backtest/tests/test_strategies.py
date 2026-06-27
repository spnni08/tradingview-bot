"""Tests for strategy candidate detection (no API calls, synthetic data)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
import pandas as pd
import pytest

import strategies.crypto_baseline           as s_baseline
import strategies.crypto_sr_volume          as s_sr_vol
import strategies.crypto_orderflow_breakout as s_breakout
import strategies.forex_sr_fib_rsi          as s_forex


def _make_df(n=500, seed=42, price_start=100.0, trend="flat"):
    """Build a synthetic OHLCV DataFrame with DatetimeIndex (UTC)."""
    np.random.seed(seed)
    idx = pd.date_range("2025-01-01", periods=n, freq="5min", tz="UTC")

    if trend == "up":
        drift = np.linspace(0, 20, n)
    elif trend == "down":
        drift = np.linspace(0, -20, n)
    else:
        drift = np.zeros(n)

    close = price_start + drift + np.random.normal(0, 0.5, n).cumsum()
    close = np.abs(close)   # ensure positive
    high   = close + np.random.uniform(0.1, 0.5, n)
    low    = close - np.random.uniform(0.1, 0.5, n)
    low    = np.maximum(low, 0.01)
    vol    = np.random.uniform(500, 5000, n)

    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": vol},
        index=idx,
    )


# ── crypto_baseline ───────────────────────────────────────────────────────────

def test_baseline_returns_dataframe():
    df = _make_df(500)
    result = s_baseline.detect_candidates(df)
    assert isinstance(result, pd.DataFrame)


def test_baseline_required_columns():
    df = _make_df(500)
    result = s_baseline.detect_candidates(df)
    if not result.empty:
        for col in ["strategy", "direction", "close", "rsi", "ema_dist_pct"]:
            assert col in result.columns, f"Missing column: {col}"


def test_baseline_direction_values():
    df = _make_df(500)
    result = s_baseline.detect_candidates(df)
    if not result.empty:
        assert set(result["direction"].unique()).issubset({"LONG", "SHORT"})


def test_baseline_strategy_key():
    df = _make_df(500)
    result = s_baseline.detect_candidates(df)
    if not result.empty:
        assert (result["strategy"] == "crypto_baseline").all()


def test_baseline_generates_some_candidates():
    """Over 500 bars of noisy price, RSI should cross thresholds several times."""
    df = _make_df(1000, seed=7)
    result = s_baseline.detect_candidates(df)
    assert len(result) > 0, "Expected at least one candidate in 1000 bars"


# ── crypto_sr_volume ──────────────────────────────────────────────────────────

def test_sr_volume_returns_dataframe():
    df = _make_df(600)
    result = s_sr_vol.detect_candidates(df)
    assert isinstance(result, pd.DataFrame)


def test_sr_volume_columns():
    df = _make_df(600)
    result = s_sr_vol.detect_candidates(df)
    if not result.empty:
        for col in ["strategy", "direction", "poc", "vah", "val", "vp_zone"]:
            assert col in result.columns


def test_sr_volume_vp_zone_values():
    df = _make_df(600)
    result = s_sr_vol.detect_candidates(df)
    if not result.empty:
        assert set(result["vp_zone"].unique()).issubset({"VAL", "VAH"})


# ── crypto_orderflow_breakout ─────────────────────────────────────────────────

def test_breakout_returns_dataframe():
    df = _make_df(400)
    result = s_breakout.detect_candidates(df)
    assert isinstance(result, pd.DataFrame)


def test_breakout_columns():
    df = _make_df(400)
    result = s_breakout.detect_candidates(df)
    if not result.empty:
        for col in ["strategy", "direction", "vol_ratio", "range_high", "range_low"]:
            assert col in result.columns


def test_breakout_vol_ratio_above_threshold():
    """Every detected breakout must have vol_ratio > 1.5 (BREAKOUT_VOL_MULT)."""
    df = _make_df(600, seed=3)
    result = s_breakout.detect_candidates(df)
    if not result.empty:
        assert (result["vol_ratio"] > 1.5).all(), "vol_ratio below threshold found"


def test_breakout_breakout_flag_matches_direction():
    df = _make_df(600, seed=5)
    result = s_breakout.detect_candidates(df)
    if not result.empty:
        longs  = result[result["direction"] == "LONG"]
        shorts = result[result["direction"] == "SHORT"]
        if not longs.empty:
            assert longs["breakout_above_range"].all()
        if not shorts.empty:
            assert shorts["breakout_below_range"].all()


# ── forex_sr_fib_rsi ─────────────────────────────────────────────────────────

def _make_session_df(n=500):
    """EUR/USD-like data with bars in London session hours."""
    idx = pd.date_range("2025-01-06 08:00", periods=n, freq="5min", tz="UTC")
    np.random.seed(9)
    close = 1.08 + np.random.normal(0, 0.001, n).cumsum()
    close = np.abs(close)
    high  = close + 0.0005
    low   = close - 0.0005
    low   = np.maximum(low, 0.001)
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close,
         "volume": np.ones(n)},
        index=idx,
    )


def test_forex_returns_dataframe():
    df = _make_session_df(500)
    result = s_forex.detect_candidates(df)
    assert isinstance(result, pd.DataFrame)


def test_forex_columns():
    df = _make_session_df(500)
    result = s_forex.detect_candidates(df)
    if not result.empty:
        for col in ["strategy", "direction", "fib_382", "fib_500", "fib_618"]:
            assert col in result.columns


def test_forex_only_in_session():
    """All candidates must fall within London/NY session hours."""
    df = _make_session_df(1000)
    result = s_forex.detect_candidates(df)
    if not result.empty:
        from config import FOREX_SESSIONS_UTC
        hours = result.index.tz_convert("UTC").hour
        in_session = pd.Series([
            any(s <= h < e for s, e in FOREX_SESSIONS_UTC)
            for h in hours
        ])
        assert in_session.all(), "Candidate found outside trading session!"


# ── No look-ahead: bar_index consistency ─────────────────────────────────────

def test_bar_index_within_bounds():
    """bar_index must point to a valid row in the source df."""
    df = _make_df(600, seed=11)
    for mod in [s_baseline, s_breakout]:
        result = mod.detect_candidates(df)
        if not result.empty:
            assert (result["bar_index"] >= 0).all()
            assert (result["bar_index"] < len(df)).all()
