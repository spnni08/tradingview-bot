// index.js — Express-API des WAVESCOUT Score Optimizers (lokaler Modus).
//
//   npm run dev          → Server auf http://localhost:3000
//
// Persistenz: Cloudflare D1 via REST (CF_* in .env) oder In-Memory mit
// JSON-Snapshot in data/store.json. Beim ersten Start wird die mitgelieferte
// Trades-CSV automatisch importiert.

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, MemoryStore } from './storage.js';
import * as api from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const SNAPSHOT = join(DATA_DIR, 'store.json');
const PORT = parseInt(process.env.PORT || '3000', 10);

loadDotEnv();

const store = await createStore(process.env);
if (store.kind === 'memory') {
  console.warn('ℹ️  In-Memory-Modus (keine CF_*-Credentials). Snapshot: data/store.json');
  restoreSnapshot(store);
}
await seedIfEmpty(store);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  }
};

app.get('/', (_req, res) => res.json({ name: 'WAVESCOUT Score Optimizer', storage: store.kind, endpoints: api.ROUTES_OVERVIEW }));
app.get('/health', (_req, res) => res.json({ ok: true, storage: store.kind }));

app.post('/api/import-csv', wrap(async (req, res) => {
  let csvText = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!csvText && req.body?.path) csvText = readFileSync(req.body.path, 'utf8');
  const result = await api.importCsv(store, csvText, String(req.query.type || 'trades'));
  persistSnapshot(store);
  res.json(result);
}));

app.post('/api/calibrate-score', wrap(async (req, res) => {
  const result = await api.calibrateScore(store, req.body || {});
  persistSnapshot(store);
  writeFileSync(join(DATA_DIR, 'formula.json'), JSON.stringify((await store.getCalibration()).formula, null, 2));
  res.json(result);
}));

app.post('/api/evaluate-signal', wrap(async (req, res) => {
  const result = await api.evaluate(store, req.body || {});
  persistSnapshot(store);
  if ((result.vetoes?.length || result.warnings?.length) && process.env.ALERT_WEBHOOK_URL) {
    fireWebhook({ type: 'SIGNAL_EVALUATION', ...result, symbol: req.body?.symbol });
  }
  res.json(result);
}));

app.get('/api/positions-monitor', wrap(async (_req, res) => {
  const result = await api.positionsMonitor(store, monitorOptions());
  if (result.alerts.some(a => a.level === 'HIGH') && process.env.ALERT_WEBHOOK_URL) {
    fireWebhook({ type: 'POSITION_ALERTS', alerts: result.alerts });
  }
  res.json(result);
}));

app.get('/api/report-daily', wrap(async (req, res) => {
  const { body, contentType } = await api.dailyReport(store, { date: req.query.date, format: String(req.query.format || 'json') }, monitorOptions());
  res.set('Content-Type', contentType).send(body);
}));

app.get('/api/rules', wrap(async (_req, res) => res.json(await api.getRules(store))));

app.use((_req, res) => res.status(404).json({ error: 'Unbekannter Endpoint', endpoints: api.ROUTES_OVERVIEW }));

app.listen(PORT, () => console.log(`🚀 WAVESCOUT Score Optimizer auf http://localhost:${PORT} (Storage: ${store.kind})`));

// ── Helpers ────────────────────────────────────────────────────

function monitorOptions() {
  return {
    riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT || '1'),
    maxExposurePct: parseFloat(process.env.MAX_EXPOSURE_PCT || '6'),
    maxOpenPerSymbol: parseInt(process.env.MAX_OPEN_PER_SYMBOL || '2', 10),
  };
}

function loadDotEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function persistSnapshot(s) {
  if (!(s instanceof MemoryStore)) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(s.toJSON()));
  } catch (err) { console.warn('Snapshot konnte nicht gespeichert werden:', err.message); }
}

function restoreSnapshot(s) {
  if (!existsSync(SNAPSHOT)) return;
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    Object.assign(s, MemoryStore.fromJSON(j));
    console.log(`📦 Snapshot geladen: ${s.trades.length} Trades, ${s.positions.length} Positionen`);
  } catch (err) { console.warn('Snapshot defekt, wird ignoriert:', err.message); }
}

async function seedIfEmpty(s) {
  const trades = await s.getTrades();
  if (trades.length) return;
  const tradesCsv = join(DATA_DIR, 'trades-2026-06-11.csv');
  const positionsCsv = join(DATA_DIR, 'open-positions.csv');
  if (existsSync(tradesCsv)) {
    const r = await api.importCsv(s, readFileSync(tradesCsv, 'utf8'), 'trades');
    console.log(`🌱 Auto-Import: ${r.imported} Trades aus data/trades-2026-06-11.csv`);
  }
  if (existsSync(positionsCsv)) {
    const r = await api.importCsv(s, readFileSync(positionsCsv, 'utf8'), 'positions');
    console.log(`🌱 Auto-Import: ${r.imported} offene Positionen aus data/open-positions.csv`);
  }
  persistSnapshot(s);
}

function fireWebhook(payload) {
  fetch(process.env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'wavescout-score-optimizer', at: new Date().toISOString(), ...payload }),
  }).catch(err => console.warn('Alert-Webhook fehlgeschlagen:', err.message));
}
