// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - BACKTESTING
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const BacktestPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);

  useEffect(() => {
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

    loadBacktestData(sessionId);
  }, []);

  const loadBacktestData = async (sessionId) => {
    try {
      const [historyRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=100`, {
          headers: { 'X-Session-ID': sessionId }
        }),
        fetch(`${API_URL}/stats`, {
          headers: { 'X-Session-ID': sessionId }
        })
      ]);

      const historyData = await historyRes.json();
      const statsData = await statsRes.json();

      setHistory(historyData);
      setStats(statsData);
      setLoading(false);
    } catch (err) {
      console.error('Error loading backtest data:', err);
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
        <Sidebar active="backtest" user={user} onLogout={handleLogout} />
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
            <div style={{color: 'var(--text-secondary)'}}>Lade Backtest-Daten...</div>
          </div>
        </main>
      </div>
    );
  }

  const totalTrades = stats ? stats.wins + stats.losses : 0;
  const winRate = totalTrades > 0 ? (stats.wins / totalTrades) * 100 : 0;

  return (
    <div className="app">
      <Sidebar active="backtest" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="🔬 Backtesting & Auswertung"
          subtitle={`${history.length} Signale analysiert · ${totalTrades} Trades abgeschlossen`}
        />
        <div className="content page-enter">

          {/* Performance Overview */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <StatCard
              label="Total Signale"
              value={history.length.toString()}
              sub="Alle empfangenen"
            />
            <StatCard
              label="Ausgeführt"
              value={totalTrades.toString()}
              sub={`${stats?.wins || 0}W · ${stats?.losses || 0}L`}
            />
            <StatCard
              label="Win-Rate"
              value={`${winRate.toFixed(1)}%`}
              sub="Abgeschlossene Trades"
              subTone={winRate >= 50 ? 'win' : 'loss'}
            />
            <StatCard
              label="Offen"
              value={(stats?.open || 0).toString()}
              sub="Noch nicht ausgeführt"
            />
          </div>

          {/* Trade History */}
          <div className="card">
            <div className="card-head">
              <Icon name="chart" className="ico"/>
              <h3>Trade History</h3>
              <div className="actions">
                <span className="badge badge-tag">{history.length} TOTAL</span>
              </div>
            </div>
            {history.length === 0 ? (
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="signal" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>Noch keine Trades vorhanden</p>
                <p style={{fontSize: 12, marginTop: 8}}>
                  TradingView sendet Signale hierher
                </p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Symbol</th>
                    <th>Richtung</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Score</th>
                    <th>Risiko</th>
                    <th>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((trade, i) => (
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
                      <td className="mono">
                        ${(trade.ai_entry || trade.price || 0).toFixed(2)}
                      </td>
                      <td className="mono">
                        {trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '-'}
                      </td>
                      <td className="mono">{trade.ai_score || 0}/100</td>
                      <td>
                        <span className={`badge ${
                          trade.ai_risk === 'LOW' ? 'badge-win' :
                          trade.ai_risk === 'HIGH' ? 'badge-loss' :
                          'badge-wait'
                        }`}>
                          {trade.ai_risk || 'MED'}
                        </span>
                      </td>
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

        </div>
      </main>
    </div>
  );
};

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

ReactDOM.createRoot(document.getElementById('root')).render(<BacktestPage/>);
