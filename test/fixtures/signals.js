// Wiederverwendbare Fixture-Payloads für die 4 WAVESCOUT-Strategien.
//
// Diese Datei enthält NUR Daten (rohe TradingView-/Pine-alert()-Payloads),
// keine Logik — damit sie auch von späteren Tests (CI-Gate, Score-Optimizer)
// importiert werden kann. Jede Strategie hat drei Fälle:
//   trade  — sollte eindeutig zu einem handelbaren Signal (OPEN) führen
//   reject — sollte eindeutig abgelehnt werden (candidate_rejected oder SKIPPED)
//   edge   — Grenz-/Sonderfall (fehlendes Feld, NaN, Score genau an der Schwelle)
//
// Keine Secrets/Tokens. Preise/Levels sind synthetisch, aber in sich stimmig
// (z.B. ema50/ema200-Lage passend zur Richtung).

export const signalFixtures = {
  // ── 1) crypto_baseline (Mean-Reversion, Gate 1 ≥60 + Gate 2 ≥75) ────────
  // Feldsatz entspricht dem tatsächlich deployten v2-Pine: direction, entry,
  // rsi, emaDistPct, nearSup, nearRes, rsiDeadZone (KEIN price/ema50/ema200/
  // trend/confidence — das ist der Feldsatz, den analyzeWithRules erwartet,
  // aber Pine für diese Strategie nie sendet).
  crypto_baseline: {
    // Starker Mean-Reversion-LONG: RSI extrem überverkauft (24), deutliche
    // EMA-Überdehnung (-1.5%), klares nearSup (kein nearRes) → passiert
    // beide Gates deutlich (Candidate 82, Mean-Reversion-Score 100/geclampt).
    trade: {
      strategy: 'crypto_baseline', symbol: 'BTC/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'PULLBACK',
      entry: '100', rsi: '24', emaDistPct: '-1.2',
      nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
    },
    // Passiert Gate 1 (EMA-Sweet-Spot + nearSup → Candidate 82), aber RSI
    // (34, nicht extrem) und die moderate EMA-Distanz (-0.79%) reichen für
    // Gate 2 nicht → Mean-Reversion-Score 67 < 75 → SKIPPED (Gate 2 greift).
    reject: {
      strategy: 'crypto_baseline', symbol: 'ETH/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'PULLBACK',
      entry: '100', rsi: '34.07', emaDistPct: '-0.79',
      nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
    },
    // Grenzfall: kaputter RSI-Wert + keine EMA/S/R-Daten → darf NICHT crashen,
    // landet mangels Score-Features unter dem Candidate-Threshold (Gate 2 wird
    // nie erreicht).
    edge: {
      strategy: 'crypto_baseline', symbol: 'SOL/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'PULLBACK',
      entry: '100', rsi: 'not-a-number',
    },
  },

  // ── 2) crypto_sr_volume (VP-Reclaim, kein Score-Gate) ───────────────────
  crypto_sr_volume: {
    // Echter VAL-Reclaim LONG mit oversold-Kontext + Trend ok.
    trade: {
      strategy: 'crypto_sr_volume', symbol: 'BTC/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'VAL_BOUNCE',
      vp_zone: 'VAL', vp_score: 15,
      price: 100, rsi: 38, ema50: 101, ema200: 99, trend: 'BULLISH',
      poc: 100.5, vah: 103, val: 99.8,
    },
    // Reiner Touch in der adversen Zone (VAH) ohne Reclaim/Kontext → Candidate
    // bleibt auf base 40 < 60 → candidate_rejected.
    reject: {
      strategy: 'crypto_sr_volume', symbol: 'ETH/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'TOUCH',
      vp_zone: 'VAH',
      price: 100, rsi: 60, ema50: 98, ema200: 99, trend: 'BEARISH',
    },
    // Grenzfall: VAL-Reclaim erkannt, aber RSI/EMA/Trend fehlen komplett.
    edge: {
      strategy: 'crypto_sr_volume', symbol: 'SOL/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'VAL_BOUNCE',
      vp_zone: 'VAL', price: 100, val: 99.8,
    },
  },

  // ── 3) crypto_orderflow_breakout (Range-Breakout + Volumen) ─────────────
  crypto_orderflow_breakout: {
    // Echter Range-Breakout nach oben mit Volumen-Spike (volRatio 2.5).
    trade: {
      strategy: 'crypto_orderflow_breakout', symbol: 'BTC/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'RANGE_BREAK_UP',
      price: 100, range_high: 99.5, range_low: 97,
      candle_volume: 250, avg_volume: 100,
      rsi: 55, ema50: 101, ema200: 99, trend: 'BULLISH',
    },
    // Volumen-Spike OHNE echten Breakout (Preis innerhalb der Range) →
    // base 35 + vol_high 20 = 55 < 60 → candidate_rejected.
    reject: {
      strategy: 'crypto_orderflow_breakout', symbol: 'ETH/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'CONSOLIDATION',
      price: 100, range_high: 105, range_low: 95,
      candle_volume: 250, avg_volume: 100,
    },
    // Grenzfall: Breakout + schwaches Volumen (volRatio 1.2 → -5) ⇒ Score
    // landet GENAU auf dem Threshold 60 (base 35 + 30 − 5).
    edge: {
      strategy: 'crypto_orderflow_breakout', symbol: 'SOL/USDT', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'RANGE_BREAK_UP',
      price: 100, range_high: 99.5,
      candle_volume: 120, avg_volume: 100,
    },
  },

  // ── 4) forex_sr_fib_rsi (Fib-Reclaim, HART session-gated) ───────────────
  forex_sr_fib_rsi: {
    // VAL-Reclaim LONG sehr nah am Level. Nur innerhalb der Forex-Session
    // handelbar (Test stubt die Uhrzeit auf 08:30 UTC).
    trade: {
      strategy: 'forex_sr_fib_rsi', symbol: 'EUR/USD', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'FIB_SR_RSI_LONG',
      price: 1.08, support: 1.0795, resistance: 1.10,
      rsi: 55, ema50: 1.081, ema200: 1.078, trend: 'BULLISH',
    },
    // Identisches Setup, aber AUSSERHALB der Session (Test stubt 03:00 UTC) →
    // sessionClosed → niemals OPEN (SKIPPED), obwohl der Candidate-Gate passt.
    reject: {
      strategy: 'forex_sr_fib_rsi', symbol: 'EUR/USD', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'FIB_SR_RSI_LONG',
      price: 1.08, support: 1.0795, resistance: 1.10,
      rsi: 55, ema50: 1.081, ema200: 1.078, trend: 'BULLISH',
    },
    // Grenzfall: Reclaim erkannt, aber `support` fehlt (kein Dist-Bonus) und
    // RSI fehlt → darf nicht crashen, bleibt knapp über dem Threshold.
    edge: {
      strategy: 'forex_sr_fib_rsi', symbol: 'EUR/USD', timeframe: '5',
      direction: 'LONG', action: 'BUY', trigger: 'FIB_SR_RSI_LONG',
      price: 1.08,
    },
  },
};

// Reihenfolge-stabile Liste aller Strategie-Keys (für parametrische Tests).
export const STRATEGY_KEYS = Object.keys(signalFixtures);
