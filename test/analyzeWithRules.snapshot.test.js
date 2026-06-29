// Snapshot-Tests für analyzeWithRules über alle 4 Strategien.
//
// analyzeWithRules(signal, strategyConfig, exitCfg) ist die REINE Scoring-/
// Entscheidungslogik (Score, recommendation, Entry/TP/SL). Dieses File deckt
// sie für jede Strategie mit drei Fixtures ab (trade / reject / edge):
//   * Voll-Snapshot der Rückgabestruktur via t.assert.snapshot()
//   * ZUSÄTZLICH explizite Assertions auf die Kernfelder (score, recommendation,
//     risk, direction), damit ein Fehlschlag sagt WAS sich geändert hat.
//
// DETERMINISMUS: Die Regel session_filter liest new Date() und ist daher
// zeitabhängig. Sie wird über sessionDisabledConfig() abgeschaltet (Gewicht 0),
// alle anderen Gewichte bleiben v2.0-Default. Forex nutzt via
// exitConfigForStrategy die engere 0.30%-SL-Distanz → andere TP/SL-Levels.
//
// Snapshots aktualisieren:  node --test --test-update-snapshots "test/**/*.test.js"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWithRules, resolveStrategyKey, exitConfigForStrategy } from '../worker.js';
import { sessionDisabledConfig } from './helpers/fakeEnv.js';
import { signalFixtures } from './fixtures/signals.js';

const CFG = sessionDisabledConfig();
const analyze = (sig) =>
  analyzeWithRules({ ...sig }, CFG, exitConfigForStrategy(resolveStrategyKey(sig)));

// Erwartete Kernfelder pro Fixture (decision + score). Explizit aufgelistet,
// damit eine Logik-Änderung punktgenau sichtbar wird, nicht nur als
// "Snapshot weicht ab".
const EXPECTED = {
  'crypto_baseline/trade':  { score: 100, recommendation: 'LONG', risk: 'LOW'  },
  'crypto_baseline/reject': { score: 38,  recommendation: 'SKIP', risk: 'HIGH' },
  'crypto_baseline/edge':   { score: 57,  recommendation: 'SKIP', risk: 'HIGH' },

  'crypto_sr_volume/trade':  { score: 88, recommendation: 'LONG', risk: 'LOW'  },
  'crypto_sr_volume/reject': { score: 32, recommendation: 'SKIP', risk: 'HIGH' },
  'crypto_sr_volume/edge':   { score: 37, recommendation: 'SKIP', risk: 'HIGH' },

  'crypto_orderflow_breakout/trade':  { score: 78, recommendation: 'LONG', risk: 'MEDIUM' },
  'crypto_orderflow_breakout/reject': { score: 37, recommendation: 'SKIP', risk: 'HIGH'   },
  'crypto_orderflow_breakout/edge':   { score: 37, recommendation: 'SKIP', risk: 'HIGH'   },

  'forex_sr_fib_rsi/trade':  { score: 65, recommendation: 'SKIP', risk: 'HIGH' },
  'forex_sr_fib_rsi/reject': { score: 65, recommendation: 'SKIP', risk: 'HIGH' },
  'forex_sr_fib_rsi/edge':   { score: 37, recommendation: 'SKIP', risk: 'HIGH' },
};

test('analyzeWithRules ist importierbar', () => {
  assert.equal(typeof analyzeWithRules, 'function');
});

for (const [strat, cases] of Object.entries(signalFixtures)) {
  for (const kind of ['trade', 'reject', 'edge']) {
    test(`analyzeWithRules · ${strat} · ${kind}`, (t) => {
      const sig = cases[kind];
      const result = analyze(sig);
      const exp = EXPECTED[`${strat}/${kind}`];

      // ── Explizite Kern-Assertions ──────────────────────────────────────
      assert.equal(result.score, exp.score, `${strat}/${kind} score`);
      assert.equal(result.recommendation, exp.recommendation, `${strat}/${kind} recommendation`);
      assert.equal(result.risk, exp.risk, `${strat}/${kind} risk`);
      assert.equal(result.direction, (sig.direction || '').toUpperCase(), 'direction');
      assert.ok(result.score >= 0 && result.score <= 100, 'score in [0,100]');
      // Entry = Preis; SL/TP liegen auf der korrekten Seite des Entries (LONG).
      assert.equal(result.entry, sig.price, 'entry == price');
      assert.ok(result.tp > result.entry, 'LONG: tp über entry');
      assert.ok(result.sl < result.entry, 'LONG: sl unter entry');

      // ── Voll-Snapshot der Rückgabestruktur ─────────────────────────────
      t.assert.snapshot(result);
    });
  }
}

// Strategie-spezifische Exit-Distanz: Forex nutzt 0.30% SL statt 1% (Crypto).
test('analyzeWithRules · Forex nutzt engere SL-Distanz als Crypto', () => {
  const crypto = analyze(signalFixtures.crypto_baseline.trade);   // 1.0% SL
  const forex  = analyze(signalFixtures.forex_sr_fib_rsi.trade);   // 0.30% SL
  const cryptoSlPct = Math.abs(crypto.entry - crypto.sl) / crypto.entry;
  const forexSlPct  = Math.abs(forex.entry  - forex.sl)  / forex.entry;
  assert.ok(Math.abs(cryptoSlPct - 0.01)  < 1e-9, 'crypto SL = 1.0%');
  assert.ok(Math.abs(forexSlPct  - 0.003) < 1e-9, 'forex SL = 0.30%');
});
