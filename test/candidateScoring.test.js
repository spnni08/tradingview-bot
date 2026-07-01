// Tests für das Kandidaten-Score-System (scoreCandidate pro Strategie).
//
// Abgedeckt:
//   1. Score-Berechnung pro Strategie mit Beispiel-Payloads
//   2. Schwellenwert-Entscheidung (knapp drüber / knapp drunter)
//   3. Korrektheit der Details-Aufschlüsselung
//   4. Custom-Weights-Override (_threshold)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate, CANDIDATE_SCORING_DEFAULTS } from '../worker.js';

// ── Imports prüfen ───────────────────────────────────────────────────────────
test('scoreCandidate und CANDIDATE_SCORING_DEFAULTS sind exportiert', () => {
  assert.equal(typeof scoreCandidate, 'function');
  assert.equal(typeof CANDIDATE_SCORING_DEFAULTS, 'object');
  assert.ok('crypto_baseline' in CANDIDATE_SCORING_DEFAULTS);
  assert.ok('crypto_sr_volume' in CANDIDATE_SCORING_DEFAULTS);
  assert.ok('crypto_orderflow_breakout' in CANDIDATE_SCORING_DEFAULTS);
  assert.ok('forex_sr_fib_rsi' in CANDIDATE_SCORING_DEFAULTS);
});

// ══════════════════════════════════════════════════════════════
// crypto_baseline
// ══════════════════════════════════════════════════════════════

test('crypto_baseline: optimaler LONG (EMA sweet-spot + nearSup, kein DeadZone) → hoher Score', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,            // außerhalb Dead-Zone (55-65)
    emaDistPct: 0.9,    // sweet-spot 0.5-1.3%
    nearSup: true,
    nearRes: false,
  });
  assert.equal(result.threshold, 60);
  // base 50 + sweet-spot 20 + nearSup 12 = 82
  assert.equal(result.score, 82);
  assert.equal(result.details.ema_dist, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.ema_dist_sweet_spot);
  assert.equal(result.details.near_sup, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.near_sup_long);
  assert.ok(!result.details.rsi_dead_zone);
});

test('crypto_baseline: RSI Dead-Zone LONG (RSI 60) → Strafe -15', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 60,            // in Dead-Zone 55-65
    emaDistPct: 0.9,
  });
  // base 50 + sweet-spot 20 - dead-zone 15 = 55
  assert.equal(result.score, 55);
  assert.equal(result.details.rsi_dead_zone, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.rsi_dead_zone_penalty);
});

test('crypto_baseline: Pine sendet rsiDeadZone=1 explizit → Strafe wird angewendet', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 45,            // RSI wäre außerhalb Dead-Zone…
    rsiDeadZone: 1,     // …aber Pine sagt explizit Dead-Zone
    emaDistPct: 0.9,
  });
  assert.ok(result.details.rsi_dead_zone != null);
  assert.equal(result.details.rsi_dead_zone, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.rsi_dead_zone_penalty);
});

test('crypto_baseline: EMA zu nah (0.3%) → Strafe -12', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,
    emaDistPct: 0.3,    // < 0.5 %
  });
  // base 50 - 12 = 38
  assert.equal(result.score, 38);
  assert.equal(result.details.ema_dist, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.ema_dist_too_close);
});

test('crypto_baseline: EMA zu weit (3.0%) → Strafe -8', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,
    emaDistPct: 3.0,    // > 2.5 %
  });
  // base 50 - 8 = 42
  assert.equal(result.score, 42);
  assert.equal(result.details.ema_dist, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.ema_dist_too_far);
});

test('crypto_baseline: LONG + Resistance overhead → Gegenwind-Strafe -8', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,
    emaDistPct: 0.9,
    nearSup: false,
    nearRes: true,      // Resistance direkt über dem Preis
  });
  // base 50 + sweet-spot 20 - near_res_penalty 8 = 62
  assert.equal(result.score, 62);
  assert.equal(result.details.near_res, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.near_res_long_penalty);
});

