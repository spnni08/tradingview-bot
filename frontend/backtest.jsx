// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.5 - BACKTESTING & STRATEGIE-LABOR
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useRef } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ─── Strategy config metadata (mirrors worker.js) ─────────────

const RULE_META = {
  rsi:                { label: 'RSI',                desc: 'Relative Strength Index',        maxW: 30 },
  ema:                { label: 'EMA 50/200',          desc: 'EMA-Kreuzung als Trendfilter',   maxW: 30 },
  trend:              { label: 'Trend-Label',         desc: 'BULLISH/BEARISH Bestätigung',    maxW: 30 },
  wave_bias:          { label: 'Wave Bias',           desc: 'LONG/SHORT Wellenrichtung',      maxW: 20 },
  support_resistance: { label: 'Support/Resistance',  desc: 'Nähe zu S/R-Niveaus',            maxW: 30 },
  timeframe:          { label: 'Timeframe',           desc: 'Höhere TFs werden bevorzugt',    maxW: 20 },
  confidence:         { label: 'Confidence',          desc: 'Signal-Konfidenz vom Sender',    maxW: 20 },
};

const LOSS_REASONS = [
  'RSI Fehlsignal', 'EMA zu spät', 'Trend falsch erkannt', 'Support/Resistance falsch',
  'Seitwärtsmarkt', 'SL zu eng', 'TP zu weit', 'News/Volatilität',
  'Signal zu spät', 'Kein 1H/4H Kontext', 'Manuell geschlossen', 'Sonstiges',
];

// ─── Helpers ──────────────────────────────────────────────────

function calculatePnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) return 0;
  const pct = ((trade.exit_price - trade.ai_entry) / trade.ai_entry) * 100;
  return trade.direction === 'LONG' ? pct : -pct;
}

function fmtDate(val) {
  const d = new Date(typeof val === 'number' ? val : val);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '–';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtPrice(v, symbol = '') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  const s = String(symbol || '').toUpperCase();
  if (s.includes('BTC') || s.includes('XAU') || s.includes('NAS')) return n.toFixed(2);
  const abs = Math.abs(n);
  if (abs < 0.01) return n.toFixed(8);
  if (abs < 1) return n.toFixed(6);
  return n.toFixed(4);
}

