// monitor.js — Position-Monitor: Korrelations-Risiken, Duplikat-Setups,
// Geister-Positionen (offen, obwohl das zugehörige Signal längst geschlossen ist)
// und Exposure-Check.

export const MONITOR_DEFAULTS = {
  maxOpenPerSymbol: 2,
  riskPerTradePct: 1,     // SL-Risiko pro Position in % des Kapitals
  maxExposurePct: 6,      // Alarm, wenn Summe der offenen Risiken darüber liegt
  duplicateLossWindowMs: 24 * 3600 * 1000,
  clusterWindowMs: 5 * 60 * 1000,
  staleMatchWindowMs: 2 * 60 * 1000, // Position ↔ Signal gelten als identisch, wenn Entry-Zeit ≤2min auseinander
};

const toMs = v => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d.getTime();
};

/**
 * positions: [{id?, symbol, direction, entry_price?, created_at}]
 * trades:    geschlossene Trades (für Duplikat-/Geister-Checks)
 */
export function monitorPositions(positions, trades = [], options = {}) {
  const opt = { ...MONITOR_DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const alerts = [];
  const open = positions || [];

  // 1) Symbol-Clustering
  const bySymbol = {};
  for (const p of open) {
    const sym = String(p.symbol).toUpperCase();
    bySymbol[sym] = (bySymbol[sym] || 0) + 1;
  }
  const correlations = Object.entries(bySymbol)
    .filter(([, n]) => n > 1)
    .map(([symbol, count]) => ({ symbol, count }));
  for (const { symbol, count } of correlations) {
    if (count > opt.maxOpenPerSymbol) {
      alerts.push({ level: 'HIGH', type: 'SYMBOL_CLUSTER', message: `${symbol}: ${count} offene Positionen – Korrelations-Risiko! (Limit ${opt.maxOpenPerSymbol})` });
    }
  }

  // 2) Richtungs-Cluster: mehrere Entries gleicher Richtung im selben Zeitfenster
  const sorted = [...open].map(p => ({ ...p, _ts: toMs(p.created_at ?? p.createdAt) })).filter(p => p._ts != null).sort((a, b) => a._ts - b._ts);
  for (let i = 0; i < sorted.length; i++) {
    const group = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]._ts - sorted[i]._ts <= opt.clusterWindowMs &&
          String(sorted[j].direction).toUpperCase() === String(sorted[i].direction).toUpperCase() &&
          sorted[j].symbol !== sorted[i].symbol) {
        group.push(sorted[j]);
      }
    }
    if (group.length >= 2) {
      alerts.push({
        level: 'MEDIUM', type: 'SIMULTANEOUS_ENTRIES',
        message: `${group.map(p => `${p.symbol} ${p.direction}`).join(' + ')} innerhalb von 5min eröffnet – ein Markt-Move kann alle gleichzeitig ausstoppen`,
      });
      i += group.length - 1;
    }
  }

  // 3) Geister-Positionen & Duplikat-Loss-Setups
  const closed = (trades || []).filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  for (const p of open) {
    const sym = String(p.symbol).toUpperCase();
    const dir = String(p.direction).toUpperCase();
    const pTs = toMs(p.created_at ?? p.createdAt);

    // Geist: geschlossener Trade mit identischem Setup & nahezu identischer Entry-Zeit
    const ghost = closed.find(t =>
      String(t.symbol).toUpperCase() === sym &&
      String(t.direction).toUpperCase() === dir &&
      pTs != null &&
      Math.abs((toMs(t.created_at_readable ?? t.created_at) ?? 0) - pTs) <= opt.staleMatchWindowMs
    );
    if (ghost) {
      alerts.push({
        level: 'HIGH', type: 'STALE_POSITION',
        message: `${sym} ${dir} (Entry ${p.created_at}) steht noch auf OPEN, aber das zugehörige Signal wurde bereits als ${ghost.outcome} geschlossen (${ghost.pnl_pct > 0 ? '+' : ''}${ghost.pnl_pct}%) – Position schließen/synchronisieren!`,
      });
      continue; // Geister nicht zusätzlich als Duplikat melden
    }

    const dupLoss = closed.find(t =>
      t.outcome === 'LOSS' &&
      String(t.symbol).toUpperCase() === sym &&
      String(t.direction).toUpperCase() === dir &&
      (toMs(t.created_at_readable ?? t.created_at) ?? 0) > now - opt.duplicateLossWindowMs
    );
    if (dupLoss) {
      alerts.push({
        level: 'MEDIUM', type: 'DUPLICATE_LOSS_SETUP',
        message: `${sym} ${dir} ist offen, aber dasselbe Setup wurde vor Kurzem verloren (${dupLoss.created_at_readable || dupLoss.created_at})`,
      });
    }
  }

  // 4) Exposure
  const exposurePct = +(open.length * opt.riskPerTradePct).toFixed(2);
  if (exposurePct > opt.maxExposurePct) {
    alerts.push({
      level: 'HIGH', type: 'EXPOSURE',
      message: `Gesamt-Exposure ${exposurePct}% (${open.length} Positionen × ${opt.riskPerTradePct}% Risiko) über Limit ${opt.maxExposurePct}%`,
    });
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return {
    open: open.length,
    bySymbol,
    correlations,
    exposure: { current: exposurePct, max: opt.maxExposurePct, riskPerTradePct: opt.riskPerTradePct },
    alerts,
  };
}