// Schwellenwert-Grenzfall
test('crypto_baseline: Score knapp über Threshold (61 ≥ 60) → passiert', () => {
  // sweet-spot (20) + nearSup (12) = base 50 + 32 - dead-zone 15 = 67? nein:
  // Wir bauen ein Szenario mit genau 61.
  // base 50 + ema_acceptable (8) + nearSup (12) = 70; zu hoch. Probiere ohne nearSup:
  // base 50 + ema_acceptable (8) = 58 < 60 → zu niedrig.
  // base 50 + ema_acceptable (8) + nearSup (12) - dead-zone (15) = 55 (nein)
  // Einfachster Weg: custom weight
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,
    emaDistPct: 0.9,    // sweet-spot +20
    nearSup: false,
    nearRes: false,
  }, { ema_dist_sweet_spot: 11 }); // 50+11=61 → knapp über 60
  assert.equal(result.score, 61);
  assert.ok(result.score >= result.threshold, 'score knapp über threshold → würde Trade öffnen');
});

test('crypto_baseline: Score knapp unter Threshold (59 < 60) → abgelehnt', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 38,
    emaDistPct: 0.9,
  }, { ema_dist_sweet_spot: 9 }); // 50+9=59 → knapp unter 60
  assert.equal(result.score, 59);
  assert.ok(result.score < result.threshold, 'score knapp unter threshold → Kandidat abgelehnt');
});

// ══════════════════════════════════════════════════════════════
// crypto_sr_volume
// ══════════════════════════════════════════════════════════════

test('crypto_sr_volume: echter Reclaim + oversold + rising + trendOk → hoher Score', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: true,
    rsiWasOversold: true,
    rsiRising: true,
    trendOk: true,
  });
  // base 40 + reclaim 25 + oversold 10 + rising 8 + trendOk 10 = 93
  assert.equal(result.score, 93);
  assert.equal(result.details.reclaim, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.reclaim);
  assert.equal(result.details.rsi_was_oversold, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.rsi_was_oversold);
  assert.equal(result.details.rsi_rising, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.rsi_rising);
  assert.equal(result.details.trend_ok, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.trend_ok);
});

test('crypto_sr_volume: nur Touch ohne Reclaim und ohne Kontext → niedriger Score (Basiswert)', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: false,
  });
  // base 40, kein Bonus
  assert.equal(result.score, 40);
  assert.ok(result.score < result.threshold, 'reiner Touch ohne Reclaim fällt unter Threshold');
});

test('crypto_sr_volume: breakdown SHORT mit rsiFalling → solider Score', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'SHORT',
    breakdown: true,
    rsiWasOverbought: true,
    rsiFalling: true,
  });
  // base 40 + breakdown 25 + overbought 10 + falling 8 = 83
  assert.equal(result.score, 83);
  assert.ok(result.score >= result.threshold);
});

test('crypto_sr_volume: snake_case Felder (rsi_was_oversold, rsi_rising) werden erkannt', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: true,
    rsi_was_oversold: true,
    rsi_rising: true,
  });
  assert.ok(result.details.rsi_was_oversold != null);
  assert.ok(result.details.rsi_rising != null);
});

// ── crypto_sr_volume — String-Boolean-Fix (wavescout_sr_volume.pine sendet
// reclaim/breakdown/rsiWasOversold/rsiWasOverbought/rsiRising/rsiFalling/
// trendOk als STRINGS "true"/"false" via str.tostring(), genau wie
// crypto_baseline vor PR #134). `!!("false")` und Klartext-Truthy-Checks sind
// für den String "false" fälschlich true — jedes Signal bekam bisher IMMER
// den vollen Bonus, unabhängig vom tatsächlichen Wert.

test('crypto_sr_volume: alle Flags als String "false" (echter Pine-Payload eines Touch OHNE Reclaim) → nur Basiswert', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: 'false', rsiWasOversold: 'false', rsiRising: 'false', trendOk: 'false',
  });
  // VORHER (Bug): !!("false") === true → base 40 + reclaim 25 + oversold 10
  // + rising 8 + trendOk 10 = 93 (jeder Touch hätte das Gate JEDER passiert).
  // NACHHER (Fix): kein Flag greift → nur Basiswert 40.
  assert.equal(result.score, 40, 'String "false" darf keinen Bonus auslösen');
  assert.equal(result.details.reclaim, undefined);
  assert.equal(result.details.trend_ok, undefined);
  assert.ok(result.score < result.threshold, 'reiner Touch ohne echten Reclaim fällt unter Threshold');
});

