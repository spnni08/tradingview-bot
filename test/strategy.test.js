// Unit-Tests für Strategie-Registry, per-Strategie Exit-Config und den HARTEN
// Forex-Session-Filter (AUFGABE 2). Lauf: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STRATEGIES,
  resolveStrategyKey,
  exitConfigForStrategy,
  isWithinForexSession,
  FOREX_SESSIONS_UTC,
  EXIT_CONFIG,
} from '../worker.js';

test('Registry enthält genau 4 Strategien (3 crypto, 1 forex)', () => {
  const keys = Object.keys(STRATEGIES);
  assert.equal(keys.length, 4);
  const crypto = keys.filter(k => STRATEGIES[k].assetClass === 'crypto');
  const forex  = keys.filter(k => STRATEGIES[k].assetClass === 'forex');
  assert.equal(crypto.length, 3);
  assert.equal(forex.length, 1);
  for (const k of ['crypto_baseline', 'crypto_sr_volume', 'crypto_orderflow_breakout', 'forex_sr_fib_rsi']) {
    assert.ok(STRATEGIES[k], `fehlt: ${k}`);
  }
});

test('Score-Optimizer-Scope: KEINE Strategie ist rule-/AI-score-gated (alle candidate-gated)', () => {
  // processSignal leitet `scoreOptimized` aus stratDef.useScoreGate ab. Seit der
  // crypto_baseline-Umstellung (Final-Gate entfernt, weil analyzeWithRules den
  // deployten v2-Payload nicht lesen kann) gated KEINE der 4 Strategien mehr über
  // den analyzeWithRules-Score — alle vertrauen dem Pine-Entry + Candidate-Gate
  // (scoreCandidate, Schwelle 60). analyzeWithRules.score ist nur noch Telemetrie.
  const optimized = Object.keys(STRATEGIES).filter(k => STRATEGIES[k].useScoreGate);
  assert.deepEqual(optimized, []);
  for (const k of Object.keys(STRATEGIES)) {
    assert.equal(STRATEGIES[k].useScoreGate, false, `${k} darf nicht score-gated sein`);
  }
});

test('resolveStrategyKey: gültiges Feld, case-insensitiv, Fallback', () => {
  assert.equal(resolveStrategyKey({ strategy: 'crypto_sr_volume' }), 'crypto_sr_volume');
  assert.equal(resolveStrategyKey({ strategy: 'CRYPTO_SR_VOLUME' }), 'crypto_sr_volume');
  assert.equal(resolveStrategyKey({ strategy_key: 'forex_sr_fib_rsi' }), 'forex_sr_fib_rsi');
  // Fehlend / unbekannt → rückwärtskompatibler Default.
  assert.equal(resolveStrategyKey({}), 'crypto_baseline');
  assert.equal(resolveStrategyKey({ strategy: 'does_not_exist' }), 'crypto_baseline');
  assert.equal(resolveStrategyKey(null), 'crypto_baseline');
});

test('exitConfigForStrategy: per-Strategie-Override + geerbte Defaults', () => {
  // Baseline = reine Defaults.
  const base = exitConfigForStrategy('crypto_baseline');
  assert.equal(base.SL_DISTANCE_PCT, EXIT_CONFIG.SL_DISTANCE_PCT); // 1.0
  assert.equal(base.TP2_R_MULTIPLE, 1.5);
  assert.equal(base.TP1_DISTANCE_FRAC, 0.60);

  // Forex überschreibt nur SL_DISTANCE_PCT, erbt den Rest.
  const fx = exitConfigForStrategy('forex_sr_fib_rsi');
  assert.equal(fx.SL_DISTANCE_PCT, 0.30);           // Override
  assert.equal(fx.TP1_DISTANCE_FRAC, 0.60);          // geerbt
  assert.equal(fx.BREAKEVEN_OFFSET_R, EXIT_CONFIG.BREAKEVEN_OFFSET_R);

  // Unbekannter Key → reine Defaults (kein Crash).
  const unknown = exitConfigForStrategy('nope');
  assert.equal(unknown.SL_DISTANCE_PCT, EXIT_CONFIG.SL_DISTANCE_PCT);
});

test('orderflow-Breakout trägt konfigurierbare Range-/Volumen-/EMA-Parameter', () => {
  const s = STRATEGIES.crypto_orderflow_breakout;
  assert.equal(s.rangeN, 20);     // Standard N (konfigurierbar)
  assert.equal(s.volMult, 1.5);   // Volumen-Multiplikator
  assert.equal(s.emaFilter, true); // EMA-Trendfilter default aktiviert
});

// ── HARTER Forex-Session-Filter ─────────────────────────────────────
// Fenster: London-Open 08–09 UTC · London/NY-Overlap 13–16 UTC (= 09–10 / 14–17 MEZ).
const at = (h, m = 0) => new Date(Date.UTC(2026, 0, 5, h, m)); // fixes UTC-Datum

test('isWithinForexSession: innerhalb der Fenster → true', () => {
  assert.equal(isWithinForexSession(at(8, 0)),  true);  // London-Open Start
  assert.equal(isWithinForexSession(at(8, 30)), true);
  assert.equal(isWithinForexSession(at(13, 0)), true);  // Overlap Start
  assert.equal(isWithinForexSession(at(15, 59)), true);
});

test('isWithinForexSession: außerhalb der Fenster → false', () => {
  assert.equal(isWithinForexSession(at(7, 59)), false); // vor London
  assert.equal(isWithinForexSession(at(9, 0)),  false); // Ende London (exklusiv)
  assert.equal(isWithinForexSession(at(11, 0)), false); // Lücke
  assert.equal(isWithinForexSession(at(16, 0)), false); // Ende Overlap (exklusiv)
  assert.equal(isWithinForexSession(at(22, 0)), false); // Nacht
});

test('FOREX_SESSIONS_UTC ist konfigurierbar (zwei Fenster)', () => {
  assert.equal(FOREX_SESSIONS_UTC.length, 2);
  // Eigene Fenster injizierbar.
  const custom = [{ name: 'x', startMin: 0, endMin: 60 }];
  assert.equal(isWithinForexSession(at(0, 30), custom), true);
  assert.equal(isWithinForexSession(at(2, 0),  custom), false);
});
