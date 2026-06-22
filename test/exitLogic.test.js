// Unit-Tests für die neue Exit-Logik: TP1 (Teilschließung) → Breakeven → TP2.
// Lauf: node --test test/
//
// Getestet wird die reine, seiteneffektfreie Funktion evaluateExit(pos, price, cfg)
// aus worker.js (plus der Helfer deriveTp1 und das konfigurierbare EXIT_CONFIG).
// Alle DB-/env-Wiring-Teile (checkPracticeTrades, evaluateOpenTrades,
// applyTp1Partial) bauen ausschließlich auf dieser Funktion auf, daher deckt
// dieser Test die Kern-Entscheidungslogik vollständig ab.
//
// Abgedeckte Fälle (laut Aufgabe):
//   • TP1-Trigger        → Position 50% schließen, SL → Breakeven
//   • Breakeven-Move     → nach TP1 endet ein SL-Treffer als (kleiner) WIN
//   • TP2-Trigger        → Restposition am vollen Ziel schließen
//   • "Preis erreicht TP1 nie" → kein Teil-Exit; SL davor = voller LOSS
//   • plus Edge-Cases: Gap durch beide Levels, Idempotenz, Guards, Config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExit, deriveTp1, EXIT_CONFIG } from '../worker.js';

// ── Referenzpositionen (R = 1% = 1.0 Preis-Einheit bei Entry 100) ───────────
// Defaults: TP1_DISTANCE_FRAC 0.60 · TP1_CLOSE_FRAC 0.50 · BREAKEVEN_OFFSET_R 0.10
//
// LONG : Entry 100 · SL 99 (1R) · TP2 101.5 (1.5R)
//        → TP1 = 100 + 0.6·1.5 = 100.9 · Breakeven-SL = 100 + 0.1·1 = 100.1
// SHORT: Entry 100 · SL 101     · TP2 98.5
//        → TP1 = 100 − 0.6·1.5 = 99.1  · Breakeven-SL = 100 − 0.1·1 = 99.9
const LONG  = { isLong: true,  entry: 100, sl: 99,  tp2: 101.5 };
const SHORT = { isLong: false, entry: 100, sl: 101, tp2: 98.5  };

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── Helfer deriveTp1 + Config ───────────────────────────────────────────────
test('deriveTp1: TP1 liegt bei 60% der Strecke Entry→TP2 (LONG & SHORT)', () => {
  assert.ok(approx(deriveTp1(100, 101.5), 100.9)); // LONG
  assert.ok(approx(deriveTp1(100, 98.5),  99.1));  // SHORT
  assert.equal(deriveTp1(NaN, 101.5), null);
  assert.equal(deriveTp1(100, undefined), null);
});

test('EXIT_CONFIG hat die erwarteten konfigurierbaren Defaults', () => {
  assert.equal(EXIT_CONFIG.TP1_DISTANCE_FRAC,  0.60);
  assert.equal(EXIT_CONFIG.TP1_CLOSE_FRAC,     0.50);
  assert.equal(EXIT_CONFIG.BREAKEVEN_OFFSET_R, 0.10);
});

// ── (1) TP1-Trigger: 50% schließen + SL auf Breakeven ───────────────────────
test('(1) LONG erreicht TP1 → TP1_PARTIAL, SL → Breakeven, 0.45% gesichert', () => {
  const d = evaluateExit({ ...LONG }, 100.9); // tp1Hit default false, tp1 abgeleitet
  assert.equal(d.action, 'TP1_PARTIAL');
  assert.ok(approx(d.newSl, 100.1));       // Breakeven + 0.1R
  assert.ok(approx(d.tp1Price, 100.9));
  assert.ok(approx(d.realizedPct, 0.45));  // 0.5 (close) × 0.9% (Bewegung bis TP1)
});

test('(1b) SHORT erreicht TP1 → TP1_PARTIAL, SL → Breakeven', () => {
  const d = evaluateExit({ ...SHORT }, 99.1);
  assert.equal(d.action, 'TP1_PARTIAL');
  assert.ok(approx(d.newSl, 99.9));
  assert.ok(approx(d.realizedPct, 0.45));
});

// ── (2) Breakeven-Move: nach TP1 ist ein SL-Treffer ein (kleiner) WIN ───────
test('(2) LONG: nach TP1 fällt Preis auf Breakeven-SL → SL_FINAL, WIN (+0.50%)', () => {
  const pos = { ...LONG, tp1Hit: true, currentSl: 100.1 }; // Zustand nach TP1
  const d = evaluateExit(pos, 100.1);
  assert.equal(d.action, 'SL_FINAL');
  assert.equal(d.outcome, 'WIN');          // dank TP1-Teilgewinn netto positiv
  assert.ok(approx(d.exitPrice, 100.1));
  assert.ok(approx(d.finalPct, 0.5));      // 0.45 (TP1) + 0.5×0.1 (Rest am BE)
});

test('(2b) LONG: nach TP1, Preis zwischen Breakeven und TP2 → NONE (Rest läuft)', () => {
  const d = evaluateExit({ ...LONG, tp1Hit: true, currentSl: 100.1 }, 100.8);
  assert.equal(d.action, 'NONE');
});

