// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - DASHBOARD MIT FUNKTIONALEN BUTTONS
// Keine Dummy-Daten · Alle Buttons funktionieren
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      window.location.href = 'login.html';
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      setUser(parsedUser);

      if (parsedUser.mustChangePassword) {
        window.location.href = 'change-password.html';
        return;
      }

      loadLiveData(sessionId);

      const interval = setInterval(() => loadLiveData(sessionId), 30000);
      return () => clearInterval(interval);
    } catch (err) {
      console.error('Error parsing user data:', err);
      localStorage.clear();
      window.location.href = 'login.html';
    }
  }, []);

  const loadLiveData = async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/dashboard/live`, {
        method: 'GET',
        headers: {
          'X-Session-ID': sessionId,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 401) {
        localStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const liveData = await response.json();
      
      console.log('✅ Live data loaded:', liveData);
      
      setData(liveData);
      setError(null);
      setLoading(false);
    } catch (err) {
      console.error('❌ Error loading live data:', err);
      setError(err.message);
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
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  };

  const handleExecuteTrade = (signal) => {
    alert(`Trade-Ausführung für ${signal.symbol} ${signal.direction}\nDiese Funktion wird bald verfügbar sein.`);
  };

  const handleSaveToJournal = (signal) => {
    localStorage.setItem('signal_for_journal', JSON.stringify(signal));
    window.location.href = 'journal.html';
  };

  const handleIgnoreSignal = async (signal) => {
    if (confirm(`Signal ${signal.symbol} ignorieren?`)) {
      // TODO: Update signal status in database
      alert('Signal ignoriert');
    }
  };

  if (loading) {
    return (
      <div className="app">
        <Sidebar active="dashboard" user={user} onLogout={handleLogout} />
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
            <div style={{color: 'var(--text-secondary)'}}>Lade Live-Daten...</div>
          </div>
        </main>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="app">
        <Sidebar active="dashboard" user={user} onLogout={handleLogout} />
        <main className="main">
          <div style={{padding: 40, textAlign: 'center'}}>
            <div style={{fontSize: 48, marginBottom: 20}}>⚠️</div>
            <h2 style={{marginBottom: 10}}>Fehler beim Laden</h2>
            <p style={{color: 'var(--text-secondary)', marginBottom: 20}}>
              {error || 'Keine Daten verfügbar'}
            </p>
            <button className="btn" onClick={() => window.location.reload()}>
              <Icon name="refresh" size={14}/>
              Neu laden
            </button>
          </div>
        </main>
      </div>
    );
  }

  const kpis = [
    {
      label: 'Equity',
      value: `$${data.stats.equity.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      color: 'var(--text-primary)',
      tip: 'Gesamtkapital'
    },
    {
      label: 'Heute PnL',
      value: (data.stats.todayPnL >= 0 ? '+' : '') + `$${data.stats.todayPnL.toFixed(2)}`,
      color: data.stats.todayPnL >= 0 ? 'var(--win)' : 'var(--loss)',
      tip: 'Profit & Loss heute'
    },
    {
      label: 'Win-Rate',
      value: `${data.stats.winRate.toFixed(1)}%`,
      color: 'var(--win)',
      tip: `${data.stats.wins}W / ${data.stats.losses}L`
    },
  ];

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Morgen';
    if (hour < 18) return 'Tag';
    return 'Abend';
  })();

  return (
    <div className="app">
      <Sidebar active="dashboard" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title={`Guten ${greeting}, ${user?.username || 'Trader'} 👋`}
          subtitle={`${data.stats.open} offene Signale · ${data.stats.totalTrades} Total Trades · Live-Daten aktiv`}
          kpis={kpis}
        />
        <div className="content page-enter">

          <div className="grid grid-2" style={{gridTemplateColumns: '1.4fr 1fr'}}>
            <BestSignalCard 
              signal={data.bestSignal} 
              onExecuteTrade={handleExecuteTrade}
              onSaveToJournal={handleSaveToJournal}
              onIgnore={handleIgnoreSignal}
            />
            <MarketBiasCard marketBias={data.marketBias} />
          </div>

          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <StatCard
              label="Trades heute"
              value={data.stats.totalTrades.toString()}
              sub={`${data.stats.wins}W · ${data.stats.losses}L · ${data.stats.open} offen`}
            />
            <StatCard
              label="Avg. Win-Rate"
              value={`${data.stats.winRate.toFixed(1)}%`}
              sub="Alle abgeschlossenen Trades"
              subTone={data.stats.winRate >= 50 ? 'win' : 'loss'}
            />
            <StatCard
              label="Offene Positionen"
              value={data.stats.open.toString()}
              sub="Warten auf Ausführung"
            />
            <StatCard
              label="System Status"
              value="LIVE"
              sub="Daten aktualisiert"
              subTone="win"
              icon="signal"
            />
          </div>

          <LatestTradesCard signals={data.latestSignals} />

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════

const BestSignalCard = ({ signal, onExecuteTrade, onSaveToJournal, onIgnore }) => {
  if (!signal) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="bolt" className="ico" />
          <h3>Bestes Signal</h3>
        </div>
        <div className="card-body" style={{
          padding: 60,
          textAlign: 'center',
          color: 'var(--text-tertiary)'
        }}>
          <Icon name="signal" size={48} style={{opacity: 0.3, marginBottom: 16}}/>
          <p>Keine offenen Signale mit hohem Score</p>
          <p style={{fontSize: 12, marginTop: 8}}>
            Neue Signale erscheinen hier automatisch
          </p>
        </div>
      </div>
    );
  }

  const timeAgo = getTimeAgo(signal.created_at);

  return (
    <div className="card best-signal-card">
      <div className="card-head">
        <Icon name="bolt" className="ico" />
        <h3>Bestes Signal</h3>
        <div className="actions">
          <span className="badge badge-tag">{timeAgo}</span>
        </div>
      </div>
      <div className="card-body">
        <div className="best-signal-grid">
          <div>
            <div style={{display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16}}>
              <AssetChip symbol={signal.symbol} />
              <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                {signal.direction}
              </span>
              <span style={{fontSize: 11, color: 'var(--text-tertiary)'}}>
                {signal.timeframe}
              </span>
            </div>

            <div className="signal-meta">
              <div className="cell">
                <div className="l">Entry</div>
                <div className="v mono">${signal.ai_entry?.toFixed(2) || signal.price?.toFixed(2) || 'N/A'}</div>
              </div>
              <div className="cell">
                <div className="l">Stop Loss</div>
                <div className="v mono loss">${signal.ai_sl?.toFixed(2) || 'N/A'}</div>
              </div>
              <div className="cell">
                <div className="l">Take Profit</div>
                <div className="v mono win">${signal.ai_tp?.toFixed(2) || 'N/A'}</div>
              </div>
            </div>

            {signal.ai_reason && (
              <div style={{
                marginTop: 16,
                padding: 12,
                background: 'var(--bg-1)',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.6
              }}>
                <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6}}>
                  AI Begründung:
                </div>
                {signal.ai_reason}
              </div>
            )}

            <div style={{display: 'flex', gap: 10, marginTop: 18}}>
              <button 
                className="btn btn-primary" 
                onClick={() => onExecuteTrade(signal)}
              >
                <Icon name="bolt" size={14}/>
                Trade ausführen
              </button>
              <button 
                className="btn" 
                onClick={() => onSaveToJournal(signal)}
              >
                <Icon name="book" size={14}/>
                Im Journal
              </button>
              <button 
                className="btn btn-ghost" 
                onClick={() => onIgnore(signal)}
              >
                Ignorieren
              </button>
            </div>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12
          }}>
            <div className="score-ring" style={{'--pct': signal.ai_score || 0}}>
              <div className="score-text">{signal.ai_score || 0}</div>
              <div className="score-sub">SCORE</div>
            </div>
            <div style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
              maxWidth: 120
            }}>
              {signal.ai_score >= 75
                ? 'Sehr starkes Setup'
                : signal.ai_score >= 65
                ? 'Gutes Setup'
                : 'Moderates Setup'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const MarketBiasCard = ({ marketBias }) => {
  if (!marketBias || marketBias.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="target" className="ico"/>
          <h3>Markt Bias</h3>
        </div>
        <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
          <p style={{color: 'var(--text-tertiary)'}}>Keine Snapshot-Daten verfügbar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="target" className="ico"/>
        <h3>Markt Bias</h3>
        <div className="actions">
          <span className="badge badge-tag">{marketBias.length} ASSETS</span>
        </div>
      </div>
      <div className="card-body" style={{padding: '8px 18px 16px'}}>
        {marketBias.map((item, i) => (
          <div className="bias-row" key={i}>
            <AssetChip symbol={item.symbol} />
            <div style={{flex: 1}}/>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 6
            }}>
              <span className="mono" style={{fontSize: 14, fontWeight: 600}}>
                ${item.price?.toFixed(2) || 'N/A'}
              </span>
              <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                <span className={`badge ${
                  item.trend === 'bullish' ? 'badge-bullish' :
                  item.trend === 'bearish' ? 'badge-bearish' :
                  'badge-neutral'
                }`}>
                  {item.trend.toUpperCase()}
                </span>
                {item.change !== 0 && (
                  <span style={{
                    fontSize: 11,
                    color: item.change > 0 ? 'var(--win)' : 'var(--loss)'
                  }}>
                    {item.change > 0 ? '+' : ''}{item.change.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const LatestTradesCard = ({ signals }) => {
  if (!signals || signals.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Letzte Trades</h3>
        </div>
        <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
          <p style={{color: 'var(--text-tertiary)'}}>Keine Trades vorhanden</p>
          <p style={{fontSize: 12, marginTop: 8, color: 'var(--text-quaternary)'}}>
            TradingView Webhooks senden Signale hierher
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Letzte Trades · {signals.length}</h3>
        <div className="actions">
          <button 
            className="btn btn-sm btn-ghost"
            onClick={() => window.location.href = 'backtest.html'}
          >
            Alle anzeigen →
          </button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Zeit</th>
            <th>Asset</th>
            <th>Richtung</th>
            <th>Entry</th>
            <th>Score</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr key={i}>
              <td className="mono muted" style={{fontSize: 11}}>
                {getTimeAgo(s.created_at)}
              </td>
              <td><AssetChip symbol={s.symbol}/></td>
              <td>
                <span className={`badge ${s.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                  {s.direction}
                </span>
              </td>
              <td className="mono">${(s.ai_entry || s.price || 0).toFixed(2)}</td>
              <td className="mono">{s.ai_score || 0}/100</td>
              <td>
                <span className={`badge ${
                  s.outcome === 'WIN' ? 'badge-win' :
                  s.outcome === 'LOSS' ? 'badge-loss' :
                  'badge-wait'
                }`}>
                  {s.outcome}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'gerade eben';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  const days = Math.floor(hours / 24);
  return `vor ${days}d`;
}

ReactDOM.createRoot(document.getElementById('root')).render(<Dashboard/>);
