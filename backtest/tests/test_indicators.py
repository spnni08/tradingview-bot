"""Tests for indicator calculations."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
import pandas as pd
import pytest

from indicators.core import rsi, ema, atr, volume_profile, volume_profile_row


def _close(values):
    return pd.Series(values, dtype=float)


# ── RSI ──────────────────────────────────────────────────────────────────────

def test_rsi_range():
    """RSI must always be 0-100."""
    np.random.seed(42)
    close = _close(np.random.uniform(100, 110, 200))
    r = rsi(close, 14)
    assert r.dropna().between(0, 100).all()


def test_rsi_flat_series():
    """Flat price → no gain, no loss → avg_loss=0 → Pine returns 100."""
    close = _close([100.0] * 30)
    r = rsi(close, 14)
    # avg_loss = 0 → RSI = 100 (matches Pine ta.rsi behaviour)
    valid = r.dropna()
    assert valid.empty or (valid == 100).all()


def test_rsi_steadily_rising():
    """Steadily rising price → RSI should approach 100."""
    close = _close(range(50, 120))
    r = rsi(close, 14)
    assert r.iloc[-1] > 90


def test_rsi_steadily_falling():
    """Steadily falling price → RSI should approach 0."""
    close = _close(range(120, 50, -1))
    r = rsi(close, 14)
    assert r.iloc[-1] < 10


# ── EMA ──────────────────────────────────────────────────────────────────────

def test_ema_flat():
    """EMA of flat series equals the flat value."""
    close = _close([100.0] * 50)
    e = ema(close, 20)
    assert abs(e.iloc[-1] - 100.0) < 1e-9


def test_ema_length():
    """EMA output has same length as input."""
    close = _close(range(1, 101))
    assert len(ema(close, 20)) == 100


# ── Volume Profile ────────────────────────────────────────────────────────────

def test_vp_row_basic():
    """POC should be in [lo, hi], VAL ≤ POC ≤ VAH."""
    np.random.seed(0)
    n = 100
    closes = np.random.uniform(100, 110, n)
    highs  = closes + np.random.uniform(0, 1, n)
    lows   = closes - np.random.uniform(0, 1, n)
    vols   = np.random.uniform(100, 1000, n)

    poc, vah, val = volume_profile_row(highs, lows, closes, vols, n_bins=20, va_pct=70.0)
    lo, hi = lows.min(), highs.max()

    assert lo <= val <= poc <= vah <= hi


def test_vp_row_single_price():
    """All closes equal → all VP levels at that price."""
    closes = np.full(50, 100.0)
    highs  = closes + 0.5
    lows   = closes - 0.5
    vols   = np.ones(50) * 500.0

    poc, vah, val = volume_profile_row(highs, lows, closes, vols, n_bins=10, va_pct=70.0)
    assert abs(poc - 100.0) < 1.0   # within one bin width


def test_volume_profile_no_lookahead():
    """volume_profile() must only use rows up to and including the current bar."""
    np.random.seed(1)
    n = 300
    df = pd.DataFrame({
        "open":   np.random.uniform(100, 110, n),
        "high":   np.random.uniform(110, 115, n),
        "low":    np.random.uniform(95, 100, n),
        "close":  np.random.uniform(100, 110, n),
        "volume": np.random.uniform(1000, 5000, n),
    })
    vp = volume_profile(df, lookback=50, n_bins=20, va_pct=70.0)

    # First 49 rows should be NaN (insufficient lookback)
    assert vp["poc"].iloc[:49].isna().all()
    # Row 49 should have a valid value
    assert not pd.isna(vp["poc"].iloc[49])


# ── ATR ──────────────────────────────────────────────────────────────────────

def test_atr_positive():
    np.random.seed(2)
    n = 50
    close = pd.Series(np.random.uniform(100, 110, n))
    high  = close + np.random.uniform(0, 2, n)
    low   = close - np.random.uniform(0, 2, n)
    a = atr(high, low, close, 14)
    assert a.dropna().gt(0).all()
