// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.5 - STATISTIKEN
// ═══════════════════════════════════════════════════════════════

const StatistikenPage = ({ user }) => {
  const [loading, setLoading]   = useState(true);
  const [stats, setStats]       = useState(null);
  const [history, setHistory]   = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [toast, setToast] = useState(null);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadStats(sessionId);
  }, []);

  const loadStats = async (sessionId) => {
    try {
      const [statsRes, histRes, analyticsRes, breakdownRes] = await Promise.all([
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/history?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/analytics`,         { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats/breakdown`,   { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (statsRes.status === 401) { localStorage.removeItem('wavescout_session'); window.location.href = 'login.html'; return; }
      setStats(statsRes.ok      ? await statsRes.json()      : null);
      setHistory(histRes.ok     ? await histRes.json()       : []);
      setAnalytics(analyticsRes.ok ? await analyticsRes.json() : null);
      setBreakdown(breakdownRes.ok ? await breakdownRes.json() : null);
    } catch (err) {
      console.error('Stats load error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  if (!stats) return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
      <p style={{ color: 'var(--text-tertiary)' }}>Keine Statistikdaten verfügbar</p>
      <button className="btn" style={{ marginTop: 16 }} onClick={() => { setLoading(true); loadStats(localStorage.getItem('wavescout_session')); }}>
        <Icon name="refresh" size={14}/> Neu laden
      </button>
    </div>
  );

  const totalClosed = stats.wins + stats.losses;
  const winRate = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;

  // PnL curve from history (closed trades only)
  const closedSorted = [...history]
    .filter(t => (t.outcome === 'WIN' || t.outcome === 'LOSS') && t.ai_entry && t.exit_price)
    .sort((a, b) => a.created_at - b.created_at);

  let cumulative = 0;
  const pnlPoints = closedSorted.map(t => {
    const diff = t.exit_price - t.ai_entry;
    cumulative += (t.direction === 'LONG' ? diff : -diff);
    return cumulative;
  });

  // Score distribution
  const scoreGroups = { '90-100': 0, '75-89': 0, '60-74': 0, '<60': 0 };
  history.forEach(t => {
    const s = t.ai_score || 0;
    if (s >= 90) scoreGroups['90-100']++;
    else if (s >= 75) scoreGroups['75-89']++;
    else if (s >= 60) scoreGroups['60-74']++;
    else scoreGroups['<60']++;
  });

  return (
    <div className="content page-enter">
      {toast && <div style={{ position: 'fixed', top: 66, right: 18, zIndex: 9999, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border)' }}>{toast}</div>}
      <div className="page-header">
        <h2>Statistiken & Analytics</h2>
        <p className="subtitle">{stats.total} Total Signale · {totalClosed} abgeschlossen · {stats.open} offen</p>
      </div>

      {/* Overview KPIs */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Abgeschlossen" value={totalClosed.toString()} sub={`${stats.total} Total Signale`}/>
        <StatCard label="Win-Rate" value={`${winRate.toFixed(1)}%`} sub={`${stats.wins}W / ${stats.losses}L`} subTone={winRate >= 50 ? 'win' : 'loss'}/>
        <StatCard label="Gewonnen" value={stats.wins.toString()} sub="Profitable Trades" subTone="win"/>
        <StatCard label="Verloren" value={stats.losses.toString()} sub="Unprofitable Trades" subTone="loss"/>
      </div>

      {/* PnL Chart */}
      {pnlPoints.length >= 2 && (
        <div className="card">
          <div className="card-head">
            <Icon name="chart" className="ico"/>
            <h3>Kumulativer PnL (Dollar)</h3>
            <div className="actions">
              <span className={`badge ${pnlPoints[pnlPoints.length-1] >= 0 ? 'badge-win' : 'badge-loss'}`}>
                {pnlPoints[pnlPoints.length-1] >= 0 ? '+' : ''}${pnlPoints[pnlPoints.length-1].toFixed(2)}
              </span>
            </div>
          </div>
          <div className="card-body" style={{ padding: '12px 20px 16px' }}>
            <PnLDollarChart points={pnlPoints}/>
          </div>
        </div>
      )}

      {/* Direction & Timeframe Breakdown */}
      {breakdown && (
        <div className="grid grid-2">
          {/* Direction Breakdown */}
          <div className="card">
            <div className="card-head">
              <Icon name="signal" className="ico"/>
              <h3>Long vs. Short</h3>
            </div>
            <div className="card-body">
              {breakdown.directions.length === 0 ? (
                <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: 20 }}>Noch keine Daten</p>
              ) : (
                breakdown.directions.map((d, i) => (
                  <BreakdownRow key={i} label={d.direction} total={d.total} wins={d.wins} losses={d.losses} winRate={d.winRate}/>
                ))
              )}
            </div>
          </div>

          {/* Timeframe Breakdown */}
          <div className="card">
            <div className="card-head">
              <Icon name="clock" className="ico"/>
              <h3>Performance nach Timeframe</h3>
            </div>
            {breakdown.timeframes.length === 0 ? (
              <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Trade-Daten</p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>TF</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr>
                </thead>
                <tbody>
                  {breakdown.timeframes.map((tf, i) => (
                    <tr key={i}>
                      <td className="mono">{tf.timeframe}m</td>
                      <td className="mono">{tf.total}</td>
                      <td className="mono win">{tf.wins}</td>
                      <td className="mono loss">{tf.losses}</td>
                      <td className="mono" style={{ color: tf.winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>
                        {tf.winRate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-2">
        {/* Symbol Performance */}
        <div className="card">
          <div className="card-head">
            <Icon name="target" className="ico"/>
            <h3>Performance nach Symbol</h3>
            {breakdown?.symbols && <div className="actions"><span className="badge badge-tag">Top {Math.min(breakdown.symbols.length, 8)}</span></div>}
          </div>
          {(!breakdown?.symbols || breakdown.symbols.length === 0) ? (
            <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Trade-Daten</p>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Symbol</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr>
              </thead>
              <tbody>
                {(breakdown.symbols || []).slice(0, 8).map((item, i) => (
                  <tr key={i}>
                    <td><AssetChip symbol={item.symbol}/></td>
                    <td className="mono">{item.total}</td>
                    <td className="mono win">{item.wins}</td>
                    <td className="mono loss">{item.losses}</td>
                    <td className="mono" style={{ color: item.winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>
                      {item.winRate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Score Distribution */}
        <div className="card">
          <div className="card-head">
            <Icon name="chart" className="ico"/>
            <h3>Score-Verteilung</h3>
          </div>
          <div className="card-body">
            {Object.entries(scoreGroups).map(([label, count]) => {
              const pct = history.length > 0 ? (count / history.length) * 100 : 0;
              return (
                <div key={label} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Score {label}</span>
                    <span className="mono" style={{ color: 'var(--text-primary)' }}>{count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: 'var(--blue-500)', borderRadius: 3, transition: 'width 0.5s ease' }}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Analytics Cards */}
      {analytics && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <StatCard
            label="Avg. Hold Time"
            value={formatDuration(analytics.avgHoldTimeMs)}
            sub="Durchschnittliche Trade-Dauer"
          />
          <StatCard
            label="Total Signale"
            value={(analytics.totalSignals ?? stats.total ?? 0).toString()}
            sub="Alle empfangenen Webhooks"
          />
          <StatCard
            label="Conversion Rate"
            value={`${(analytics.totalSignals ?? stats.total) > 0 ? ((totalClosed / (analytics.totalSignals ?? stats.total)) * 100).toFixed(1) : 0}%`}
            sub="Signale → abgeschlossene Trades"
          />
        </div>
      )}

      {/* Recent Trades */}
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Letzte 10 Trades</h3>
        </div>
        {history.length === 0 ? (
          <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Trades</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Zeit</th><th>Symbol</th><th>Richtung</th><th>TF</th><th>Score</th><th>Ergebnis</th></tr>
              </thead>
              <tbody>
                {history.slice(0, 10).map((t, i) => (
                  <tr key={i}>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {new Date(t.created_at).toLocaleDateString('de-DE')}
                    </td>
                    <td><AssetChip symbol={t.symbol}/></td>
                    <td>
                      <span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.direction}</span>
                    </td>
                    <td className="mono muted">{t.timeframe}m</td>
                    <td className="mono">{t.ai_score || 0}/100</td>
                    <td>
                      <window.OutcomeEditor
                        id={t.id}
                        currentOutcome={t.outcome}
                        type="signal"
                        onUpdated={(next) => setHistory(prev => prev.map(x => x.id === t.id ? { ...x, outcome: next } : x))}
                        showToast={(m) => showToast(m)}
                      />
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
};

// ─── Helpers ─────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function BreakdownRow({ label, total, wins, losses, winRate }) {
  const closed = wins + losses;
  const pct = closed > 0 ? (wins / closed) * 100 : 0;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`badge ${label === 'LONG' ? 'badge-long' : 'badge-short'}`}>{label}</span>
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{total} Trades</span>
        </div>
        <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 600, color: winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>
          {winRate}%
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--win)' }}>{wins}W</span>
        <span style={{ fontSize: 12, color: 'var(--text-quaternary)' }}>·</span>
        <span style={{ fontSize: 12, color: 'var(--loss)' }}>{losses}L</span>
        <span style={{ fontSize: 12, color: 'var(--text-quaternary)' }}>·</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{total - closed} offen</span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
        {closed > 0 && (
          <>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--win)', transition: 'width 0.5s ease' }}/>
            <div style={{ height: '100%', width: `${100 - pct}%`, background: 'var(--loss)', opacity: 0.6, transition: 'width 0.5s ease' }}/>
          </>
        )}
      </div>
    </div>
  );
}

function PnLDollarChart({ points }) {
  const W = 100, H = 60;
  if (!points || points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = v => H - ((v - min) / range) * H;
  const toX = i => (i / (points.length - 1)) * W;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fill  = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const last  = points[points.length - 1];
  const color = last >= 0 ? 'var(--win)' : 'var(--loss)';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 90 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="statPnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {zero > 0 && zero < H && (
        <line x1="0" y1={zero.toFixed(1)} x2={W} y2={zero.toFixed(1)} stroke="var(--border)" strokeWidth="0.5"/>
      )}
      <path d={fill} fill="url(#statPnlGrad)"/>
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.2"/>
    </svg>
  );
}

window.StatistikenPage = StatistikenPage;
