#!/usr/bin/env python3
"""
WAVESCOUT Backtest Engine — entry point.

Usage:
  python run.py                              # all symbols, all strategies
  python run.py --symbols BTC/USDT ETH/USDT # specific crypto symbols
  python run.py --strategies crypto_baseline # specific strategies
  python run.py --months 6                   # lookback period
  python run.py --av-key <KEY>               # Alpha Vantage key for forex
  python run.py --refresh                    # force re-download (ignore cache)
  python run.py --fmt csv                    # export as CSV instead of Parquet
  python run.py --no-forex                   # skip forex (no AV key needed)
"""
import argparse
import os
import sys
from pathlib import Path

# Allow imports from backtest/ root
sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd

from config import (
    CRYPTO_SYMBOLS, FOREX_SYMBOLS, CRYPTO_TIMEFRAME, FOREX_TIMEFRAME,
    LOOKBACK_MONTHS, ALPHA_VANTAGE_KEY,
)
from data.fetcher import load_or_fetch
from simulation.backtest import run_backtest
from export.exporter import (
    export_strategy, export_combined, print_validation_report, export_json_summary,
)

import strategies.crypto_baseline           as s_baseline
import strategies.crypto_sr_volume          as s_sr_vol
import strategies.crypto_orderflow_breakout as s_breakout
import strategies.forex_sr_fib_rsi          as s_forex


STRATEGY_MAP = {
    "crypto_baseline":           s_baseline,
    "crypto_sr_volume":          s_sr_vol,
    "crypto_orderflow_breakout": s_breakout,
    "forex_sr_fib_rsi":          s_forex,
}

CRYPTO_STRATEGIES = ["crypto_baseline", "crypto_sr_volume", "crypto_orderflow_breakout"]
FOREX_STRATEGIES  = ["forex_sr_fib_rsi"]