// ─── iOS Toggle ────────────────────────────────────────────────

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      className={`ios-toggle ${on ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      role="switch"
      aria-checked={on}
    />
  );
}

// ─── PnL Chart ─────────────────────────────────────────────────

function PnLChart({ points }) {
  const W = 100, H = 60;
  if (!points || points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = v => H - ((v - min) / range) * H;
  const toX = i => (i / (points.length - 1)) * W;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fillD = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const color = points[points.length - 1] >= 0 ? 'var(--win)' : 'var(--loss)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {zero > 0 && zero < H && <line x1="0" y1={zero.toFixed(1)} x2={W} y2={zero.toFixed(1)} stroke="var(--border)" strokeWidth="0.5"/>}
      <path d={fillD} fill="url(#pnlGrad)"/>
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.2"/>
    </svg>
  );
}

// ─── Outcome Selector (shared) ────────────────────────────────
const OutcomeSelector = ({ tradeId, current, onChange }) => (
  <window.OutcomeEditor
    id={tradeId}
    currentOutcome={current}
    type={String(tradeId).startsWith('signal_') ? 'signal' : 'practice'}
    onUpdated={(next) => onChange(tradeId, next)}
  />
);

// ─── Loss Reason Modal ─────────────────────────────────────────

function LossReasonModal({ signalId, sessionId, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [note,   setNote]   = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await fetch(`${API_URL}/signals/${signalId}/loss-reason`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ reason, note: note.trim() || null })
      });
      onSaved?.();
      onClose();
    } catch (e) { console.error(e); } finally { setSaving(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Loss-Grund markieren</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 8, display: 'block', color: 'var(--text-secondary)' }}>Grund auswählen</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LOSS_REASONS.map(r => (
                <button key={r} onClick={() => setReason(r)} className="btn btn-sm" style={{ fontSize: 11, background: reason === r ? 'rgba(59,130,246,0.15)' : 'var(--bg-3)', color: reason === r ? 'var(--blue-400)' : 'var(--text-secondary)', border: `1px solid ${reason === r ? 'rgba(59,130,246,0.35)' : 'var(--border)'}` }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block', color: 'var(--text-secondary)' }}>Notiz (optional)</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Zusätzliche Anmerkung…" style={{ width: '100%' }}/>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn btn-primary" onClick={save} disabled={!reason || saving}>
            {saving ? <div className="spinner-sm"/> : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Signal Detail Modal ───────────────────────────────────────

function SignalDetailModal({ signal, onClose, onMarkLoss }) {
  if (!signal) return null;
  const pnl = calculatePnL(signal);
  const fields = [
    ['Symbol',      signal.symbol],
    ['Richtung',    signal.direction],
    ['Datum',       fmtDate(signal.created_at)],
    ['Timeframe',   signal.timeframe ? signal.timeframe + 'm' : '–'],
    ['Entry',       signal.ai_entry  ? '$' + fmtPrice(signal.ai_entry, signal.symbol)  : '–'],
    ['Take Profit', signal.ai_tp     ? '$' + fmtPrice(signal.ai_tp, signal.symbol)     : '–'],
    ['Stop Loss',   signal.ai_sl     ? '$' + fmtPrice(signal.ai_sl, signal.symbol)     : '–'],
    ['Exit',        signal.exit_price ? '$' + fmtPrice(signal.exit_price, signal.symbol) : '–'],
    ['PnL',         pnl !== 0 ? fmtPct(pnl) : '–'],
    ['Score',       (signal.ai_score || 0) + '/100'],
    ['Risiko',      signal.ai_risk || '–'],
    ['RSI',         signal.rsi ?? '–'],
    ['EMA50',       signal.ema50  ? signal.ema50.toFixed(0)  : '–'],
    ['EMA200',      signal.ema200 ? signal.ema200.toFixed(0) : '–'],
    ['Trend',       signal.trend     || '–'],
    ['Wave Bias',   signal.wave_bias || '–'],
    ['Strategie',   signal.strategy_name    || 'WAVESCOUT Standard'],
    ['Version',     signal.strategy_version || 'v1.0'],
    ['Ergebnis',    signal.outcome || 'OPEN'],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{signal.direction}</span>
            <h3 style={{ margin: 0 }}>{signal.symbol}</h3>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', fontSize: 13 }}>
          {fields.map(([l, v]) => (
            <div key={l}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{l}</div>
              <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{v}</div>
            </div>
          ))}
        </div>
        {signal.ai_reason && (
          <div style={{ padding: '0 20px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Analyse-Begründung</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-3)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 }}>{signal.ai_reason}</div>
          </div>
        )}
        <div className="modal-foot">
          {signal.outcome === 'LOSS' && (
            <button className="btn btn-ghost" style={{ color: 'var(--loss)', marginRight: 'auto' }} onClick={() => { onMarkLoss?.(); onClose(); }}>
              Loss-Grund markieren
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

// ─── Practice Trades Tab ───────────────────────────────────────

function PracticeTradesTab({ sessionId }) {
  const [trades, setTrades]   = useState([]);
  const [stats,  setStats]    = useState(null);
  const [loading,setLoading]  = useState(true);
  const [fSymbol,setFSymbol]  = useState('all');
  const [fTf,    setFTf]      = useState('all');
  const [fDir,   setFDir]     = useState('all');
  const [fStatus,setFStatus]  = useState('all');

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(`${API_URL}/practice-trades?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/practice-trades/stats`,     { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (tRes.ok) setTrades(await tRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const symbols    = ['all', ...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const timeframes = ['all', ...new Set(trades.map(t => t.timeframe).filter(Boolean))];
  const filtered   = trades.filter(t => {
    if (fSymbol !== 'all' && t.symbol    !== fSymbol)  return false;
    if (fTf     !== 'all' && t.timeframe !== fTf)      return false;
    if (fDir    !== 'all' && t.direction !== fDir)     return false;
    if (fStatus !== 'all' && t.status    !== fStatus)  return false;
    return true;
  });

  const updatePracticeStatus = async (tradeId, status) => {
    setTrades(prev => prev.map(t => String(t.id) === String(tradeId) ? { ...t, status } : t));
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Übungstrades…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-val">{stats?.total ?? 0}</div><div className="kpi-lbl">Gesamt</div></div>
        <div className="kpi-card"><div className="kpi-val">{stats?.open ?? 0}</div><div className="kpi-lbl">Offen</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--win)' }}>{stats?.wins ?? 0}</div><div className="kpi-lbl">Wins</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--loss)' }}>{stats?.losses ?? 0}</div><div className="kpi-lbl">Losses</div></div>
        <div className="kpi-card">
          <div className="kpi-val" style={{ color: (stats?.winRate ?? 0) >= 50 ? 'var(--win)' : 'var(--loss)' }}>{(stats?.winRate ?? 0).toFixed(1)}%</div>
          <div className="kpi-lbl">Win-Rate</div>
        </div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--win)' }}>{fmtPct(stats?.avgWinPct)}</div><div className="kpi-lbl">Ø Gewinn</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--loss)' }}>{fmtPct(stats?.avgLossPct)}</div><div className="kpi-lbl">Ø Verlust</div></div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/><h3>Filter</h3>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={() => { setFSymbol('all'); setFTf('all'); setFDir('all'); setFStatus('all'); }}>Zurücksetzen</button>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Symbol',    value: fSymbol, set: setFSymbol, opts: symbols.map(s => [s, s === 'all' ? 'Alle Symbole' : s]) },
              { label: 'Timeframe', value: fTf,     set: setFTf,    opts: timeframes.map(t => [t, t === 'all' ? 'Alle TFs' : t + 'm']) },
              { label: 'Richtung',  value: fDir,    set: setFDir,   opts: [['all','Alle'],['LONG','Long'],['SHORT','Short']] },
              { label: 'Status',    value: fStatus, set: setFStatus,opts: [['all','Alle'],['OPEN','Offen'],['WIN','Gewinner'],['LOSS','Verlierer']] },
            ].map(({ label, value, set, opts }) => (
              <div key={label}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>{label}</label>
                <select value={value} onChange={e => set(e.target.value)} className="input" style={{ minWidth: 140 }}>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>Übungstrades</h3>
          <div className="actions"><span className="badge badge-tag">{filtered.length}</span></div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>{trades.length === 0 ? 'Noch keine Übungstrades — werden automatisch beim nächsten Signal erstellt' : 'Keine Trades mit diesen Filtern'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>Datum</th><th>Symbol</th><th>TF</th><th>Richtung</th><th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>Result</th><th>Status</th></tr></thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td className="mono muted" style={{ fontSize: 11 }}>{t.id}</td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                    <td><AssetChip symbol={t.symbol}/></td>
                    <td className="mono muted">{t.timeframe}</td>
                    <td><span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.direction}</span></td>
                    <td className="mono">${fmtPrice((t.entry_price || 0), t.symbol)}</td>
                    <td className="mono" style={{ color: 'var(--win)' }}>${fmtPrice((t.take_profit || 0), t.symbol)}</td>
                    <td className="mono" style={{ color: 'var(--loss)' }}>${fmtPrice((t.stop_loss || 0), t.symbol)}</td>
                    <td className="mono">{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '–'}</td>
                    <td className={`mono ${t.result_pct > 0 ? 'win' : t.result_pct < 0 ? 'loss' : ''}`}>{t.result_pct != null ? fmtPct(t.result_pct) : '–'}</td>
                    <td><OutcomeSelector tradeId={t.id} current={t.status} onChange={updatePracticeStatus}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Signal History Tab ────────────────────────────────────────

function SignalHistoryTab({ sessionId }) {
  const [history,   setHistory]   = useState([]);
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [fOutcome,  setFOutcome]  = useState('all');
  const [fSymbol,   setFSymbol]   = useState('all');
  const [selected,  setSelected]  = useState(null);
  const [lossModal, setLossModal] = useState(null);

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } }),
      ]);
      if (hRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setHistory(hRes.ok ? await hRes.json() : []);
      setStats(sRes.ok  ? await sRes.json()  : null);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const updateOutcome = async (tradeId, outcome) => {
    setHistory(prev => prev.map(t => t.id === tradeId ? { ...t, outcome } : t));
  };

  const totalClosed = (stats?.wins || 0) + (stats?.losses || 0);
  const winRate     = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;
  const symbols     = ['all', ...new Set(history.map(h => h.symbol).filter(Boolean))];
  const closedTrades = history.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS').slice().reverse();
  let cumulative = 0;
  const pnlPoints = closedTrades.map(t => { cumulative += calculatePnL(t); return cumulative; });
  const filtered  = history.filter(h => {
    if (fOutcome !== 'all' && h.outcome !== fOutcome) return false;
    if (fSymbol  !== 'all' && h.symbol  !== fSymbol)  return false;
    return true;
  });

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Signal-History…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {selected   && <SignalDetailModal signal={selected} onClose={() => setSelected(null)} onMarkLoss={() => { setLossModal(selected.id); setSelected(null); }}/>}
      {lossModal  && <LossReasonModal signalId={lossModal} sessionId={sessionId} onClose={() => setLossModal(null)} onSaved={() => setLossModal(null)}/>}

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="kpi-card"><div className="kpi-val">{history.length}</div><div className="kpi-lbl">Total Signale</div></div>
        <div className="kpi-card"><div className="kpi-val">{totalClosed}</div><div className="kpi-lbl">Abgeschlossen</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>{winRate.toFixed(1)}%</div><div className="kpi-lbl">Win-Rate</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--text-tertiary)' }}>{stats?.open || 0}</div><div className="kpi-lbl">Offen</div></div>
      </div>

      {pnlPoints.length >= 2 && (
        <div className="card">
          <div className="card-head"><Icon name="chart" className="ico"/><h3>Kumulativer PnL</h3>
            <div className="actions"><span className={`badge ${pnlPoints[pnlPoints.length-1] >= 0 ? 'badge-win' : 'badge-loss'}`}>{pnlPoints[pnlPoints.length-1] >= 0 ? '+' : ''}{pnlPoints[pnlPoints.length-1].toFixed(2)}%</span></div>
          </div>
          <div className="card-body" style={{ padding: '12px 20px 16px' }}><PnLChart points={pnlPoints}/></div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/><h3>Filter</h3>
          {(fOutcome !== 'all' || fSymbol !== 'all') && <div className="actions"><button className="btn btn-ghost btn-sm" onClick={() => { setFOutcome('all'); setFSymbol('all'); }}>Zurücksetzen</button></div>}
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Ergebnis</label>
              <select value={fOutcome} onChange={e => setFOutcome(e.target.value)} className="input" style={{ minWidth: 140 }}>
                <option value="all">Alle</option><option value="WIN">Wins</option><option value="LOSS">Losses</option><option value="OPEN">Offen</option><option value="IGNORED">Ignoriert</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Symbol</label>
              <select value={fSymbol} onChange={e => setFSymbol(e.target.value)} className="input" style={{ minWidth: 140 }}>
                {symbols.map(s => <option key={s} value={s}>{s === 'all' ? 'Alle Symbole' : s}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><Icon name="signal" className="ico"/><h3>Trade History</h3>
          <div className="actions"><span className="badge badge-tag">{filtered.length}</span></div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>{history.length === 0 ? 'Noch keine Signale empfangen' : 'Keine Trades mit diesen Filtern'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Datum</th><th>Symbol</th><th>Richtung</th><th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>PnL</th><th>Score</th><th>Strategie</th><th>Ergebnis</th></tr></thead>
              <tbody>
                {filtered.map((trade, i) => {
                  const pnl = calculatePnL(trade);
                  return (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setSelected(trade)}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(trade.created_at)}</td>
                      <td><AssetChip symbol={trade.symbol}/></td>
                      <td><span className={`badge ${trade.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{trade.direction}</span></td>
                      <td className="mono">${(trade.ai_entry || trade.price || 0).toFixed(2)}</td>
                      <td className="mono" style={{ color: 'var(--win)' }}>{trade.ai_tp  ? `$${fmtPrice(trade.ai_tp, trade.symbol)}`  : '—'}</td>
                      <td className="mono" style={{ color: 'var(--loss)' }}>{trade.ai_sl ? `$${fmtPrice(trade.ai_sl, trade.symbol)}`  : '—'}</td>
                      <td className="mono">{trade.exit_price ? `$${fmtPrice(trade.exit_price, trade.symbol)}` : '—'}</td>
                      <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>{pnl !== 0 ? fmtPct(pnl) : '—'}</td>
                      <td className="mono">{trade.ai_score || 0}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{trade.strategy_name || 'Standard'} <span style={{ color: 'var(--text-quaternary)' }}>{trade.strategy_version || ''}</span></td>
                      <td onClick={e => e.stopPropagation()}>
                        <OutcomeSelector tradeId={trade.id} current={trade.outcome} onChange={updateOutcome}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ padding: '10px 20px', fontSize: 12, color: 'var(--text-tertiary)', borderTop: '1px solid var(--border)' }}>
              Klicke auf eine Zeile für Details
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Strategy Lab Tab ──────────────────────────────────────────

