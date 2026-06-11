#!/usr/bin/env node
// cli.js — Offline-Nutzung ohne Server:
//   node cli.js calibrate data/trades-2026-06-11.csv
//   node cli.js report    data/trades-2026-06-11.csv data/open-positions.csv
//   node cli.js evaluate  '{"symbol":"SOLUSDT","direction":"LONG","rsi":41,...}'

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTradesCsv, parseCsv, normalizeTradeRow } from './csv.js';
import { calibrate, findCombos } from './optimizer.js';
import { evaluateSignal, defaultFormula } from './scoring.js';
import { monitorPositions } from './monitor.js';
import { buildDailyReport, reportToHtml, reportToCsv } from './reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [cmd, ...args] = process.argv.slice(2);

const loadTrades = file => {
  const { trades, errors } = parseTradesCsv(readFileSync(file, 'utf8'));
  if (errors.length) console.warn(`⚠️  ${errors.length} Zeilen übersprungen:`, errors.slice(0, 3).join('; '));
  return trades;
};

const fmtWeight = w => (w >= 0 ? `+${w}` : `${w}`);

if (cmd === 'calibrate') {
  const trades = loadTrades(args[0] || join(__dirname, 'data/trades-2026-06-11.csv'));
  const result = calibrate(trades);
  const combos = findCombos(trades, { size: 3, minN: 8, top: 8 });

  console.log(`\n━━━ WAVESCOUT Score-Kalibrierung ━━━`);
  console.log(`Baseline: ${result.baseline.trades} Trades, ${(result.baseline.winRate * 100).toFixed(1)}% Win-Rate (${result.baseline.wins}W/${result.baseline.losses}L)\n`);

  console.log('Score-Ranges (alte Formel):');
  for (const r of result.scoreRanges) console.log(`  ${r.range.padEnd(6)} ${String(r.wins).padStart(3)}W/${String(r.losses).padEnd(3)}L  ${r.winRate ?? '–'}%`);

  console.log('\nRegel-Ranking (n ≥ 5):');
  for (const r of result.rules.filter(r => r.n >= 5)) {
    console.log(`  ${r.verdict.padEnd(12)} ${String(r.winRate).padStart(5)}% (n=${String(r.n).padStart(3)})  ${fmtWeight(r.oldWeight).padStart(4)} → ${fmtWeight(r.newWeight).padStart(4)}  ${r.label}`);
  }

  console.log('\nBeste Kombos:');
  for (const c of combos.best.slice(0, 5)) console.log(`  ${c.winRate}% (n=${c.n})  ${c.combo}`);
  console.log('\nSchlechteste Kombos:');
  for (const c of combos.worst.slice(0, 5)) console.log(`  ${c.winRate}% (n=${c.n})  ${c.combo}`);

  console.log('\nEmpfehlungen:');
  for (const rec of result.recommendations) console.log(`  • ${rec}`);

  console.log('\nSchwellen-Kurve (neue Formel):');
  for (const c of result.backtest.thresholdCurve) console.log(`  Score ≥ ${c.threshold}: ${c.winRate ?? '–'}% Win-Rate, ${c.kept} Trades (${c.keptPct}%)`);

  const out = join(__dirname, 'data/formula.json');
  writeFileSync(out, JSON.stringify(result.formula, null, 2));
  console.log(`\n💾 Neue Formel gespeichert: ${out}`);
} else if (cmd === 'report') {
  const trades = loadTrades(args[0] || join(__dirname, 'data/trades-2026-06-11.csv'));
  const positions = args[1] ? parseCsv(readFileSync(args[1], 'utf8')).map(normalizeTradeRow) : [];
  const calibration = calibrate(trades);
  const monitor = monitorPositions(positions, trades);
  const date = args[2] || trades.at(-1)?.created_at_readable?.slice(0, 10);
  const report = buildDailyReport({ trades, calibration, monitor, date });

  const dir = join(__dirname, 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `report-${report.date}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, `report-${report.date}.html`), reportToHtml(report));
  writeFileSync(join(dir, `report-${report.date}.csv`), reportToCsv(report));
  console.log(`📄 Reports geschrieben: reports/report-${report.date}.{json,html,csv}`);
  console.log(`   Heute: ${report.today.trades} Trades, ${report.today.winRate ?? '–'}% WR · Gesamt: ${report.total.winRate}%`);
  for (const a of monitor.alerts) console.log(`   [${a.level}] ${a.type}: ${a.message}`);
} else if (cmd === 'evaluate') {
  const signal = JSON.parse(args[0] || '{}');
  let formula = defaultFormula();
  try { formula = JSON.parse(readFileSync(join(__dirname, 'data/formula.json'), 'utf8')); } catch { /* legacy */ }
  const result = evaluateSignal(signal, formula);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('Usage: node cli.js calibrate|report|evaluate [args]');
  process.exit(1);
}
