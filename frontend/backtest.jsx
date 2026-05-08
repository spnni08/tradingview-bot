// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - BACKTEST & AUSWERTUNG
// ═══════════════════════════════════════════════════════════════

const BacktestPage = ({ user }) => {
  const [loading, setLoading]           = useState(true);
  const [history, setHistory]           = useState([]);
  const [stats, setStats]               = useState(null);
  const [practiceTrades, setPracticeTrades] = useState([]);
  const [practiceStats, setPracticeStats] = useState(null);
  const [showStrategy, setShowStrategy] = useState(false);
  const [filterOutcome, setFilterOutcome] = useState('all');
  const [filterSymbol, setFilterSymbol] = useState('all');
  const [filterTimeframe, setFilterTimeframe] = useState('all');
  const [filterDirection, setFilterDirection] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadData(sessionId);
  }, []);

  const loadData = async (sessionId) => {
    try {
      const [histRes, statsRes, practiceRes, practiceStatsRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/practice-trades`,   { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/practice-trades/stats`, { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (histRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setHistory(histRes.ok ? await histRes.json() : []);
      setStats(statsRes.ok   ? await statsRes.json() : null);
      setPracticeTrades(practiceRes.ok ? await practiceRes.json() : []);
      setPracticeStats(practiceStatsRes.ok ? await practiceStatsRes.json() : null);
    } catch (err) {
      console.error('Backtest load error:', err);
    } finally {
      setLoading(false);
    }
  };


  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  const totalClosed = (practiceStats?.wins || 0) + (practiceStats?.losses || 0);
  const winRate = totalClosed > 0 ? ((practiceStats?.wins || 0) / totalClosed) * 100 : 0;

  const strategy = {
    name: 'Top-Down Daytrading v1.0',
    focus: 'BTC/ETH · 5–15min Entry mit 1H/4H Bias',
    steps: [
      'Bias morgens auf 4H/1H prüfen (EMA200 über/unter Preis)',
      'Nur in markierten 15m Key-Zonen aktiv werden',
      'Entry auf 5–10m nach Strukturbruch + Trendkerze + RSI-Filter',
      'TP mindestens 1:1.5, Ziel 1:2 · SL logisch über/unter Struktur',
      'Ausschluss: Gegen Bias, flache EMA200, Chop/Wicks, FOMO'
    ]
  };

  const symbols = ['all', ...new Set(practiceTrades.map(h => h.symbol).filter(Boolean))];
  const timeframes = ['all', ...new Set(practiceTrades.map(h => h.timeframe).filter(Boolean))];

  const filtered = practiceTrades.filter(h => {
    if (filterOutcome !== 'all' && h.status !== filterOutcome) return false;
    if (filterSymbol !== 'all' && h.symbol !== filterSymbol) return false;
    if (filterTimeframe !== 'all' && String(h.timeframe) !== String(filterTimeframe)) return false;
    if (filterDirection !== 'all' && h.direction !== filterDirection) return false;
    const created = new Date(h.created_at).getTime();
    if (dateFrom && created < new Date(`${dateFrom}T00:00:00`).getTime()) return false;
    if (dateTo && created > new Date(`${dateTo}T23:59:59`).getTime()) return false;
    return true;
  });

  // Calculate cumulative PnL for the chart
  const closedTrades = practiceTrades.filter(t => t.status === 'WIN' || t.status === 'LOSS').slice().reverse();
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
        <p className="subtitle">{practiceStats?.total || 0} Übungstrades gesamt · {totalClosed} abgeschlossen · {practiceStats?.open || 0} offen</p>
      </div>

      {/* Overview */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        <StatCard label="Übungstrades" value={`${practiceStats?.total || 0}`} sub="Paper Trades"/>
        <StatCard label="Winrate" value={`${(practiceStats?.winRate || 0).toFixed(1)}%`} subTone={(practiceStats?.winRate || 0) >= 50 ? 'win' : 'loss'} sub={(practiceStats?.winRate || 0) >= 50 ? 'Profitabel' : 'Ausbaufähig'}/>
        <StatCard label="Offen" value={`${practiceStats?.open || 0}`} sub="Noch aktiv"/>
        <StatCard label="Gewinner" value={`${practiceStats?.wins || 0}`} sub="TP erreicht" subTone="win"/>
        <StatCard label="Verlierer" value={`${practiceStats?.losses || 0}`} sub="SL erreicht" subTone="loss"/>
        <StatCard label="Ø Gewinn/Verlust" value={`${(practiceStats?.avgWin || 0).toFixed(2)}% / ${(practiceStats?.avgLoss || 0).toFixed(2)}%`} sub="Nur geschlossene Trades"/>
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


      <div className="card">
        <div className="card-head">
          <Icon name="book" className="ico"/>
          <h3>Strategie-Regeln</h3>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowStrategy(v => !v)}>{showStrategy ? 'Ausblenden' : 'Anzeigen'}</button>
          </div>
        </div>
        {showStrategy && (
          <div className="card-body" style={{ display: 'grid', gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>{strategy.focus}</p>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: 13 }}>
              {strategy.steps.map((step, idx) => <li key={idx}>{step}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/>
          <h3>Filter</h3>
          {(filterOutcome !== 'all' || filterSymbol !== 'all' || filterTimeframe !== 'all' || filterDirection !== 'all' || dateFrom || dateTo) && (
            <div className="actions">
              <button className="btn btn-ghost btn-sm" onClick={() => { setFilterOutcome('all'); setFilterSymbol('all'); setFilterTimeframe('all'); setFilterDirection('all'); setDateFrom(''); setDateTo(''); }}>
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
                <option value="WIN">WIN</option>
                <option value="LOSS">LOSS</option>
                <option value="OPEN">OPEN</option>
                <option value="SKIPPED">SKIPPED</option>
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
            <div><label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Timeframe</label><select value={filterTimeframe} onChange={(e) => setFilterTimeframe(e.target.value)} className="input" style={{ minWidth: 110 }}>{timeframes.map(tf => <option key={tf} value={tf}>{tf === 'all' ? 'Alle' : tf}</option>)}</select></div>
            <div><label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Richtung</label><select value={filterDirection} onChange={(e) => setFilterDirection(e.target.value)} className="input" style={{ minWidth: 110 }}><option value="all">Alle</option><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div><label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Von</label><input type="date" value={dateFrom} onChange={(e)=>setDateFrom(e.target.value)} className="input"/></div>
            <div><label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Bis</label><input type="date" value={dateTo} onChange={(e)=>setDateTo(e.target.value)} className="input"/></div>
          </div>
        </div>
      </div>

      {/* Trade History Table */}
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Übungstrades</h3>
          <div className="actions">
            <span className="badge badge-tag">{filtered.length} Trades</span>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="signal" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>
              {practiceTrades.length === 0 ? 'Noch keine Übungstrades vorhanden' : 'Keine Trades mit diesen Filtern'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Datum</th><th>Symbol</th><th>Richtung</th>
                  <th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>PnL</th>
                  <th>Status</th><th>Ergebnis %</th><th>Closed</th>
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
                      <td className="mono">${Number(trade.entry_price || 0).toFixed(2)}</td>
                      <td className="mono win">{trade.take_profit ? `$${Number(trade.take_profit).toFixed(2)}` : '—'}</td>
                      <td className="mono loss">{trade.stop_loss ? `$${Number(trade.stop_loss).toFixed(2)}` : '—'}</td>
                      <td className="mono">{trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '—'}</td>
                      <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>{pnl !== 0 ? `${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}</td>
                      <td><span className={`badge ${trade.status === 'WIN' ? 'badge-win' : trade.status === 'LOSS' ? 'badge-loss' : 'badge-wait'}`}>{trade.status || 'OPEN'}</span></td>
                      <td className={`mono ${(trade.result_pct || 0) >= 0 ? 'win' : 'loss'}`}>{trade.result_pct != null ? `${trade.result_pct > 0 ? '+' : ''}${Number(trade.result_pct).toFixed(2)}%` : '—'}</td>
                      <td className="mono muted">{trade.closed_at ? new Date(trade.closed_at).toLocaleString('de-DE') : '—'}</td>
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
  if (!trade.exit_price || !trade.entry_price || trade.entry_price === 0) return 0;
  const diff = trade.exit_price - trade.entry_price;
  const pct = (diff / trade.entry_price) * 100;
  return trade.direction === 'LONG' ? pct : -pct;
}

window.BacktestPage = BacktestPage;
