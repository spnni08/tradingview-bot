// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - BACKTESTING & PAPER TRADING
// Übungstrades · Signal-Historie · Performance-Analyse
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useRef } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ─── Helpers ─────────────────────────────────────────────────

function calculatePnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) return 0;
  const diff = trade.exit_price - trade.ai_entry;
  const pct  = (diff / trade.ai_entry) * 100;
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

// ─── Stat Card ───────────────────────────────────────────────

function StatCard({ label, value, sub, subTone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className={`sub ${subTone || 'muted'}`}>{sub}</div>}
    </div>
  );
}

// ─── Outcome Selector ────────────────────────────────────────

const OutcomeSelector = ({ tradeId, current, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const options = ['WIN', 'LOSS', 'BE', 'OPEN', 'IGNORED'];
  const cls = current === 'WIN' ? 'badge-win' : current === 'LOSS' ? 'badge-loss' : 'badge-wait';

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        className={`badge ${cls}`}
        style={{ cursor: 'pointer', border: 'none', fontFamily: 'var(--font-main)' }}
        onClick={() => setOpen(o => !o)}
        title="Ergebnis ändern"
      >
        {current || 'OPEN'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 50,
          background: 'var(--bg-1)', border: '1px solid var(--border)',
          borderRadius: 8, overflow: 'hidden', minWidth: 110,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
        }}>
          {options.map(o => (
            <button
              key={o}
              style={{
                display: 'block', width: '100%', padding: '8px 12px',
                border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                textAlign: 'left', fontFamily: 'var(--font-main)',
                color: o === current ? 'var(--blue-500)' : 'var(--text-secondary)',
                background: o === current ? 'var(--bg-2)' : 'none'
              }}
              onClick={() => { onChange(tradeId, o); setOpen(false); }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── PnL Chart ───────────────────────────────────────────────

const PnLChart = ({ points }) => {
  const W = 100, H = 60;
  if (!points || points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = (v) => H - ((v - min) / range) * H;
  const toX = (i) => (i / (points.length - 1)) * W;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fill  = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const color = points[points.length - 1] >= 0 ? 'var(--win)' : 'var(--loss)';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {zero > 0 && zero < H && (
        <line x1="0" y1={zero.toFixed(1)} x2={W} y2={zero.toFixed(1)} stroke="var(--border)" strokeWidth="0.5"/>
      )}
      <path d={fill} fill="url(#pnlGrad)"/>
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.2"/>
    </svg>
  );
};

// ─── Collapsible Strategy Panel ──────────────────────────────

function StrategyPanel() {
  return (
    <div className="card-body" style={{ fontSize: 13, lineHeight: 1.7 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>📈 LONG Entry</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>Letzter Close &gt; Vorheriger Close (mind. 0.05%)</li>
            <li>RSI zwischen 30 und 70</li>
            <li>EMA50 über EMA200 (bullischer Trend)</li>
            <li>Market-Buy sofort ausführen</li>
          </ul>
        </div>
        <div>
          <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>📉 SHORT Entry</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>Letzter Close &lt; Vorheriger Close (mind. 0.05%)</li>
            <li>RSI zwischen 30 und 70</li>
            <li>EMA50 unter EMA200 (bärischer Trend)</li>
            <li>Market-Sell sofort ausführen</li>
          </ul>
        </div>
        <div>
          <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>🚫 Skip-Bedingungen</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>RSI über 70 (überkauft) oder unter 30 (überverkauft)</li>
            <li>Kursänderung unter 0.05% (Chop/Seitwärts)</li>
            <li>Gegen den 1H/4H-Bias</li>
          </ul>
        </div>
        <div>
          <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>⚖️ Risiko-Management</p>
          <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
            <li>TP: +2% vom Entry (LONG) / -2% (SHORT)</li>
            <li>SL: -1% vom Entry (LONG) / +1% (SHORT)</li>
            <li>Fixe Handelsgröße: 1% des Portfolios · Max. $3</li>
            <li>R:R min. 1:2 · SL logisch unter Struktur</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─── Practice Trades Tab ─────────────────────────────────────

function PracticeTradesTab({ sessionId }) {
  const [trades, setTrades]    = useState([]);
  const [stats, setStats]      = useState(null);
  const [loading, setLoading]  = useState(true);
  const [fSymbol, setFSymbol]  = useState('all');
  const [fTf, setFTf]          = useState('all');
  const [fDir, setFDir]        = useState('all');
  const [fStatus, setFStatus]  = useState('all');

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
    } catch (e) {
      console.error('practice-trades load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const symbols    = ['all', ...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const timeframes = ['all', ...new Set(trades.map(t => t.timeframe).filter(Boolean))];

  const filtered = trades.filter(t => {
    if (fSymbol !== 'all' && t.symbol    !== fSymbol)  return false;
    if (fTf     !== 'all' && t.timeframe !== fTf)      return false;
    if (fDir    !== 'all' && t.direction !== fDir)     return false;
    if (fStatus !== 'all' && t.status    !== fStatus)  return false;
    return true;
  });

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>
      <div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>
      Lade Übungstrades…
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* KPI Bar */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        <StatCard label="Gesamt"    value={stats?.total   ?? 0} sub="Übungstrades" />
        <StatCard label="Offen"     value={stats?.open    ?? 0} sub="Noch aktiv" />
        <StatCard label="Gewinner"  value={stats?.wins    ?? 0} sub={stats?.wins    ? `Ø +${stats.avgWinPct?.toFixed(1)}%`  : '–'} subTone="win" />
        <StatCard label="Verlierer" value={stats?.losses  ?? 0} sub={stats?.losses  ? `Ø ${stats.avgLossPct?.toFixed(1)}%` : '–'} subTone="loss" />
        <StatCard
          label="Win-Rate"
          value={`${stats?.winRate?.toFixed(1) ?? 0}%`}
          sub={(stats?.winRate ?? 0) >= 50 ? 'Profitabel ✓' : 'Unprofitabel'}
          subTone={(stats?.winRate ?? 0) >= 50 ? 'win' : 'loss'}
        />
        <StatCard label="Ø Gewinn"  value={fmtPct(stats?.avgWinPct)}  sub="pro Win-Trade"  subTone="win" />
        <StatCard label="Ø Verlust" value={fmtPct(stats?.avgLossPct)} sub="pro Loss-Trade" subTone="loss" />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/>
          <h3>Filter</h3>
          <div className="actions">
            <button className="btn btn-ghost btn-sm"
              onClick={() => { setFSymbol('all'); setFTf('all'); setFDir('all'); setFStatus('all'); }}>
              Zurücksetzen
            </button>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻ Aktualisieren</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Symbol',    value: fSymbol, set: setFSymbol, opts: symbols.map(s => [s, s === 'all' ? 'Alle Symbole' : s]) },
              { label: 'Timeframe', value: fTf,     set: setFTf,    opts: timeframes.map(t => [t, t === 'all' ? 'Alle TFs' : t + 'm']) },
              { label: 'Richtung',  value: fDir,    set: setFDir,   opts: [['all','Alle'],['LONG','Long'],['SHORT','Short']] },
              { label: 'Status',    value: fStatus, set: setFStatus,opts: [['all','Alle'],['OPEN','Offen'],['WIN','Gewinner'],['LOSS','Verlierer']] }
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

      {/* Table */}
      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/>
          <h3>Übungstrades</h3>
          <div className="actions">
            <span className="badge badge-tag">{filtered.length} Trades</span>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="signal" size={48} style={{ opacity: 0.2, marginBottom: 16 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>
              {trades.length === 0
                ? 'Noch keine Übungstrades — werden automatisch beim nächsten Signal erstellt'
                : 'Keine Trades mit diesen Filtern'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th><th>Datum</th><th>Symbol</th><th>TF</th><th>Richtung</th>
                  <th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>Result</th>
                  <th>Status</th><th>Geschlossen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td className="mono muted" style={{ fontSize: 11 }}>{t.id}</td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                    <td><AssetChip symbol={t.symbol}/></td>
                    <td className="mono muted">{t.timeframe}</td>
                    <td>
                      <span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="mono">${(t.entry_price || 0).toFixed(2)}</td>
                    <td className="mono win">${(t.take_profit || 0).toFixed(2)}</td>
                    <td className="mono loss">${(t.stop_loss || 0).toFixed(2)}</td>
                    <td className="mono">{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '–'}</td>
                    <td className={`mono ${t.result_pct > 0 ? 'win' : t.result_pct < 0 ? 'loss' : ''}`}>
                      {t.result_pct != null ? fmtPct(t.result_pct) : '–'}
                    </td>
                    <td>
                      <span className={`badge ${t.status === 'WIN' ? 'badge-win' : t.status === 'LOSS' ? 'badge-loss' : 'badge-wait'}`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {t.closed_at ? fmtDate(t.closed_at) : '–'}
                    </td>
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

// ─── Signal History Tab ──────────────────────────────────────

function SignalHistoryTab({ sessionId }) {
  const [history, setHistory]      = useState([]);
  const [stats, setStats]          = useState(null);
  const [loading, setLoading]      = useState(true);
  const [fOutcome, setFOutcome]    = useState('all');
  const [fSymbol, setFSymbol]      = useState('all');

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (hRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setHistory(hRes.ok ? await hRes.json() : []);
      setStats(sRes.ok  ? await sRes.json()  : null);
    } catch (e) {
      console.error('history load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const updateOutcome = async (tradeId, outcome) => {
    try {
      await fetch(`${API_URL}/signals/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ outcome })
      });
      setHistory(prev => prev.map(t => t.id === tradeId ? { ...t, outcome } : t));
    } catch (e) { console.error('Update outcome error:', e); }
  };

  const totalClosed = (stats?.wins || 0) + (stats?.losses || 0);
  const winRate = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;
  const symbols = ['all', ...new Set(history.map(h => h.symbol).filter(Boolean))];

  const closedTrades = history.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS').slice().reverse();
  let cumulative = 0;
  const pnlPoints = closedTrades.map(t => { cumulative += calculatePnL(t); return cumulative; });

  const filtered = history.filter(h => {
    if (fOutcome !== 'all' && h.outcome !== fOutcome) return false;
    if (fSymbol  !== 'all' && h.symbol  !== fSymbol)  return false;
    return true;
  });

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>
      <div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>
      Lade Signal-History…
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* KPI */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Total Signale" value={history.length.toString()} sub="Alle empfangenen Webhooks"/>
        <StatCard label="Abgeschlossen" value={totalClosed.toString()} sub={`${stats?.wins || 0}W · ${stats?.losses || 0}L`}/>
        <StatCard
          label="Win-Rate" value={`${winRate.toFixed(1)}%`}
          sub={winRate >= 50 ? 'Profitabel' : 'Unprofitabel'}
          subTone={winRate >= 50 ? 'win' : 'loss'}
        />
        <StatCard label="Offen" value={(stats?.open || 0).toString()} sub="Warten auf Auswertung"/>
      </div>

      {/* PnL Chart */}
      {pnlPoints.length >= 2 && (
        <div className="card">
          <div className="card-head">
            <Icon name="chart" className="ico"/>
            <h3>Kumulativer PnL</h3>
            <div className="actions">
              <span className={`badge ${pnlPoints[pnlPoints.length - 1] >= 0 ? 'badge-win' : 'badge-loss'}`}>
                {pnlPoints[pnlPoints.length - 1] >= 0 ? '+' : ''}{pnlPoints[pnlPoints.length - 1].toFixed(2)}%
              </span>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 20px 16px' }}>
            <PnLChart points={pnlPoints}/>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/>
          <h3>Filter</h3>
          {(fOutcome !== 'all' || fSymbol !== 'all') && (
            <div className="actions">
              <button className="btn btn-ghost btn-sm" onClick={() => { setFOutcome('all'); setFSymbol('all'); }}>
                Zurücksetzen
              </button>
            </div>
          )}
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Ergebnis</label>
              <select value={fOutcome} onChange={e => setFOutcome(e.target.value)} className="input" style={{ minWidth: 140 }}>
                <option value="all">Alle</option>
                <option value="WIN">Wins</option>
                <option value="LOSS">Losses</option>
                <option value="OPEN">Offen</option>
                <option value="IGNORED">Ignoriert</option>
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

      {/* Table */}
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Trade History</h3>
          <div className="actions">
            <span className="badge badge-tag">{filtered.length} Trades</span>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="signal" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>
              {history.length === 0 ? 'Noch keine Signale empfangen' : 'Keine Trades mit diesen Filtern'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Datum</th><th>Symbol</th><th>Richtung</th>
                  <th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>PnL</th>
                  <th>Score</th><th>Risiko</th><th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((trade, i) => {
                  const pnl = calculatePnL(trade);
                  return (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {new Date(trade.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                        {' '}
                        {new Date(trade.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td><AssetChip symbol={trade.symbol}/></td>
                      <td>
                        <span className={`badge ${trade.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="mono">${(trade.ai_entry || trade.price || 0).toFixed(2)}</td>
                      <td className="mono win">{trade.ai_tp  ? `$${trade.ai_tp.toFixed(2)}`  : '—'}</td>
                      <td className="mono loss">{trade.ai_sl ? `$${trade.ai_sl.toFixed(2)}`  : '—'}</td>
                      <td className="mono">{trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '—'}</td>
                      <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>
                        {pnl !== 0 ? `${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}
                      </td>
                      <td className="mono">{trade.ai_score || 0}</td>
                      <td>
                        <span className={`badge ${trade.ai_risk === 'LOW' ? 'badge-win' : trade.ai_risk === 'HIGH' ? 'badge-loss' : 'badge-wait'}`}>
                          {trade.ai_risk || 'MED'}
                        </span>
                      </td>
                      <td>
                        <OutcomeSelector tradeId={trade.id} current={trade.outcome} onChange={updateOutcome}/>
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

// ─── Main Page ───────────────────────────────────────────────

const BacktestPage = ({ user }) => {
  const [activeTab, setActiveTab]       = useState('practice');
  const [strategyOpen, setStrategyOpen] = useState(false);

  const sessionId = localStorage.getItem('wavescout_session');

  const tabs = [
    { id: 'practice', label: '📊 Übungstrades' },
    { id: 'history',  label: '📈 Signal-Historie' }
  ];

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Backtesting & Paper Trading</h2>
        <p className="subtitle">Nur Paper-Trades — keine echten Orders werden ausgeführt</p>
      </div>

      {/* Tab Navigation + Strategy toggle */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none', padding: '10px 18px', cursor: 'pointer',
              fontSize: 14, fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--blue-500)' : 'var(--text-secondary)',
              borderBottom: activeTab === tab.id ? '2px solid var(--blue-500)' : '2px solid transparent',
              marginBottom: -1, transition: 'all .15s'
            }}
          >
            {tab.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingBottom: 4 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setStrategyOpen(o => !o)}
          >
            📋 Strategie-Regeln {strategyOpen ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Collapsible Strategy Rules */}
      {strategyOpen && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ cursor: 'pointer' }} onClick={() => setStrategyOpen(false)}>
            <Icon name="book" className="ico"/>
            <h3>Strategie-Regeln</h3>
            <div className="actions">
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Einklappen ▲</span>
            </div>
          </div>
          <StrategyPanel/>
        </div>
      )}

      {/* Tab Content */}
      {activeTab === 'practice' && <PracticeTradesTab sessionId={sessionId}/>}
      {activeTab === 'history'  && <SignalHistoryTab  sessionId={sessionId}/>}
    </div>
  );
};

window.BacktestPage = BacktestPage;
