// End-to-End-Snapshot-Tests für processSignal(env, signal).
//
// processSignal ist die Kern-Pipeline: Candidate-Gate → Rule-/VP-Score →
// (optional Claude) → Telegram/Notify → Persistenz in `signals`. Sie hat starke
// Seiteneffekte (D1, fetch). Die Tests fahren sie gegen eine in-memory
// D1-Attrappe (test/helpers/fakeEnv.js) und eingefrorene Zeit/Random/fetch,
// sodass Score, Entscheidung, IDs und Timestamps reproduzierbar sind und KEIN
// echter Netzwerk-Call passiert. Es wird KEINE Produktionslogik verändert.
//
// Pro Strategie dieselben Fixtures wie analyzeWithRules (trade/reject/edge):
//   * Voll-Snapshot der Entscheidung + der persistierten signals-Zeile
//   * Explizite Assertions auf status / outcome / score / strategy_key
//
// Snapshots aktualisieren:  node --test --test-update-snapshots "test/**/*.test.js"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { processSignal, deriveTp1 } from '../worker.js';
import {
  makeEnv, installDeterminism, NON_SESSION_UTC, FOREX_SESSION_UTC,
} from './helpers/fakeEnv.js';
import { signalFixtures } from './fixtures/signals.js';

// Wann (UTC) jeder Fall läuft. Forex ist HART session-gated: trade/edge laufen
// innerhalb (08:30), der reject-Fall außerhalb (03:00) der Forex-Session.
// Crypto läuft generell außerhalb aller Sessions (session_filter trägt 0 bei).
const CLOCK = {
  forex_sr_fib_rsi: { trade: FOREX_SESSION_UTC, reject: NON_SESSION_UTC, edge: FOREX_SESSION_UTC },
};
const clockFor = (strat, kind) => CLOCK[strat]?.[kind] ?? NON_SESSION_UTC;

async function run(strat, kind) {
  const restore = installDeterminism(clockFor(strat, kind));
  try {
    const env = makeEnv();
    const result = await processSignal(env, { ...signalFixtures[strat][kind] });
    return { result, env };
  } finally {
    restore();
  }
}

// Stabile Sicht für den Snapshot (Entscheidung + persistierte signals-Zeile).
function snapshotView({ result, env }) {
  if (result.status === 'candidate_rejected') {
    return {
      status: result.status,
      candidateScore: result.candidateScore,
      candidateThreshold: result.candidateThreshold,
      strategyKey: result.strategyKey,
      // Abgelehnter Kandidat wird trotzdem als REJECTED-Zeile persistiert
      // (kein Signal verschwindet lautlos) + ein signal_candidates-Eintrag.
      signalsInserts: env.DB.insertCount('signals'),
      candidateInserts: env.DB.insertCount('signal_candidates'),
    };
  }
  const a = result.analysis;
  const row = env.DB.insertedRow('signals');
  return {
    status: result.status,
    analysis: {
      score: a.score, recommendation: a.recommendation, risk: a.risk,
      direction: a.direction, entry: a.entry, tp: a.tp, sl: a.sl,
    },
    signalsRow: {
      outcome: row.outcome, direction: row.direction,
      ai_score: row.ai_score, ai_entry: row.ai_entry,
      ai_tp: row.ai_tp, ai_sl: row.ai_sl, ai_tp1: row.ai_tp1,
      strategy_key: row.strategy_key, asset_class: row.asset_class,
      is_test: row.is_test,
    },
  };
}

// Erwartete Kern-Entscheidung pro Fixture (status / outcome / score / strategy).
const EXPECTED = {
  // trade: Candidate-Gate 82 (Sweet-Spot + nearSup), Mean-Reversion-Score 100
  // (RSI 24 extrem + EMA-Dist 1.2% + klares nearSup) → beide Gates passiert.
  'crypto_baseline/trade':  { status: 'ok', outcome: 'OPEN',    score: 100 },
  // reject: Candidate-Gate 82 (passiert Gate 1), aber RSI 34 ist nicht extrem
  // und die EMA-Distanz (0.79%) reicht nicht → Mean-Reversion-Score 67 < 75
  // (Gate 2) → SKIPPED. Zeigt, dass Gate 2 jetzt wieder echte Trennschärfe hat.
  'crypto_baseline/reject': { status: 'ok', outcome: 'SKIPPED', score: 67  },
  'crypto_baseline/edge':   { status: 'candidate_rejected', candidateScore: 50 },

  // crypto_sr_volume/trade: Rule-Score 88 + VP-Bonus 15 → 100 (VP-Konfluenz).
  'crypto_sr_volume/trade':  { status: 'ok', outcome: 'OPEN', score: 100 },
  'crypto_sr_volume/reject': { status: 'candidate_rejected', candidateScore: 40 },
  // edge: useScoreGate=false → OPEN trotz niedrigem Rule-Score (Pine-Entry).
  'crypto_sr_volume/edge':   { status: 'ok', outcome: 'OPEN', score: 37 },

  'crypto_orderflow_breakout/trade':  { status: 'ok', outcome: 'OPEN', score: 78 },
  'crypto_orderflow_breakout/reject': { status: 'candidate_rejected', candidateScore: 55 },
  // edge: Candidate-Score liegt GENAU auf dem Threshold (60) → passiert.
  'crypto_orderflow_breakout/edge':   { status: 'ok', outcome: 'OPEN', score: 37 },

  // Forex: useScoreGate=false → innerhalb der Session OPEN, außerhalb SKIPPED.
  'forex_sr_fib_rsi/trade':  { status: 'ok', outcome: 'OPEN',    score: 65 },
  'forex_sr_fib_rsi/reject': { status: 'ok', outcome: 'SKIPPED', score: 65 },
  'forex_sr_fib_rsi/edge':   { status: 'ok', outcome: 'OPEN',    score: 37 },
};

