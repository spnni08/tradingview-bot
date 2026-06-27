# WAVESCOUT Backtest Engine

Standalone Python backtest engine that mirrors the 4 WAVESCOUT Pine Script
strategies on historical OHLCV data to produce a labelled candidate dataset
for ML training. **No dependency on `worker.js` or Cloudflare code.**

## Setup

```bash
cd backtest
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

## Usage

```bash
# All strategies, all symbols, 9-month lookback
venv/bin/python run.py

# Crypto-only (no Alpha Vantage key required)
venv/bin/python run.py --no-forex

# Specific symbols / strategies
venv/bin/python run.py --symbols BTC/USDT ETH/USDT --strategies crypto_baseline

# Shorten lookback
venv/bin/python run.py --months 3

# Force re-download cache
venv/bin/python run.py --refresh

# Export as CSV instead of Parquet
venv/bin/python run.py --fmt csv
```

Results are written to `output/`:
- `candidates_<strategy>.parquet` — one file per strategy
- `candidates_all.parquet` — all strategies combined

## Forex data (EUR/USD)

Forex requires a free [Alpha Vantage](https://www.alphavantage.co/support/#api-key)
API key (25 requests/day; 9 months = 9 requests):

```bash
venv/bin/python run.py --av-key YOUR_KEY
# or
ALPHA_VANTAGE_KEY=YOUR_KEY venv/bin/python run.py
```

**Why Alpha Vantage?**  
- ccxt supports many crypto exchanges but not EUR/USD natively  
- yfinance only has 60 days of 5-minute forex data  
- Alpha Vantage's `FX_INTRADAY` endpoint gives 5-minute bars back 20+ years
- Free tier: 25 req/day, no credit card required

## Data caching

Raw OHLCV data is cached as Parquet in `data/cache/` and re-used on subsequent
runs. The fetcher auto-extends the cache when bars are stale (> 24h). Cache
files are gitignored.

## Architecture

```
backtest/
├── config.py                 # all parameters (symbols, exit config, VP params)
├── run.py                    # CLI entry point
├── data/
│   └── fetcher.py            # ccxt (Binance) + Alpha Vantage fetchers + cache
├── indicators/
│   └── core.py               # RSI, EMA, ATR, Volume Profile (matches Pine exactly)
├── strategies/
│   ├── crypto_baseline.py        # RSI crossover trigger
│   ├── crypto_sr_volume.py       # VAL/VAH bounce trigger
│   ├── crypto_orderflow_breakout.py  # range breakout + volume trigger
│   └── forex_sr_fib_rsi.py       # Fibonacci zone + session filter
├── simulation/
│   ├── exit_logic.py         # TP1 → Breakeven → TP2 → SL simulation
│   └── backtest.py           # per-candidate outcome loop
├── export/
│   └── exporter.py           # Parquet/CSV export + validation report
└── tests/
    ├── test_indicators.py
    ├── test_exit_logic.py
    └── test_strategies.py
```

## Exit Logic (mirrors worker.js EXIT_CONFIG)

| Parameter | Crypto | Forex |
|---|---|---|
| SL distance | 1.00% | 0.30% |
| TP2 | Entry + 1.5R | same |
| TP1 | 60% of way to TP2 | same |
| TP1 close fraction | 50% | same |
| Breakeven offset | Entry + 0.1R | same |
| Max bars open | 288 (≈24h on 5m) | same |

## Output columns

| Column | Description |
|---|---|
| `timestamp` | Bar timestamp (UTC) |
| `symbol` | e.g. `BTC/USDT` |
| `strategy` | Strategy key |
| `direction` | `LONG` / `SHORT` |
| `entry_price` | Close price at trigger bar |
| `outcome` | `TP2` / `SL_BEFORE_TP1` / `SL_AFTER_TP1` / `TIMEOUT` |
| `pnl_pct` | Blended realized PnL % |
| `win` | 1 if pnl_pct > 0 |
| `tp1_hit` | 1 if TP1 was reached |
| `bars_held` | Candles until exit |
| Strategy-specific context | `ema_dist_pct`, `near_sup`, `reclaim`, `vol_ratio`, `dist_to_val`, … |

## Tests

```bash
venv/bin/python -m pytest tests/ -v
```

35 tests covering indicators, exit logic, and all 4 strategy detectors.