// ── (3) TP2-Trigger: Restposition am vollen Ziel schließen ──────────────────
test('(3) LONG: nach TP1 erreicht Preis TP2 → TP2_FINAL, WIN (+1.20%)', () => {
  const d = evaluateExit({ ...LONG, tp1Hit: true, currentSl: 100.1 }, 101.5);
  assert.equal(d.action, 'TP2_FINAL');
  assert.equal(d.outcome, 'WIN');
  assert.ok(approx(d.exitPrice, 101.5));
  assert.ok(approx(d.finalPct, 1.2));      // 0.45 (TP1) + 0.5×1.5 (Rest am TP2)
});

test('(3b) SHORT: nach TP1 erreicht Preis TP2 → TP2_FINAL, WIN (+1.20%)', () => {
  const d = evaluateExit({ ...SHORT, tp1Hit: true, currentSl: 99.9 }, 98.5);
  assert.equal(d.action, 'TP2_FINAL');
  assert.equal(d.outcome, 'WIN');
  assert.ok(approx(d.finalPct, 1.2));
});

// ── (4) "Preis erreicht TP1 nie" ────────────────────────────────────────────
test('(4) LONG: Preis im Plus aber unter TP1 → NONE (kein Teil-Exit)', () => {
  assert.equal(evaluateExit({ ...LONG }, 100.5).action, 'NONE');
});

test('(4b) LONG: SL VOR TP1 getroffen → SL_FINAL, voller LOSS (−1.00%)', () => {
  const d = evaluateExit({ ...LONG }, 99); // tp1Hit false
  assert.equal(d.action, 'SL_FINAL');
  assert.equal(d.outcome, 'LOSS');
  assert.ok(approx(d.exitPrice, 99));
  assert.ok(approx(d.finalPct, -1.0));     // volle Position, kein Teilgewinn
});

test('(4c) SHORT: SL VOR TP1 getroffen → SL_FINAL, voller LOSS (−1.00%)', () => {
  const d = evaluateExit({ ...SHORT }, 101);
  assert.equal(d.action, 'SL_FINAL');
  assert.equal(d.outcome, 'LOSS');
  assert.ok(approx(d.finalPct, -1.0));
});

// ── (5) Edge: Gap durch TP1 UND TP2 im selben Tick ──────────────────────────
test('(5) LONG: Preis springt über TP2 ohne gebuchten TP1 → TP2_FINAL mit korrektem Blend', () => {
  const d = evaluateExit({ ...LONG }, 102); // tp1Hit false, price ≥ tp2
  assert.equal(d.action, 'TP2_FINAL');
  assert.equal(d.outcome, 'WIN');
  assert.ok(approx(d.exitPrice, 101.5));    // schließt am TP2-Level, nicht am Gap-Preis
  assert.ok(approx(d.finalPct, 1.2));       // TP1-Teil über das feste Level mitberücksichtigt
});

// ── (6) Idempotenz der Logik: TP1 feuert nicht zweimal ──────────────────────
test('(6) LONG: tp1Hit=true, Preis erneut auf TP1-Level → kein zweites TP1_PARTIAL', () => {
  const d = evaluateExit({ ...LONG, tp1Hit: true, currentSl: 100.1 }, 100.9);
  assert.equal(d.action, 'NONE');
});

// ── (7) Guards: ungültige Eingaben → NONE ───────────────────────────────────
test('(7) Guards: SL == Entry, nicht-finite Werte und fehlendes pos → NONE', () => {
  assert.equal(evaluateExit({ isLong: true, entry: 100, sl: 100, tp2: 101.5 }, 100.9).action, 'NONE');
  assert.equal(evaluateExit({ ...LONG }, NaN).action, 'NONE');
  assert.equal(evaluateExit({ isLong: true, entry: 100, sl: 99 /* tp2 fehlt */ }, 100.9).action, 'NONE');
  assert.equal(evaluateExit(null, 100).action, 'NONE');
  assert.equal(evaluateExit({ entry: 100, sl: 99, tp2: 101.5 /* isLong fehlt */ }, 100.9).action, 'NONE');
});

// ── (8) Konfigurierbarkeit: eigenes cfg ändert Levels & Anteile ─────────────
test('(8) Custom-Config: TP1 50% Strecke, 40% schließen, exakter Breakeven (Offset 0)', () => {
  const cfg = { TP1_DISTANCE_FRAC: 0.50, TP1_CLOSE_FRAC: 0.40, BREAKEVEN_OFFSET_R: 0 };
  assert.ok(approx(deriveTp1(100, 101.5, cfg), 100.75));

  const d = evaluateExit({ ...LONG }, 100.75, cfg);
  assert.equal(d.action, 'TP1_PARTIAL');
  assert.ok(approx(d.newSl, 100));               // Offset 0 → exakt Entry
  assert.ok(approx(d.tp1Price, 100.75));
  assert.ok(approx(d.realizedPct, 0.30));        // 0.40 × 0.75%

  // Mit demselben cfg endet ein finaler TP2-Treffer beim geblendeten 40/60-Mix.
  const d2 = evaluateExit({ ...LONG, tp1Hit: true, currentSl: 100 }, 101.5, cfg);
  assert.equal(d2.action, 'TP2_FINAL');
  assert.ok(approx(d2.finalPct, 0.40 * 0.75 + 0.60 * 1.5)); // 0.3 + 0.9 = 1.2
});