for (const [strat, cases] of Object.entries(signalFixtures)) {
  for (const kind of ['trade', 'reject', 'edge']) {
    test(`processSignal · ${strat} · ${kind}`, async (t) => {
      const { result, env } = await run(strat, kind);
      const exp = EXPECTED[`${strat}/${kind}`];

      assert.equal(result.status, exp.status, `${strat}/${kind} status`);

      if (exp.status === 'candidate_rejected') {
        assert.equal(result.candidateScore, exp.candidateScore, 'candidateScore');
        assert.ok(result.candidateScore < result.candidateThreshold, 'score < threshold');
        assert.equal(result.strategyKey, strat, 'strategyKey');
        // Auch abgelehnte Kandidaten werden persistiert (Sichtbarkeit im Dashboard).
        assert.equal(env.DB.insertCount('signals'), 1, 'REJECTED signals-Zeile geschrieben');
        assert.equal(env.DB.insertCount('signal_candidates'), 1, 'signal_candidates-Zeile geschrieben');
      } else {
        const row = env.DB.insertedRow('signals');
        assert.ok(row, 'signals-Zeile vorhanden');
        assert.equal(row.outcome, exp.outcome, `${strat}/${kind} outcome`);
        assert.equal(result.analysis.score, exp.score, `${strat}/${kind} score`);
        assert.equal(row.ai_score, exp.score, 'row.ai_score == analysis.score');
        assert.equal(row.strategy_key, strat, 'row.strategy_key');
        assert.equal(row.is_test, 0, 'kein Test-Signal');
        // TP1-Ableitung deterministisch aus entry/tp (60% des Weges zu TP2).
        assert.ok(
          Math.abs(row.ai_tp1 - deriveTp1(result.analysis.entry, result.analysis.tp)) < 1e-9,
          'ai_tp1 == deriveTp1(entry, tp)',
        );
        assert.equal(env.DB.insertCount('signals'), 1, 'genau eine signals-Zeile');
      }

      t.assert.snapshot(snapshotView({ result, env }));
    });
  }
}

// ── Strukturelle Garantien ────────────────────────────────────────────────

test('processSignal · OPEN-Trade persistiert genau eine signals- + eine candidate-Zeile', async () => {
  const { env } = await run('crypto_baseline', 'trade');
  assert.equal(env.DB.insertCount('signals'), 1);
  assert.equal(env.DB.insertCount('signal_candidates'), 1);
});

test('processSignal · Forex: identisches Setup öffnet IN-Session, SKIPPED außerhalb', async () => {
  const inSession  = await run('forex_sr_fib_rsi', 'trade');   // 08:30 UTC
  const offSession = await run('forex_sr_fib_rsi', 'reject');  // 03:00 UTC (gleiches Payload)
  assert.equal(inSession.env.DB.insertedRow('signals').outcome, 'OPEN');
  assert.equal(offSession.env.DB.insertedRow('signals').outcome, 'SKIPPED');
});

test('processSignal · Ergebnis ist reproduzierbar (zweimal gleiches Resultat)', async () => {
  const a = snapshotView(await run('crypto_orderflow_breakout', 'trade'));
  const b = snapshotView(await run('crypto_orderflow_breakout', 'trade'));
  assert.deepEqual(a, b);
});

// ── crypto_baseline Gate 2 (Mean-Reversion-Scorer, deployter Pine-v2-Payload) ─
// Das deployte Pine v2 sendet für crypto_baseline NICHT den Feldsatz, den
// analyzeWithRules liest: kein price (sondern `entry`), kein ema50/ema200,
// kein trend/timeframe/support/resistance/confidence — nur direction, entry,
// rsi, emaDistPct, nearSup, nearRes, rsiDeadZone. Diese Tests sichern ab, dass
// (1) Gate 2 jetzt den dedizierten Mean-Reversion-Scorer nutzt (statt des
// strukturell blinden analyzeWithRules) und (2) der Entry/TP/SL weiterhin aus
// `entry` abgeleitet wird statt 0 zu sein.

