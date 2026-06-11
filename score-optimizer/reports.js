// reports.js — Täglicher Report als JSON, HTML (Email-tauglich) und CSV.

import { toCsv } from './csv.js';

const dayOf = v => {
  const s = String(v || '');
  return s.slice(0, 10);
};

/** Baut den Tagesreport aus Trades, Kalibrierung und Monitor-Ergebnis. */
export function buildDailyReport({ trades = [], calibration = null, monitor = null, date = null }) {
  const day = date || new Date().toISOString().slice(0, 10);
  const closed = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  const todays = closed.filter(t => dayOf(t.created_at_readable || t.created_at) === day);
  const wins = todays.filter(t => t.outcome === 'WIN').length;
  const allWins = closed.filter(t => t.outcome === 'WIN').length;

  const report = {
    date: day,
    generatedAt: new Date().toISOString(),
    today: {
      trades: todays.length, wins, losses: todays.length - wins,
      winRate: todays.length ? +(100 * wins / todays.length).toFixed(1) : null,
      pnlPct: +todays.reduce((s, t) => s + (t.pnl_pct || 0), 0).toFixed(2),
    },
    total: {
      trades: closed.length, wins: allWins, losses: closed.length - allWins,
      winRate: closed.length ? +(100 * allWins / closed.length).toFixed(1) : null,
    },
    comparison: calibration ? {
      oldFormula: { description: 'v2.0 (statische Gewichte)', winRateAll: calibration.backtest.oldWinRateAll },
      newFormula: {
        description: `${calibration.formula.version} (GO ≥ ${calibration.formula.thresholds.go})`,
        winRateAtGo: calibration.backtest.newWinRateAtGo,
        keptPct: calibration.backtest.keptPctAtGo,
      },
      improvement: calibration.backtest.improvement,
    } : null,
    topProblems: calibration
      ? calibration.rules
          .filter(r => r.n >= 5 && r.lift < 0)
          .sort((a, b) => a.lift - b.lift)
          .slice(0, 3)
          .map(r => ({ rule: r.label, winRate: r.winRate, n: r.n, lift: r.lift, newWeight: r.newWeight }))
      : [],
    recommendations: calibration ? calibration.recommendations : [],
    positions: monitor || null,
    todaysTrades: todays.map(t => ({
      symbol: t.symbol, direction: t.direction, outcome: t.outcome,
      score: t.ai_score, rsi: t.rsi, pnl_pct: t.pnl_pct, time: t.created_at_readable,
    })),
  };
  return report;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function reportToHtml(r) {
  const badge = (v, good) => `<span style="font-weight:700;color:${good ? '#10b981' : '#f04f4f'}">${esc(v)}</span>`;
  const alertColor = { HIGH: '#f04f4f', MEDIUM: '#f59e0b', LOW: '#64748b' };
  const rows = (r.todaysTrades || []).map(t => `
    <tr>
      <td>${esc(t.time)}</td><td>${esc(t.symbol)}</td><td>${esc(t.direction)}</td>
      <td style="color:${t.outcome === 'WIN' ? '#10b981' : '#f04f4f'};font-weight:700">${esc(t.outcome)}</td>
      <td align="right">${esc(t.score)}</td><td align="right">${t.pnl_pct > 0 ? '+' : ''}${esc(t.pnl_pct)}%</td>
    </tr>`).join('');
  const problems = (r.topProblems || []).map(p =>
    `<li><b>${esc(p.rule)}</b> — Win-Rate ${esc(p.winRate)}% (n=${esc(p.n)}, Lift ${esc(p.lift)}%) → neues Gewicht ${esc(p.newWeight)}</li>`).join('');
  const recs = (r.recommendations || []).map(x => `<li>${esc(x)}</li>`).join('');
  const alerts = (r.positions?.alerts || []).map(a =>
    `<li style="color:${alertColor[a.level] || '#64748b'}"><b>[${esc(a.level)}] ${esc(a.type)}</b>: ${esc(a.message)}</li>`).join('');

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>WAVESCOUT Daily Report ${esc(r.date)}</title></head>
<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;max-width:860px;margin:auto">
  <h1 style="margin:0 0 4px">WAVESCOUT Score Optimizer — Tagesreport</h1>
  <div style="color:#94a3b8;margin-bottom:24px">${esc(r.date)} · generiert ${esc(r.generatedAt)}</div>

  <h2>Heutige Performance</h2>
  <p>Trades: <b>${esc(r.today.trades)}</b> · Win-Rate: ${badge(r.today.winRate != null ? r.today.winRate + '%' : '–', (r.today.winRate ?? 0) >= 70)}
     · PnL: ${badge((r.today.pnlPct > 0 ? '+' : '') + r.today.pnlPct + '%', r.today.pnlPct >= 0)}</p>
  <p style="color:#94a3b8">Gesamt: ${esc(r.total.trades)} Trades, ${esc(r.total.winRate)}% Win-Rate (${esc(r.total.wins)}W/${esc(r.total.losses)}L)</p>

  ${r.comparison ? `<h2>Alte vs. neue Formel</h2>
  <p>${esc(r.comparison.oldFormula.description)}: <b>${esc(r.comparison.oldFormula.winRateAll)}%</b> →
     ${esc(r.comparison.newFormula.description)}: <b style="color:#10b981">${esc(r.comparison.newFormula.winRateAtGo)}%</b>
     (behält ${esc(r.comparison.newFormula.keptPct)}% der Signale)</p>` : ''}

  ${problems ? `<h2>Top-Problem-Regeln</h2><ul>${problems}</ul>` : ''}
  ${alerts ? `<h2>Positions-Alerts</h2><ul>${alerts}</ul>` : ''}
  ${recs ? `<h2>Empfehlungen</h2><ul>${recs}</ul>` : ''}

  ${rows ? `<h2>Heutige Trades</h2>
  <table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="color:#94a3b8;text-align:left"><th>Zeit</th><th>Symbol</th><th>Richtung</th><th>Outcome</th><th align="right">Score</th><th align="right">PnL</th></tr>
    ${rows}
  </table>` : '<p>Keine geschlossenen Trades heute.</p>'}
</body></html>`;
}

export function reportToCsv(r) {
  const rows = (r.todaysTrades || []).map(t => ({ date: r.date, ...t }));
  if (!rows.length) return 'date,symbol,direction,outcome,score,rsi,pnl_pct,time\n';
  return toCsv(rows);
}
