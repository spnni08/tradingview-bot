// Regressionstests für den Payload-Mapping-Bug aus PR #120.
//
// Bug: scoreCandidate() erwartete vorberechnete Felder (emaDistPct, reclaim,
// breakoutAboveRange, volRatio, reclaimVAL, distToVAL …), die KEIN Pine-Script
// jemals sendet. Die Pine-alert()-JSONs liefern nur Rohbausteine + `trigger`.
// Dadurch blieb jedes Bonus-Feld leer → Score = base < 60 → 100 % REJECTED.
//
// Diese Tests füttern scoreCandidate()/normalizeSignalForScoring() mit den
// EXAKTEN JSON-Payloads, wie die 4 Pine-Scripts (pinescript/strategies/*.pine)
// sie via alert() an /webhook posten — nicht mit synthetischen Feldern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate, normalizeSignalForScoring } from '../worker.js';

// ── Echte Pine-alert()-Payloads (1:1 aus f_payload der jeweiligen .pine) ──────

// crypto_baseline.pine — close 0.9 % über EMA200 (Sweet-Spot), RSI außerhalb DZ
const BASELINE_LONG = {
  strategy: 'crypto_baseline', symbol: 'BTCUSDT', direction: 'LONG',
  action: 'BUY', trigger: 'BASELINE_RSI_EMA', timeframe: '15',
  price: 63567, rsi: 41, ema50: 63100, ema200: 63000, trend: 'BULLISH',
  timestamp: '1700000000000',
};

// crypto_sr_volume.pine — VAL-Bounce LONG (Pine feuert nur beim Reclaim)
const SRVOL_LONG = {
  strategy: 'crypto_sr_volume', symbol: 'ETHUSDT', direction: 'LONG',
  action: 'BUY', trigger: 'VAL_BOUNCE', timeframe: '15',
  price: 3120, rsi: 39, ema50: 3110, ema200: 3050,
  poc: 3115, vah: 3180, val: 3118, vp_zone: 'VAL', trend: 'BULLISH',
  timestamp: '1700000000000',
};

// crypto_orderflow_breakout.pine — Range-Breakout nach oben, Vol-Spike 2.4×
const BREAKOUT_LONG = {
  strategy: 'crypto_orderflow_breakout', symbol: 'SOLUSDT', direction: 'LONG',
  action: 'BUY', trigger: 'RANGE_BREAK_UP', timeframe: '15',
  price: 152.4, rsi: 58, ema50: 150, ema200: 145,
  range_high: 151.8, range_low: 147.2, candle_volume: 24000, avg_volume: 10000,
  range_n: 20, timestamp: '1700000000000',
};

// forex_sr_fib_rsi.pine — Long-Reclaim am Support, Preis sehr nah am Support
const FOREX_LONG = {
  strategy: 'forex_sr_fib_rsi', symbol: 'EURUSD', direction: 'LONG',
  action: 'BUY', trigger: 'FIB_SR_RSI_LONG', timeframe: '15',
  price: 1.0825, rsi: 44, ema50: 1.0820, ema200: 1.0790,
  support: 1.0820, resistance: 1.0900,
  fib_382: 1.0850, fib_500: 1.0860, fib_618: 1.0872,
  timestamp: '1700000000000',
};

// ── Mapping: abgeleitete Felder werden aus Rohpayload erzeugt ─────────────────

test('crypto_baseline: emaDistPct wird aus close & ema200 abgeleitet', () => {
  const s = normalizeSignalForScoring('crypto_baseline', BASELINE_LONG);
  // |63567 - 63000| / 63000 * 100 ≈ 0.9 %
  assert.ok(Math.abs(s.emaDistPct - 0.9) < 0.05, `emaDistPct ≈ 0.9, war ${s.emaDistPct}`);
});

test('crypto_sr_volume: reclaim/trendOk werden aus trigger & trend abgeleitet', () => {
  const s = normalizeSignalForScoring('crypto_sr_volume', SRVOL_LONG);
  assert.equal(s.reclaim, true);
  assert.equal(s.breakdown, false);
  assert.equal(s.trendOk, true);
});

test('crypto_orderflow_breakout: breakout & volRatio werden abgeleitet', () => {
  const s = normalizeSignalForScoring('crypto_orderflow_breakout', BREAKOUT_LONG);
  assert.equal(s.breakoutAboveRange, true);
  assert.equal(s.breakoutBelowRange, false);
  assert.ok(Math.abs(s.volRatio - 2.4) < 0.001, `volRatio ≈ 2.4, war ${s.volRatio}`);
  assert.equal(s.trendOk, true); // ema50 150 > ema200 145
});

test('forex_sr_fib_rsi: reclaimVAL & distToVAL werden abgeleitet', () => {
  const s = normalizeSignalForScoring('forex_sr_fib_rsi', FOREX_LONG);
  assert.equal(s.reclaimVAL, true);
  assert.equal(s.breakdownVAH, false);
  // |1.0825 - 1.0820| / 1.0820 * 100 ≈ 0.046 %  → < 0.1 % (sehr nah)
  assert.ok(s.distToVAL < 0.1, `distToVAL < 0.1, war ${s.distToVAL}`);
});

// ── Score-Gate: echte Payloads passieren jetzt den Threshold (vorher: nie) ────

test('REGRESSION: alle 4 echten Pine-Payloads erreichen jetzt Score ≥ 60', () => {
  const cases = [
    ['crypto_baseline',            BASELINE_LONG],
    ['crypto_sr_volume',           SRVOL_LONG],
    ['crypto_orderflow_breakout',  BREAKOUT_LONG],
    ['forex_sr_fib_rsi',           FOREX_LONG],
  ];
  for (const [key, payload] of cases) {
    const { score, threshold } = scoreCandidate(key, payload);
    assert.ok(score >= threshold,
      `${key}: erwartet PASS, bekam score=${score} < threshold=${threshold}`);
  }
});

test('REGRESSION: ohne Mapping wären dieselben Payloads alle < 60 (base-Wert)', () => {
  // Belegt den Bug: ohne abgeleitete Felder bleibt nur der base-Wert übrig.
  // Wir simulieren das, indem wir nur die Pflichtfelder ohne Rohbausteine geben.
  const bareBaseline = { strategy: 'crypto_baseline', direction: 'LONG', rsi: 41 };
  const { score } = scoreCandidate('crypto_baseline', bareBaseline);
  assert.ok(score < 60, `ohne close/ema200 bleibt base 50 < 60, war ${score}`);
});

// ── SHORT-Richtung & Gegenproben ──────────────────────────────────────────────

test('crypto_sr_volume SHORT: VAH-Breakdown wird korrekt zugeordnet', () => {
  const s = normalizeSignalForScoring('crypto_sr_volume', {
    strategy: 'crypto_sr_volume', direction: 'SHORT', trigger: 'VAH_BOUNCE',
    vp_zone: 'VAH', rsi: 61, ema50: 100, ema200: 105, trend: 'BEARISH',
  });
  assert.equal(s.breakdown, true);
  assert.equal(s.reclaim, false);
  assert.equal(s.trendOk, true);
  assert.equal(s.rsiWasOverbought, true);
});

test('explizit gesetzte Felder werden NICHT überschrieben', () => {
  const s = normalizeSignalForScoring('crypto_orderflow_breakout', {
    direction: 'LONG', trigger: 'RANGE_BREAK_UP',
    breakoutAboveRange: false, volRatio: 9,  // explizit → bleibt erhalten
  });
  assert.equal(s.breakoutAboveRange, false);
  assert.equal(s.volRatio, 9);
});
