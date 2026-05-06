// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - STATISTIKEN MIT LIVE-DATEN
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const StatistikenPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  useEffect(() => {
    // Check auth
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      window.location.href = 'login.html';
      return;
    }

    const parsedUser = JSON.parse(userData);
    setUser(parsedUser);

    if (parsedUser.mustChangePassword) {
      window.location.href = 'change-password.html';
      return;
    }

    loadStats(sessionId);
  }, []);

  const loadStats = async (sessionId) => {
    try {
      const [statsRes, historyRes, analyticsRes] = await Promise.all([
        fetch(`${API_URL}/stats`, {
          headers: { 'X-Session-ID': sessionId }
        }),
        fetch(`${API_URL}/history?limit=100`, {
          headers: { 'X-Session-ID': sessionId }
        }),
        fetch(`${API_URL}/analytics`, {
          headers: { 'X-Session-ID': sessionId }
        })
      ]);

      if (statsRes.status === 401) {
        localStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      const statsData = await statsRes.json();
      const historyData = await historyRes.json();
      const analyticsData = await analyticsRes.json();

      setStats(statsData);
      setHistory(historyData);
      setAnalytics(analyticsData);
      setLoading(false);
    } catch (err) {
      console.error('Error loading stats:', err);
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const sessionId = localStorage.getItem('wavescout_session');
    
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'X-Session-ID': sessionId }
      });
    } finally {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  };

  if (loading) {
    return (
      <div className="app">
        <Sidebar active="statistiken" user={user} onLogout={handleLogout} />
        <main className="main">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            flexDirection: 'column',
            gap: 20
          }}>
            <div className="spinner-lg"></div>
            <div style={{color: 'var(--text-secondary)'}}>Lade Statistiken...</div>
          </div>
        </main>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="app">
        <Sidebar active="statistiken" user={user} onLogout={handleLogout} />
        <main className="main">
          <div style={{padding: 40, textAlign: 'center'}}>
            <p>Fehler beim Laden der Statistiken</p>
            <button className="btn" onClick={() => window.location.reload()}>
              Neu laden
            </button>
          </div>
        </main>
      </div>
    );
  }

  // Calculate performance metrics
  const totalTrades = stats.wins + stats.losses;
  const winRate = totalTrades > 0 ? (stats.wins / totalTrades) * 100 : 0;
  
  // Group by symbol
  const bySymbol = {};
  history.forEach(trade => {
    if (!bySymbol[trade.symbol]) {
      bySymbol[trade.symbol] = { wins: 0, losses: 0, total: 0 };
    }
    bySymbol[trade.symbol].total++;
    if (trade.outcome === 'WIN') bySymbol[trade.symbol].wins++;
    if (trade.outcome === 'LOSS') bySymbol[trade.symbol].losses++;
  });

  const symbolStats = Object.entries(bySymbol)
    .map(([symbol, data]) => ({
      symbol,
      ...data,
      winRate: data.total > 0 ? (data.wins / (data.wins + data.losses)) * 100 : 0
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return (
    <div className="app">
      <Sidebar active="statistiken" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="📊 Statistiken & Analytics"
          subtitle={`${stats.total} Total Signale · ${totalTrades} abgeschlossen · ${stats.open} offen`}
        />
        <div className="content page-enter">

          {/* Overview Stats */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <StatCard
              label="Gesamt Trades"
              value={totalTrades.toString()}
              sub={`${stats.total} Total Signale`}
            />
            <StatCard
              label="Win-Rate"
              value={`${winRate.toFixed(1)}%`}
              sub={`${stats.wins}W / ${stats.losses}L`}
              subTone={winRate >= 50 ? 'win' : 'loss'}
            />
            <StatCard
              label="Gewonnen"
              value={stats.wins.toString()}
              sub="Profitable Trades"
              subTone="win"
            />
            <StatCard
              label="Verloren"
              value={stats.losses.toString()}
              sub="Unprofitable Trades"
              subTone="loss"
            />
          </div>

          {/* Performance by Symbol */}
          <div className="card">
            <div className="card-head">
              <Icon name="target" className="ico"/>
              <h3>Performance nach Symbol</h3>
              <div className="actions">
                <span className="badge badge-tag">Top 5</span>
              </div>
            </div>
            {symbolStats.length === 0 ? (
              <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
                <p style={{color: 'var(--text-tertiary)'}}>Keine Trades vorhanden</p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Trades</th>
                    <th>Wins</th>
                    <th>Losses</th>
                    <th>Win-Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {symbolStats.map((item, i) => (
                    <tr key={i}>
                      <td><AssetChip symbol={item.symbol}/></td>
                      <td className="mono">{item.total}</td>
                      <td className="mono win">{item.wins}</td>
                      <td className="mono loss">{item.losses}</td>
                      <td className="mono" style={{
                        color: item.winRate >= 50 ? 'var(--win)' : 'var(--loss)'
                      }}>
                        {item.winRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent Performance */}
          <div className="card">
            <div className="card-head">
              <Icon name="chart" className="ico"/>
              <h3>Letzte 10 Trades</h3>
            </div>
            {history.length === 0 ? (
              <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
                <Icon name="signal" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>Noch keine Trades</p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Symbol</th>
                    <th>Richtung</th>
                    <th>Score</th>
                    <th>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 10).map((trade, i) => (
                    <tr key={i}>
                      <td className="mono muted" style={{fontSize: 11}}>
                        {new Date(trade.created_at).toLocaleDateString('de-DE')}
                      </td>
                      <td><AssetChip symbol={trade.symbol}/></td>
                      <td>
                        <span className={`badge ${
                          trade.direction === 'LONG' ? 'badge-long' : 'badge-short'
                        }`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="mono">{trade.ai_score || 0}/100</td>
                      <td>
                        <span className={`badge ${
                          trade.outcome === 'WIN' ? 'badge-win' :
                          trade.outcome === 'LOSS' ? 'badge-loss' :
                          'badge-wait'
                        }`}>
                          {trade.outcome}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Analytics */}
          {analytics && (
            <div className="grid" style={{gridTemplateColumns: 'repeat(3, 1fr)'}}>
              <StatCard
                label="Avg. Hold Time"
                value={formatDuration(analytics.avgHoldTimeMs)}
                sub="Durchschnittliche Trade-Dauer"
              />
              <StatCard
                label="Total Signale"
                value={analytics.totalSignals.toString()}
                sub="Alle empfangenen Signale"
              />
              <StatCard
                label="Conversion Rate"
                value={`${totalTrades > 0 ? ((totalTrades / analytics.totalSignals) * 100).toFixed(1) : 0}%`}
                sub="Signale → Trades"
              />
            </div>
          )}

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════

const StatCard = ({ label, value, sub, subTone = 'muted', icon }) => (
  <div className="stat" data-tip={sub}>
    <div className="label" style={{display: 'flex', alignItems: 'center', gap: 6}}>
      {icon && <Icon name={icon} size={11}/>}
      {label}
    </div>
    <div className="value">{value}</div>
    {sub && <div className={`sub ${subTone}`}>{sub}</div>}
  </div>
);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

ReactDOM.createRoot(document.getElementById('root')).render(<StatistikenPage/>);