test('crypto_sr_volume: alle Flags als String "true" → voller Bonus (Regression, wie zuvor mit echten Booleans)', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: 'true', rsiWasOversold: 'true', rsiRising: 'true', trendOk: 'true',
  });
  // base 40 + reclaim 25 + oversold 10 + rising 8 + trendOk 10 = 93
  assert.equal(result.score, 93);
  assert.equal(result.details.reclaim, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.reclaim);
});

test('crypto_sr_volume: breakdown SHORT als String "false" mit echtem rsiWasOverbought="true" → nur der wahre Flag zählt', () => {
  const result = scoreCandidate('crypto_sr_volume', {
    direction: 'SHORT',
    breakdown: 'false', rsiWasOverbought: 'true', rsiFalling: 'false',
  });
  // base 40 + overbought 10 = 50 (breakdown/falling bleiben aus, weil "false")
  assert.equal(result.score, 50);
  assert.equal(result.details.breakdown, undefined);
  assert.equal(result.details.rsi_was_overbought, CANDIDATE_SCORING_DEFAULTS.crypto_sr_volume.weights.rsi_was_overbought);
});

// ══════════════════════════════════════════════════════════════
// crypto_orderflow_breakout
// ══════════════════════════════════════════════════════════════

test('crypto_orderflow_breakout: echter Breakout nach oben + volRatio 2.5 + trendOk → sehr hoher Score', () => {
  const result = scoreCandidate('crypto_orderflow_breakout', {
    direction: 'LONG',
    breakoutAboveRange: true,
    volRatio: 2.5,      // >= 2.0 → vol_ratio_high
    trendOk: true,
  });
  // base 35 + breakout 30 + vol_high 20 + trendOk 10 = 95
  assert.equal(result.score, 95);
  assert.equal(result.details.breakout_above_range, CANDIDATE_SCORING_DEFAULTS.crypto_orderflow_breakout.weights.breakout_above_range);
  assert.equal(result.details.vol_ratio, CANDIDATE_SCORING_DEFAULTS.crypto_orderflow_breakout.weights.vol_ratio_high);
});

test('crypto_orderflow_breakout: Volumen-Spike ohne echten Breakout → schwacher Score', () => {
  const result = scoreCandidate('crypto_orderflow_breakout', {
    direction: 'LONG',
    breakoutAboveRange: false,
    volRatio: 2.5,      // hohes Volumen, aber kein Breakout
  });
  // base 35 + vol_high 20 = 55 < 60
  assert.equal(result.score, 55);
  assert.ok(result.score < result.threshold, 'reiner Vol-Spike ohne Breakout fällt unter Threshold');
});

test('crypto_orderflow_breakout: niedriger volRatio (<1.5) → Strafe -5', () => {
  const result = scoreCandidate('crypto_orderflow_breakout', {
    direction: 'LONG',
    breakoutAboveRange: true,
    volRatio: 1.2,
  });
  // base 35 + breakout 30 - vol_low_penalty 5 = 60
  assert.equal(result.score, 60);
  assert.equal(result.details.vol_ratio, CANDIDATE_SCORING_DEFAULTS.crypto_orderflow_breakout.weights.vol_ratio_low_penalty);
});

// ══════════════════════════════════════════════════════════════
// forex_sr_fib_rsi
// ══════════════════════════════════════════════════════════════

// distToVAL/distToVAH: wavescout_forex.pine sendet eine ROHE Preisdifferenz
// (`close - fxVAL` bzw. `fxVAH - close`), nicht Prozent — der Worker
// normalisiert das intern auf Prozent von `price` (siehe scoreCandidate).
// Die Tests brauchen deshalb einen `price` und einen realistischen
// Preis-Delta-Wert statt eines direkten Prozentwerts.

