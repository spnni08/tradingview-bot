// Smoke-/Snapshot-Tests für analyzeWithRules: node --test test/
//
// analyzeWithRules(signal, strategyConfig) berechnet den Signal-Score und
// damit indirekt Trade-Eröffnungen. Dieses File ist die erste Testabdeckung
// dafür. Es testet ausschließlich die reine Scoring-Logik – processSignal
// (async, env/DB) ist hier bewusst nicht abgedeckt.
//
// DETERMINISMUS: Die Regel `session_filter` liest new Date().getUTCHours()
// und ist daher zeitabhängig. In ALLEN Tests wird sie über die unten stehende
// STRATEGY-Config deaktiviert (rules.session_filter.enabled = false), damit die
// Scores stabil und exakt prüfbar sind. Alle anderen Regeln sind in der Config
// nicht gesetzt und fallen in analyzeWithRules über `?? <default>` automatisch
// auf die Default-Gewichte zurück:
//   rsi 18 · ema 15 · trend 10 · wave_bias 8 · support_resistance 10
//   · timeframe 7 · confidence 7   (session_filter → 0, da deaktiviert)
// Thresholds bleiben Default: min_trade_score = min_telegram_score = 75.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeWithRules,
  calcRR,
  safePct,
  getSignalQuality,
  DEFAULT_STRATEGY_CONFIG,
} from '../worker.js';

// Session-Filter aus → reproduzierbare Scores. Restliche Gewichte = Default.
const STRATEGY = { rules: { session_filter: { enabled: false } } };
const analyze = (signal) => analyzeWithRules(signal, STRATEGY);

test('Named-Exports aus worker.js sind importierbar', () => {
  assert.equal(typeof analyzeWithRules, 'function');
  assert.equal(typeof calcRR, 'function');
  assert.equal(typeof safePct, 'function');
  assert.equal(typeof getSignalQuality, 'function');
  assert.equal(DEFAULT_STRATEGY_CONFIG.version, 'v2.0');
});

// ── (a) Starkes LONG-Setup A: maximale Übereinstimmung ──────────────
// base 50  +rsi 18 (RSI 28 < 30 → überverkauft, Pullback-LONG)
//          +ema 15 (EMA50>EMA200, Dist 4% > 3% → voller Bonus, Preis über EMA200)
//          +trend 10 (BULLISH passt zu LONG)  +wave 8 (Bias LONG)
//          +tf 7 (15min Entry-TF)  +conf 7 (85% ≥ 80)  +sr 10 (nah an Support)
//   raw = 125 → clamp 100. Alle Regeln matchen, keine failed_rules.
test('(a) Starkes LONG-Setup A → LONG, Score 100 (geclamped), keine failed_rules', () => {
  const r = analyze({
    direction: 'LONG', rsi: 28,
    ema50: 105, ema200: 100, price: 104,
    trend: 'BULLISH', wave_bias: 'LONG',
    timeframe: '15', confidence: 85, support: 103,
  });

  assert.equal(r.recommendation, 'LONG');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.score, 100);          // raw 125 → auf 100 geclamped
  assert.equal(r.risk, 'LOW');         // ≥ 87

  // Erwartete Regeln haben positiv gefeuert – ohne auf Klartext zu prüfen.
  assert.ok(r.score_breakdown.rsi > 0);
  assert.ok(r.score_breakdown.ema > 0);
  assert.ok(r.score_breakdown.trend > 0);
  assert.ok(r.score_breakdown.wave_bias > 0);
  assert.ok(r.score_breakdown.support_resistance > 0);
  assert.equal(r.failed_rules.length, 0);
  assert.ok(r.matched_rules.length >= 5);

  // Determinismus-Beleg: deaktivierte Session-Regel trägt nichts bei.
  assert.equal(r.score_breakdown.session_filter, undefined);
});

