// worker.js — Cloudflare-Worker-Variante des Score Optimizers.
//
// Nutzt dieselbe D1-Datenbank wie der Haupt-Worker (Binding DB) und kann
// per POST /api/import-from-signals die echten Trades direkt aus der
// bestehenden `signals`-Tabelle übernehmen — ohne CSV-Umweg.
//
// Deploy:  cd score-optimizer && wrangler deploy

import { D1BindingStore } from './storage.js';
import * as api from './api.js';

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = new D1BindingStore(env.DB);

    try {
      await store.init();

      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ name: 'WAVESCOUT Score Optimizer (Worker)', storage: 'd1-binding', endpoints: { ...api.ROUTES_OVERVIEW, 'POST /api/import-from-signals': 'Trades direkt aus der signals-Tabelle übernehmen' } });
      }

      if (request.method === 'POST' && url.pathname === '/api/import-csv') {
        const text = await request.text();
        let csv = text;
        try { const body = JSON.parse(text); if (body.csv) csv = body.csv; } catch { /* raw CSV body */ }
        return json(await api.importCsv(store, csv, url.searchParams.get('type') || 'trades'));
      }

      // Integration: Trades & offene Positionen direkt aus der bestehenden DB
      if (request.method === 'POST' && url.pathname === '/api/import-from-signals') {
        const rows = await store.query(`
          SELECT symbol, direction, timeframe, outcome, ai_score, signal_quality,
                 rsi, ema50, ema200, trend, wave_bias, price, ai_entry, ai_tp, ai_sl,
                 exit_price, pnl_pct,
                 datetime(created_at/1000,'unixepoch') AS created_at_readable,
                 matched_rules, failed_rules
          FROM signals WHERE outcome IN ('WIN','LOSS') ORDER BY created_at ASC`, []);
        await store.clearTrades();
        const imported = await store.insertTrades(rows);
        const open = await store.query(`
          SELECT id, symbol, direction, timeframe, entry_price, take_profit, stop_loss, created_at
          FROM practice_trades WHERE status = 'OPEN'`, []);
        await store.replacePositions(open);
        return json({ imported, openPositions: open.length, source: 'signals + practice_trades' });
      }

      if (request.method === 'POST' && url.pathname === '/api/calibrate-score') {
        const result = await api.calibrateScore(store, {});
        if (env.RULES_KV) await env.RULES_KV.put('latest-formula', JSON.stringify((await store.getCalibration()).formula));
        return json(result);
      }

      if (request.method === 'POST' && url.pathname === '/api/evaluate-signal') {
        const signal = await request.json().catch(() => ({}));
        const result = await api.evaluate(store, signal);
        if (env.RULES_KV) await env.RULES_KV.put(`eval:${signal.symbol}:${Date.now()}`, JSON.stringify(result), { expirationTtl: 86400 });
        return json(result);
      }

      if (request.method === 'GET' && url.pathname === '/api/positions-monitor') {
        return json(await api.positionsMonitor(store));
      }

      if (request.method === 'GET' && url.pathname === '/api/report-daily') {
        const { body, contentType } = await api.dailyReport(store, {
          date: url.searchParams.get('date') || undefined,
          format: url.searchParams.get('format') || 'json',
        });
        return new Response(body, { headers: { 'Content-Type': contentType } });
      }

      if (request.method === 'GET' && url.pathname === '/api/rules') {
        return json(await api.getRules(store));
      }

      return json({ error: 'Unbekannter Endpoint', endpoints: api.ROUTES_OVERVIEW }, 404);
    } catch (err) {
      return json({ error: err.message }, err.status || 500);
    }
  },
};
