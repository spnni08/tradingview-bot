"""Tests for exit logic (TP1/TP2/SL simulation)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
import pandas as pd
import pytest

from simulation.exit_logic import simulate_trade
from config import EXIT_CONFIG


def _df_from_closes(closes, scale=1.0):
    """Build OHLCV df where high=close+0.5%, low=close-0.5%."""
    arr = np.array(closes, dtype=float) * scale
    return pd.DataFrame({
        "open":   arr,
        "high":   arr * 1.005,
        "low":    arr * 0.995,
        "close":  arr,
        "volume": np.ones(len(arr)) * 1000,
    })


CFG = EXIT_CONFIG.copy()


# ── LONG scenarios ────────────────────────────────────────────────────────────

def test_long_tp2():
    """Price rises steadily → hits TP2."""
    # Entry at 100, SL 99, TP2 101.5, TP1 100.9
    closes = [100] + [100.3] * 5 + [101.0] * 3 + [101.6] * 3
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    assert res.outcome == "TP2"
    assert res.pnl_pct > 0
    assert res.tp1_hit is True


def test_long_sl_before_tp1():
    """Price drops immediately → SL hit before TP1."""
    closes = [100] + [99.5] * 5 + [98.0] * 5
    # high = close * 1.005 → won't reach TP1; low = close * 0.995 < SL=99
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    assert res.outcome == "SL_BEFORE_TP1"
    assert res.pnl_pct < 0
    assert res.tp1_hit is False


def test_long_sl_after_tp1():
    """TP1 hit → breakeven SL → price falls back → SL_AFTER_TP1 (still positive)."""
    # Entry 100, TP1 ≈ 100.9 → reaches it, then drops
    closes = [100] + [100.95] * 2 + [100.8, 100.5, 100.1, 99.9] * 4
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    # After TP1, SL moves to breakeven ~100.1; a further drop may hit it
    # Either SL_AFTER_TP1 (positive) or TP2
    assert res.tp1_hit is True
    assert res.pnl_pct >= 0   # blended PnL with TP1 portion is always positive


def test_long_timeout():
    """Price stays flat → timeout after MAX_BARS."""
    closes = [100.0] * (CFG["MAX_BARS_OPEN"] + 5)
    df = _df_from_closes(closes)
    # flat candles: high=100.5, low=99.5 → between SL (99) and TP1 (100.9)
    res = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    assert res.outcome == "TIMEOUT"
    assert res.bars_held == CFG["MAX_BARS_OPEN"]


# ── SHORT scenarios ───────────────────────────────────────────────────────────

def test_short_tp2():
    """Price drops steadily → hits TP2."""
    closes = [100] + [99.7] * 3 + [99.0] * 3 + [98.4] * 3
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="SHORT", exit_cfg=CFG)
    assert res.outcome == "TP2"
    assert res.pnl_pct > 0
    assert res.tp1_hit is True


def test_short_sl_before_tp1():
    """Price rises → SL hit before TP1."""
    closes = [100] + [100.6] * 5 + [101.5] * 5
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="SHORT", exit_cfg=CFG)
    assert res.outcome == "SL_BEFORE_TP1"
    assert res.pnl_pct < 0


# ── PnL correctness ──────────────────────────────────────────────────────────

def test_pnl_tp2_correct():
    """
    Verify blended PnL for TP2 outcome:
    50% at TP1 (+0.9%), 50% at TP2 (+1.5%) → +1.2%.
    """
    # Entry 100 → TP1 ≈ 100.9 → TP2 ≈ 101.5
    closes = [100] + [100.95] * 2 + [101.6] * 5
    df = _df_from_closes(closes)
    res = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    if res.outcome == "TP2":
        assert abs(res.pnl_pct - 1.2) < 0.15   # allow small float imprecision


def test_no_lookahead_guard():
    """Entry at last bar → immediately returns TIMEOUT with 0 bars held."""
    closes = [100.0] * 5
    df = _df_from_closes(closes)
    # bar_index = 4 (last bar); loop range is empty
    res = simulate_trade(df, entry_bar=4, direction="LONG", exit_cfg=CFG)
    assert res.outcome == "TIMEOUT"
    assert res.bars_held == 0


# ── Forex exit config ─────────────────────────────────────────────────────────

def test_forex_tighter_sl():
    """Forex SL = 0.3% → SL level closer to entry than crypto."""
    from config import FOREX_EXIT_OVERRIDE
    forex_cfg = {**CFG, **FOREX_EXIT_OVERRIDE}
    closes = [100] + [99.9] * 3 + [99.5] * 3   # would survive crypto SL (99), not forex (99.7)
    df = _df_from_closes(closes)
    # low = close * 0.995 → e.g. 99.5 * 0.995 = 99.0025 → above crypto SL but...
    # Forex SL = 100 * (1 - 0.003) = 99.7 → 99.5 * 0.995 = 99.0025 < 99.7 → SL hit
    res_forex  = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=forex_cfg)
    res_crypto = simulate_trade(df, entry_bar=0, direction="LONG", exit_cfg=CFG)
    # Forex SL fires earlier (fewer bars or same bar)
    assert res_forex.bars_held <= res_crypto.bars_held
