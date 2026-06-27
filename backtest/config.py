"""Central configuration — symbols, timeframes, date ranges, exit parameters."""
from datetime import datetime, timezone

# ── Symbols & timeframes ──────────────────────────────────────────────────────
CRYPTO_SYMBOLS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"]
FOREX_SYMBOLS  = ["EUR/USD"]           # fetched via Alpha Vantage

CRYPTO_TIMEFRAME = "5m"               # matches live Pine Script timeframe
FOREX_TIMEFRAME  = "5m"

# How far back to fetch (months)
LOOKBACK_MONTHS = 9

# ── Alpha Vantage (Forex) ─────────────────────────────────────────────────────
# Free API key: https://www.alphavantage.co/support/#api-key
# The free tier allows 25 requests/day. One symbol = 1 request per call.
# Set via env var ALPHA_VANTAGE_KEY or pass --av-key to run.py.
ALPHA_VANTAGE_KEY = ""                 # override from env or CLI

# ── Exit logic (mirrors EXIT_CONFIG in worker.js) ─────────────────────────────
EXIT_CONFIG = {
    "SL_DISTANCE_PCT":    1.00,   # 1R = 1% risk
    "TP2_R_MULTIPLE":     1.50,   # TP2 at 1.5R
    "TP1_DISTANCE_FRAC":  0.60,   # TP1 at 60% of way to TP2
    "TP1_CLOSE_FRAC":     0.50,   # close 50% at TP1
    "BREAKEVEN_OFFSET_R": 0.10,   # after TP1: SL → entry + 0.1R
    "MAX_BARS_OPEN":      288,    # max candles to hold (≈ 24h on 5m)
}

FOREX_EXIT_OVERRIDE = {
    "SL_DISTANCE_PCT": 0.30,      # forex: tighter SL
}

# ── Volume Profile (mirrors crypto_sr_volume.pine defaults) ──────────────────
VP_LOOKBACK = 288    # bars
VP_BINS     = 50
VP_VA_PCT   = 70.0   # value area %
VP_TOL_PCT  = 0.15   # zone tolerance %

# ── Strategy trigger parameters ───────────────────────────────────────────────
BASELINE_RSI_LONG_THRESH  = 30   # broad trigger: RSI crosses below 30
BASELINE_RSI_SHORT_THRESH = 70

SR_VOL_RSI_NO_DOWN = 40
SR_VOL_RSI_NO_UP   = 60

BREAKOUT_N        = 20    # range lookback bars
BREAKOUT_VOL_MULT = 1.5

FOREX_SWING_LEN   = 20
FOREX_FIB_TOL_PCT = 0.10
FOREX_RSI_LONG    = 50
FOREX_RSI_SHORT   = 50

FOREX_SESSIONS_UTC = [
    (8, 9),    # London-Open 08:00–09:00 UTC
    (13, 16),  # London/NY-Overlap 13:00–16:00 UTC
]