// ── (b) Klares SKIP: alles gegen das LONG-Signal ────────────────────
// base 50  -rsi 18 (RSI 72 > 70 → überkauft, kein Pullback-Entry)
//          -ema 21 (EMA bearish -15 UND Preis unter EMA200 -6)
//          -trend 10 (BEARISH gegen LONG)  -wave 4 (Bias SHORT gegen LONG)
//          +tf 7 (15min)  +conf 0 (50% < 60 → failed)
//          +sr 0 (Support 10% entfernt → failed, kein Bonus)
//   raw = 4 → Score 4, SKIP, viele failed_rules.
test('(b) Gegenläufiges LONG → SKIP, Score 4, mehrere failed_rules', () => {
  const r = analyze({
    direction: 'LONG', rsi: 72,
    ema50: 98, ema200: 105, price: 100,
    trend: 'BEARISH', wave_bias: 'SHORT',
    timeframe: '15', confidence: 50, support: 90,
  });

  assert.equal(r.recommendation, 'SKIP');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.score, 4);
  assert.equal(r.risk, 'HIGH');

  assert.ok(r.score_breakdown.rsi < 0);
  assert.ok(r.score_breakdown.ema < 0);
  assert.ok(r.score_breakdown.trend < 0);
  assert.ok(r.failed_rules.length >= 4);   // RSI, EMA-Bias, EMA200, Trend, Wave, Conf, SR
});

// ── (c) Spiegelbild zu (a): starkes SHORT-Setup A ───────────────────
// base 50  +rsi 18 (RSI 72 > 70 → überkauft, Pullback-SHORT)
//          +ema 15 (EMA50<EMA200, Dist 4,8% > 3%, Preis unter EMA200)
//          +trend 10 (BEARISH passt zu SHORT)  +wave 8 (Bias SHORT)
//          +tf 7  +conf 7  +sr 10 (nah an Resistance)
//   raw = 125 → clamp 100.
test('(c) Starkes SHORT-Setup A → SHORT, Score 100 (geclamped)', () => {
  const r = analyze({
    direction: 'SHORT', rsi: 72,
    ema50: 100, ema200: 105, price: 100,
    trend: 'BEARISH', wave_bias: 'SHORT',
    timeframe: '15', confidence: 85, resistance: 101,
  });

  assert.equal(r.recommendation, 'SHORT');
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.score, 100);
  assert.equal(r.risk, 'LOW');

  assert.ok(r.score_breakdown.rsi > 0);
  assert.ok(r.score_breakdown.ema > 0);
  assert.ok(r.score_breakdown.trend > 0);
  assert.ok(r.score_breakdown.wave_bias > 0);
  assert.ok(r.score_breakdown.support_resistance > 0);
  assert.equal(r.failed_rules.length, 0);
});

// ── (d) Setup B (Continuation) LONG, RSI im Trend-Bereich ───────────
// setup_type CONTINUATION → Setup B. base 50
//   +rsi 18 (RSI 55 im Trend-Bereich 45–65 → Setup B LONG)
//   +ema 11 (EMA bullish, Dist 2% im Band 1–3% → 0,7·15)
//   +trend 10  +wave 0 (kein Bias-Feld → unknown)
//   +tf 7 (5min)  +conf 0 (kein Feld)  +sr 0 (keine Zonen)
//   raw = 96 → Score 96, LONG.
test('(d) Setup B LONG (RSI im Trend-Bereich) → LONG, Score 96, setup_type SETUP_B', () => {
  const r = analyze({
    direction: 'LONG', setup_type: 'CONTINUATION', rsi: 55,
    ema50: 105, ema200: 100, price: 102,
    trend: 'BULLISH', timeframe: '5m',
  });

  assert.equal(r.recommendation, 'LONG');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.score, 96);
  assert.equal(r.risk, 'LOW');
  assert.equal(r.setup_type, 'SETUP_B');

  assert.ok(r.score_breakdown.rsi > 0);   // Trend-Bereich-Treffer
  assert.ok(r.score_breakdown.ema > 0);
  assert.ok(r.score_breakdown.trend > 0);
  assert.equal(r.failed_rules.length, 0);
});

// ── (e) Extreme RSI: RSI > 75 bei LONG → RSI-Strafe ─────────────────
// base 50  -rsi 18 (RSI 80 > 75 → extrem überkauft, Reversal-Risiko, kein LONG)
//          +ema 15 (bullish, Dist 4%)  +trend 10  Rest 0
//   raw = 57 → Score 57, SKIP (< 75). Entscheidend: score_breakdown.rsi < 0.
test('(e) RSI > 75 bei LONG → RSI-Strafe (score_breakdown.rsi < 0), SKIP', () => {
  const r = analyze({
    direction: 'LONG', rsi: 80,
    ema50: 105, ema200: 100, price: 104,
    trend: 'BULLISH',
  });

  assert.equal(r.recommendation, 'SKIP');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.score, 57);
  assert.equal(r.risk, 'HIGH');

  assert.ok(r.score_breakdown.rsi < 0);    // Kern der Assertion
  assert.ok(r.failed_rules.length >= 1);
});

