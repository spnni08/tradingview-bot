// Smoke-Tests: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, parseTradesCsv, toCsv, normalizeTradeRow } from '../csv.js';
import { normalizeRule, deriveRules, sessionOf } from '../rules.js';
import { calibrate, findCombos, tradeRuleKeys } from '../optimizer.js';
import { evaluateSignal, scoreSignal, defaultFormula } from '../scoring.js';
import { monitorPositions } from '../monitor.js';
import { buildDailyReport, reportToHtml } from '../reports.js';
import { MemoryStore } from '../storage.js';
import * as api from '../api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADES_CSV = readFileSync(join(__dirname, '../data/trades-2026-06-11.csv'), 'utf8');
const POSITIONS_CSV = readFileSync(join(__dirname, '../data/open-positions.csv'), 'utf8');
const { trades } = parseTradesCsv(TRADES_CSV);
const positions = parseCsv(POSITIONS_CSV).map(normalizeTradeRow);

test('CSV-Parser: quoted fields, Umlaute, Pipes', () => {
  const rows = parseCsv('a,b\n"x, y","mit ""Quote"""\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'mit "Quote"' }]);
  const back = toCsv(rows);
  assert.match(back, /"x, y"/);
});

test('Echte Trades-CSV: 102 Trades, 79W/23L', () => {
  assert.equal(trades.length, 102);
  assert.equal(trades.filter(t => t.outcome === 'WIN').length, 79);
  assert.equal(trades.filter(t => t.outcome === 'LOSS').length, 23);
});

test('Regel-Normalisierung: deutsche Strings → kanonische Keys', () => {
  assert.equal(normalizeRule('RSI neutral-niedrig (44)'), 'RSI_NEUTRAL_LOW_LONG');
  assert.equal(normalizeRule('RSI neutral-hoch (58)'), 'RSI_NEUTRAL_HIGH_SHORT');
  assert.equal(normalizeRule('Preis zu nah an EMA 200 (0.32%) – Ausschluss v2.0'), 'EMA200_PROXIMITY_EXCLUSION');
  assert.equal(normalizeRule('EMA bullish (EMA50>EMA200, Dist 0.9%) – LONG'), 'EMA_ALIGNED_LONG');
  assert.equal(normalizeRule('London-Open Session (07-10 UTC) – bevorzugte Zeit'), 'SESSION_LONDON');
  assert.equal(normalizeRule('Preis nah an Resistance – günstig für SHORT'), 'SR_RESISTANCE_NEAR_SHORT');
  assert.equal(normalizeRule('⚠️ 2 HIGH-Impact News aktiv'), 'NEWS_HIGH_IMPACT');
});

test('Session-Ableitung aus Signal-Zeit', () => {
  assert.equal(sessionOf('2026-06-11 07:40:04'), 'LONDON');
  assert.equal(sessionOf('2026-06-11 14:15:09'), 'US');
  assert.equal(sessionOf('2026-06-11 00:20:08'), 'OFF');
});

test('Kalibrierung: EMA200-Paradox wird invertiert, Baseline stimmt', () => {
  const result = calibrate(trades);
  assert.equal(result.baseline.trades, 102);
  assert.equal(result.baseline.winRate, 79 / 102);

  const ema = result.rules.find(r => r.key === 'EMA200_PROXIMITY_EXCLUSION');
  assert.ok(ema, 'EMA200-Regel muss in den Daten vorkommen');
  assert.ok(ema.winRate > 75, `EMA200-Flag-Trades gewinnen überdurchschnittlich (${ema.winRate}%)`);
  assert.equal(ema.verdict, 'INVERTED');
  assert.ok(ema.newWeight >= 5, 'invertiertes Gewicht ≥ +5');

  // Gewichte respektieren die Spec-Clamps
  for (const r of result.rules.filter(r => r.verdict !== 'INSUFFICIENT')) {
    assert.ok(r.newWeight <= 25 && r.newWeight >= -15, `${r.key}: ${r.newWeight} in [-15, 25]`);
  }
});

test('Score-Ranges: 75–85 ist das Schwach-Band', () => {
  const result = calibrate(trades);
  const weak = result.scoreRanges.find(r => r.range === '75–85');
  assert.ok(weak.n > 50, 'Masse der Trades liegt im 75–85-Band');
  assert.ok(weak.winRate < result.scoreRanges.find(r => r.range === '85–95').winRate);
});

test('Kombos: liefert Best/Worst mit Mindest-n', () => {
  const { best, worst } = findCombos(trades, { size: 2, minN: 8 });
  assert.ok(best.length > 0 && worst.length > 0);
  assert.ok(best[0].winRate >= worst[0].winRate);
  for (const c of [...best, ...worst]) assert.ok(c.n >= 8);
});

test('tradeRuleKeys: enthält Session & Features', () => {
  const t = trades.find(t => t.created_at_readable.includes('07:40'));
  const keys = tradeRuleKeys(t);
  assert.ok(keys.includes('SESSION_LONDON'));
});

test('Evaluator: Best-Combo-Signal (London + EMA-Sweet-Spot) schlägt Dead-Zone-Signal', () => {
  const { formula } = calibrate(trades);
  // Historisch stärkstes Setup: LONG, EMA-Distanz 0,5–1,3% + Alignment, London
  const strong = evaluateSignal({
    symbol: 'SOLUSDT', direction: 'LONG', timeframe: '5m',
    rsi: 44, ema50: 65.1, ema200: 64.57, price: 65.09,
    created_at: '2026-06-12 08:00:00',
  }, formula, { openPositions: [], recentTrades: [] });
  // Historisch schwaches Setup: SHORT mit RSI in der 55–65-Neutralzone, US-Session
  const weak = evaluateSignal({
    symbol: 'TRXUSDT', direction: 'SHORT', timeframe: '5m',
    rsi: 58, ema50: 0.3434, ema200: 0.3481, price: 0.3435,
    created_at: '2026-06-12 14:00:00',
  }, formula, { openPositions: [], recentTrades: [] });

  assert.ok(strong.score > weak.score, `strong (${strong.score}) > weak (${weak.score})`);
  assert.ok(strong.score >= formula.thresholds.go, `Score ${strong.score} ≥ GO-Schwelle ${formula.thresholds.go}`);
  assert.equal(strong.vetoes.length, 0);
  assert.ok(['GO', 'CAUTION'].includes(strong.recommendation));
});

test('Evaluator: Duplikat-Loss in 24h → NO-GO (Veto)', () => {
  const { formula } = calibrate(trades);
  const now = new Date('2026-06-11T01:00:00Z').getTime();
  const result = evaluateSignal({
    symbol: 'VIRTUALUSDT', direction: 'SHORT', timeframe: '5m',
    rsi: 70, ema50: 0.543, ema200: 0.553, price: 0.549,
    created_at: '2026-06-11 01:00:00',
  }, formula, { openPositions: [], recentTrades: trades, now });
  assert.equal(result.recommendation, 'NO-GO');
  assert.ok(result.vetoes.some(v => v.includes('DUPLIKAT-SETUP')));
});

test('Evaluator: Symbol-Limit offener Positionen → Veto', () => {
  const result = evaluateSignal({
    symbol: 'VIRTUALUSDT', direction: 'LONG', rsi: 40, ema50: 0.57, ema200: 0.56, price: 0.568, timeframe: '5m',
  }, defaultFormula(), {
    openPositions: [
      { symbol: 'VIRTUALUSDT', direction: 'LONG', created_at: '2026-06-08T22:00:07Z' },
      { symbol: 'VIRTUALUSDT', direction: 'SHORT', created_at: '2026-06-11T00:20:08Z' },
    ],
    recentTrades: [],
  });
  assert.equal(result.recommendation, 'NO-GO');
  assert.ok(result.vetoes.some(v => v.includes('KORRELATION')));
});

test('Evaluator: fehlende Pflichtfelder → Warnung + NO-GO', () => {
  const result = evaluateSignal({ rsi: 50 }, defaultFormula(), {});
  assert.equal(result.recommendation, 'NO-GO');
  assert.ok(result.warnings.length > 0);
});

test('Monitor: erkennt VIRTUAL-Cluster, Geister-Positionen und Exposure', () => {
  const m = monitorPositions(positions, trades, { now: new Date('2026-06-11T12:00:00Z').getTime() });
  assert.equal(m.open, 8);
  const virtual = m.correlations.find(c => c.symbol === 'VIRTUALUSDT');
  assert.equal(virtual.count, 3);
  assert.ok(m.alerts.some(a => a.type === 'SYMBOL_CLUSTER' && a.message.includes('VIRTUALUSDT')));
  // Alle 8 Positionen gehören zu bereits geschlossenen LOSS-Signalen
  const stale = m.alerts.filter(a => a.type === 'STALE_POSITION');
  assert.ok(stale.length >= 6, `mindestens 6 Geister-Positionen erkannt (${stale.length})`);
  assert.ok(m.exposure.current > m.exposure.max);
  assert.ok(m.alerts.some(a => a.type === 'EXPOSURE'));
});

test('Report: JSON + HTML werden generiert', () => {
  const calibration = calibrate(trades);
  const monitor = monitorPositions(positions, trades);
  const report = buildDailyReport({ trades, calibration, monitor, date: '2026-06-11' });
  assert.equal(report.date, '2026-06-11');
  assert.ok(report.today.trades > 0);
  assert.ok(report.recommendations.length > 0);
  const html = reportToHtml(report);
  assert.match(html, /WAVESCOUT/);
  assert.match(html, /Empfehlungen/);
});

test('API-Schicht: import → calibrate → evaluate → rules (in-memory)', async () => {
  const store = new MemoryStore();
  const imp = await api.importCsv(store, TRADES_CSV, 'trades');
  assert.equal(imp.imported, 102);
  await api.importCsv(store, POSITIONS_CSV, 'positions');

  const cal = await api.calibrateScore(store);
  assert.ok(cal.improvement.includes('→'));
  assert.ok(Object.keys(cal.newWeights).length > 10);

  const ev = await api.evaluate(store, { symbol: 'BTCUSDT', direction: 'LONG', rsi: 38, ema50: 63291, ema200: 62926, price: 63027, timeframe: '5m' });
  assert.ok(['GO', 'CAUTION', 'NO-GO'].includes(ev.recommendation));

  const rules = await api.getRules(store);
  assert.ok(rules.active.length > 0);

  const monitor = await api.positionsMonitor(store);
  assert.equal(monitor.open, 8);

  const rep = await api.dailyReport(store, { date: '2026-06-11', format: 'json' });
  assert.ok(JSON.parse(rep.body).today.trades > 0);
});
