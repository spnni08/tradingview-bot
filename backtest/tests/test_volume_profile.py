"""
Tests fuer backtest/volume_profile.py.

Prueft die 1:1-Replikation der Pine-Logik aus ``wavescout_core_v2.pine``:
  * POC/VAL/VAH gegen von Hand berechnete Werte (kleines Beispiel-Fenster),
    inkl. Value-Area-Tie-Break (unterer Nachbar bei Gleichstand).
  * Vorzeichen von ``cvd_slope`` fuer klar bullische vs. baerische Kerzenfolgen.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
import pandas as pd
import pytest

from volume_profile import (
    rolling_volume_profile,
    vp_touch_signals,
    cvd_approximation,
)


# ── Volume Profile: Hand-berechnetes Fenster ──────────────────────────────────

def _vp_window_df():
    """3-Bar-Fenster mit bekannter Bin-Verteilung.

    lo = 10, hi = 16  -> binSize = (16-10)/3 = 2
    Bins: [10,12) -> idx 0, [12,14) -> idx 1, [14,16] -> idx 2
      close 11 -> floor((11-10)/2)=0
      close 13 -> floor((13-10)/2)=1
      close 15 -> floor((15-10)/2)=2
    """
    return pd.DataFrame({
        "open":   [11.0, 13.0, 15.0],
        "high":   [11.5, 13.5, 16.0],   # max high = 16
        "low":    [10.0, 12.5, 14.5],   # min low  = 10
        "close":  [11.0, 13.0, 15.0],
        "volume": [20.0, 50.0, 30.0],   # bin0=20, bin1=50 (POC), bin2=30
    })


def test_vp_poc_val_vah_hand_computed():
    """POC/VAL/VAH gegen von Hand berechnete Werte.

    binVol = [20, 50, 30], total=100, target=70.
    POC = bin1 -> price = 10 + (1+0.5)*2 = 13.
    Expansion ab acc=50: below=20, above=30 -> above gewinnt (vah_idx=2),
    acc=80 >= 70. -> val_idx=1, vah_idx=2.
    VAL = 10 + 1*2 = 12 ; VAH = 10 + (2+1)*2 = 16.
    """
    df = _vp_window_df()
    out = rolling_volume_profile(df, lookback=3, buckets=3, value_area_pct=0.70)

    # Erste lookback-1 Zeilen NaN
    assert out["poc"].iloc[:2].isna().all()
    assert out["val"].iloc[:2].isna().all()
    assert out["vah"].iloc[:2].isna().all()

    assert out["poc"].iloc[-1] == pytest.approx(13.0)
    assert out["val"].iloc[-1] == pytest.approx(12.0)
    assert out["vah"].iloc[-1] == pytest.approx(16.0)


def test_vp_value_area_tie_prefers_lower_bin():
    """Bei Gleichstand der Nachbar-Volumina wird der UNTERE Bin bevorzugt.

    binVol = [25, 50, 25], total=100, target=70, acc(POC)=50.
    below=25 == above=25 -> ``vol_below >= vol_above`` -> unterer Nachbar,
    val_idx=0, acc=75 >= 70. -> val_idx=0, vah_idx=1.
    VAL = 10 + 0*2 = 10 ; VAH = 10 + (1+1)*2 = 14 ; POC = 13.
    """
    df = _vp_window_df()
    df["volume"] = [25.0, 50.0, 25.0]
    out = rolling_volume_profile(df, lookback=3, buckets=3, value_area_pct=0.70)

    assert out["poc"].iloc[-1] == pytest.approx(13.0)
    assert out["val"].iloc[-1] == pytest.approx(10.0)   # unterer Nachbar dazu
    assert out["vah"].iloc[-1] == pytest.approx(14.0)


def test_vp_levels_ordered():
    """VAL <= POC <= VAH und innerhalb [lo, hi] auf Zufallsdaten."""
    rng = np.random.default_rng(7)
    n = 120
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    df = pd.DataFrame({
        "open": close,
        "high": close + rng.uniform(0, 1, n),
        "low": close - rng.uniform(0, 1, n),
        "close": close,
        "volume": rng.uniform(50, 500, n),
    })
    out = rolling_volume_profile(df, lookback=100, buckets=24)
    last = out.iloc[-1]
    lo = df["low"].iloc[-100:].min()
    hi = df["high"].iloc[-100:].max()
    assert lo <= last["val"] <= last["poc"] <= last["vah"] <= hi


def test_vp_touch_signals_simple_touch():
    """touch_val = low <= val, touch_vah = high >= vah (kein Crossunder/-over)."""
    df = pd.DataFrame({
        "low":  [9.0, 13.0, 11.0],
        "high": [12.0, 17.0, 12.0],
        "val":  [10.0, 10.0, np.nan],   # letzte Zeile ohne Profil
        "vah":  [16.0, 16.0, np.nan],
    })
    out = vp_touch_signals(df)
    # Bar0: low 9 <= val 10 -> True ; high 12 >= vah 16 -> False
    assert bool(out["touch_val"].iloc[0]) is True
    assert bool(out["touch_vah"].iloc[0]) is False
    # Bar1: low 13 <= val 10 -> False ; high 17 >= vah 16 -> True
    assert bool(out["touch_val"].iloc[1]) is False
    assert bool(out["touch_vah"].iloc[1]) is True
    # Bar2: kein Profil -> beide False
    assert bool(out["touch_val"].iloc[2]) is False
    assert bool(out["touch_vah"].iloc[2]) is False


# ── CVD-Approximation ─────────────────────────────────────────────────────────

def _candles(direction: str, n: int = 30) -> pd.DataFrame:
    """Synthetische Kerzenfolge.

    bullish: Close nahe High (buyRatio ~1 -> delta > 0).
    bearish: Close nahe Low  (buyRatio ~0 -> delta < 0).
    """
    base = np.arange(n, dtype=float)
    high = 100 + base + 1.0
    low = 100 + base
    if direction == "bullish":
        close = high - 0.05
        open_ = low + 0.05
    else:
        close = low + 0.05
        open_ = high - 0.05
    return pd.DataFrame({
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": np.full(n, 100.0),
    })


def test_cvd_slope_positive_for_bullish():
    out = cvd_approximation(_candles("bullish"), slope_lookback=14)
    assert out["cvd_cum"].iloc[-1] > 0
    assert out["cvd_slope"].iloc[-1] > 0


def test_cvd_slope_negative_for_bearish():
    out = cvd_approximation(_candles("bearish"), slope_lookback=14)
    assert out["cvd_cum"].iloc[-1] < 0
    assert out["cvd_slope"].iloc[-1] < 0


def test_cvd_zero_range_uses_half_buy_ratio():
    """Range == 0 -> buyRatio 0.5 -> delta 0 (kein NaN, keine Division durch 0)."""
    df = pd.DataFrame({
        "open": [100.0, 100.0],
        "high": [100.0, 100.0],
        "low": [100.0, 100.0],
        "close": [100.0, 100.0],
        "volume": [100.0, 100.0],
    })
    out = cvd_approximation(df, slope_lookback=1)
    assert out["cvd_cum"].iloc[-1] == pytest.approx(0.0)


def test_cvd_filter_toggle():
    """use_cvd_filter=False entfernt das cvd_slope-Gate aus den Triggern."""
    rng = np.random.default_rng(3)
    n = 60
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    df = pd.DataFrame({
        "open": close - 0.5,
        "high": close + 1.0,
        "low": close - 1.0,
        "close": close,
        # garantierte Vol-Spikes alle paar Bars
        "volume": np.where(np.arange(n) % 5 == 0, 1000.0, 100.0),
    })
    with_filter = cvd_approximation(df, use_cvd_filter=True)
    without_filter = cvd_approximation(df, use_cvd_filter=False)

    # Ohne Filter ist die Triggermenge eine Obermenge (cvd_slope-Gate entfaellt).
    long_with = with_filter["orderflow_long_trigger"]
    long_without = without_filter["orderflow_long_trigger"]
    assert (long_without | ~long_with).all()              # with ⊆ without
    assert long_without.sum() >= long_with.sum()