function StrategyLabTab({ sessionId, userRole }) {
  const [strategies, setStrategies]   = useState([]);
  const [selected,   setSelected]     = useState(null);
  const [editCfg,    setEditCfg]      = useState(null);
  const [loading,    setLoading]      = useState(true);
  const [saving,     setSaving]       = useState(false);
  const [newName,    setNewName]      = useState('');
  const [newVersion, setNewVersion]   = useState('');
  const [toast,      setToast]        = useState(null);
  const [resetDlg,   setResetDlg]    = useState(false);
  const isAdmin = userRole === 'admin';

  useEffect(() => { load(); }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/strategies`, { headers: { 'X-Session-ID': sessionId } });
      if (res.ok) {
        const data = await res.json();
        setStrategies(data);
        if (data.length > 0) {
          const active = data.find(s => s.active) || data[0];
          setSelected(active);
          setEditCfg(JSON.parse(JSON.stringify(active.config || {})));
        }
      }
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const selectStrategy = s => {
    setSelected(s);
    setEditCfg(JSON.parse(JSON.stringify(s.config || {})));
  };

  const updateRule = (key, field, value) =>
    setEditCfg(prev => ({ ...prev, rules: { ...prev.rules, [key]: { ...prev.rules?.[key], [field]: value } } }));

  const updateThreshold = (key, value) =>
    setEditCfg(prev => ({ ...prev, thresholds: { ...prev.thresholds, [key]: value } }));

  const saveNewVersion = async () => {
    if (!newName.trim()) return showToast('Bitte Namen eingeben', 'error');
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ name: newName.trim(), version: newVersion.trim() || 'v1.0', config: editCfg })
      });
      if (res.ok) { showToast('Strategie gespeichert'); setNewName(''); setNewVersion(''); await load(); }
      else { const e = await res.json(); showToast(e.error || 'Fehler', 'error'); }
    } catch (e) { showToast(e.message, 'error'); } finally { setSaving(false); }
  };

  const activate = async stratId => {
    try {
      const res = await fetch(`${API_URL}/strategies/${stratId}/activate`, { method: 'POST', headers: { 'X-Session-ID': sessionId } });
      if (res.ok) { showToast('Strategie aktiviert'); await load(); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  const deleteStrategy = async stratId => {
    try {
      const res = await fetch(`${API_URL}/strategies/${stratId}`, { method: 'DELETE', headers: { 'X-Session-ID': sessionId } });
      if (res.ok) { showToast('Strategie gelöscht'); await load(); }
      else { const e = await res.json(); showToast(e.error || 'Fehler', 'error'); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  const resetToDefault = async () => {
    try {
      const res = await fetch(`${API_URL}/strategies/reset-to-default`, { method: 'POST', headers: { 'X-Session-ID': sessionId } });
      if (res.ok) { showToast('Auf Standardstrategie zurückgesetzt'); setResetDlg(false); await load(); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Strategien…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {toast && (
        <div className={`toast-bar ${toast.type}`} style={{ position: 'fixed', top: 80, right: 24, zIndex: 999, animation: 'none' }}>
          {toast.msg}
        </div>
      )}

      {resetDlg && (
        <div className="modal-overlay" onClick={() => setResetDlg(false)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h3>Auf Standard zurücksetzen?</h3></div>
            <div style={{ padding: '16px 20px' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Die aktive Strategie wird auf WAVESCOUT Standard zurückgesetzt. Deine gespeicherten Strategie-Versionen bleiben erhalten.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setResetDlg(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={resetToDefault}>Zurücksetzen</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, alignItems: 'start' }}>

        {/* Strategy list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, padding: '0 4px' }}>Versionen</div>
          {strategies.map(s => (
            <div key={s.id} onClick={() => selectStrategy(s)} style={{
              padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
              border: `1px solid ${selected?.id === s.id ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
              background: selected?.id === s.id ? 'rgba(59,130,246,0.07)' : 'var(--bg-2)',
              transition: 'all 0.15s'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.active ? 'var(--win)' : 'var(--bg-4)', display: 'inline-block', flexShrink: 0 }}/>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', paddingLeft: 13 }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.version}</span>
                {s.is_default && <span className="badge badge-tag" style={{ fontSize: 9, padding: '1px 5px' }}>Standard</span>}
                {s.active     && <span className="badge badge-win"  style={{ fontSize: 9, padding: '1px 5px' }}>Aktiv</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Editor */}
        {selected && editCfg ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            <div className="card">
              <div className="card-head">
                <div>
                  <h3 style={{ margin: 0 }}>{selected.name}</h3>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 400 }}>{selected.version}</span>
                </div>
                <div className="actions">
                  {isAdmin && !selected.active && <button className="btn btn-ghost btn-sm" onClick={() => activate(selected.id)}>Als aktiv setzen</button>}
                  {isAdmin && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--wait)' }} onClick={() => setResetDlg(true)}>Auf Standard zurücksetzen</button>}
                  {isAdmin && !selected.is_default && !selected.protected && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--loss)' }} onClick={() => deleteStrategy(selected.id)}>Löschen</button>}
                </div>
              </div>
              {selected.protected && (
                <div style={{ margin: '0 20px 16px', padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 10, fontSize: 13, color: 'var(--wait)' }}>
                  Standardstrategie — Regeln sind schreibgeschützt. Erstelle eine neue Version um Änderungen vorzunehmen.
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head"><Icon name="book" className="ico"/><h3>Regeln & Gewichtungen</h3></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {Object.entries(RULE_META).map(([key, meta]) => {
                  const rule     = editCfg.rules?.[key] || { enabled: true, weight: 10 };
                  const disabled = !!selected.protected;
                  return (
                    <div key={key} className="settings-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: rule.enabled ? 'var(--text-primary)' : 'var(--text-quaternary)' }}>{meta.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-quaternary)' }}>{meta.desc}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                        {rule.enabled && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input type="range" min={0} max={meta.maxW} step={1} value={rule.weight} disabled={disabled}
                              onChange={e => updateRule(key, 'weight', parseInt(e.target.value))}
                              style={{ width: 80, accentColor: 'var(--blue-500)', cursor: disabled ? 'not-allowed' : 'pointer' }}/>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-400)', minWidth: 22, textAlign: 'right' }}>{rule.weight}</span>
                          </div>
                        )}
                        <Toggle on={!!rule.enabled} onChange={v => updateRule(key, 'enabled', v)} disabled={disabled}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div className="card-head"><Icon name="settings" className="ico"/><h3>Score-Schwellen</h3></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {[
                  { key: 'min_trade_score',    label: 'Min. Trade Score',    desc: 'Ab diesem Score wird ein Trade empfohlen',                  min: 50, max: 90, def: 70 },
                  { key: 'min_telegram_score', label: 'Min. Telegram Score', desc: 'Ab diesem Score wird eine Telegram-Meldung gesendet',        min: 30, max: 80, def: 55 },
                ].map(({ key, label, desc, min, max, def }) => {
                  const val = editCfg.thresholds?.[key] ?? def;
                  return (
                    <div key={key} className="settings-row">
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-quaternary)' }}>{desc}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="range" min={min} max={max} step={1} value={val} disabled={!!selected.protected}
                          onChange={e => updateThreshold(key, parseInt(e.target.value))}
                          style={{ width: 100, accentColor: 'var(--blue-500)' }}/>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue-400)', minWidth: 22 }}>{val}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {isAdmin && (
              <div className="card">
                <div className="card-head"><Icon name="plus" className="ico"/><h3>Als neue Version speichern</h3></div>
                <div className="card-body">
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                    Erstellt eine neue Strategie-Version mit den aktuell eingestellten Regeln und Gewichtungen.
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Name</label>
                      <input className="input" value={newName} onChange={e => setNewName(e.target.value)}
                        placeholder={`${selected.name} — Variante`} style={{ minWidth: 200 }}/>
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Version</label>
                      <input className="input" value={newVersion} onChange={e => setNewVersion(e.target.value)}
                        placeholder="v1.1" style={{ width: 80 }}/>
                    </div>
                    <button className="btn btn-primary" onClick={saveNewVersion} disabled={saving || !newName.trim()}>
                      {saving ? <div className="spinner-sm"/> : 'Speichern'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>Keine Strategie ausgewählt</div>
        )}
      </div>
    </div>
  );
}

