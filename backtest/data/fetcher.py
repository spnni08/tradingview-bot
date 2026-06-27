"""
Data fetcher: ccxt (Binance) for crypto, Alpha Vantage for forex.
Results are cached as Parquet in data/cache/.
"""
import os
import time
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ccxt
import pandas as pd

from config import (
    CRYPTO_TIMEFRAME, FOREX_TIMEFRAME, LOOKBACK_MONTHS,
    ALPHA_VANTAGE_KEY,
)

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cache_path(symbol: str, timeframe: str) -> Path:
    safe = symbol.replace("/", "_").replace(":", "_")
    return CACHE_DIR / f"{safe}_{timeframe}.parquet"


def _start_ts(months: int) -> int:
    """Unix timestamp in ms for N months ago."""
    dt = datetime.now(tz=timezone.utc) - timedelta(days=months * 30)
    return int(dt.timestamp() * 1000)


# ── Crypto (Binance via ccxt) ─────────────────────────────────────────────────

def fetch_crypto(symbol: str, timeframe: str = CRYPTO_TIMEFRAME,
                 lookback_months: int = LOOKBACK_MONTHS,
                 force_refresh: bool = False) -> pd.DataFrame:
    """
    Fetch OHLCV from Binance. Cached as Parquet.
    Returns DataFrame with columns: open, high, low, close, volume
    Index: DatetimeIndex (UTC).
    """
    cache = _cache_path(symbol, timeframe)
    if cache.exists() and not force_refresh:
        df = pd.read_parquet(cache)
        # extend if cache is more than 1 day stale
        last_ts = df.index[-1].timestamp() * 1000
        now_ms  = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        if now_ms - last_ts < 24 * 3600 * 1000:
            print(f"  [cache] {symbol} {timeframe}: {len(df)} bars")
            return df
        since = int(last_ts) + 1
        print(f"  [extend] {symbol} {timeframe}: fetching from {pd.Timestamp(since, unit='ms', tz='UTC')}")
    else:
        since = _start_ts(lookback_months)
        df = pd.DataFrame()

    exchange = ccxt.binance({"enableRateLimit": True})
    ohlcvs = []
    limit   = 1000

    while True:
        batch = exchange.fetch_ohlcv(symbol, timeframe, since=since, limit=limit)
        if not batch:
            break
        ohlcvs.extend(batch)
        since = batch[-1][0] + 1
        if len(batch) < limit:
            break
        time.sleep(exchange.rateLimit / 1000)

    if not ohlcvs:
        return df

    new_df = pd.DataFrame(ohlcvs, columns=["ts", "open", "high", "low", "close", "volume"])
    new_df.index = pd.to_datetime(new_df["ts"], unit="ms", utc=True)
    new_df = new_df.drop(columns=["ts"])

    if not df.empty:
        df = pd.concat([df, new_df]).drop_duplicates().sort_index()
    else:
        df = new_df.sort_index()

    df.to_parquet(cache)
    print(f"  [fetched] {symbol} {timeframe}: {len(df)} bars → {cache.name}")
    return df


# ── Forex (Alpha Vantage) ─────────────────────────────────────────────────────

def fetch_forex(symbol: str = "EUR/USD", timeframe: str = FOREX_TIMEFRAME,
                lookback_months: int = LOOKBACK_MONTHS,
                av_key: str = "",
                force_refresh: bool = False) -> pd.DataFrame:
    """
    Fetch forex OHLCV from Alpha Vantage FX_INTRADAY endpoint.
    Uses the `outputsize=full` parameter (last ~30 trading days per call).
    Iterates over months using `month=YYYY-MM` parameter for extended history.

    Free tier: 25 requests/day. One month = 1 request.
    9 months → 9 requests (well within free limit).

    Returns DataFrame with columns: open, high, low, close, volume (= 0 for forex)
    Index: DatetimeIndex (UTC).

    Args:
        symbol: "EUR/USD" format.
        timeframe: "5m" → "5min" in AV notation.
        av_key: Alpha Vantage API key. Falls back to ALPHA_VANTAGE_KEY config.
    """
    cache = _cache_path(symbol, timeframe)
    if cache.exists() and not force_refresh:
        df = pd.read_parquet(cache)
        last_ts = df.index[-1].timestamp() * 1000
        now_ms  = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        if now_ms - last_ts < 24 * 3600 * 1000:
            print(f"  [cache] {symbol} {timeframe}: {len(df)} bars")
            return df

    key = av_key or ALPHA_VANTAGE_KEY
    if not key:
        raise ValueError(
            "Alpha Vantage API key required for forex data.\n"
            "  Get a free key at https://www.alphavantage.co/support/#api-key\n"
            "  Then pass --av-key <KEY> to run.py or set ALPHA_VANTAGE_KEY in .env"
        )

    from_symbol, to_symbol = symbol.split("/")
    interval_map = {"1m": "1min", "5m": "5min", "15m": "15min", "1h": "60min"}
    interval = interval_map.get(timeframe, "5min")

    all_frames = []
    start_dt = datetime.now(tz=timezone.utc) - timedelta(days=lookback_months * 30)

    for month_offset in range(lookback_months + 1):
        target = start_dt + timedelta(days=30 * month_offset)
        month_str = target.strftime("%Y-%m")
        url = (
            f"https://www.alphavantage.co/query"
            f"?function=FX_INTRADAY"
            f"&from_symbol={from_symbol}&to_symbol={to_symbol}"
            f"&interval={interval}&outputsize=full"
            f"&month={month_str}&apikey={key}"
        )
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        ts_key = f"Time Series FX ({interval})"
        if ts_key not in data:
            print(f"  [av] {symbol} {month_str}: no data or rate limit — {data.get('Note', data.get('Information', '?'))}")
            time.sleep(12)   # rate limit: 5 req/min on free tier
            continue

        rows = []
        for dt_str, vals in data[ts_key].items():
            rows.append({
                "timestamp": pd.Timestamp(dt_str, tz="US/Eastern").tz_convert("UTC"),
                "open":  float(vals["1. open"]),
                "high":  float(vals["2. high"]),
                "low":   float(vals["3. low"]),
                "close": float(vals["4. close"]),
                "volume": 0.0,
            })
        frame = pd.DataFrame(rows).set_index("timestamp").sort_index()
        all_frames.append(frame)
        print(f"  [av] {symbol} {month_str}: {len(frame)} bars")
        time.sleep(13)   # free tier: 5 req/min

    if not all_frames:
        raise RuntimeError(f"No forex data fetched for {symbol}")

    df = pd.concat(all_frames).drop_duplicates().sort_index()
    df.to_parquet(cache)
    print(f"  [forex] {symbol} {timeframe}: {len(df)} bars total → {cache.name}")
    return df


def load_or_fetch(symbol: str, is_forex: bool = False,
                  timeframe: str = None,
                  lookback_months: int = LOOKBACK_MONTHS,
                  av_key: str = "", force_refresh: bool = False) -> pd.DataFrame:
    """Convenience wrapper."""
    if is_forex:
        tf = timeframe or FOREX_TIMEFRAME
        return fetch_forex(symbol, tf, lookback_months, av_key, force_refresh)
    else:
        tf = timeframe or CRYPTO_TIMEFRAME
        return fetch_crypto(symbol, tf, lookback_months, force_refresh)
