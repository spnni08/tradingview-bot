// Tests für scoreMeanReversionBaseline — crypto_baseline Gate 2 (Schwelle 75).
//
// Ersetzt analyzeWithRules als Final-Gate-Scorer für crypto_baseline: liest
// die tatsächlich vom deployten v2-Pine gesendeten Felder (rsi, emaDistPct,
// nearSup, nearRes, rsiDeadZone) und bewertet Mean-Reversion-Qualität
// (Überdehnung + RSI-Extrem + S/R-Bestätigung), nicht Trendfolge.
//
// Abgedeckt:
//   1. Sehr starkes Setup (RSI extrem + starke EMA-Überdehnung + nearSup) > 75
//   2. Schwaches Setup (RSI normal, kein S/R-Level) < 75
//   3. RSI-Dead-Zone-Malus
//   4. EMA-Distanz-Bonus (Stufen)
//   5. Regression gegen die 10 realen Payloads aus PR #134 (Vorher/Nachher)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreMeanReversionBaseline, scoreCandidate } from '../worker.js';

test('scoreMeanReversionBaseline ist exportiert', () => {
  assert.equal(typeof scoreMeanReversionBaseline, 'function');
});

test('sehr starkes LONG-Setup (RSI extrem + starke EMA-Überdehnung + nearSup) → deutlich über 75', () => {
  const score = scoreMeanReversionBaseline({
    direction: 'LONG', rsi: '22', emaDistPct: '-1.5',
    nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
  });
  // base 40 + rsi<25 (25) + emaDist>=1.0 (22) + nearSup (15) = 102 → geclampt 100
  assert.equal(score, 100);
  assert.ok(score >= 75, 'muss Gate 2 klar passieren');
});

test('sehr starkes SHORT-Setup (RSI extrem + starke EMA-Überdehnung + nearRes) → deutlich über 75', () => {
  const score = scoreMeanReversionBaseline({
    direction: 'SHORT', rsi: '78', emaDistPct: '1.4',
    nearSup: 'false', nearRes: 'true', rsiDeadZone: 'false',
  });
  // base 40 + rsi>75 (25) + emaDist>=1.0 (22) + nearRes (15) = 102 → geclampt 100
  assert.equal(score, 100);
  assert.ok(score >= 75);
});

test('schwaches Setup (RSI normal, kein S/R-Level, EMA nah) → deutlich unter 75', () => {
  const score = scoreMeanReversionBaseline({
    direction: 'LONG', rsi: '48', emaDistPct: '-0.05',
    nearSup: 'false', nearRes: 'false', rsiDeadZone: 'false',
  });
  // base 40, kein Bonus (RSI Normalbereich, EMA <0.1%, kein S/R) = 40
  assert.equal(score, 40);
  assert.ok(score < 75);
});

test('RSI-Dead-Zone-Malus: sonst starkes Setup wird durch Dead-Zone unter 75 gedrückt', () => {
  const withoutDeadZone = scoreMeanReversionBaseline({
    direction: 'SHORT', rsi: '63', emaDistPct: '0.6',
    nearSup: 'false', nearRes: 'true', rsiDeadZone: 'false',
  });
  const withDeadZone = scoreMeanReversionBaseline({
    direction: 'SHORT', rsi: '63', emaDistPct: '0.6',
    nearSup: 'false', nearRes: 'true', rsiDeadZone: 'true',
  });
  assert.equal(withDeadZone, withoutDeadZone - 15, 'Dead-Zone zieht exakt 15 Punkte ab');
  assert.ok(withDeadZone < 75, 'Dead-Zone-Setup darf Gate 2 nicht passieren');
});

test('EMA-Distanz-Bonus: Stufen (>=1.0 / >=0.5 / >=0.1 / <0.1) sind monoton', () => {
  const base = { direction: 'LONG', rsi: '50', nearSup: 'false', nearRes: 'false', rsiDeadZone: 'false' };
  const far    = scoreMeanReversionBaseline({ ...base, emaDistPct: '-1.2' });  // >= 1.0 → +22
  const mid    = scoreMeanReversionBaseline({ ...base, emaDistPct: '-0.7' });  // >= 0.5 → +12
  const near   = scoreMeanReversionBaseline({ ...base, emaDistPct: '-0.2' });  // >= 0.1 → +5
  const atEma  = scoreMeanReversionBaseline({ ...base, emaDistPct: '-0.05' }); // < 0.1  → 0
  assert.equal(far,   40 + 22);
  assert.equal(mid,   40 + 12);
  assert.equal(near,  40 + 5);
  assert.equal(atEma, 40);
  assert.ok(far > mid && mid > near && near > atEma, 'Bonus muss mit der Distanz steigen');
});

test('Vorzeichen von emaDistPct ist irrelevant, nur die Magnitude zählt', () => {
  const negative = scoreMeanReversionBaseline({ direction: 'LONG', rsi: '50', emaDistPct: '-1.2' });
  const positive = scoreMeanReversionBaseline({ direction: 'LONG', rsi: '50', emaDistPct: '1.2' });
  assert.equal(negative, positive);
});

test('S/R-Nähe: eindeutiges Level (+15) > ambivalentes Signal beide Flags (+10) > kein Level (0)', () => {
  const base = { direction: 'LONG', rsi: '50', emaDistPct: '0', rsiDeadZone: 'false' };
  const clear      = scoreMeanReversionBaseline({ ...base, nearSup: 'true',  nearRes: 'false' });
  const ambivalent = scoreMeanReversionBaseline({ ...base, nearSup: 'true',  nearRes: 'true'  });
  const none       = scoreMeanReversionBaseline({ ...base, nearSup: 'false', nearRes: 'false' });
  assert.equal(clear,      40 + 15);
  assert.equal(ambivalent, 40 + 10);
  assert.equal(none,       40);
});

