"""
WAVESCOUT Backtest — Order-Flow-/Struktur-Bausteine

  1) Rolling Volume Profile (POC / VAL / VAH)  — Pendant zu Krypto-2
     (crypto_sr_volume) und Forex (forex_sr_fib_rsi).
  2) CVD-Approximation (kumulatives Delta + Slope) — Pendant zu Krypto-3
     (crypto_orderflow_breakout) als Order-Flow-Bestätigungsfilter.

Diese Implementierung ist bewusst 1:1 zur Pine-Script-Logik in
``wavescout_core_v2.pine`` (Score-Pipeline) gehalten — inkl. Bin-Indexierung,
Value-Area-Expansion und CVD-Berechnung. Wird die Pine-Datei geaendert,
muss dieses Modul mitgezogen werden, sonst divergieren Backtest und
Live-Signal.

Referenz-Parameter (Pine, identisch fuer Krypto-2 und Forex):
    k2Lookback / fxLookback        = 200   -> ``lookback``
    k2Bins     / fxBins            = 24    -> ``buckets``
    k2ValueAreaPct / fxValueAreaPct= 0.70  -> ``value_area_pct``
    cvdSlopeLen                    = 14    -> ``slope_lookback``
    k3RangeLen                     = 20    -> ``vol_avg_window``
    k3VolMultiplier                = 1.5   -> ``vol_spike_multiplier``

Alle Funktionen sind reine Funktionen (DataFrame rein, DataFrame raus,
keine Seiteneffekte), reines pandas/numpy, damit sie pro Strategie in der
bestehenden Backtest-Pipeline aufrufbar sind.

ACHTUNG — Divergenz zum aktuell eingecheckten Pine/``indicators.core``:
    Die in diesem Repo liegenden Einzel-Pines (crypto_sr_volume.pine: 288/50,
    Value-Area-Tie-Break ``above >= below``) und ``indicators.core.volume_profile``
    weichen von der hier replizierten Score-Pipeline-Logik ab (200/24,
    Tie-Break ``volBelow >= volAbove``, d.h. bei Gleichstand wird der
    UNTERE Nachbar bevorzugt). Dieses Modul folgt der Score-Pipeline-Spezifikation
    aus ``wavescout_core_v2.pine``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------
# 1) ROLLING VOLUME PROFILE (POC / VAL / VAH)
# ---------------------------------------------------------------------

def rolling_volume_profile(
    df: pd.DataFrame,
    lookback: int = 200,
    buckets: int = 24,
    value_area_pct: float = 0.70,
) -> pd.DataFrame:
    """Rolling Volume Profile (POC/VAL/VAH) wie in ``wavescout_core_v2.pine``.

    Parametrisierbar, damit Krypto-2 (``k2Lookback/k2Bins/k2ValueAreaPct``)
    und Forex (``fxLookback/fxBins/fxValueAreaPct``) dieselbe Funktion nutzen
    (Default-Werte = Pine-Defaults 200 / 24 / 0.70).

    Pine-Logik:
      * ``lo`` = niedrigstes Low, ``hi`` = hoechstes High im Lookback-Fenster
        (Fenster inkl. aktueller Kerze, analog ``ta.lowest`` / ``ta.highest``).
      * ``binSize = (hi - lo) / bins``.
      * Jede Kerze traegt ihr VOLLES Volumen in den Bin ihres Closes ein
        (kein Split ueber die Kerzen-Range):
        ``idx = clamp(floor((close - lo) / binSize), 0, bins - 1)``.
      * POC = Bin mit maximalem Volumen.
      * Value Area: ausgehend vom POC-Bin symmetrisch nach aussen erweitern,
        bei jedem Schritt den Nachbarn mit dem groesseren Volumen hinzunehmen;
        bei Gleichstand den UNTEREN Nachbarn bevorzugen (``volBelow >= volAbove``),
        bis die Zielmenge (``value_area_pct`` des Gesamtvolumens) erreicht ist.
      * VAL = untere Grenze des unteren Value-Area-Bins,
        VAH = obere Grenze des oberen Value-Area-Bins.

    Erwartet ``df`` mit Spalten ``high, low, close, volume`` (aufsteigend nach
    Zeit). Gibt eine Kopie mit zusaetzlichen Spalten ``poc``, ``val``, ``vah``
    zurueck (NaN fuer die ersten ``lookback - 1`` Zeilen).
    """
    n = len(df)
    poc = np.full(n, np.nan)
    val = np.full(n, np.nan)
    vah = np.full(n, np.nan)

    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    vols = df["volume"].to_numpy(dtype=float)

    for i in range(lookback - 1, n):
        window = slice(i - lookback + 1, i + 1)
        vp_high = highs[window].max()
        vp_low = lows[window].min()
        vp_step = (vp_high - vp_low) / buckets
        if vp_step <= 0:
            # Entartetes Fenster (hi == lo) -> kein definierbares Profil, NaN.
            continue

        win_close = closes[window]
        win_vol = vols[window]

        # idx = clamp(floor((close - lo) / binSize), 0, bins - 1)
        idx = np.clip(
            np.floor((win_close - vp_low) / vp_step).astype(int), 0, buckets - 1
        )
        vol_buckets = np.zeros(buckets)
        np.add.at(vol_buckets, idx, win_vol)

        poc_idx = int(np.argmax(vol_buckets))

        total_vol = vol_buckets.sum()
        target_vol = total_vol * value_area_pct

        val_idx = poc_idx
        vah_idx = poc_idx
        acc_vol = vol_buckets[poc_idx]

        while acc_vol < target_vol and (val_idx > 0 or vah_idx < buckets - 1):
            vol_below = vol_buckets[val_idx - 1] if val_idx > 0 else -1.0
            vol_above = vol_buckets[vah_idx + 1] if vah_idx < buckets - 1 else -1.0
            # Groesseres Volumen gewinnt; bei Gleichstand unterer Nachbar.
            if vol_below >= vol_above:
                val_idx -= 1
                acc_vol += vol_below
            else:
                vah_idx += 1
                acc_vol += vol_above

        poc[i] = vp_low + (poc_idx + 0.5) * vp_step
        val[i] = vp_low + val_idx * vp_step
        vah[i] = vp_low + (vah_idx + 1) * vp_step

    out = df.copy()
    out["poc"] = poc
    out["val"] = val
    out["vah"] = vah
    return out


def vp_touch_signals(df: pd.DataFrame) -> pd.DataFrame:
    """Touch-Trigger fuer VAL/VAH wie ``k2TouchVAL`` / ``k2TouchVAH`` in Pine.

    Pine verwendet hier KEIN ``ta.crossunder`` / ``ta.crossover``, sondern ein
    einfaches Beruehren pro Bar:
        ``touch_val = low  <= val``
        ``touch_vah = high >= vah``

    Erwartet ``df`` mit den Spalten ``low``, ``high``, ``val``, ``vah``
    (z.B. Output von :func:`rolling_volume_profile`). Bars ohne gueltiges
    Profil (val/vah NaN) liefern ``False``.
    """
    out = df.copy()
    has_val = out["val"].notna()
    has_vah = out["vah"].notna()
    out["touch_val"] = has_val & (out["low"] <= out["val"])
    out["touch_vah"] = has_vah & (out["high"] >= out["vah"])
    return out


# ---------------------------------------------------------------------
# 2) CVD-APPROXIMATION (Order-Flow-Bestaetigung, Krypto-3)
# ---------------------------------------------------------------------

def cvd_approximation(
    df: pd.DataFrame,
    slope_lookback: int = 14,
    vol_avg_window: int = 20,
    vol_spike_multiplier: float = 1.5,
    use_cvd_filter: bool = True,
) -> pd.DataFrame:
    """CVD-Approximation + Krypto-3-Filter wie in ``wavescout_core_v2.pine``.

    OHLCV-basierte Naeherung des kumulativen Volumen-Deltas (kein Tick-/
    Orderbook-Feed noetig), Abschnitt "SHARED ORDER-FLOW: CVD-APPROXIMATION":

      * ``buyRatio = (close - low) / (high - low)``, bei Range == 0 -> 0.5
      * ``delta    = volume * (2 * buyRatio - 1)``
      * ``cvd_cum  = kumulative Summe von delta ueber die gesamte Historie``
      * ``cvd_slope= cvd_cum - cvd_cum[slope_lookback Bars zuvor]``  (Default 14)

    Filterlogik aus Krypto-3 (``crypto_orderflow_breakout``):
      * ``vol_avg   = SMA(volume, k3RangeLen=20)``
      * ``vol_spike = volume > vol_avg * k3VolMultiplier (Default 1.5)``
      * ``long_trigger  = vol_spike & (close > open) & (cvd_slope > 0)``
      * ``short_trigger = vol_spike & (close < open) & (cvd_slope < 0)``

    ``use_cvd_filter`` entspricht dem Pine-Toggle ``k3UseCvdFilter``: ist es
    ``False``, faellt das ``cvd_slope``-Gate weg (Trigger nur ueber Vol-Spike
    + Kerzenrichtung), die Spalten ``cvd_cum`` / ``cvd_slope`` werden trotzdem
    berechnet.

    Erwartet ``df`` mit ``open, high, low, close, volume``. Gibt eine Kopie
    mit Spalten ``cvd_cum``, ``cvd_slope``, ``vol_avg``, ``is_vol_spike``,
    ``orderflow_long_trigger``, ``orderflow_short_trigger`` zurueck.
    """
    out = df.copy()

    candle_range = out["high"] - out["low"]
    buy_ratio = np.where(
        candle_range.to_numpy() != 0.0,
        (out["close"] - out["low"]) / candle_range.replace(0.0, np.nan),
        0.5,
    )
    delta = out["volume"] * (2.0 * buy_ratio - 1.0)

    out["cvd_cum"] = delta.cumsum()
    out["cvd_slope"] = out["cvd_cum"] - out["cvd_cum"].shift(slope_lookback)

    out["vol_avg"] = out["volume"].rolling(vol_avg_window).mean()
    out["is_vol_spike"] = out["volume"] > out["vol_avg"] * vol_spike_multiplier

    long_base = out["is_vol_spike"] & (out["close"] > out["open"])
    short_base = out["is_vol_spike"] & (out["close"] < out["open"])

    if use_cvd_filter:
        long_base = long_base & (out["cvd_slope"] > 0)
        short_base = short_base & (out["cvd_slope"] < 0)

    out["orderflow_long_trigger"] = long_base
    out["orderflow_short_trigger"] = short_base
    return out


# ---------------------------------------------------------------------
# Quick self-check (kein pytest-Ersatz, nur Sanity-Check beim direkten Run)
# ---------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 300
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    high = close + rng.uniform(0, 1, n)
    low = close - rng.uniform(0, 1, n)
    open_ = close + rng.normal(0, 0.3, n)
    volume = rng.uniform(50, 500, n)

    df = pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume}
    )

    vp_df = rolling_volume_profile(df, lookback=200, buckets=24)
    vp_df = vp_touch_signals(vp_df)
    cvd_df = cvd_approximation(df)

    print("VP zuletzt:\n", vp_df[["poc", "val", "vah"]].tail())
    print("\nTouch-Events:", int(vp_df["touch_val"].sum()), "VAL /",
          int(vp_df["touch_vah"].sum()), "VAH")
    print("\nCVD zuletzt:\n", cvd_df[["cvd_cum", "cvd_slope", "is_vol_spike"]].tail())
    print(
        "\nOrderflow-Trigger:",
        int(cvd_df["orderflow_long_trigger"].sum()), "long /",
        int(cvd_df["orderflow_short_trigger"].sum()), "short",
    )
