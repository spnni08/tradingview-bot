// api.js — Endpoint-Logik, geteilt zwischen Express (index.js) und
// Cloudflare Worker (worker.js). Reine Funktionen über einem Store.

import { parseTradesCsv, parseCsv, normalizeTradeRow } from './csv.js';
import { calibrate, findCombos } from './optimizer.js';
import { evaluateSignal, defaultFormula } from './scoring.js';
import { monitorPositions } from './monitor.js';
import { buildDailyReport, reportToHtml, reportToCsv } from './reports.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** POST /api/import-csv — type: 'trades' (Default) oder 'positions'. */
export async function importCsv(store, csvText, type = 'trades') {
  if (!csvText || !String(csvText).trim()) throw new ApiError(400, 'Leerer CSV-Body');

  if (type === 'positions') {
    const rows = parseCsv(String(csvText)).map(normalizeTradeRow);
    const bad = rows.filter(r => !r.symbol || !r.direction);
    if (bad.length) throw new ApiError(400, `${bad.length} Positions-Zeilen ohne symbol/direction`);
    const n = await store.replacePositions(rows);
    return { imported: n, type: 'positions', stored: true };
  }

  const { trades, errors } = parseTradesCsv(String(csvText));
  if (!trades.length) throw new ApiError(400, `Keine gültigen Trades gefunden. ${errors.join('; ')}`);

  // Offene Zeilen (outcome=OPEN) wandern in den Positions-Store
  const open = trades.filter(t => t.outcome === 'OPEN');
  const closedOrAll = trades.filter(t => t.outcome !== 'OPEN');
  const n = await store.insertTrades(closedOrAll);
  if (open.length) {
    const existing = await store.getPositions();
    await store.replacePositions([...existing, ...open.map(t => ({
      symbol: t.symbol, direction: t.direction, timeframe: t.timeframe,
      entry_price: t.ai_entry ?? t.price, take_profit: t.ai_tp, stop_loss: t.ai_sl,
      created_at: t.created_at_readable,
    }))]);
  }
  return { imported: n, openPositions: open.length, skippedRows: errors.length, errors, stored: store.kind !== 'memory', storage: store.kind };
}

/** POST /api/calibrate-score */
export async function calibrateScore(store, options = {}) {
  const trades = await store.getTrades();
  if (!trades.length) throw new ApiError(409, 'Keine Trades importiert – zuerst POST /api/import-csv');
  const result = calibrate(trades, options);
  const combos = findCombos(trades, { size: 3, minN: 8, top: 10 });
  await store.saveCalibration({ ...result, combos });
  return {
    baseline: result.baseline,
    newWeights: result.formula.weights,
    thresholds: result.formula.thresholds,
    improvement: result.backtest.improvement,
    deadRules: result.rules.filter(r => r.verdict === 'DEAD').map(r => r.label),
    invertedRules: result.rules.filter(r => r.verdict === 'INVERTED').map(r => r.label),
    strongRules: result.rules.filter(r => r.verdict === 'STRONG').map(r => ({ rule: r.label, winRate: r.winRate, n: r.n, weight: r.newWeight })),
    scoreRanges: result.scoreRanges,
    rules: result.rules,
    bestCombos: combos.best.slice(0, 5),
    worstCombos: combos.worst.slice(0, 5),
    recommendations: result.recommendations,
  };
}

/** POST /api/evaluate-signal */
export async function evaluate(store, signal, options = {}) {
  const calibration = await store.getCalibration();
  const formula = calibration?.formula ?? defaultFormula();
  const [positions, trades] = await Promise.all([store.getPositions(), store.getTrades()]);
  const result = evaluateSignal(signal, formula, {
    openPositions: positions,
    recentTrades: trades,
    now: options.now,
  }, options);
  const record = {
    symbol: signal?.symbol, direction: signal?.direction,
    score: result.score, recommendation: result.recommendation,
    reasons: result.reasons, warnings: result.warnings, vetoes: result.vetoes,
    formulaVersion: formula.version,
  };
  await store.logEvaluation(record);
  if (!calibration) result.warnings.push('Noch keine Kalibrierung – Legacy-Formel verwendet (POST /api/calibrate-score)');
  return { ...result, formulaVersion: formula.version };
}

/** GET /api/positions-monitor */
export async function positionsMonitor(store, options = {}) {
  const [positions, trades] = await Promise.all([store.getPositions(), store.getTrades()]);
  return monitorPositions(positions, trades, options);
}

/** GET /api/report-daily?format=json|html|csv&date=YYYY-MM-DD */
export async function dailyReport(store, { date, format = 'json' } = {}, monitorOptions = {}) {
  const [trades, calibration, positions] = await Promise.all([store.getTrades(), store.getCalibration(), store.getPositions()]);
  const monitor = monitorPositions(positions, trades, monitorOptions);
  const report = buildDailyReport({ trades, calibration, monitor, date });
  if (format === 'html') return { body: reportToHtml(report), contentType: 'text/html; charset=utf-8' };
  if (format === 'csv') return { body: reportToCsv(report), contentType: 'text/csv; charset=utf-8' };
  return { body: JSON.stringify(report, null, 2), contentType: 'application/json; charset=utf-8' };
}

/** GET /api/rules */
export async function getRules(store) {
  const calibration = await store.getCalibration();
  if (!calibration) {
    return { active: Object.entries(defaultFormula().weights).map(([key, weight]) => ({ key, weight })), dead: [], suggested: ['POST /api/calibrate-score ausführen, um Regeln aus echten Daten zu kalibrieren'] };
  }
  const rules = calibration.rules || [];
  return {
    active: rules.filter(r => r.verdict !== 'DEAD' && r.n >= 5)
      .sort((a, b) => b.newWeight - a.newWeight)
      .map(r => ({ key: r.key, rule: r.label, winRate: r.winRate, n: r.n, weight: r.newWeight, verdict: r.verdict })),
    dead: rules.filter(r => r.verdict === 'DEAD').map(r => ({ key: r.key, rule: r.label, winRate: r.winRate, n: r.n, weight: r.newWeight })),
    inverted: rules.filter(r => r.verdict === 'INVERTED').map(r => ({ key: r.key, rule: r.label, winRate: r.winRate, n: r.n, weight: r.newWeight })),
    insufficient: rules.filter(r => r.verdict === 'INSUFFICIENT').map(r => ({ key: r.key, rule: r.label, n: r.n })),
    suggested: calibration.recommendations || [],
    bestCombos: calibration.combos?.best?.slice(0, 5) || [],
  };
}

export const ROUTES_OVERVIEW = {
  'POST /api/import-csv': 'CSV importieren (Body: text/csv; ?type=trades|positions)',
  'POST /api/calibrate-score': 'Score-Formel aus importierten Trades neu kalibrieren',
  'POST /api/evaluate-signal': 'Signal bewerten → GO / NO-GO / CAUTION',
  'GET /api/positions-monitor': 'Offene Positionen: Korrelations- & Duplikat-Alerts',
  'GET /api/report-daily': 'Tagesreport (?format=json|html|csv&date=YYYY-MM-DD)',
  'GET /api/rules': 'Aktive / tote / invertierte Regeln + Empfehlungen',
  'GET /health': 'Healthcheck',
};