test('forex_sr_fib_rsi: reclaimVAL LONG + sehr geringer Abstand (0.0005 bei price 1.08 → 0.046 %) → hoher Score', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG',
    reclaimVAL: true,
    price: 1.08,
    distToVAL: 0.0005,  // 0.0005 / 1.08 * 100 = 0.046 % < 0.1 % → sehr nah
  });
  // base 35 + reclaimVAL 30 + dist_very_close 15 = 80
  assert.equal(result.score, 80);
  assert.equal(result.details.reclaim_val, CANDIDATE_SCORING_DEFAULTS.forex_sr_fib_rsi.weights.reclaim_val);
  assert.equal(result.details.dist_to_level, CANDIDATE_SCORING_DEFAULTS.forex_sr_fib_rsi.weights.dist_very_close);
});

test('forex_sr_fib_rsi: breakdownVAH SHORT + mittlerer Abstand (0.002 bei price 1.08 → 0.185 %) → solider Score', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'SHORT',
    breakdownVAH: true,
    price: 1.08,
    distToVAH: 0.002,   // 0.002 / 1.08 * 100 = 0.185 % → 0.1–0.3 % → dist_close
  });
  // base 35 + breakdownVAH 30 + dist_close 5 = 70
  assert.equal(result.score, 70);
  assert.ok(result.score >= result.threshold);
});

test('forex_sr_fib_rsi: kein Reclaim/Breakdown → nur Basiswert 35 < Threshold', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG',
    reclaimVAL: false,
  });
  assert.equal(result.score, 35);
  assert.ok(result.score < result.threshold);
});

test('forex_sr_fib_rsi: snake_case Felder (reclaim_val, dist_to_val) werden erkannt', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG',
    reclaim_val: true,
    price: 1.08,
    dist_to_val: 0.0005,
  });
  assert.equal(result.score, 80);
});

// ── distToVAL/distToVAH — Prozent-Normalisierung (Payload-Contract-Fix) ─────
// wavescout_forex.pine sendet eine ROHE Preisdifferenz, nicht Prozent. Für
// EUR/USD (~1.08) wäre jede reale Differenz automatisch < 0.1 (die alten,
// als Prozent gedachten Schwellen) — der dist_very_close-Bonus hätte praktisch
// IMMER gefeuert, unabhängig von der tatsächlichen Nähe zum Level.

test('forex_sr_fib_rsi: realistische EUR/USD-Distanz (0.0004 absolut) wird korrekt als sehr nah erkannt', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG', price: 1.08, distToVAL: 0.0004, // → 0.037 % < 0.1 %
  });
  assert.equal(result.details.dist_to_level, CANDIDATE_SCORING_DEFAULTS.forex_sr_fib_rsi.weights.dist_very_close);
});

test('forex_sr_fib_rsi: realistische EUR/USD-Distanz, die WEIT vom Level entfernt ist, bekommt KEINEN Nah-Bonus', () => {
  // 0.02 absolute Preisdifferenz bei price 1.08 = 1.85 % — weit weg, aber vor
  // dem Fix wäre 0.02 < 0.3 gewesen und hätte fälschlich dist_close ausgelöst.
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG', price: 1.08, distToVAL: 0.02,
  });
  assert.equal(result.details.dist_to_level, undefined, 'echte 1.85 % Abstand ist NICHT nah am Level');
});

test('forex_sr_fib_rsi: Vorzeichen von distToVAL (Preis über/unter Level) ist irrelevant für die Nähe', () => {
  const below = scoreCandidate('forex_sr_fib_rsi', { direction: 'LONG', price: 1.08, distToVAL: 0.0004 });
  const above = scoreCandidate('forex_sr_fib_rsi', { direction: 'LONG', price: 1.08, distToVAL: -0.0004 });
  assert.equal(below.score, above.score, 'Math.abs() macht das Vorzeichen irrelevant, nur die Magnitude zählt');
});

test('forex_sr_fib_rsi: ohne price/entry kein Crash, kein (fälschlicher) Nah-Bonus', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG', reclaimVAL: true, distToVAL: 0.0004, // kein price/entry im Payload
  });
  assert.equal(result.score, 65, 'base 35 + reclaimVAL 30, kein Dist-Bonus ohne Preisreferenz');
  assert.equal(result.details.dist_to_level, undefined);
});

