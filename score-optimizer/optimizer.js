// optimizer.js — Score-Kalibrierung & Regel-Kombinations-Analyse.
//
// Methodik:
//  1. Für jede kanonische Regel (aus matched_rules ∪ failed_rules) und jedes
//     abgeleitete Feature: Wins/Losses zählen → Win-Rate.
//  2. Laplace-Smoothing ((wins+1)/(n+2)) gegen Kleinstichproben-Ausreißer.
//  3. Neues Gewicht = (geglättete WR − Baseline-WR) × Faktor,
//     geclampt auf [-15, +25] (Spec: Stark-Rules max ±25, Dead-Rules max −15).
//  4. Regeln mit n < minSample behalten ihr altes Gewicht (INSUFFICIENT).
//  5. EMA200-Proximity-Paradox: performt die Ausschluss-Regel BESSER als die
//     Baseline, wird sie invertiert (Empfehlung: Grenzwert 0,5% → 0,1% senken
//     oder Regel streichen).

import { normalizeRule, parseRuleList, deriveFeatures, labelOf, DEFAULT_WEIGHTS, sessionOf } from './rules.js';
import { scoreSignal } from './scoring.js';

export const CALIBRATION_DEFAULTS = {
  minSample: 5,        // Mindest-Trades pro Regel für ein neues Gewicht
  factor: 80,          // Punktegewicht pro 1.0 Win-Rate-Lift
  maxWeight: 25,       // Spec: Stark-Rules bis ±25
  minWeight: -15,      // Spec: Dead-Rules bis −15
  deadThreshold: 0.50, // WR unter Baseline−Schwelle UND absolut < 50% ⇒ DEAD-Kandidat
  strongLift: 0.06,    // Lift über Baseline ⇒ STRONG
  targetWinRate: 0.85, // Ziel-WR für die GO-Schwelle
  ubiquityCutoff: 0.9, // Regeln, die bei >90% aller Trades feuern, fliegen aus den Kombos
};

const isWin = t => t.outcome === 'WIN';
const isClosed = t => t.outcome === 'WIN' || t.outcome === 'LOSS';

/** Kanonische Regel-Keys + Features eines historischen Trades. */
export function tradeRuleKeys(t) {
  const keys = new Set();
  for (const raw of parseRuleList(t.matched_rules)) keys.add(normalizeRule(raw));
  for (const raw of parseRuleList(t.failed_rules)) keys.add(normalizeRule(raw));
  for (const f of deriveFeatures(t)) keys.add(f);
  const session = sessionOf(t.created_at_readable || t.created_at);
  // Session-Keys ergänzen, falls der Regel-String fehlt (Worker bewertet
  // Sessions zur Verarbeitungszeit — bei Backfills kann er fehlen)
  if (session === 'LONDON') keys.add('SESSION_LONDON');
  if (session === 'US') keys.add('SESSION_US');
  keys.delete(null);
  return [...keys];
}

/** Win/Loss-Statistik pro Regel-Key über alle geschlossenen Trades. */
export function analyzeRules(trades) {
  const closed = trades.filter(isClosed);
  const stats = new Map();
  for (const t of closed) {
    for (const key of tradeRuleKeys(t)) {
      if (!stats.has(key)) stats.set(key, { key, wins: 0, losses: 0 });
      const s = stats.get(key);
      if (isWin(t)) s.wins++; else s.losses++;
    }
  }
  for (const s of stats.values()) {
    s.n = s.wins + s.losses;
    s.winRate = s.n ? s.wins / s.n : 0;
  }
  return stats;
}

/** Win-Rates pro Score-Range (alte Formel). */
export function scoreRangeStats(trades) {
  const ranges = [
    { range: '0–60', min: 0, max: 60 },
    { range: '60–75', min: 60, max: 75 },
    { range: '75–85', min: 75, max: 85 },
    { range: '85–95', min: 85, max: 95 },
    { range: '95+', min: 95, max: 101 },
  ];
  for (const r of ranges) { r.wins = 0; r.losses = 0; }
  for (const t of trades.filter(isClosed)) {
    const sc = t.ai_score ?? 0;
    const r = ranges.find(r => sc >= r.min && sc < r.max);
    if (r) { if (isWin(t)) r.wins++; else r.losses++; }
  }
  return ranges.map(r => ({
    range: r.range, wins: r.wins, losses: r.losses, n: r.wins + r.losses,
    winRate: r.wins + r.losses ? +(100 * r.wins / (r.wins + r.losses)).toFixed(1) : null,
  }));
}

/**
 * Kern: Kalibriert die Score-Formel aus echten Trades.
 * Liefert { baseline, rules, scoreRanges, formula, backtest, recommendations }.
 */