// Ein realer Gate-1-Payload (Spread-Quelle aus PR #134, Signal #3), in
// deployter v2-Form. RSI 30.45 ist nicht extrem genug und die EMA-Distanz
// (0.79%) nur moderat → das ist genau der Fall, den Gate 2 aussieben soll.
const V2_BASELINE = {
  strategy: 'crypto_baseline', symbol: 'BTCUSDT', assetClass: 'crypto',
  direction: 'LONG', action: 'BUY',
  entry: '62000', tp1: '62620', tp2: '63240', sl: '61380', time: '1717000000',
  rsi: '30.45', emaDistPct: '-0.7899325815',
  nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
};

async function runRaw(signal) {
  const restore = installDeterminism(NON_SESSION_UTC);
  try {
    const env = makeEnv();
    const result = await processSignal(env, { ...signal });
    return { result, env };
  } finally {
    restore();
  }
}

test('processSignal · crypto_baseline v2-Payload: Gate 1 passiert, Gate 2 (Mean-Reversion) filtert → SKIPPED', async () => {
  const { result, env } = await runRaw(V2_BASELINE);
  assert.equal(result.status, 'ok', 'Gate 1 (Candidate-Score) passiert (82 ≥ 60)');
  const row = env.DB.insertedRow('signals');
  assert.equal(row.strategy_key, 'crypto_baseline');
  // Mean-Reversion-Score: base 40 + RSI (30.45, nicht extrem) 0 + EMA-Dist
  // (0.79 %, mittlere Stufe) 12 + nearSup 15 = 67 < 75 (Gate 2).
  assert.equal(row.ai_score, 67, 'Mean-Reversion-Score ersetzt den alten, strukturell blinden Rule-Score');
  assert.equal(row.outcome, 'SKIPPED', 'moderates Setup passiert Gate 1, aber nicht Gate 2 (≥75)');
});

test('processSignal · crypto_baseline: entry → price gemappt (kein Null-Level-Trade)', async () => {
  const { result, env } = await runRaw(V2_BASELINE);
  const row = env.DB.insertedRow('signals');
  // Vor dem Fix: price/entry/tp/sl = 0 (analyzeWithRules las das fehlende
  // `price`-Feld). Nach dem Fix kommt der Entry aus `entry` (62000).
  assert.equal(row.price, 62000, 'price wird aus entry abgeleitet');
  assert.equal(result.analysis.entry, 62000, 'analysis.entry == entry');
  assert.ok(result.analysis.tp > 0 && result.analysis.sl > 0, 'TP/SL sind echte Levels, nicht 0');
  assert.ok(row.ai_entry === 62000 && row.ai_tp > 0 && row.ai_sl > 0, 'persistierte Levels gültig');
});

test('processSignal · expliziter price-Wert wird durch entry NICHT überschrieben', async () => {
  const { env } = await runRaw({ ...V2_BASELINE, price: 61500 });
  const row = env.DB.insertedRow('signals');
  assert.equal(row.price, 61500, 'vorhandener price hat Vorrang vor entry');
});

// ── crypto_baseline: Claude läuft NIE (kein API-Call für einen Scorer, der
// die falschen Felder liest) ─────────────────────────────────────────────
// Regression für die explizite Anforderung: analyzeSignalWithAI() prompted
// Claude mit denselben Trendfolge-Feldern wie analyzeWithRules — für baseline
// wäre das reine "n/a"-Daten. Ein starkes Setup (Mean-Reversion-Score weit
// über der alten aiThreshold von 55) darf trotzdem KEINEN Netzwerk-Call
// auslösen; die Gate-2-Entscheidung muss vollständig deterministisch bleiben.

test('processSignal · crypto_baseline: kein fetch()-Call (Claude) selbst bei starkem Setup + gesetztem ANTHROPIC_API_KEY', async () => {
  const restore = installDeterminism(NON_SESSION_UTC);
  let fetchCalls = 0;
  const spiedFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetchCalls++; return spiedFetch(...args); };
  try {
    const env = { ...makeEnv(), ANTHROPIC_API_KEY: 'sk-test-would-trigger-claude' };
    // RSI 24 extrem + starke EMA-Überdehnung + klares nearSup → Mean-Reversion-
    // Score 100, weit über der alten Claude-Trigger-Schwelle (preAiScore ≥ 55).
    const strongBaseline = {
      strategy: 'crypto_baseline', symbol: 'BTCUSDT', direction: 'LONG', action: 'BUY',
      entry: '62000', rsi: '24', emaDistPct: '-1.5',
      nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
    };
    const result = await processSignal(env, strongBaseline);
    assert.equal(result.status, 'ok');
    assert.equal(env.DB.insertedRow('signals').outcome, 'OPEN', 'starkes Setup öffnet trotzdem, rein über Gate 2');
    assert.equal(fetchCalls, 0, 'kein einziger fetch()-Call — Claude darf für baseline nie aufgerufen werden');
  } finally {
    globalThis.fetch = spiedFetch;
    restore();
  }
});
