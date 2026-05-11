// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - DASHBOARD
// ═══════════════════════════════════════════════════════════════

const DashboardPage = ({ user, navigate }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadLiveData(sessionId);
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json());
      setError(null);
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleExecuteTrade = (signal) => {
    // Trade execution placeholder — broker API integration needed
    window.alert(`Trade-Ausführung für ${signal.symbol} ${signal.direction}\nDiese Funktion erfordert Broker-API-Integration.`);
  };

  const handleSaveToJournal = (signal) => {
    localStorage.setItem('signal_for_journal', JSON.stringify(signal));
    navigate('journal');
  };

  const handleIgnoreSignal = async (signal) => {
    if (!window.confirm(`Signal ${signal.symbol} ${signal.direction} ignorieren?`)) return;
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/signals/${signal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ outcome: 'IGNORED' })
      });
      loadLiveData(sessionId);
    } catch (err) {
      console.error('Ignore error:', err);
    }
  };

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  if (error || !data) return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
      <p style={{ color: 'var(--text-tertiary)', marginBottom: 16 }}>Fehler beim Laden: {error}</p>
      <button className="btn" onClick={() => { setLoading(true); loadLiveData(localStorage.getItem('wavescout_session')); }}>
        <Icon name="refresh" size={14}/> Neu laden
      </button>
    </div>
  );

  const stats = data?.stats || { totalTrades: 0, wins: 0, losses: 0, open: 0, todayPnL: 0, winRate: 0 };
  const bestSignal = data?.bestSignal || null;
  const latestSignals = Array.isArray(data?.latestSignals) ? data.latestSignals : [];
  const marketBias = data?.marketBias || null;
  const todayPnL = stats.todayPnL ?? 0;
  const winRate  = stats.winRate  ?? 0;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Morgen';
    if (h < 18) return 'Tag';
    return 'Abend';
  })();

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Guten {greeting}, {user?.username || 'Trader'}</h2>
        <p className="subtitle">
          {stats.open} offene Signale · {stats.totalTrades} Total Trades · Live-Daten
        </p>
      </div>

      <div className="grid grid-2" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <BestSignalCard
          signal={bestSignal}
          onExecuteTrade={handleExecuteTrade}
          onSaveToJournal={handleSaveToJournal}
          onIgnore={handleIgnoreSignal}
        />
        <MarketBiasCard marketBias={marketBias}/>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard
          label="Trades gesamt"
          value={stats.totalTrades.toString()}
          sub={`${stats.wins}W · ${stats.losses}L · ${stats.open} offen`}
        />
        <StatCard
          label="Win-Rate"
          value={`${winRate.toFixed(1)}%`}
          sub="Alle abgeschlossenen Trades"
          subTone={winRate >= 50 ? 'win' : 'loss'}
        />
        <StatCard
          label="Heute PnL"
          value={(todayPnL >= 0 ? '+' : '') + `$${todayPnL.toFixed(2)}`}
          sub="Profit & Loss heute"
          subTone={todayPnL >= 0 ? 'win' : 'loss'}
        />
        <StatCard
          label="System"
          value="LIVE"
          sub="Daten aktualisiert"
          subTone="win"
          icon="signal"
        />
      </div>

      <LatestTradesCard signals={latestSignals} onViewAll={() => navigate('backtest')}/>
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────

