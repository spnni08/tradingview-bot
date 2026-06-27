"""
Trade outcome simulator — mirrors EXIT_CONFIG logic in worker.js.

Given an entry bar index and OHLCV data, walks forward through candles
to determine outcome.  No look-ahead: only candles AFTER entry are used.

EXIT_CONFIG (per strategy):
  SL_DISTANCE_PCT    = 1.00%  (forex: 0.30%)
  TP2_R_MULTIPLE     = 1.50
  TP1_DISTANCE_FRAC  = 0.60   # TP1 at 60% of way to TP2
  TP1_CLOSE_FRAC     = 0.50   # close 50% at TP1 (impacts PnL calculation)
  BREAKEVEN_OFFSET_R = 0.10   # after TP1: SL → entry + 0.1R
  MAX_BARS_OPEN      = 288    # timeout
"""
import numpy as np
import pandas as pd
from typing import NamedTuple


class TradeResult(NamedTuple):
    outcome: str        # TP2 | SL_BEFORE_TP1 | SL_AFTER_TP1 | TIMEOUT
    pnl_pct: float      # realized PnL in % (blended for partial exits)
    tp1_hit: bool
    bars_held: int
    exit_price: float
    tp1_price: float
    tp2_price: float
    sl_price: float


def simulate_trade(df: pd.DataFrame, entry_bar: int, direction: str,
                   exit_cfg: dict) -> TradeResult:
    """
    Simulate a single trade forward from entry_bar (inclusive).

    df must have columns: open, high, low, close.
    entry_bar: integer position in df (iloc index).
    direction: 'LONG' or 'SHORT'.
    exit_cfg: dict with keys matching EXIT_CONFIG.
    """
    sl_pct    = exit_cfg["SL_DISTANCE_PCT"]    / 100.0
    tp2_r     = exit_cfg["TP2_R_MULTIPLE"]
    tp1_frac  = exit_cfg["TP1_DISTANCE_FRAC"]
    tp1_close = exit_cfg["TP1_CLOSE_FRAC"]
    be_r      = exit_cfg["BREAKEVEN_OFFSET_R"]
    max_bars  = exit_cfg["MAX_BARS_OPEN"]

    entry_price = df["close"].iloc[entry_bar]
    is_long     = direction == "LONG"

    if is_long:
        sl   = entry_price * (1 - sl_pct)
        tp2  = entry_price + tp2_r * (entry_price - sl)
        tp1  = entry_price + tp1_frac * (tp2 - entry_price)
        be_sl = entry_price + be_r * (entry_price - sl)   # after TP1
    else:
        sl   = entry_price * (1 + sl_pct)
        tp2  = entry_price - tp2_r * (sl - entry_price)
        tp1  = entry_price - tp1_frac * (entry_price - tp2)
        be_sl = entry_price - be_r * (sl - entry_price)

    tp1_hit       = False
    active_sl     = sl
    n             = len(df)
    last_bar      = min(entry_bar + max_bars, n - 1)
    bars_held     = 0
    exit_price    = df["close"].iloc[last_bar]

    for i in range(entry_bar + 1, last_bar + 1):
        high = df["high"].iloc[i]
        low  = df["low"].iloc[i]
        bars_held += 1

        if is_long:
            if not tp1_hit and low <= active_sl:
                # SL hit before TP1 → full loss
                return TradeResult(
                    outcome="SL_BEFORE_TP1",
                    pnl_pct=_pct(active_sl, entry_price, is_long),
                    tp1_hit=False, bars_held=bars_held,
                    exit_price=active_sl,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )
            if not tp1_hit and high >= tp1:
                tp1_hit   = True
                active_sl = be_sl   # move SL to breakeven
            if tp1_hit and low <= active_sl:
                # SL after TP1 → blended: 50% at TP1, 50% at breakeven
                pnl = _blended_pnl(tp1, active_sl, entry_price, is_long, tp1_close)
                return TradeResult(
                    outcome="SL_AFTER_TP1",
                    pnl_pct=pnl,
                    tp1_hit=True, bars_held=bars_held,
                    exit_price=active_sl,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )
            if high >= tp2:
                pnl = _blended_pnl(tp1, tp2, entry_price, is_long, tp1_close)
                return TradeResult(
                    outcome="TP2",
                    pnl_pct=pnl,
                    tp1_hit=True, bars_held=bars_held,
                    exit_price=tp2,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )
        else:  # SHORT
            if not tp1_hit and high >= active_sl:
                return TradeResult(
                    outcome="SL_BEFORE_TP1",
                    pnl_pct=_pct(active_sl, entry_price, is_long),
                    tp1_hit=False, bars_held=bars_held,
                    exit_price=active_sl,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )
            if not tp1_hit and low <= tp1:
                tp1_hit   = True
                active_sl = be_sl
            if tp1_hit and high >= active_sl:
                pnl = _blended_pnl(tp1, active_sl, entry_price, is_long, tp1_close)
                return TradeResult(
                    outcome="SL_AFTER_TP1",
                    pnl_pct=pnl,
                    tp1_hit=True, bars_held=bars_held,
                    exit_price=active_sl,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )
            if low <= tp2:
                pnl = _blended_pnl(tp1, tp2, entry_price, is_long, tp1_close)
                return TradeResult(
                    outcome="TP2",
                    pnl_pct=pnl,
                    tp1_hit=True, bars_held=bars_held,
                    exit_price=tp2,
                    tp1_price=tp1, tp2_price=tp2, sl_price=sl,
                )

    # Timeout
    return TradeResult(
        outcome="TIMEOUT",
        pnl_pct=_pct(exit_price, entry_price, is_long),
        tp1_hit=tp1_hit, bars_held=bars_held,
        exit_price=exit_price,
        tp1_price=tp1, tp2_price=tp2, sl_price=sl,
    )


def _pct(exit_p: float, entry_p: float, is_long: bool) -> float:
    if entry_p == 0:
        return 0.0
    change = (exit_p - entry_p) / entry_p * 100
    return change if is_long else -change


def _blended_pnl(tp1_price: float, second_price: float, entry_price: float,
                  is_long: bool, tp1_frac: float) -> float:
    """50% closed at TP1, remaining 50% at second_price."""
    pnl_tp1  = _pct(tp1_price,    entry_price, is_long)
    pnl_rest = _pct(second_price, entry_price, is_long)
    return tp1_frac * pnl_tp1 + (1 - tp1_frac) * pnl_rest