def _send_telegram(token: str, chat_id: str, text: str) -> None:
    """Fire-and-forget Telegram message; logs errors but never raises."""
    import urllib.request, urllib.parse, json as _json
    try:
        payload = _json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=payload, headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status != 200:
                print(f"  [telegram] unexpected status {r.status}")
    except Exception as e:
        print(f"  [telegram] failed to send notification: {e}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="WAVESCOUT Backtest Engine")
    p.add_argument("--symbols",     nargs="+", default=None,
                   help="Crypto symbols (e.g. BTC/USDT ETH/USDT)")
    p.add_argument("--strategies",  nargs="+", default=None,
                   choices=list(STRATEGY_MAP.keys()),
                   help="Strategies to run (default: all)")
    p.add_argument("--months",      type=int, default=LOOKBACK_MONTHS,
                   help="Lookback in months (default: %(default)s)")
    p.add_argument("--av-key",      default=os.environ.get("ALPHA_VANTAGE_KEY", ALPHA_VANTAGE_KEY),
                   help="Alpha Vantage API key for EUR/USD data")
    p.add_argument("--refresh",     action="store_true",
                   help="Force re-download even if cache exists")
    p.add_argument("--fmt",         choices=["parquet", "csv"], default="parquet")
    p.add_argument("--no-forex",    action="store_true",
                   help="Skip forex strategies (no AV key needed)")
    p.add_argument("--no-progress", action="store_true",
                   help="Disable tqdm progress bars")
    p.add_argument("--json-summary", default=None, metavar="PATH",
                   help="Write JSON summary to PATH (used by CI)")
    p.add_argument("--fail-on-empty", action="store_true",
                   help="Exit 1 if all strategies produced 0 candidates")
    p.add_argument("--telegram-token", default=os.environ.get("TELEGRAM_BOT_TOKEN", ""),
                   help="Telegram bot token for run notification")
    p.add_argument("--telegram-chat",  default=os.environ.get("TELEGRAM_CHAT_ID", ""),
                   help="Telegram chat ID for run notification")
    return p.parse_args()


def main():
    args = parse_args()

    crypto_syms = args.symbols or CRYPTO_SYMBOLS
    strategies  = args.strategies or list(STRATEGY_MAP.keys())
    if args.no_forex:
        strategies = [s for s in strategies if s not in FOREX_STRATEGIES]

    crypto_strats = [s for s in strategies if s in CRYPTO_STRATEGIES]
    forex_strats  = [s for s in strategies if s in FOREX_STRATEGIES]

    print(f"\n{'='*65}")
    print(f"  WAVESCOUT Backtest Engine")
    print(f"  Lookback: {args.months} months")
    print(f"  Crypto symbols: {crypto_syms}")
    print(f"  Strategies: {strategies}")
    print(f"{'='*65}\n")

    all_results: dict[str, list[pd.DataFrame]] = {s: [] for s in strategies}

    # ── Crypto ───────────────────────────────────────────────────────────────
    for symbol in crypto_syms:
        print(f"\n[{symbol}] Fetching data...")
        try:
            df = load_or_fetch(symbol, is_forex=False,
                                lookback_months=args.months,
                                force_refresh=args.refresh)
        except Exception as e:
            print(f"  ERROR fetching {symbol}: {e}")
            continue

        print(f"  {len(df):,} bars  ({df.index[0]} → {df.index[-1]})")

        for strat_key in crypto_strats:
            mod = STRATEGY_MAP[strat_key]
            print(f"\n  [{strat_key}] detecting candidates...")
            try:
                candidates = mod.detect_candidates(df)
                print(f"    {len(candidates):,} candidates found")
            except Exception as e:
                print(f"    ERROR: {e}")
                import traceback; traceback.print_exc()
                continue

            if candidates.empty:
                continue

            result = run_backtest(
                df, candidates, symbol, strat_key,
                show_progress=not args.no_progress,
            )
            if not result.empty:
                all_results[strat_key].append(result)

    # ── Forex ─────────────────────────────────────────────────────────────────
    if forex_strats:
        for symbol in FOREX_SYMBOLS:
            print(f"\n[{symbol}] Fetching forex data...")
            try:
                df = load_or_fetch(symbol, is_forex=True,
                                    lookback_months=args.months,
                                    av_key=args.av_key,
                                    force_refresh=args.refresh)
            except ValueError as e:
                print(f"  {e}")
                continue
            except Exception as e:
                print(f"  ERROR fetching {symbol}: {e}")
                continue

            print(f"  {len(df):,} bars  ({df.index[0]} → {df.index[-1]})")

            for strat_key in forex_strats:
                mod = STRATEGY_MAP[strat_key]
                print(f"\n  [{strat_key}] detecting candidates...")
                try:
                    candidates = mod.detect_candidates(df)
                    print(f"    {len(candidates):,} candidates found")
                except Exception as e:
                    print(f"    ERROR: {e}")
                    continue

                if candidates.empty:
                    continue

                result = run_backtest(
                    df, candidates, symbol, strat_key,
                    show_progress=not args.no_progress,
                )
                if not result.empty:
                    all_results[strat_key].append(result)

    # ── Merge & Export ────────────────────────────────────────────────────────
    print("\n\nExporting results...")
    merged: dict[str, pd.DataFrame] = {}
    for strat_key, frames in all_results.items():
        if frames:
            merged[strat_key] = pd.concat(frames, ignore_index=True)
        else:
            merged[strat_key] = pd.DataFrame()

    for strat_key, df in merged.items():
        export_strategy(df, strat_key, fmt=args.fmt)

    export_combined(merged, fmt=args.fmt)
    print_validation_report(merged)

    # ── JSON summary (CI artifact) ────────────────────────────────────────────
    summary = None
    if args.json_summary:
        from pathlib import Path as _Path
        summary = export_json_summary(merged, _Path(args.json_summary))

    # ── Fail-fast: exit 1 if all results empty ────────────────────────────────
    total_candidates = sum(len(df) for df in merged.values() if not df.empty)
    if args.fail_on_empty and total_candidates == 0:
        msg = "FATAL: 0 candidates produced across all strategies — data fetch may have failed."
        print(f"\n{msg}", file=sys.stderr)
        if args.telegram_token and args.telegram_chat:
            _send_telegram(args.telegram_token, args.telegram_chat,
                           f"*WAVESCOUT Backtest FAILED*\n{msg}")
        sys.exit(1)

    # ── Telegram notification ─────────────────────────────────────────────────
    if args.telegram_token and args.telegram_chat:
        lines = ["*WAVESCOUT Backtest Complete*"]
        for strat_key, df in merged.items():
            if df.empty:
                lines.append(f"  • `{strat_key}`: 0 candidates")
            else:
                wr = df["win"].mean() * 100
                lines.append(f"  • `{strat_key}`: {len(df):,} cands, win {wr:.1f}%")
        _send_telegram(args.telegram_token, args.telegram_chat, "\n".join(lines))


if __name__ == "__main__":
    main()