// ─── Strategy Compare Tab ──────────────────────────────────────

function CompareTable({ rows, keyPrefix }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead><tr><th>Strategie</th><th>Version</th><th>Total</th><th>Wins</th><th>Losses</th><th>Win-Rate</th><th>WAIT</th><th>SKIP</th><th>Ø Score</th></tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={`${keyPrefix}-${i}`}>
              <td style={{ fontWeight: 500 }}>{s.strategy_name || s.strategyName || '–'}</td>
              <td className="mono muted" style={{ fontSize: 11 }}>{s.strategy_version || s.strategyVersion || '–'}</td>
              <td className="mono">{s.total}</td>
              <td className="mono" style={{ color: 'var(--win)' }}>{s.wins}</td>
              <td className="mono" style={{ color: 'var(--loss)' }}>{s.losses}</td>
              <td className={`mono ${(s.winRate) >= 50 ? 'win' : 'loss'}`}>{s.winRate}%</td>
              <td className="mono muted">{s.wait_count || s.waitCount || 0}</td>
              <td className="mono muted">{s.skip_count || s.skipCount || 0}</td>
              <td className="mono">{s.avg_score || s.avgScore || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategyCompareTab({ sessionId }) {
  const [compareData, setCompareData] = useState([]);
  const [allStrats,   setAllStrats]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [abRunning,   setAbRunning]   = useState(false);
  const [abResult,    setAbResult]    = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [cRes, sRes] = await Promise.all([
        fetch(`${API_URL}/strategies/compare`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/strategies`,          { headers: { 'X-Session-ID': sessionId } }),
      ]);
      if (cRes.ok) setCompareData(await cRes.json());
      if (sRes.ok) setAllStrats(await sRes.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const runAbTest = async () => {
    if (!allStrats.length) return;
    setAbRunning(true);
    try {
      const res = await fetch(`${API_URL}/strategies/ab-backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ strategyIds: allStrats.map(s => s.id) })
      });
      if (res.ok) setAbResult(await res.json());
    } catch (e) { console.error(e); } finally { setAbRunning(false); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>Performance nach Strategie</h3>
          <div className="actions"><button className="btn btn-ghost btn-sm" onClick={load}>↻ Aktualisieren</button></div>
        </div>
        {compareData.length === 0 ? (
          <div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Noch keine Signale mit Strategie-Zuordnung. Neue Signale über den Webhook werden automatisch der aktiven Strategie zugeordnet.</p>
          </div>
        ) : (
          <>
            <CompareTable rows={compareData} keyPrefix="real"/>
            {compareData.some(s => s.total < 20) && (
              <div style={{ padding: '10px 20px', background: 'var(--bg-warning)', color: 'var(--wait)', fontSize: 12, borderTop: '1px solid var(--border)' }}>
                ⚠ Ergebnisse mit unter 20 Signalen sind noch nicht aussagekräftig.
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>A/B Backtest</h3>
          <div className="actions"><span className="badge badge-tag">Alle Strategien · Historische Signale</span></div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Alle {allStrats.length} gespeicherten Strategien werden gegen die letzten 100 historischen Signale getestet. Die Regel-Scores werden neu berechnet, das tatsächliche Outcome (WIN/LOSS) bleibt wie gespeichert.
          </p>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={runAbTest} disabled={abRunning || allStrats.length === 0}>
            {abRunning ? <><div className="spinner-sm" style={{ display: 'inline-block', marginRight: 6 }}/>Berechne…</> : 'A/B Test starten'}
          </button>
          {abResult && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>Ergebnis ({abResult.signalCount} Signale):</p>
              <CompareTable rows={abResult.results} keyPrefix="ab"/>
              {abResult.signalCount < 20 && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--bg-warning)', borderRadius: 8, fontSize: 12, color: 'var(--wait)' }}>
                  ⚠ Nur {abResult.signalCount} Signale für den Test — für belastbare Aussagen werden mehr Trades benötigt.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Loss Analysis Tab ─────────────────────────────────────────

function LossAnalysisTab({ sessionId }) {
  const [losses,    setLosses]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [lossModal, setLossModal] = useState(null);
  const [reasons,   setReasons]   = useState({});

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } });
      if (res.ok) setLosses((await res.json()).filter(t => t.outcome === 'LOSS'));
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const loadReasons = async signalId => {
    try {
      const res = await fetch(`${API_URL}/signals/${signalId}/loss-reasons`, { headers: { 'X-Session-ID': sessionId } });
      if (res.ok) {
        const reasonData = await res.json();
        setReasons(prev => ({ ...prev, [signalId]: reasonData }));
      }
    } catch (e) { console.error(e); }
  };

  const reasonCounts = {};
  Object.values(reasons).flat().forEach(r => { reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1; });
  const topReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {lossModal && (
        <LossReasonModal signalId={lossModal} sessionId={sessionId}
          onClose={() => setLossModal(null)}
          onSaved={() => { loadReasons(lossModal); setLossModal(null); }}/>
      )}

      {topReasons.length > 0 && (
        <div className="card">
          <div className="card-head"><Icon name="chart" className="ico"/><h3>Häufige Loss-Gründe</h3></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topReasons.map(([reason, cnt]) => (
              <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, fontSize: 13 }}>{reason}</div>
                <div style={{ width: 120, background: 'var(--bg-3)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--loss)', borderRadius: 4, width: `${Math.min(100, (cnt / losses.length) * 200)}%` }}/>
                </div>
                <span className="badge badge-loss" style={{ minWidth: 28, textAlign: 'center', fontSize: 11 }}>{cnt}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Loss-Trades</h3>
          <div className="actions">
            <span className="badge badge-loss">{losses.length} Losses</span>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻</button>
          </div>
        </div>
        {losses.length === 0 ? (
          <div className="card-body" style={{ textAlign: 'center', padding: 40 }}><p style={{ color: 'var(--text-tertiary)' }}>Keine Losses vorhanden</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Datum</th><th>Symbol</th><th>Richtung</th><th>Score</th><th>Strategie</th><th>Loss-Gründe</th><th></th></tr></thead>
              <tbody>
                {losses.map((t, i) => {
                  const signalReasons = reasons[t.id] || [];
                  return (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                      <td><AssetChip symbol={t.symbol}/></td>
                      <td><span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.direction}</span></td>
                      <td className="mono" style={{ color: 'var(--loss)' }}>{t.ai_score || 0}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.strategy_name || 'Standard'}</td>
                      <td>
                        {signalReasons.length > 0 ? (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {signalReasons.map((r, ri) => <span key={ri} className="badge badge-tag" style={{ fontSize: 10 }}>{r.reason}</span>)}
                          </div>
                        ) : <span style={{ color: 'var(--text-quaternary)', fontSize: 12 }}>–</span>}
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                          onClick={() => { setLossModal(t.id); loadReasons(t.id); }}>
                          {signalReasons.length > 0 ? 'Bearbeiten' : '+ Markieren'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Suggestions Tab ───────────────────────────────────────────

function SuggestionsTab({ sessionId }) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/strategies/suggestions`, { headers: { 'X-Session-ID': sessionId } });
      if (res.ok) setSuggestions(await res.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const priColor = p => p === 'high' ? 'var(--loss)' : p === 'medium' ? 'var(--wait)' : 'var(--text-tertiary)';
  const priLabel = p => p === 'high' ? 'Hoch' : p === 'medium' ? 'Mittel' : 'Niedrig';

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Analysiere…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Automatische Analyse — Änderungen werden nicht automatisch übernommen. Du entscheidest selbst, ob du eine neue Strategie-Version erstellst.
        </p>
        <button className="btn btn-ghost btn-sm" onClick={load} style={{ flexShrink: 0, marginLeft: 16 }}>↻ Aktualisieren</button>
      </div>
      {suggestions.map((s, i) => (
        <div key={i} className="card" style={{ borderLeft: `3px solid ${priColor(s.priority)}` }}>
          <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: priColor(s.priority), textTransform: 'uppercase', letterSpacing: '0.06em' }}>{priLabel(s.priority)}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>{s.message}</p>
            </div>
            {s.action && <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--blue-400)', fontWeight: 500, marginTop: 2 }}>→ {s.action}</div>}
          </div>
        </div>
      ))}
      {suggestions.length === 0 && <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>Keine Vorschläge verfügbar</div>}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────

const BacktestPage = ({ user }) => {
  const [activeTab, setActiveTab] = useState('practice');
  const sessionId = localStorage.getItem('wavescout_session');
  const userRole  = user?.role || 'user';

  const tabs = [
    { id: 'practice',    label: 'Übungstrades'       },
    { id: 'history',     label: 'Signal-Historie'     },
    { id: 'strategy',    label: 'Strategie-Labor'     },
    { id: 'compare',     label: 'Strategie-Vergleich' },
    { id: 'loss',        label: 'Loss-Analyse'        },
    { id: 'suggestions', label: 'Vorschläge'          },
  ];

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Backtesting & Strategie-Labor</h2>
        <p className="subtitle">Paper-Trades · Strategie-Versionen · Loss-Analyse · Verbesserungsvorschläge</p>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 1 }}>
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', minWidth: 'max-content' }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              background: 'none', border: 'none', padding: '10px 18px', cursor: 'pointer',
              fontSize: 14, fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--blue-500)' : 'var(--text-secondary)',
              borderBottom: activeTab === tab.id ? '2px solid var(--blue-500)' : '2px solid transparent',
              marginBottom: -1, transition: 'all .15s', whiteSpace: 'nowrap', fontFamily: 'var(--font-main)'
            }}>{tab.label}</button>
          ))}
        </div>
      </div>

      {activeTab === 'practice'    && <PracticeTradesTab  sessionId={sessionId}/>}
      {activeTab === 'history'     && <SignalHistoryTab   sessionId={sessionId}/>}
      {activeTab === 'strategy'    && <StrategyLabTab     sessionId={sessionId} userRole={userRole}/>}
      {activeTab === 'compare'     && <StrategyCompareTab sessionId={sessionId}/>}
      {activeTab === 'loss'        && <LossAnalysisTab    sessionId={sessionId}/>}
      {activeTab === 'suggestions' && <SuggestionsTab     sessionId={sessionId}/>}
    </div>
  );
};

window.BacktestPage = BacktestPage;
