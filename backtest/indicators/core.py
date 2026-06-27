"""
Indicators that exactly mirror Pine Script built-ins.

Pine's ta.rsi uses Wilder's smoothing (RMA = EWM with alpha=1/N, adjust=False).
Pine's ta.ema uses standard EWM with adjust=False, span=N.
All indicators return pd.Series aligned to the input index.
"""
import numpy as np
import pandas as pd


# ── RSI (Wilder's smoothing — matches Pine ta.rsi) ───────────────────────────

def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    # RMA = EWM adjust=False, com = length-1  (alpha = 1/length)
    avg_gain = gain.ewm(alpha=1 / length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / length, adjust=False).mean()
    # When avg_loss = 0 (all gains), Pine returns 100.
    # replace(0, nan) would give NaN, so we handle it explicitly.
    rs = avg_gain / avg_loss.where(avg_loss != 0, np.nan)
    result = 100 - 100 / (1 + rs)
    result = result.where(avg_loss != 0, 100.0)   # avg_loss=0 → RSI=100
    return result.rename("rsi")


# ── EMA (matches Pine ta.ema) ────────────────────────────────────────────────

def ema(close: pd.Series, length: int) -> pd.Series:
    return close.ewm(span=length, adjust=False).mean().rename(f"ema{length}")


# ── ATR (matches Pine ta.atr) ────────────────────────────────────────────────

def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / length, adjust=False).mean().rename("atr")


# ── Volume Profile (mirrors crypto_sr_volume.pine calcVP) ────────────────────

def volume_profile_row(high_w: np.ndarray, low_w: np.ndarray,
                        close_w: np.ndarray, vol_w: np.ndarray,
                        n_bins: int, va_pct: float) -> tuple[float, float, float]:
    """
    Compute (POC price, VAH price, VAL price) for one window of bars.
    Mirrors Pine Script calcVP() exactly.

    high_w, low_w, close_w, vol_w: arrays of length == lookback (oldest→newest).
    n_bins: number of price bins.
    va_pct: value area percentage (e.g. 70.0).
    """
    hi = high_w.max()
    lo = low_w.min()
    if hi <= lo:
        mid = (hi + lo) / 2
        return mid, hi, lo

    bin_size = (hi - lo) / n_bins
    bin_vol = np.zeros(n_bins)

    # assign each close to a bin (matches Pine idx = int((close-lo)/binSize))
    idxs = np.clip(((close_w - lo) / bin_size).astype(int), 0, n_bins - 1)
    np.add.at(bin_vol, idxs, vol_w)

    poc_idx = int(np.argmax(bin_vol))
    poc_price = lo + (poc_idx + 0.5) * bin_size

    total  = bin_vol.sum()
    target = total * va_pct / 100.0
    lo_idx = poc_idx
    hi_idx = poc_idx
    acc    = bin_vol[poc_idx]

    # expand value area from POC (matches Pine while loop)
    while acc < target and (lo_idx > 0 or hi_idx < n_bins - 1):
        below = bin_vol[lo_idx - 1] if lo_idx > 0          else -1.0
        above = bin_vol[hi_idx + 1] if hi_idx < n_bins - 1 else -1.0
        if above >= below:
            hi_idx += 1
            acc    += max(0.0, above)
        else:
            lo_idx -= 1
            acc    += max(0.0, below)

    vah = lo + (hi_idx + 1) * bin_size
    val = lo + lo_idx       * bin_size
    return poc_price, vah, val


def volume_profile(df: pd.DataFrame, lookback: int, n_bins: int, va_pct: float
                   ) -> pd.DataFrame:
    """
    Rolling Volume Profile for each bar.  Uses only past data (no look-ahead).
    Returns DataFrame with columns: poc, vah, val (same index as df).

    Pine's calcVP() reads close[i] for i in 0..vpLookback-1 at each bar,
    so the window includes the CURRENT bar.  We replicate that.
    """
    highs  = df["high"].to_numpy()
    lows   = df["low"].to_numpy()
    closes = df["close"].to_numpy()
    vols   = df["volume"].to_numpy()
    n      = len(df)

    poc_arr = np.full(n, np.nan)
    vah_arr = np.full(n, np.nan)
    val_arr = np.full(n, np.nan)

    for i in range(lookback - 1, n):
        h_w = highs [i - lookback + 1 : i + 1]
        l_w = lows  [i - lookback + 1 : i + 1]
        c_w = closes[i - lookback + 1 : i + 1]
        v_w = vols  [i - lookback + 1 : i + 1]
        poc_arr[i], vah_arr[i], val_arr[i] = volume_profile_row(
            h_w, l_w, c_w, v_w, n_bins, va_pct
        )

    return pd.DataFrame({"poc": poc_arr, "vah": vah_arr, "val": val_arr},
                         index=df.index)
