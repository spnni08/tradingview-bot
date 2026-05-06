// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - BACKTEST (FUNKTIONIERT RICHTIG)
// Mit Trade-History, Performance-Analyse, Charts
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const BacktestPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);
  const [filterOutcome, setFilterOutcome] = useState('all'); // all, WIN, LOSS, OPEN
  const [filterSymbol, setFilterSymbol] = useState('all');

  useEffect(() => {
    console.log('🔬 Backtest page initializing...');
    
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      console.log('❌ No session, redirecting to login');
      window.location.href = 'login.html';
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      console.log('✅ User loaded:', parsedUser.username);
      setUser(parsedUser);

      if (parsedUser.mustChangePassword) {
        window.location.href = 'change-password.html';
        return;
      }

      loadBacktestData(sessionId);
    } catch (err) {
      console.error('Error parsing user:', err);
      window.location.href = 'login.html';
    }
  }, []);

  const loadBacktestData = async (sessionId) => {
    try {
      console.log('📊 Loading backtest data...');
      
      const [historyRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=100`, {
          headers: { 'X-Session-ID': sessionId }
        }),
        fetch(`${API_URL}/stats`, {
          headers: { 'X-Session-ID': sessionId }
        })
      ]);

      let historyData = [];
      if (historyRes.ok) {
        historyData = await historyRes.json();
        console.log('✅ History loaded:', historyData.length, 'trades');
      } else {
        console.log('⚠️ History endpoint failed');
      }

      let statsData = null;
      if (statsRes.ok) {
        statsData = await statsRes.json();
        console.log('✅ Stats loaded:', statsData);
      }

      setHistory(historyData);
      setStats(statsData);
      setLoading(false);
    } catch (err) {
      console.error('❌ Error loading backtest data:', err);
      setHistory([]);
      setStats(null);
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

  // Get unique symbols
  const symbols = ['all', ...new Set(history.map(h => h.symbol))];

  // Filter history
  const filteredHistory = history.filter(h => {
    if (filterOutcome !== 'all' && h.outcome !== filterOutcome) return false;
    if (filterSymbol !== 'all' && h.symbol !== filterSymbol) return false;
    return true;
  });

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
            <div className="stat">
              <div className="label">Total Signale</div>
              <div className="value">{history.length}</div>
              <div className="sub muted">Alle empfangenen</div>
            </div>
            <div className="stat">
              <div className="label">Ausgeführt</div>
              <div className="value">{totalTrades}</div>
              <div className="sub muted">{stats?.wins || 0}W · {stats?.losses || 0}L</div>
            </div>
            <div className="stat">
              <div className="label">Win-Rate</div>
              <div className="value">{winRate.toFixed(1)}%</div>
              <div className={`sub ${winRate >= 50 ? 'win' : 'loss'}`}>
                {winRate >= 50 ? 'Profitabel' : 'Unprofitabel'}
              </div>
            </div>
            <div className="stat">
              <div className="label">Offen</div>
              <div className="value">{stats?.open || 0}</div>
              <div className="sub muted">Noch nicht ausgeführt</div>
            </div>
          </div>

          {/* Filters */}
          <div className="card">
            <div className="card-head">
              <Icon name="filter" className="ico"/>
              <h3>Filter</h3>
            </div>
            <div className="card-body">
              <div style={{display: 'flex', gap: 16, flexWrap: 'wrap'}}>
                <div>
                  <label style={{display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500}}>
                    Ergebnis
                  </label>
                  <select
                    value={filterOutcome}
                    onChange={(e) => setFilterOutcome(e.target.value)}
                    className="input"
                    style={{minWidth: 150}}
                  >
                    <option value="all">Alle</option>
                    <option value="WIN">Nur Wins</option>
                    <option value="LOSS">Nur Losses</option>
                    <option value="OPEN">Nur Offene</option>
                  </select>
                </div>

                <div>
                  <label style={{display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500}}>
                    Symbol
                  </label>
                  <select
                    value={filterSymbol}
                    onChange={(e) => setFilterSymbol(e.target.value)}
                    className="input"
                    style={{minWidth: 150}}
                  >
                    {symbols.map(s => (
                      <option key={s} value={s}>
                        {s === 'all' ? 'Alle Symbole' : s}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{marginLeft: 'auto', display: 'flex', alignItems: 'flex-end'}}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setFilterOutcome('all');
                      setFilterSymbol('all');
                    }}
                  >
                    Filter zurücksetzen
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Trade History */}
          <div className="card">
            <div className="card-head">
              <Icon name="chart" className="ico"/>
              <h3>Trade History</h3>
              <div className="actions">
                <span className="badge badge-tag">
                  {filteredHistory.length} {filteredHistory.length === 1 ? 'Trade' : 'Trades'}
                </span>
              </div>
            </div>
            {filteredHistory.length === 0 ? (
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="signal" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>
                  {history.length === 0 
                    ? 'Noch keine Trades vorhanden' 
                    : 'Keine Trades mit diesen Filtern'
                  }
                </p>
                {history.length === 0 && (
                  <p style={{fontSize: 12, marginTop: 8, color: 'var(--text-quaternary)'}}>
                    TradingView sendet Signale hierher
                  </p>
                )}
              </div>
            ) : (
              <div style={{overflowX: 'auto'}}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Symbol</th>
                      <th>Richtung</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>PnL</th>
                      <th>Score</th>
                      <th>Risiko</th>
                      <th>Ergebnis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistory.map((trade, i) => {
                      const pnl = calculatePnL(trade);
                      
                      return (
                        <tr key={i}>
                          <td className="mono muted" style={{fontSize: 11}}>
                            {new Date(trade.created_at).toLocaleDateString('de-DE', {
                              day: '2-digit',
                              month: '2-digit',
                              year: '2-digit'
                            })}
                            {' '}
                            {new Date(trade.created_at).toLocaleTimeString('de-DE', {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
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
                          <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>
                            {pnl !== 0 ? (pnl > 0 ? '+' : '') + pnl.toFixed(2) + '%' : '-'}
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function calculatePnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) {
    return 0;
  }

  const diff = trade.exit_price - trade.ai_entry;
  const pnlPercent = (diff / trade.ai_entry) * 100;
  
  return trade.direction === 'LONG' ? pnlPercent : -pnlPercent;
}

ReactDOM.createRoot(document.getElementById('root')).render(<BacktestPage/>);