export function calibrate(trades, options = {}) {
  const opt = { ...CALIBRATION_DEFAULTS, ...options };
  const closed = trades.filter(isClosed);
  if (!closed.length) throw new Error('Kalibrierung: keine geschlossenen Trades (WIN/LOSS) vorhanden');

  const wins = closed.filter(isWin).length;
  const baseline = {
    trades: closed.length, wins, losses: closed.length - wins,
    winRate: wins / closed.length,
    winRatePct: +(100 * wins / closed.length).toFixed(1),
  };

  const stats = analyzeRules(trades);
  const rules = [];
  const weights = { ...DEFAULT_WEIGHTS };
  const deadRules = [];
  const invertedRules = [];

  for (const s of [...stats.values()].sort((a, b) => b.n - a.n)) {
    const smoothed = (s.wins + 1) / (s.n + 2);
    const lift = smoothed - baseline.winRate;
    const oldWeight = DEFAULT_WEIGHTS[s.key] ?? 0;
    let newWeight, verdict;

    if (s.n < opt.minSample) {
      newWeight = oldWeight;
      verdict = 'INSUFFICIENT';
    } else {
      newWeight = Math.max(opt.minWeight, Math.min(opt.maxWeight, Math.round(lift * opt.factor)));
      if (s.winRate < opt.deadThreshold && lift < -0.10) {
        verdict = 'DEAD';
        deadRules.push(s.key);
        newWeight = Math.max(opt.minWeight, Math.min(newWeight, -8));
      } else if (lift >= opt.strongLift) verdict = 'STRONG';
      else if (lift <= -opt.strongLift) verdict = 'WEAK';
      else verdict = 'NEUTRAL';

      // EMA200-Paradox: Ausschluss-Regel performt besser als Baseline ⇒ invertieren
      if (s.key === 'EMA200_PROXIMITY_EXCLUSION' && lift > 0) {
        newWeight = Math.max(newWeight, 5);
        verdict = 'INVERTED';
        invertedRules.push(s.key);
      }
    }

    weights[s.key] = newWeight;
    rules.push({
      key: s.key, label: labelOf(s.key),
      n: s.n, wins: s.wins, losses: s.losses,
      winRate: +(100 * s.winRate).toFixed(1),
      smoothedWinRate: +(100 * smoothed).toFixed(1),
      lift: +(100 * lift).toFixed(1),
      oldWeight, newWeight, verdict,
    });
  }

  const scoreRanges = scoreRangeStats(trades);

  // Formel zusammenstellen + Schwellen aus Backtest ableiten
  const formula = {
    version: 'v3-calibrated',
    generatedAt: new Date().toISOString(),
    baseScore: 50,
    weights,
    deadRules,
    invertedRules,
    thresholds: { go: 75, caution: 60 }, // wird unten aus dem Backtest ersetzt
    weakBand: null,                      // wird unten relativ zur GO-Schwelle gesetzt
    minScore: 0, maxScore: 100,
  };

  const backtest = backtestFormula(trades, formula, opt);
  formula.thresholds = backtest.suggestedThresholds;
  // Signale knapp über GO brauchen einen der Stark-Filter, sonst nur CAUTION
  formula.weakBand = {
    min: formula.thresholds.go, max: formula.thresholds.go + 8,
    requireOneOf: ['SESSION_LONDON', 'EMA_DIST_SWEET'],
  };

  const recommendations = buildRecommendations(rules, baseline, scoreRanges, backtest);

  return { baseline, rules, scoreRanges, formula, backtest, recommendations };
}

/**
 * Wendet die neue Formel auf historische Trades an und sucht die GO-Schwelle,
 * die die Ziel-Win-Rate erreicht, ohne zu viele Trades zu verwerfen.
 */
export function backtestFormula(trades, formula, opt = CALIBRATION_DEFAULTS) {
  const closed = trades.filter(isClosed);
  const scored = closed.map(t => ({
    t,
    score: scoreSignal({ ...t, created_at: t.created_at_readable || t.created_at }, formula).score,
  }));

  const curve = [];
  for (let th = 50; th <= 96; th += 2) {
    const kept = scored.filter(s => s.score >= th);
    const w = kept.filter(s => isWin(s.t)).length;
    curve.push({
      threshold: th, kept: kept.length,
      keptPct: +(100 * kept.length / scored.length).toFixed(1),
      winRate: kept.length ? +(100 * w / kept.length).toFixed(1) : null,
    });
  }

  // kleinste Schwelle mit Ziel-WR und ≥30% behaltenen Trades; sonst beste WR
  const target = 100 * (opt.targetWinRate ?? 0.85);
  let goRow = curve.find(c => c.winRate != null && c.winRate >= target && c.keptPct >= 30);
  if (!goRow) goRow = [...curve].filter(c => c.winRate != null && c.keptPct >= 30).sort((a, b) => b.winRate - a.winRate)[0] || curve[0];

  const baseWr = +(100 * closed.filter(isWin).length / closed.length).toFixed(1);
  return {
    oldWinRateAll: baseWr,
    newWinRateAtGo: goRow.winRate,
    keptAtGo: goRow.kept,
    keptPctAtGo: goRow.keptPct,
    suggestedThresholds: { go: goRow.threshold, caution: Math.max(50, goRow.threshold - 15) },
    thresholdCurve: curve,
    improvement: `${baseWr}% → ${goRow.winRate}% (bei Score ≥ ${goRow.threshold}, ${goRow.keptPct}% der Signale)`,
  };
}