// ── (f) EMA200-Ausschluss: Preis < 0,5 % von EMA200 entfernt ────────
// Preis 100.3 vs. EMA200 100 → Dist 0,3 % < 0,5 % → Ausschluss-Strafe -12.
// base 50  +rsi 0 (RSI 50 neutral)  -ema 12 (Ausschluss)  Rest 0
//   raw = 38 → Score 38, SKIP. Entscheidend: score_breakdown.ema < 0.
test('(f) Preis zu nah an EMA200 → Ausschluss-Strafe (score_breakdown.ema < 0), SKIP', () => {
  const r = analyze({
    direction: 'LONG', rsi: 50,
    ema50: 105, ema200: 100, price: 100.3,
  });

  assert.equal(r.recommendation, 'SKIP');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.score, 38);
  assert.equal(r.risk, 'HIGH');

  assert.ok(r.score_breakdown.ema < 0);    // Ausschluss hat gefeuert
  assert.equal(r.score_breakdown.rsi, 0);  // RSI 50 neutral → kein Beitrag
  assert.ok(r.failed_rules.length >= 1);
});

// ── (g) Leeres Signal ohne Indikatordaten → Basis-Score 30 ──────────
// Kein rsi/ema/trend/wave → hasIndicatorData = false → Start bei 30.
// Alle Regeln liefern "keine Daten" (unknown), kein Delta. Score bleibt 30.
test('(g) Leeres Signal ohne Indikatordaten → SKIP, Basis-Score 30', () => {
  const r = analyze({});

  assert.equal(r.recommendation, 'SKIP');
  assert.equal(r.direction, '');           // keine Richtung
  assert.equal(r.score, 30);               // Basis ohne Indikatordaten
  assert.equal(r.risk, 'HIGH');

  // Keine Regel trägt etwas bei – alle Breakdown-Werte 0, nur unknown_rules.
  for (const v of Object.values(r.score_breakdown)) assert.equal(v, 0);
  assert.equal(r.matched_rules.length, 0);
  assert.ok(r.unknown_rules.length > 0);
});

// ── (h) Spiegelbild zu (d): Setup B (Breakout) SHORT ────────────────
// setup_type BREAKOUT → Setup B. base 50
//   +rsi 18 (RSI 45 im Trend-Bereich 35–55 → Setup B SHORT)
//   +ema 11 (EMA bearish, Dist 1,9% im Band 1–3%)  +trend 10
//   +tf 7 (15min)  Rest 0  → raw 96.
test('(h) Setup B SHORT (RSI im Trend-Bereich) → SHORT, Score 96, setup_type SETUP_B', () => {
  const r = analyze({
    direction: 'SHORT', setup_type: 'BREAKOUT', rsi: 45,
    ema50: 100, ema200: 105, price: 103,
    trend: 'BEARISH', timeframe: '15m',
  });

  assert.equal(r.recommendation, 'SHORT');
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.score, 96);
  assert.equal(r.risk, 'LOW');
  assert.equal(r.setup_type, 'SETUP_B');

  assert.ok(r.score_breakdown.rsi > 0);
  assert.ok(r.score_breakdown.ema > 0);
  assert.ok(r.score_breakdown.trend > 0);
  assert.equal(r.failed_rules.length, 0);
});

// ── (i) Schwellen-Grenzfall: exakt Score 75 ─────────────────────────
// base 50  +rsi 4 (RSI 45 < 50 → neutral-niedrig, 0,22·18)
//          +ema 11 (bullish, Dist 1,5%)  +trend 10  Rest 0
//   raw = 75. Genau auf min_trade_score (75) → Empfehlung = Richtung,
//   aber risk MEDIUM (< min_trade+12 = 87).
test('(i) Grenzfall Score genau 75 → LONG empfohlen, risk MEDIUM', () => {
  const r = analyze({
    direction: 'LONG', rsi: 45,
    ema50: 105, ema200: 100, price: 101.5,
    trend: 'BULLISH',
  });

  assert.equal(r.score, 75);
  assert.equal(r.recommendation, 'LONG');  // 75 ≥ min_trade_score 75
  assert.equal(r.direction, 'LONG');
  assert.equal(r.risk, 'MEDIUM');          // < 87 → MEDIUM statt LOW
});

