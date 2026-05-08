// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - BACKTEST & AUSWERTUNG
// ═══════════════════════════════════════════════════════════════

const BacktestPage = ({ user }) => {
  const [loading, setLoading]           = useState(true);
  const [history, setHistory]           = useState([]);
  const [stats, setStats]               = useState(null);
  const [filterOutcome, setFilterOutcome] = useState('all');
  const [filterSymbol, setFilterSymbol] = useState('all');

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadData(sessionId);
  }, []);

  const loadData = async (sessionId) => {
    try {
      const [histRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (histRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setHistory(histRes.ok ? await histRes.json() : []);
      setStats(statsRes.ok   ? await statsRes.json() : null);
    } catch (err) {
      console.error('Backtest load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateOutcome = async (tradeId, outcome) => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/signals/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ outcome })
      });
      setHistory(prev => prev.map(t => t.id === tradeId ? { ...t, outcome } : t));
    } catch (err) {
      console.error('Update outcome error:', err);
    }
  };

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  const totalClosed = (stats?.wins || 0) + (stats?.losses || 0);
  const winRate = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;
  const symbols = ['all', ...new Set(history.map(h => h.symbol).filter(Boolean))];

  const filtered = history.filter(h => {
    if (filterOutcome !== 'all' && h.outcome !== filterOutcome) return false;
    if (filterSymbol !== 'all' && h.symbol !== filterSymbol) return false;
    return true;
  });

  // Calculate cumulative PnL for the chart
  const closedTrades = history.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS').slice().reverse();
  let cumulative = 0;
  const pnlPoints = closedTrades.map(t => {
    const pnl = calculatePnL(t);
    cumulative += pnl;
    return cumulative;
  });

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Backtest & Auswertung</h2>
        <p className="subtitle">{history.length} Signale gesamt · {totalClosed} abgeschlossen · {stats?.open || 0} offen</p>
      </div>

      {/* Overview */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Total Signale" value={history.length.toString()} sub="Alle empfangenen Webhooks"/>
        <StatCard label="Abgeschlossen" value={totalClosed.toString()} sub={`${stats?.wins || 0}W · ${stats?.losses || 0}L`}/>
        <StatCard
          label="Win-Rate"
          value={`${winRate.toFixed(1)}%`}
          sub={winRate >= 50 ? 'Profitabel' : 'Unprofitabel'}
          subTone={winRate >= 50 ? 'win' : 'loss'}
        />
        <StatCard label="Offen" value={(stats?.open || 0).toString()} sub="Warten auf Auswertung"/>
      </div>

      {/* PnL Sparkline */}
      {pnlPoints.length >= 2 && (
        <div className="card">
          <div className="card-head">
            <Icon name="chart" className="ico"/>
            <h3>Kumulativer PnL</h3>
            <div className="actions">
              <span className={`badge ${pnlPoints[pnlPoints.length-1] >= 0 ? 'badge-win' : 'badge-loss'}`}>
                {pnlPoints[pnlPoints.length-1] >= 0 ? '+' : ''}{pnlPoints[pnlPoints.length-1].toFixed(2)}%
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
          {(filterOutcome !== 'all' || filterSymbol !== 'all') && (
            <div className="actions">
              <button className="btn btn-ghost btn-sm" onClick={() => { setFilterOutcome('all'); setFilterSymbol('all'); }}>
                Zurücksetzen
              </button>
            </div>
          )}
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Ergebnis</label>
              <select value={filterOutcome} onChange={(e) => setFilterOutcome(e.target.value)} className="input" style={{ minWidth: 140 }}>
                <option value="all">Alle</option>
                <option value="WIN">Wins</option>
                <option value="LOSS">Losses</option>
                <option value="OPEN">Offen</option>
                <option value="IGNORED">Ignoriert</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Symbol</label>
              <select value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)} className="input" style={{ minWidth: 140 }}>
                {symbols.map(s => (
                  <option key={s} value={s}>{s === 'all' ? 'Alle Symbole' : s}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Trade History Table */}
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
                  <th>Entry</th><th>Exit</th><th>PnL</th>
                  <th>Score</th><th>Risiko</th><th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((trade, i) => {
                  const pnl = calculatePnL(trade);
                  return (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {new Date(trade.created_at).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit' })}
                        {' '}
                        {new Date(trade.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}
                      </td>
                      <td><AssetChip symbol={trade.symbol}/></td>
                      <td>
                        <span className={`badge ${trade.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="mono">${(trade.ai_entry || trade.price || 0).toFixed(2)}</td>
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
                        <OutcomeSelector
                          tradeId={trade.id}
                          current={trade.outcome}
                          onChange={updateOutcome}
                        />
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
};

// ─── Outcome selector inline in table ───────────────────────

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
                display: 'block', width: '100%', padding: '8px 12px', background: 'none',
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

// ─── SVG PnL Chart ───────────────────────────────────────────

const PnLChart = ({ points }) => {
  const W = 100, H = 60;
  if (!points || points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = (v) => H - ((v - min) / range) * H;
  const toX = (i) => (i / (points.length - 1)) * W;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero = toY(0);
  const fill = `${pathD} L ${toX(points.length-1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const positive = points[points.length-1] >= 0;
  const color = positive ? 'var(--win)' : 'var(--loss)';

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

// ─── Helpers ─────────────────────────────────────────────────

function calculatePnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) return 0;
  const diff = trade.exit_price - trade.ai_entry;
  const pct = (diff / trade.ai_entry) * 100;
  return trade.direction === 'LONG' ? pct : -pct;
}

window.BacktestPage = BacktestPage;
