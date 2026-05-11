// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - STATISTIKEN
// ═══════════════════════════════════════════════════════════════

const StatistikenPage = ({ user }) => {
  const [loading, setLoading] = useState(true);
  const [stats, setStats]     = useState(null);
  const [history, setHistory] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadStats(sessionId);
  }, []);

  const loadStats = async (sessionId) => {
    try {
      const [statsRes, histRes, analyticsRes] = await Promise.all([
        fetch(`${API_URL}/stats`,            { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/history?limit=200`,{ headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/analytics`,        { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (statsRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setStats(statsRes.ok      ? await statsRes.json()      : null);
      setHistory(histRes.ok     ? await histRes.json()       : []);
      setAnalytics(analyticsRes.ok ? await analyticsRes.json() : null);
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
    </div>
  );

  const totalClosed = stats.wins + stats.losses;
  const winRate = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;

  // Group by symbol
  const bySymbol = {};
  history.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0, total: 0 };
    bySymbol[t.symbol].total++;
    if (t.outcome === 'WIN') bySymbol[t.symbol].wins++;
    if (t.outcome === 'LOSS') bySymbol[t.symbol].losses++;
  });
  const symbolStats = Object.entries(bySymbol)
    .map(([symbol, d]) => ({ symbol, ...d, winRate: d.total > 0 ? (d.wins / (d.wins + d.losses || 1)) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

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
      <div className="page-header">
        <h2>Statistiken & Analytics</h2>
        <p className="subtitle">{stats.total} Total Signale · {totalClosed} abgeschlossen · {stats.open} offen</p>
      </div>

      {/* Overview */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Abgeschlossen" value={totalClosed.toString()} sub={`${stats.total} Total Signale`}/>
        <StatCard label="Win-Rate" value={`${winRate.toFixed(1)}%`} sub={`${stats.wins}W / ${stats.losses}L`} subTone={winRate >= 50 ? 'win' : 'loss'}/>
        <StatCard label="Gewonnen" value={stats.wins.toString()} sub="Profitable Trades" subTone="win"/>
        <StatCard label="Verloren" value={stats.losses.toString()} sub="Unprofitable Trades" subTone="loss"/>
      </div>

      <div className="grid grid-2">
        {/* Performance by Symbol */}
        <div className="card">
          <div className="card-head">
            <Icon name="target" className="ico"/>
            <h3>Performance nach Symbol</h3>
            <div className="actions"><span className="badge badge-tag">Top {symbolStats.length}</span></div>
          </div>
          {symbolStats.length === 0 ? (
            <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Trade-Daten</p>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Symbol</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr>
              </thead>
              <tbody>
                {symbolStats.map((item, i) => (
                  <tr key={i}>
                    <td><AssetChip symbol={item.symbol}/></td>
                    <td className="mono">{item.total}</td>
                    <td className="mono win">{item.wins}</td>
                    <td className="mono loss">{item.losses}</td>
                    <td className="mono" style={{ color: item.winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>
                      {item.winRate.toFixed(1)}%
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
            value={analytics.totalSignals?.toString() || '0'}
            sub="Alle empfangenen Webhooks"
          />
          <StatCard
            label="Conversion Rate"
            value={`${analytics.totalSignals > 0 ? ((totalClosed / analytics.totalSignals) * 100).toFixed(1) : 0}%`}
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
          <table className="tbl">
            <thead>
              <tr><th>Zeit</th><th>Symbol</th><th>Richtung</th><th>Score</th><th>Ergebnis</th></tr>
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
                  <td className="mono">{t.ai_score || 0}/100</td>
                  <td>
                    <span className={`badge ${t.outcome === 'WIN' ? 'badge-win' : t.outcome === 'LOSS' ? 'badge-loss' : 'badge-wait'}`}>
                      {t.outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

function formatDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

window.StatistikenPage = StatistikenPage;