const BestSignalCard = ({ signal, onExecuteTrade, onSaveToJournal, onIgnore }) => {
  if (!signal) return (
    <div className="card">
      <div className="card-head">
        <Icon name="bolt" className="ico"/>
        <h3>Bestes Signal</h3>
      </div>
      <div className="card-body" style={{ padding: 60, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <Icon name="signal" size={40} style={{ opacity: 0.2, marginBottom: 14 }}/>
        <p>Keine offenen Signale</p>
        <p style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>Neue Signale erscheinen hier automatisch</p>
      </div>
    </div>
  );

  return (
    <div className="card best-signal-card">
      <div className="card-head">
        <Icon name="bolt" className="ico"/>
        <h3>Bestes Signal</h3>
        <div className="actions">
          <span className="badge badge-tag">{getTimeAgo(signal.created_at)}</span>
        </div>
      </div>
      <div className="card-body">
        <div className="best-signal-grid">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <AssetChip symbol={signal.symbol}/>
              <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                {signal.direction}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{signal.timeframe}</span>
            </div>

            <div className="signal-meta">
              <div className="cell">
                <div className="l">Entry</div>
                <div className="v mono">${(signal.ai_entry || signal.price || 0).toFixed(2)}</div>
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
              <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-0)', borderRadius: 8, fontSize: 13, lineHeight: 1.6 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>AI Analyse</div>
                {signal.ai_reason}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => onExecuteTrade(signal)}>
                <Icon name="bolt" size={14}/> Trade ausführen
              </button>
              <button className="btn" onClick={() => onSaveToJournal(signal)}>
                <Icon name="book" size={14}/> Journal
              </button>
              <button className="btn btn-ghost" onClick={() => onIgnore(signal)}>
                Ignorieren
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div className="score-ring" style={{ '--pct': signal.ai_score || 0 }}>
              <div className="score-text">{signal.ai_score || 0}</div>
              <div className="score-sub">SCORE</div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 110 }}>
              {signal.ai_score >= 75 ? 'Sehr starkes Setup' : signal.ai_score >= 65 ? 'Gutes Setup' : 'Moderates Setup'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const MarketBiasCard = ({ marketBias }) => {
  if (!marketBias || marketBias.length === 0) return (
    <div className="card">
      <div className="card-head"><Icon name="target" className="ico"/><h3>Markt Bias</h3></div>
      <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Keine Snapshot-Daten</p>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="target" className="ico"/>
        <h3>Markt Bias</h3>
        <div className="actions"><span className="badge badge-tag">{marketBias.length} ASSETS</span></div>
      </div>
      <div className="card-body" style={{ padding: '8px 18px 16px' }}>
        {marketBias.map((item, i) => (
          <div className="bias-row" key={i}>
            <AssetChip symbol={item.symbol}/>
            <div style={{ flex: 1 }}/>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                ${item.price?.toFixed(2) || 'N/A'}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`badge ${item.trend === 'bullish' ? 'badge-bullish' : item.trend === 'bearish' ? 'badge-bearish' : 'badge-neutral'}`}>
                  {item.trend.toUpperCase()}
                </span>
                {item.change !== 0 && (
                  <span style={{ fontSize: 11, color: item.change > 0 ? 'var(--win)' : 'var(--loss)' }}>
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

const LatestTradesCard = ({ signals, onViewAll }) => {
  if (!signals || signals.length === 0) return (
    <div className="card">
      <div className="card-head"><Icon name="signal" className="ico"/><h3>Letzte Trades</h3></div>
      <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Keine Trades vorhanden</p>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Letzte Trades · {signals.length}</h3>
        <div className="actions">
          <button className="btn btn-sm btn-ghost" onClick={onViewAll}>Alle anzeigen →</button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Zeit</th><th>Asset</th><th>Richtung</th>
            <th>Entry</th><th>Score</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr key={i}>
              <td className="mono muted" style={{ fontSize: 11 }}>{getTimeAgo(s.created_at)}</td>
              <td><AssetChip symbol={s.symbol}/></td>
              <td><span className={`badge ${s.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{s.direction}</span></td>
              <td className="mono">${(s.ai_entry || s.price || 0).toFixed(2)}</td>
              <td className="mono">{s.ai_score || 0}/100</td>
              <td>
                <span className={`badge ${s.outcome === 'WIN' ? 'badge-win' : s.outcome === 'LOSS' ? 'badge-loss' : 'badge-wait'}`}>
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

window.DashboardPage = DashboardPage;
