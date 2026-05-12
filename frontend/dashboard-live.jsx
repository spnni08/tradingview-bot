// WaveScout — Dashboard page MIT LIVE-DATEN
const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [user, setUser] = useState(null);
  const [toast, setToast] = useState(null);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

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

    // Check if password must be changed
    if (parsedUser.mustChangePassword) {
      window.location.href = 'change-password.html';
      return;
    }

    loadLiveData(sessionId);

    // Refresh every 30 seconds
    const interval = setInterval(() => loadLiveData(sessionId), 30000);
    return () => clearInterval(interval);
  }, []);

  const loadLiveData = async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/dashboard/live`, {
        headers: { 'X-Session-ID': sessionId }
      });

      if (response.status === 401) {
        localStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      const liveData = await response.json();
      setData(liveData);
      setLoading(false);
    } catch (error) {
      console.error('Error loading live data:', error);
      setLoading(false);
    }
  };

  const handleLogout = () => {
    const sessionId = localStorage.getItem('wavescout_session');
    fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId }
    }).finally(() => {
      localStorage.clear();
      window.location.href = 'login.html';
    });
  };

  if (loading) {
    return (
      <div className="app">
        <Sidebar active="dashboard" />
        <main className="main">
          <div style={{display:'flex', alignItems:'center', justifyContent:'center', height:'100vh'}}>
            <div className="spinner-lg"></div>
          </div>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <Sidebar active="dashboard" />
        <main className="main">
          <div style={{padding:40, textAlign:'center'}}>
            <p>Fehler beim Laden der Daten</p>
            <button className="btn" onClick={() => window.location.reload()}>Neu laden</button>
          </div>
        </main>
      </div>
    );
  }

  const kpis = [
    { label: 'Equity', value: <CountUp to={data.stats.equity} prefix="$" decimals={2}/>, color: 'var(--text-primary)', tip: 'Gesamtkapital im Account' },
    { label: 'Tages-PnL', value: <CountUp to={data.stats.todayPnL} prefix="$" decimals={2} sign/>, color: data.stats.todayPnL >= 0 ? 'var(--win)' : 'var(--loss)', tip: 'PnL seit 00:00 UTC' },
    { label: 'Win-Rate', value: <CountUp to={data.stats.winRate} suffix="%" decimals={1}/>, color: 'var(--win)', tip: 'Alle Trades' },
  ];

  return (
    <div className="app">
      <Sidebar active="dashboard" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title={`Guten ${getGreeting()}, ${user?.username || 'Trader'} 👋`}
          subtitle={`${data.latestSignals?.length || 0} neue Signale · ${data.stats.totalTrades} Total Trades · Live-Daten aktiv`}
          kpis={kpis}
        />
        <div className="content page-enter">
          {toast && <div style={{ position: 'fixed', top: 66, right: 18, zIndex: 9999, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-1)', border: '1px solid var(--border)' }}>{toast}</div>}

          {/* Row 1: Best Signal + Markt Bias */}
          <div className="grid grid-2" style={{gridTemplateColumns: '1.4fr 1fr'}}>
            <BestSignalCard signal={data.bestSignal} />
            <MarktBiasCard marketBias={data.marketBias} />
          </div>

          {/* Row 2: KPIs */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <StatCard 
              label="Trades heute" 
              value={data.stats.totalTrades.toString()} 
              sub={`${data.stats.wins} gewonnen · ${data.stats.losses} verloren`}
            />
            <StatCard 
              label="Win-Rate" 
              value={`${data.stats.winRate.toFixed(1)}%`} 
              sub="Alle Trades" 
              subTone="win"
            />
            <StatCard 
              label="Total Trades" 
              value={data.stats.totalTrades.toString()} 
              sub={`${data.stats.wins}W / ${data.stats.losses}L`}
            />
            <StatCard 
              label="Live-Status" 
              value="AKTIV" 
              sub="System läuft" 
              subTone="win" 
              icon="signal"
            />
          </div>

          {/* Row 3: Latest Signals */}
          <RecentSignalsCard
            signals={data.latestSignals}
            onOutcomeLocal={(id, outcome) => setData(prev => ({ ...prev, latestSignals: (prev.latestSignals || []).map(s => s.id === id ? { ...s, outcome } : s) }))}
            showToast={showToast}
          />

        </div>
      </main>
      <ShortcutsOverlay />
      <HintChip />
    </div>
  );
};

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Morgen';
  if (hour < 18) return 'Tag';
  return 'Abend';
}

// ───── Best Signal (LIVE DATA) ─────
const BestSignalCard = ({ signal }) => {
  if (!signal) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="bolt" className="ico" />
          <h3>Bestes Signal</h3>
        </div>
        <div className="card-body" style={{padding:40, textAlign:'center', color:'var(--text-tertiary)'}}>
          <Icon name="signal" size={32} />
          <p style={{marginTop:12}}>Keine offenen Signale verfügbar</p>
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
            <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:14}}>
              <AssetChip symbol={signal.symbol} />
              <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                {signal.direction}
              </span>
            </div>

            <div className="signal-meta">
              <div className="cell">
                <div className="l">Entry</div>
                <div className="v mono">${signal.ai_entry?.toFixed(2) || 'N/A'}</div>
              </div>
              <div className="cell">
                <div className="l">Stop Loss</div>
                <div className="v mono">${signal.ai_sl?.toFixed(2) || 'N/A'}</div>
              </div>
              <div className="cell">
                <div className="l">Take Profit</div>
                <div className="v mono win">${signal.ai_tp?.toFixed(2) || 'N/A'}</div>
              </div>
            </div>

            <div style={{marginTop:14, padding:12, background:'var(--bg-1)', borderRadius:8}}>
              <div style={{fontSize:12, color:'var(--text-tertiary)', marginBottom:6}}>Begründung:</div>
              <div style={{fontSize:13, lineHeight:1.5}}>{signal.ai_reason || 'Keine Begründung verfügbar'}</div>
            </div>

            <div style={{display:'flex', gap:10, marginTop:18}}>
              <button className="btn btn-primary" data-tip="Trade ausführen (Hotkey: T)">
                <Icon name="bolt" size={14}/>
                Trade ausführen
              </button>
              <button className="btn" data-tip="Signal in Journal speichern">
                <Icon name="book" size={14}/>
                Im Journal speichern
              </button>
              <button className="btn btn-ghost" data-tip="Signal verwerfen (I)">Ignorieren</button>
            </div>
          </div>

          <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:8}}>
            <div className="score-ring" style={{'--pct': signal.ai_score || 0}}>
              <div className="score-text">{signal.ai_score || 0}</div>
              <div className="score-sub">SCORE</div>
            </div>
            <div style={{fontSize:11, color:'var(--text-tertiary)', textAlign:'center', maxWidth:120}}>
              {signal.ai_score >= 75 ? 'Sehr starkes Setup' : signal.ai_score >= 65 ? 'Gutes Setup' : 'Moderates Setup'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───── Markt Bias (LIVE DATA) ─────
const MarktBiasCard = ({ marketBias }) => {
  if (!marketBias || marketBias.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="target" className="ico"/>
          <h3>Markt Bias</h3>
        </div>
        <div className="card-body" style={{padding:40, textAlign:'center', color:'var(--text-tertiary)'}}>
          Keine Daten verfügbar
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
      <div className="card-body" style={{padding: '6px 18px 14px'}}>
        {marketBias.map((r, i) => (
          <div className="bias-row" key={i}>
            <AssetChip symbol={r.symbol} />
            <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, minWidth:80}}>
              <span className="mono" style={{fontSize:13}}>${r.price?.toFixed(2) || 'N/A'}</span>
              <span className={`badge ${
                r.trend === 'bullish' ? 'badge-bullish' : 
                r.trend === 'bearish' ? 'badge-bearish' : 
                'badge-neutral'
              }`}>
                {r.trend === 'bullish' ? 'BULLISH' : r.trend === 'bearish' ? 'BEARISH' : 'NEUTRAL'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───── Recent Signals (LIVE DATA) ─────
const RecentSignalsCard = ({ signals, onOutcomeLocal, showToast }) => {
  if (!signals || signals.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Letzte Signale</h3>
        </div>
        <div className="card-body" style={{padding:40, textAlign:'center', color:'var(--text-tertiary)'}}>
          Keine Signale vorhanden
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Letzte Signale · {signals.length}</h3>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Richtung</th>
            <th>Score</th>
            <th>Status</th>
            <th>Zeit</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr key={i}>
              <td><AssetChip symbol={s.symbol}/></td>
              <td>
                <span className={`badge ${s.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                  {s.direction}
                </span>
              </td>
              <td className="mono">{s.ai_score}/100</td>
              <td>
                <window.OutcomeEditor
                  id={s.id}
                  currentOutcome={s.outcome}
                  type="signal"
                  onUpdated={(next) => onOutcomeLocal?.(s.id, next)}
                  showToast={(m) => showToast?.(m)}
                />
              </td>
              <td className="mono muted" style={{fontSize:11}}>{getTimeAgo(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ───── Stat Card ─────
const StatCard = ({ label, value, sub, subTone = 'muted', icon }) => (
  <div className="stat" data-tip={`${label}: ${value}`}>
    <div className="label" style={{display:'flex', alignItems:'center', gap:6}}>
      {icon && <Icon name={icon} size={11}/>}
      {label}
    </div>
    <div className="value">{value}</div>
    {sub && <div className={`sub ${subTone}`}>{sub}</div>}
  </div>
);

// Helper functions
function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'gerade eben';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  const days = Math.floor(hours / 24);
  return `vor ${days}d`;
}

ReactDOM.createRoot(document.getElementById('root')).render(<Dashboard/>);