/**
 * Regel-Kombinationen (Paare/Tripel) nach Win-Rate ranken.
 * Nur Kombos mit ausreichend Trades (minN).
 */
export function findCombos(trades, { size = 2, minN = 8, top = 15, ubiquityCutoff = CALIBRATION_DEFAULTS.ubiquityCutoff } = {}) {
  const closed = trades.filter(isClosed);
  const all = closed.map(t => tradeRuleKeys(t).filter(k => !k.startsWith('RAW:')));
  // Allgegenwärtige Regeln (z. B. "Timeframe 5min" bei 100% der Trades) tragen
  // keine Information und blähen die Kombo-Liste nur auf.
  const coverage = new Map();
  for (const keys of all) for (const k of keys) coverage.set(k, (coverage.get(k) || 0) + 1);
  const informative = k => (coverage.get(k) || 0) / closed.length <= ubiquityCutoff;
  const perTrade = closed.map((t, i) => ({ keys: all[i].filter(informative), win: isWin(t) }));
  const combos = new Map();

  const addCombo = (keys, win) => {
    const id = keys.join(' + ');
    if (!combos.has(id)) combos.set(id, { keys, wins: 0, losses: 0 });
    const c = combos.get(id);
    if (win) c.wins++; else c.losses++;
  };

  for (const { keys, win } of perTrade) {
    const sorted = [...keys].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (size >= 2) addCombo([sorted[i], sorted[j]], win);
        if (size >= 3) {
          for (let k = j + 1; k < sorted.length; k++) addCombo([sorted[i], sorted[j], sorted[k]], win);
        }
      }
    }
  }

  const rows = [...combos.values()]
    .map(c => ({ ...c, n: c.wins + c.losses, winRate: +(100 * c.wins / (c.wins + c.losses)).toFixed(1) }))
    .filter(c => c.n >= minN);

  const best = [...rows].sort((a, b) => b.winRate - a.winRate || b.n - a.n).slice(0, top)
    .map(c => ({ combo: c.keys.map(labelOf).join(' + '), keys: c.keys, n: c.n, wins: c.wins, losses: c.losses, winRate: c.winRate }));
  const worst = [...rows].sort((a, b) => a.winRate - b.winRate || b.n - a.n).slice(0, top)
    .map(c => ({ combo: c.keys.map(labelOf).join(' + '), keys: c.keys, n: c.n, wins: c.wins, losses: c.losses, winRate: c.winRate }));

  return { best, worst, totalCombos: rows.length };
}

function buildRecommendations(rules, baseline, scoreRanges, backtest) {
  const recs = [];
  const byKey = Object.fromEntries(rules.map(r => [r.key, r]));

  const ema = byKey.EMA200_PROXIMITY_EXCLUSION;
  if (ema && ema.verdict === 'INVERTED') {
    recs.push(`EMA200-Ausschluss-Regel invertieren oder streichen: Trades MIT diesem Flag gewinnen ${ema.winRate}% (Baseline ${(baseline.winRate * 100).toFixed(1)}%). Alternativ Grenzwert von 0,5% auf 0,1% senken. Neues Gewicht: ${ema.newWeight >= 0 ? '+' : ''}${ema.newWeight}.`);
  }
  const rsiZone = byKey.RSI_55_65;
  if (rsiZone && rsiZone.n >= 5 && rsiZone.lift < 0) {
    recs.push(`RSI 55–65 (Neutralzone) abwerten: Win-Rate ${rsiZone.winRate}% bei n=${rsiZone.n} (Lift ${rsiZone.lift}%). Neues Gewicht: ${rsiZone.newWeight}.`);
  }
  for (const r of rules.filter(r => r.verdict === 'DEAD')) {
    recs.push(`DEAD RULE blocken: "${r.label}" — Win-Rate ${r.winRate}% bei n=${r.n}. Gewicht ${r.newWeight}.`);
  }
  for (const r of rules.filter(r => r.verdict === 'STRONG').slice(0, 5)) {
    recs.push(`STRONG: "${r.label}" — Win-Rate ${r.winRate}% bei n=${r.n} (+${r.lift}% Lift). Gewicht +${r.newWeight}.`);
  }
  const weak = scoreRanges.find(r => r.range === '75–85');
  if (weak && weak.winRate != null && weak.winRate < 100 * baseline.winRate) {
    recs.push(`Score-Band 75–85 ist die Schwachstelle (${weak.winRate}% bei n=${weak.n}): Signale in diesem Band nur mit Zusatzfilter (London-Session oder EMA-Sweet-Spot) ausführen.`);
  }
  recs.push(`Neue GO-Schwelle: Score ≥ ${backtest.suggestedThresholds.go} ⇒ ${backtest.improvement}`);
  return recs;
}