// ── forex_sr_fib_rsi — String-Boolean-Fix (wavescout_forex.pine sendet
// reclaimVAL/breakdownVAH ebenfalls als STRINGS "true"/"false", derselbe Bug
// wie bei crypto_sr_volume oben).

test('forex_sr_fib_rsi: reclaimVAL als String "false" (echter Pine-Payload ohne Reclaim) → kein Bonus', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG',
    reclaimVAL: 'false',
    distToVAL: 999, // fern vom Level, damit auch der Dist-Bonus nicht greift
  });
  // VORHER (Bug): signal.reclaimVAL || … ist für "false" (String) truthy →
  // +30 obwohl kein echter Reclaim vorlag. NACHHER: nur Basiswert 35.
  assert.equal(result.score, 35);
  assert.equal(result.details.reclaim_val, undefined);
});

test('forex_sr_fib_rsi: reclaimVAL als String "true" → Bonus greift (Regression)', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'LONG',
    reclaimVAL: 'true',
    distToVAL: 999,
  });
  // base 35 + reclaimVAL 30 = 65
  assert.equal(result.score, 65);
  assert.equal(result.details.reclaim_val, CANDIDATE_SCORING_DEFAULTS.forex_sr_fib_rsi.weights.reclaim_val);
});

test('forex_sr_fib_rsi: breakdownVAH als String "false" → kein Bonus', () => {
  const result = scoreCandidate('forex_sr_fib_rsi', {
    direction: 'SHORT',
    breakdownVAH: 'false',
    distToVAH: 999,
  });
  assert.equal(result.score, 35);
  assert.equal(result.details.breakdown_vah, undefined);
});

// ══════════════════════════════════════════════════════════════
// Sonderfälle
// ══════════════════════════════════════════════════════════════

test('unbekannter strategyKey → Fallback-Score 50, threshold 60', () => {
  const result = scoreCandidate('unknown_strategy', { direction: 'LONG' });
  assert.equal(result.score, 50);
  assert.equal(result.threshold, 60);
  assert.deepEqual(result.details, {});
});

test('Score wird auf 0–100 geclampt (kein Unter-/Überlauf)', () => {
  // Alle positiven Gewichte addieren → muss ≤ 100 bleiben
  const high = scoreCandidate('crypto_sr_volume', {
    direction: 'LONG',
    reclaim: true,
    rsiWasOversold: true,
    rsiRising: true,
    trendOk: true,
    rsiWasOverbought: true, // doppelt, irrelevant für Richtung
  });
  assert.ok(high.score <= 100);

  // Alles negativ (crypto_baseline) → muss ≥ 0 bleiben
  const low = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    rsi: 60,             // dead-zone
    emaDistPct: 0.1,     // too_close
    nearRes: true,       // adverse
  }, {
    ema_dist_too_close:    -50,
    rsi_dead_zone_penalty: -50,
    near_res_long_penalty: -50,
  });
  assert.ok(low.score >= 0);
});

test('custom _threshold im Override wird respektiert', () => {
  const result = scoreCandidate('crypto_baseline', {
    direction: 'LONG',
    emaDistPct: 0.9,     // sweet-spot +20 → score 70
  }, { _threshold: 75 }); // custom threshold
  assert.equal(result.threshold, 75);
  assert.ok(result.score < result.threshold, 'custom threshold 75 → score 70 < 75 = abgelehnt');
});

test('Alle 4 Strategien haben sinnvolle Default-Schwellenwerte (>0, ≤100)', () => {
  for (const [key, cfg] of Object.entries(CANDIDATE_SCORING_DEFAULTS)) {
    assert.ok(cfg.threshold > 0 && cfg.threshold <= 100, `${key}: threshold muss 1-100 sein`);
    assert.ok(cfg.base >= 0, `${key}: base muss ≥ 0 sein`);
    assert.equal(typeof cfg.weights, 'object', `${key}: weights muss ein Objekt sein`);
  }
});