test('String-Payload (wie vom deployten Pine gesendet) wird korrekt geparst', () => {
  // Pine sendet ALLE Felder als Strings (str.tostring()).
  const score = scoreMeanReversionBaseline({
    strategy: 'crypto_baseline', direction: 'LONG', entry: '59563.46',
    rsi: '34.07', emaDistPct: '-0.79', nearSup: 'true', nearRes: 'false',
    rsiDeadZone: 'false',
  });
  assert.equal(typeof score, 'number');
  assert.ok(Number.isFinite(score));
});

test('Score wird auf 0–100 geclampt', () => {
  const high = scoreMeanReversionBaseline({
    direction: 'LONG', rsi: '10', emaDistPct: '-5', nearSup: 'true', nearRes: 'true',
  });
  assert.ok(high <= 100);

  const low = scoreMeanReversionBaseline({
    direction: 'SHORT', rsi: '50', emaDistPct: '0', nearSup: 'false', nearRes: 'false',
    rsiDeadZone: 'true',
  });
  assert.ok(low >= 0);
});

// ══════════════════════════════════════════════════════════════
// Vorher/Nachher: die 10 realen Payloads aus PR #134
// ══════════════════════════════════════════════════════════════
// Dieselben 10 Payloads wie in candidateScoring.test.js ("10 reale
// Candidate-Payloads"). Dokumentiert, wie beide Gates zusammenspielen:
// Gate 1 (Candidate, ≥60) siebt breit vor, Gate 2 (Mean-Reversion, ≥75)
// filtert daraus die tatsächlich starken Setups. Kein Overfitting auf exakte
// Werte — die Assertions prüfen Trennschärfe (starke vs. schwache Setups),
// nicht einzelne Score-Zahlen.

const REAL_PAYLOADS = [
  { n: 1,  direction:'SHORT', rsi:'65.47', emaDistPct:'-0.3369177592', nearSup:'false', nearRes:'true',  rsiDeadZone:'false' },
  { n: 2,  direction:'LONG',  rsi:'30.45', emaDistPct:'-0.1316657777', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
  { n: 3,  direction:'LONG',  rsi:'34.07', emaDistPct:'-0.7899325815', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
  { n: 4,  direction:'LONG',  rsi:'31.34', emaDistPct:'-0.1302639542', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
  { n: 5,  direction:'SHORT', rsi:'63.04', emaDistPct:'0.520238653',   nearSup:'false', nearRes:'true',  rsiDeadZone:'true'  },
  { n: 6,  direction:'LONG',  rsi:'30.43', emaDistPct:'-1.3665869987', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
  { n: 7,  direction:'LONG',  rsi:'32.19', emaDistPct:'-0.6774662072', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
  { n: 8,  direction:'LONG',  rsi:'38.71', emaDistPct:'-1.0281079832', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
  { n: 9,  direction:'LONG',  rsi:'36.26', emaDistPct:'-1.352147608',  nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
  { n: 10, direction:'LONG',  rsi:'30.49', emaDistPct:'-0.6424644261', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
];

test('10 reale Payloads: Gate 1 (Candidate) siebt breit vor, Gate 2 (Mean-Reversion) filtert scharf', () => {
  const rows = REAL_PAYLOADS.map(p => {
    const candidate = scoreCandidate('crypto_baseline', p);
    const meanReversion = scoreMeanReversionBaseline(p);
    return {
      n: p.n,
      candidateScore: candidate.score,
      passedGate1: candidate.score >= candidate.threshold,
      meanReversionScore: meanReversion,
      passedGate2: meanReversion >= 75,
    };
  });

  // #1, #2, #4 scheitern bereits an Gate 1 (Candidate < 60) — Gate 2 wird nie erreicht.
  for (const n of [1, 2, 4]) {
    const row = rows.find(r => r.n === n);
    assert.ok(!row.passedGate1, `#${n} sollte Gate 1 nicht passieren`);
  }

  // Von den 7 Gate-1-Passierern (#3, #5, #6, #7, #8, #9, #10) passieren nur
  // die mit klarer EMA-Überdehnung (>1.3%) UND eindeutigem nearSup (kein
  // ambivalentes nearRes) UND ohne Dead-Zone-Malus auch Gate 2.
  const gate1Passed = rows.filter(r => r.passedGate1);
  assert.equal(gate1Passed.length, 7, 'genau 7 Payloads passieren Gate 1');

  const gate2Passed = gate1Passed.filter(r => r.passedGate2);
  const gate2Failed = gate1Passed.filter(r => !r.passedGate2);
  assert.deepEqual(gate2Passed.map(r => r.n), [6, 8, 9], 'nur die stärksten Setups passieren Gate 2');
  assert.deepEqual(gate2Failed.map(r => r.n), [3, 5, 7, 10], 'moderate/schwache Setups bleiben unter Gate 2');

  // Klare Trennung: alle Gate-2-Passierer liegen mit Abstand über der Schwelle,
  // alle Ablehnungen mit Abstand darunter (kein Grenzfall-Wackeln durch Rauschen).
  for (const r of gate2Passed) assert.ok(r.meanReversionScore >= 76, `#${r.n} sollte klar über 75 liegen (war ${r.meanReversionScore})`);
  for (const r of gate2Failed) assert.ok(r.meanReversionScore <= 67, `#${r.n} sollte klar unter 75 liegen (war ${r.meanReversionScore})`);

  // #5 (rsiDeadZone=true) landet am weitesten unten — der Dead-Zone-Malus wirkt.
  const five = rows.find(r => r.n === 5);
  assert.ok(five.meanReversionScore <= 55, '#5 (Dead-Zone) sollte klar unter 75 liegen');
});
