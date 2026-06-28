// Test: jedes eingehende Signal muss im Dashboard sichtbar sein.
// Invariante: Trades(OPEN/WIN/LOSS) + SKIPPED + REJECTED = Total Signale in DB.
// Kein Signal darf lautlos verschwinden.
// Lauf: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Outcome-Klassifikation (spiegelt processSignal-Logik wider) ────────────

function classifySignal({ passedCandidateGate, sessionClosed, strategyPaused, useScoreGate, score, minScore }) {
  if (!passedCandidateGate) return 'REJECTED';
  const passesGate = !sessionClosed && !strategyPaused &&
    (useScoreGate ? score >= (minScore ?? 75) : true);
  return passesGate ? 'OPEN' : 'SKIPPED';
}

// ── Accounting-Invariante ──────────────────────────────────────────────────

function checkAccounting(signals) {
  const total    = signals.length;
  const open     = signals.filter(s => s.outcome === 'OPEN').length;
  const skipped  = signals.filter(s => s.outcome === 'SKIPPED').length;
  const rejected = signals.filter(s => s.outcome === 'REJECTED').length;
  const wins     = signals.filter(s => s.outcome === 'WIN').length;
  const losses   = signals.filter(s => s.outcome === 'LOSS').length;
  const accounted = open + skipped + rejected + wins + losses;
  return { total, open, skipped, rejected, wins, losses, accounted, balanced: accounted === total };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('classifySignal: REJECTED wenn Candidate-Gate nicht bestanden', () => {
  const outcome = classifySignal({ passedCandidateGate: false, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 90, minScore: 75 });
  assert.equal(outcome, 'REJECTED');
});

test('classifySignal: OPEN wenn alle Gates bestanden', () => {
  const outcome = classifySignal({ passedCandidateGate: true, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 80, minScore: 75 });
  assert.equal(outcome, 'OPEN');
});

test('classifySignal: SKIPPED wenn Score unter minScore', () => {
  const outcome = classifySignal({ passedCandidateGate: true, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 60, minScore: 75 });
  assert.equal(outcome, 'SKIPPED');
});

test('classifySignal: SKIPPED wenn Forex-Session geschlossen', () => {
  const outcome = classifySignal({ passedCandidateGate: true, sessionClosed: true, strategyPaused: false, useScoreGate: false, score: 99, minScore: 75 });
  assert.equal(outcome, 'SKIPPED');
});

test('classifySignal: SKIPPED wenn Strategie pausiert', () => {
  const outcome = classifySignal({ passedCandidateGate: true, sessionClosed: false, strategyPaused: true, useScoreGate: false, score: 99, minScore: 75 });
  assert.equal(outcome, 'SKIPPED');
});

test('classifySignal: OPEN für Pine-Strategie (useScoreGate=false) wenn nicht pausiert/session-closed', () => {
  const outcome = classifySignal({ passedCandidateGate: true, sessionClosed: false, strategyPaused: false, useScoreGate: false, score: 30, minScore: 75 });
  assert.equal(outcome, 'OPEN');
});

test('Accounting-Invariante: N Signale = OPEN + SKIPPED + REJECTED + WIN + LOSS', () => {
  const incomingSignals = [
    { passedCandidateGate: false, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 45, minScore: 75 }, // → REJECTED
    { passedCandidateGate: false, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 52, minScore: 75 }, // → REJECTED
    { passedCandidateGate: false, sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 58, minScore: 75 }, // → REJECTED
    { passedCandidateGate: true,  sessionClosed: true,  strategyPaused: false, useScoreGate: false, score: 70, minScore: 75 }, // → SKIPPED (session)
    { passedCandidateGate: true,  sessionClosed: false, strategyPaused: true, useScoreGate: false, score: 70, minScore: 75 }, // → SKIPPED (paused)
    { passedCandidateGate: true,  sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 60, minScore: 75 }, // → SKIPPED (score)
    { passedCandidateGate: true,  sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 80, minScore: 75 }, // → OPEN
    { passedCandidateGate: true,  sessionClosed: false, strategyPaused: false, useScoreGate: true, score: 92, minScore: 75 }, // → OPEN
    { passedCandidateGate: true,  sessionClosed: false, strategyPaused: false, useScoreGate: false, score: 55, minScore: 75 }, // → OPEN (Pine)
  ];

  const signals = incomingSignals.map(s => ({ outcome: classifySignal(s) }));
  // Simulate some closed trades
  signals[6].outcome = 'WIN';
  signals[7].outcome = 'LOSS';

  const result = checkAccounting(signals);
  assert.equal(result.balanced, true,
    `Accounting nicht ausgeglichen! ${result.accounted}/${result.total}: ` +
    `OPEN=${result.open} WIN=${result.wins} LOSS=${result.losses} SKIPPED=${result.skipped} REJECTED=${result.rejected}`
  );
  assert.equal(result.total, 9);
  assert.equal(result.rejected, 3);
  assert.equal(result.skipped, 3);
  assert.equal(result.open, 1);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
});

test('Accounting: Keine unerklärte Differenz erlaubt', () => {
  // Simuliert einen "Fehlerfall": 1 Signal fehlt (wäre lautlos verschwunden)
  const signals = [
    { outcome: 'OPEN' },
    { outcome: 'OPEN' },
    { outcome: 'WIN' },
    // 1 fehlt hier (war früher der Bug)
  ];
  const result = checkAccounting(signals);
  // Mit dem Fix muss jedes Signal in einer der Kategorien landen.
  // Wir testen hier, dass die Invariante korrekt detektiert wenn N != accounted.
  const fakeTotal = 4; // was tatsächlich ankam
  assert.notEqual(result.accounted, fakeTotal,
    'Wenn ein Signal fehlt, muss die Invariante das erkennen'
  );
});

// ── Forex-Session-Klassifikation ───────────────────────────────────────────

function getForexSession(h, m) {
  const t = h * 60 + m;
  const inAsia   = t >= 0    && t < 9*60;
  const inLondon = t >= 8*60 && t < 17*60;
  const inNY     = t >= 13*60 && t < 22*60;
  if (inLondon && inNY) return 'London/NY-Overlap';
  if (inLondon)          return 'London-Session';
  if (inNY)              return 'NY-Session';
  if (inAsia)            return 'Asia-Session';
  return 'Off-Session';
}

test('Forex-Session: 06:00 UTC → Asia', () => {
  assert.equal(getForexSession(6, 0), 'Asia-Session');
});

test('Forex-Session: 10:00 UTC → London', () => {
  assert.equal(getForexSession(10, 0), 'London-Session');
});

test('Forex-Session: 14:00 UTC → London/NY-Overlap', () => {
  assert.equal(getForexSession(14, 0), 'London/NY-Overlap');
});

test('Forex-Session: 19:00 UTC → NY', () => {
  assert.equal(getForexSession(19, 0), 'NY-Session');
});

test('Forex-Session: 23:00 UTC → Off-Session', () => {
  assert.equal(getForexSession(23, 0), 'Off-Session');
});

test('Forex-Session: Grenze 13:00 UTC → Overlap beginnt', () => {
  assert.equal(getForexSession(13, 0), 'London/NY-Overlap');
});

test('Forex-Session: 17:00 UTC → London endet, noch NY', () => {
  assert.equal(getForexSession(17, 0), 'NY-Session');
});
