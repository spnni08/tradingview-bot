// scoring.js — Live-Signal-Evaluator: neue Score-Formel + GO/NO-GO/CAUTION.

import { deriveRules, labelOf, DEFAULT_WEIGHTS } from './rules.js';

export const EVALUATOR_DEFAULTS = {
  maxOpenPerSymbol: 2,      // mehr offene Positionen pro Symbol ⇒ Veto
  duplicateLossWindowMs: 24 * 3600 * 1000, // gleicher Setup-Loss in 24h ⇒ Veto
  clusterWindowMs: 5 * 60 * 1000,          // ≥2 Entries gleiche Richtung in 5min ⇒ Warnung
};

/** Default-Formel (alte Gewichte) — wird durch Kalibrierung ersetzt. */
export function defaultFormula() {
  return {
    version: 'v2-legacy',
    baseScore: 50,
    weights: { ...DEFAULT_WEIGHTS },
    deadRules: [],
    invertedRules: [],
    thresholds: { go: 80, caution: 65 },
    weakBand: { min: 75, max: 85, requireOneOf: ['SESSION_LONDON', 'EMA_DIST_SWEET'] },
    minScore: 0, maxScore: 100,
  };
}

/** Score eines Signals nach gegebener Formel (ohne Kontext-Checks). */
export function scoreSignal(signal, formula) {
  const f = formula || defaultFormula();
  const { keys, reasons, unknown } = deriveRules(signal);
  let score = f.baseScore ?? 50;
  const fired = [];
  keys.forEach((key, i) => {
    const w = f.weights?.[key] ?? DEFAULT_WEIGHTS[key] ?? 0;
    score += w;
    fired.push({ key, label: labelOf(key), reason: reasons[i], weight: w });
  });
  score = Math.max(f.minScore ?? 0, Math.min(f.maxScore ?? 100, Math.round(score)));
  return { score, fired, unknown };
}

const toMs = v => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d.getTime();
};

/**
 * Vollständige Bewertung: Score + Kontext-Checks (Korrelation, Duplikat-Loss).
 *
 * context = {
 *   openPositions: [{symbol, direction, created_at|createdAt}],
 *   recentTrades:  [{symbol, direction, outcome, created_at_readable|created_at}],
 *   now: ms (optional, default Date.now())
 * }
 */
export function evaluateSignal(signal, formula, context = {}, options = {}) {
  const opt = { ...EVALUATOR_DEFAULTS, ...options };
  const f = formula || defaultFormula();
  const warnings = [];
  const vetoes = [];

  // Fehlende Felder → Default-Score mit Warnung (Spec-Anforderung)
  const missing = ['symbol', 'direction'].filter(k => !signal?.[k]);
  if (missing.length) {
    return {
      score: f.baseScore ?? 50,
      recommendation: 'NO-GO',
      reasons: [`Pflichtfelder fehlen: ${missing.join(', ')}`],
      warnings: ['Signal unvollständig – Default-Score vergeben'],
      vetoes: ['MISSING_FIELDS'],
      fired: [],
    };
  }

  const { score, fired, unknown } = scoreSignal(signal, f);
  const firedKeys = new Set(fired.map(x => x.key));
  const now = context.now ?? Date.now();
  const symbol = String(signal.symbol).toUpperCase();
  const direction = String(signal.direction).toUpperCase();

  for (const u of unknown) warnings.push(`Keine Daten: ${u}`);

  // Dead Rules aus der Kalibrierung
  for (const dead of f.deadRules || []) {
    if (firedKeys.has(dead)) warnings.push(`Dead Rule aktiv: ${labelOf(dead)} (historisch < 50% Win-Rate)`);
  }

  // Kontext: offene Positionen
  const open = context.openPositions || [];
  const sameSymbol = open.filter(p => String(p.symbol).toUpperCase() === symbol);
  if (sameSymbol.length >= opt.maxOpenPerSymbol) {
    vetoes.push(`KORRELATION: bereits ${sameSymbol.length} offene Position(en) auf ${symbol} (Limit ${opt.maxOpenPerSymbol})`);
  }
  const cluster = open.filter(p => {
    const ts = toMs(p.created_at ?? p.createdAt);
    return ts != null && String(p.direction).toUpperCase() === direction && Math.abs(now - ts) <= opt.clusterWindowMs;
  });
  if (cluster.length >= 1) {
    warnings.push(`CLUSTER: ${cluster.length} weitere ${direction}-Position(en) in den letzten 5 Minuten eröffnet (${cluster.map(p => p.symbol).join(', ')}) – korrelierter Markt-Move`);
  }

  // Kontext: kürzlich verlorenes identisches Setup
  const recent = context.recentTrades || [];
  const dupLoss = recent.find(t =>
    t.outcome === 'LOSS' &&
    String(t.symbol).toUpperCase() === symbol &&
    String(t.direction).toUpperCase() === direction &&
    (toMs(t.created_at_readable ?? t.created_at) ?? 0) > now - opt.duplicateLossWindowMs
  );
  if (dupLoss) {
    vetoes.push(`DUPLIKAT-SETUP: ${symbol} ${direction} wurde in den letzten 24h bereits verloren (${dupLoss.created_at_readable || dupLoss.created_at})`);
  }

  // Schwaches Score-Band: Zusatzfilter verlangen
  const wb = f.weakBand;
  if (wb && score >= wb.min && score < wb.max) {
    const hasStrong = (wb.requireOneOf || []).some(k => firedKeys.has(k));
    if (!hasStrong) {
      warnings.push(`Score ${score} liegt im historisch schwachen Band ${wb.min}–${wb.max} ohne Stark-Filter (${(wb.requireOneOf || []).map(labelOf).join(' / ')})`);
    }
  }

  // Entscheidung
  let recommendation;
  if (vetoes.length || score < (f.thresholds?.caution ?? 60)) recommendation = 'NO-GO';
  else if (warnings.length || score < (f.thresholds?.go ?? 80)) recommendation = 'CAUTION';
  else recommendation = 'GO';

  const reasons = [
    `Score ${score} (Basis ${f.baseScore}, Formel ${f.version})`,
    ...fired.filter(x => x.weight !== 0).map(x => `${x.weight > 0 ? '+' : ''}${x.weight} ${x.label}`),
  ];
  if (score < (f.thresholds?.caution ?? 60)) reasons.push(`Score unter CAUTION-Schwelle ${(f.thresholds?.caution ?? 60)}`);

  return { score, recommendation, reasons, warnings, vetoes, fired };
}