// ══════════════════════════════════════════════════════════════
// crypto_baseline — Rekalibrierung (echte Payload-Felder)
// ══════════════════════════════════════════════════════════════
// Reale Pine-Payloads liefern emaDistPct VORZEICHENBEHAFTET (− = Preis unter
// EMA200) und nearSup/nearRes/rsiDeadZone als STRINGS "true"/"false". Vorher
// verwarf `emaDistPct > 0` jedes Below-EMA-Signal und `!!"false"` war truthy →
// alle Scores klebten bei 54. Diese Tests sichern die Korrektur ab.

test('crypto_baseline: signierter (negativer) emaDistPct wird über Magnitude bewertet', () => {
  // |−0.79| = 0.79 → Sweet-Spot (+20). nearSup "true" (+12), nearRes "false" (0).
  const r = scoreCandidate('crypto_baseline', {
    direction: 'LONG', rsi: '34.07', emaDistPct: '-0.7899325815',
    nearSup: 'true', nearRes: 'false', rsiDeadZone: 'false',
  });
  assert.equal(r.details.ema_dist, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.ema_dist_sweet_spot);
  assert.equal(r.score, 82);          // vorher: 54 (ema komplett verworfen)
  assert.ok(r.score >= r.threshold);
});

test('crypto_baseline: String-Booleans korrekt geparst — "false" ist NICHT truthy', () => {
  // SHORT, nearSup "false" (kein Malus), nearRes "true" (+12), |−0.337|<0.5 → too_close (−12).
  const r = scoreCandidate('crypto_baseline', {
    direction: 'SHORT', rsi: '65.47', emaDistPct: '-0.3369177592',
    nearSup: 'false', nearRes: 'true', rsiDeadZone: 'false',
  });
  assert.equal(r.details.near_sup, undefined, 'nearSup "false" darf keinen Effekt haben');
  assert.equal(r.details.near_res, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.near_res_short);
  assert.equal(r.score, 50);
});

test('crypto_baseline: rsiDeadZone als String "true" greift als Malus', () => {
  // |0.52| Sweet-Spot (+20), rsiDeadZone "true" (−15), nearRes "true" (+12) → 67.
  const r = scoreCandidate('crypto_baseline', {
    direction: 'SHORT', rsi: '63.04', emaDistPct: '0.520238653',
    nearSup: 'false', nearRes: 'true', rsiDeadZone: 'true',
  });
  assert.equal(r.details.rsi_dead_zone, CANDIDATE_SCORING_DEFAULTS.crypto_baseline.weights.rsi_dead_zone_penalty);
  assert.equal(r.score, 67);
});

test('crypto_baseline: 10 reale Candidate-Payloads erzeugen sinnvolle Streuung (nicht alle bei 54)', () => {
  const payloads = [
    { direction:'SHORT', rsi:'65.47', emaDistPct:'-0.3369177592', nearSup:'false', nearRes:'true',  rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'30.45', emaDistPct:'-0.1316657777', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'34.07', emaDistPct:'-0.7899325815', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'31.34', emaDistPct:'-0.1302639542', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
    { direction:'SHORT', rsi:'63.04', emaDistPct:'0.520238653',   nearSup:'false', nearRes:'true',  rsiDeadZone:'true'  },
    { direction:'LONG',  rsi:'30.43', emaDistPct:'-1.3665869987', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'32.19', emaDistPct:'-0.6774662072', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'38.71', emaDistPct:'-1.0281079832', nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'36.26', emaDistPct:'-1.352147608',  nearSup:'true',  nearRes:'false', rsiDeadZone:'false' },
    { direction:'LONG',  rsi:'30.49', emaDistPct:'-0.6424644261', nearSup:'true',  nearRes:'true',  rsiDeadZone:'false' },
  ];
  const scores = payloads.map(p => scoreCandidate('crypto_baseline', p).score);
  const spread = Math.max(...scores) - Math.min(...scores);
  // Vorher: alle 54 (eine 74) → Spread 20. Nachher: deutlich breiter.
  assert.ok(spread >= 35, `Streuung zu klein (${spread}) — Rekalibrierung greift nicht`);
  assert.ok(scores.filter(s => s >= 60).length >= 5, 'mind. die Hälfte sollte den Gate passieren');
  assert.ok(scores.some(s => s < 50), 'schwache Setups sollen klar unter 50 landen');
});