// ── Helfer (über Named-Export geprüft) ──────────────────────────────
test('Helfer: getSignalQuality / calcRR / safePct liefern erwartete Werte', () => {
  assert.equal(getSignalQuality(95), 'PREMIUM');
  assert.equal(getSignalQuality(75), 'GUT');
  assert.equal(getSignalQuality(60), 'OKAY');
  assert.equal(getSignalQuality(45), 'SCHWACH');
  assert.equal(getSignalQuality(10), 'SKIP');
  assert.equal(getSignalQuality(null), 'UNBEKANNT');

  // LONG: Entry 100, TP 101.5, SL 99 → Reward 1.5 / Risk 1 = 1.5R
  assert.equal(calcRR(100, 101.5, 99, true), 1.5);
  // SHORT: Entry 100, TP 98.5, SL 101 → Reward 1.5 / Risk 1 = 1.5R
  assert.equal(calcRR(100, 98.5, 101, false), 1.5);
  assert.equal(calcRR(100, 101, 100, true), null);   // Risk 0 → null

  assert.equal(safePct(101.5, 100), 1.5);
  assert.equal(safePct(0, 100), null);
  assert.equal(safePct(101.5, 0), null);
});

// ── Diagnose-Regression: deployter crypto_baseline-v2-Payload ───────────────
// Das deployte Pine v2 sendet für crypto_baseline einen Feldsatz, den
// analyzeWithRules NICHT liest (direction, entry, rsi, emaDistPct, nearSup,
// nearRes, rsiDeadZone) — es fehlen price, ema50/ema200, trend, timeframe,
// support, resistance, confidence. Dadurch finden 6 von 8 Regeln „keine Daten",
// nur RSI trägt bei (gedeckelt durch crossover@30/crossunder@70 → Teilwertung
// +10), und der Score klebt strukturell bei 50+10 = 60 (Session aus). Er konnte
// das alte Final-Gate (75) NIE erreichen. Dieser Test fixiert die Diagnose, die
// zur Umstellung auf reines Candidate-Gating geführt hat.
test('crypto_baseline v2-Payload: Score strukturell bei 60 gedeckelt (6/8 Regeln ohne Daten)', () => {
  const v2 = {
    direction: 'LONG', entry: '62000', rsi: '30.45', emaDistPct: '-0.7899325815',
    nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
  };
  const r = analyze(v2);                 // Session-Filter ist in STRATEGY aus
  assert.equal(r.score, 60, 'nur Basis (50) + RSI-Teilwertung (10)');
  assert.ok(r.score < 75, 'erreicht das alte Final-Gate nie');
  assert.equal(r.score_breakdown.ema, 0,                'EMA: keine ema50/ema200 im Payload');
  assert.equal(r.score_breakdown.trend, 0,              'Trend: kein trend-Feld');
  assert.equal(r.score_breakdown.support_resistance, 0, 'S/R: kein price/support/resistance');
  assert.equal(r.score_breakdown.timeframe, 0,          'Timeframe: kein timeframe-Feld');
  assert.equal(r.score_breakdown.confidence, 0,         'Confidence: kein confidence-Feld');
  // entry ist NICHT price → analyzeWithRules berechnet entry/tp/sl = 0
  // (genau deshalb mappt processSignal entry→price vor dem Scoring).
  assert.equal(r.entry, 0, 'ohne price-Mapping kein Entry-Level');
});

test('crypto_baseline v2-Payload + entry→price: Levels werden gültig (Score bleibt Telemetrie)', () => {
  const v2 = {
    direction: 'LONG', entry: '62000', price: 62000, rsi: '30.45',
    emaDistPct: '-0.7899325815', nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
  };
  const r = analyze(v2);
  assert.equal(r.entry, 62000, 'Entry aus gemapptem price');
  assert.ok(r.tp > 0 && r.sl > 0, 'TP/SL echte Levels');
  assert.equal(r.score, 60, 'Score weiterhin gedeckelt (price füllt EMA/S/R nicht)');
});
