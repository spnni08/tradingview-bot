// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - BACKTESTING & PAPER TRADING
// Übungstrades · Signal-Historie · Performance-Analyse
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ─── Helper ──────────────────────────────────────────────────

function calcPnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) return 0;
  const diff = trade.exit_price - trade.ai_entry;
  const pct  = (diff / trade.ai_entry) * 100;
  return trade.direction === 'LONG' ? pct : -pct;
}

function fmtDate(val) {
  const d = new Date(typeof val === 'number' ? val : val);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtPct(n, showSign = true) {
  if (n == null || isNaN(n)) return '–';
  return (showSign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── Stat Card ───────────────────────────────────────────────

function StatCard({ label, value, sub, subClass }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className={`sub ${subClass || 'muted'}`}>{sub}</div>}
    </div>
  );
}

// ─── Collapsible Strategy Rules ──────────────────────────────

function StrategyPanel({ open, onToggle }) {
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div
        className="card-head"
        onClick={onToggle}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <Icon name="chart" className="ico" />
        <h3>Strategie-Regeln</h3>
        <div className="actions">
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginRight: 8 }}>
            {open ? 'Einklappen ▲' : 'Ausklappen ▼'}
          </span>
        </div>
      </div>
      {open && (
        <div className="card-body" style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>📈 LONG Entry</p>
              <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
                <li>Letzter Close &gt; Vorheriger Close (mind. 0.05%)</li>
                <li>RSI zwischen 30 und 70</li>
                <li>EMA50 über EMA200 (bullischer Trend)</li>
                <li>Market-Buy sofort ausführen</li>
              </ul>
            </div>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>📉 SHORT Entry</p>
              <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
                <li>Letzter Close &lt; Vorheriger Close (mind. 0.05%)</li>
                <li>RSI zwischen 30 und 70</li>
                <li>EMA50 unter EMA200 (bärischer Trend)</li>
                <li>Market-Sell sofort ausführen</li>
              </ul>
            </div>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>🚫 Neutral / Skip</p>
              <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
                <li>RSI über 70 (überkauft)</li>
                <li>RSI unter 30 (überverkauft)</li>
                <li>Kursänderung unter 0.05% (Chop)</li>
              </ul>
            </div>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>⚖️ Risiko-Management</p>
              <ul style={{ paddingLeft: 18, color: 'var(--text-secondary)' }}>
                <li>TP: +2% vom Entry (LONG) / -2% (SHORT)</li>
                <li>SL: -1% vom Entry (LONG) / +1% (SHORT)</li>
                <li>Fixe Handelsgröße: 1% des Portfolios</li>
                <li>Max. $3 pro Trade</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Practice Trades Tab ─────────────────────────────────────

function PracticeTradesTab({ sessionId }) {
  const [trades, setTrades]     = useState([]);
  const [stats, setStats]       = useState(null);
  const [loading, setLoading]   = useState(true);
  const [filterSymbol, setFs]   = useState('all');
  const [filterTf, setFtf]      = useState('all');
  const [filterDir, setFd]      = useState('all');
  const [filterStatus, setFst]  = useState('all');

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(`${API_URL}/practice-trades?limit=200`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/practice-trades/stats`,    { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (tRes.ok) setTrades(await tRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch (e) {
      console.error('practice-trades load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const symbols    = ['all', ...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const timeframes = ['all', ...new Set(trades.map(t => t.timeframe).filter(Boolean))];

  const filtered = trades.filter(t => {
    if (filterSymbol !== 'all' && t.symbol    !== filterSymbol) return false;
    if (filterTf     !== 'all' && t.timeframe !== filterTf)     return false;
    if (filterDir    !== 'all' && t.direction !== filterDir)     return false;
    if (filterStatus !== 'all' && t.status    !== filterStatus)  return false;
    return true;
  });

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>
      <div className="spinner-lg" style={{ margin: '0 auto 16px' }} />
      Lade Übungstrades…
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Stats Overview */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        <StatCard label="Gesamt" value={stats?.total ?? 0} sub="Übungstrades" />
        <StatCard label="Offen"  value={stats?.open  ?? 0} sub="Noch aktiv" />
        <StatCard
          label="Gewinner" value={stats?.wins ?? 0}
          sub={stats?.wins ? `+${stats.avgWinPct?.toFixed(1)}% Ø` : '–'}
          subClass="win"
        />
        <StatCard
          label="Verlierer" value={stats?.losses ?? 0}
          sub={stats?.losses ? `${stats.avgLossPct?.toFixed(1)}% Ø` : '–'}
          subClass="loss"
        />
        <StatCard
          label="Win-Rate"
          value={`${stats?.winRate?.toFixed(1) ?? 0}%`}
          sub={(stats?.winRate ?? 0) >= 50 ? 'Profitabel ✓' : 'Unprofitabel'}
          subClass={(stats?.winRate ?? 0) >= 50 ? 'win' : 'loss'}
        />
        <StatCard
          label="Ø Gewinn"
          value={fmtPct(stats?.avgWinPct)}
          sub="pro Win-Trade"
          subClass="win"
        />
        <StatCard
          label="Ø Verlust"
          value={fmtPct(stats?.avgLossPct)}
          sub="pro Loss-Trade"
          subClass="loss"
        />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico" />
          <h3>Filter</h3>
          <div className="actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setFs('all'); setFtf('all'); setFd('all'); setFst('all'); }}
            >
              Zurücksetzen
            </button>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻ Neu laden</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Symbol',     value: filterSymbol, set: setFs,  opts: symbols.map(s => [s, s === 'all' ? 'Alle Symbole' : s]) },
              { label: 'Timeframe',  value: filterTf,     set: setFtf, opts: timeframes.map(t => [t, t === 'all' ? 'Alle TFs' : t + 'm']) },
              { label: 'Richtung',   value: filterDir,    set: setFd,  opts: [['all','Alle'],['LONG','Long'],['SHORT','Short']] },
              { label: 'Status',     value: filterStatus, set: setFst, opts: [['all','Alle'],['OPEN','Offen'],['WIN','Gewinner'],['LOSS','Verlierer']] }
            ].map(({ label, value, set, opts }) => (
              <div key={label}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>{label}</label>
                <select value={value} onChange={e => set(e.target.value)} className="input" style={{ minWidth: 140 }}>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico" />
          <h3>Übungstrades</h3>
          <div className="actions">
            <span className="badge badge-tag">{filtered.length} Trades</span>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="signal" size={48} style={{ opacity: 0.2, marginBottom: 16 }} />
            <p style={{ color: 'var(--text-tertiary)' }}>
              {trades.length === 0
                ? 'Noch keine Übungstrades — kommen automatisch wenn Signale eingehen'
                : 'Keine Trades mit diesen Filtern'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Datum</th>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th>Richtung</th>
                  <th>Entry</th>
                  <th>TP</th>
                  <th>SL</th>
                  <th>Exit</th>
                  <th>Result</th>
                  <th>Status</th>
                  <th>Geschlossen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => {
                  const resultPct = t.result_pct ?? null;
                  return (
                    <tr key={t.id ?? i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{t.id}</td>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                      <td><AssetChip symbol={t.symbol} /></td>
                      <td className="mono muted">{t.timeframe}</td>
                      <td>
                        <span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                          {t.direction}
                        </span>
                      </td>
                      <td className="mono">${(t.entry_price || 0).toFixed(2)}</td>
                      <td className="mono win">${(t.take_profit || 0).toFixed(2)}</td>
                      <td className="mono loss">${(t.stop_loss || 0).toFixed(2)}</td>
                      <td className="mono">{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '–'}</td>
                      <td className={`mono ${resultPct > 0 ? 'win' : resultPct < 0 ? 'loss' : ''}`}>
                        {resultPct != null ? fmtPct(resultPct) : '–'}
                      </td>
                      <td>
                        <span className={`badge ${
                          t.status === 'WIN'  ? 'badge-win'  :
                          t.status === 'LOSS' ? 'badge-loss' : 'badge-wait'
                        }`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {t.closed_at ? fmtDate(t.closed_at) : '–'}
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
}

// ─── Signal History Tab ──────────────────────────────────────

function SignalHistoryTab({ sessionId }) {
  const [history, setHistory]       = useState([]);
  const [stats, setStats]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [filterOutcome, setFo]      = useState('all');
  const [filterSymbol, setFs]       = useState('all');

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=100`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`,             { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (hRes.ok) setHistory(await hRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch (e) {
      console.error('history load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const symbols = ['all', ...new Set(history.map(h => h.symbol).filter(Boolean))];
  const totalTrades = stats ? stats.wins + stats.losses : 0;
  const winRate = totalTrades > 0 ? (stats.wins / totalTrades) * 100 : 0;

  const filtered = history.filter(h => {
    if (filterOutcome !== 'all' && h.outcome !== filterOutcome) return false;
    if (filterSymbol  !== 'all' && h.symbol  !== filterSymbol)  return false;
    return true;
  });

  if (loading) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>
      <div className="spinner-lg" style={{ margin: '0 auto 16px' }} />
      Lade Signal-History…
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Stats */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Total Signale" value={history.length} sub="Alle empfangenen" />
        <StatCard label="Ausgeführt"    value={totalTrades}    sub={`${stats?.wins ?? 0}W · ${stats?.losses ?? 0}L`} />
        <StatCard
          label="Win-Rate" value={`${winRate.toFixed(1)}%`}
          sub={winRate >= 50 ? 'Profitabel' : 'Unprofitabel'}
          subClass={winRate >= 50 ? 'win' : 'loss'}
        />
        <StatCard label="Offen" value={stats?.open ?? 0} sub="Noch aktiv" />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico" />
          <h3>Filter</h3>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={() => { setFo('all'); setFs('all'); }}>
              Zurücksetzen
            </button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Ergebnis</label>
              <select value={filterOutcome} onChange={e => setFo(e.target.value)} className="input" style={{ minWidth: 150 }}>
                <option value="all">Alle</option>
                <option value="WIN">Nur Wins</option>
                <option value="LOSS">Nur Losses</option>
                <option value="OPEN">Nur Offene</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>Symbol</label>
              <select value={filterSymbol} onChange={e => setFs(e.target.value)} className="input" style={{ minWidth: 150 }}>
                {symbols.map(s => <option key={s} value={s}>{s === 'all' ? 'Alle Symbole' : s}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico" />
          <h3>Signal-Historie</h3>
          <div className="actions">
            <span className="badge badge-tag">{filtered.length} Signale</span>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="signal" size={48} style={{ opacity: 0.2, marginBottom: 16 }} />
            <p style={{ color: 'var(--text-tertiary)' }}>
              {history.length === 0 ? 'Noch keine Signale vorhanden' : 'Keine Signale mit diesen Filtern'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
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
                {filtered.map((trade, i) => {
                  const pnl = calcPnL(trade);
                  return (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(trade.created_at)}</td>
                      <td><AssetChip symbol={trade.symbol} /></td>
                      <td>
                        <span className={`badge ${trade.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="mono">${(trade.ai_entry || trade.price || 0).toFixed(2)}</td>
                      <td className="mono">{trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '–'}</td>
                      <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>
                        {pnl !== 0 ? fmtPct(pnl) : '–'}
                      </td>
                      <td className="mono">{trade.ai_score || 0}/100</td>
                      <td>
                        <span className={`badge ${
                          trade.ai_risk === 'LOW'  ? 'badge-win'  :
                          trade.ai_risk === 'HIGH' ? 'badge-loss' : 'badge-wait'
                        }`}>{trade.ai_risk || 'MED'}</span>
                      </td>
                      <td>
                        <span className={`badge ${
                          trade.outcome === 'WIN'  ? 'badge-win'  :
                          trade.outcome === 'LOSS' ? 'badge-loss' : 'badge-wait'
                        }`}>{trade.outcome}</span>
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
}

// ─── Main Page ───────────────────────────────────────────────

const BacktestPage = () => {
  const [user, setUser]               = useState(null);
  const [activeTab, setActiveTab]     = useState('practice');
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [sessionId, setSessionId]     = useState(null);

  useEffect(() => {
    const sid  = localStorage.getItem('wavescout_session');
    const udat = localStorage.getItem('wavescout_user');

    if (!sid || !udat) { window.location.href = 'login.html'; return; }

    try {
      const parsedUser = JSON.parse(udat);
      if (parsedUser.mustChangePassword) { window.location.href = 'change-password.html'; return; }
      setUser(parsedUser);
      setSessionId(sid);
    } catch (e) {
      window.location.href = 'login.html';
    }
  }, []);

  const handleLogout = async () => {
    const sid = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { 'X-Session-ID': sid } });
    } finally {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  };

  if (!sessionId) {
    return (
      <div className="app">
        <main className="main">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
            <div className="spinner-lg" />
          </div>
        </main>
      </div>
    );
  }

  const tabs = [
    { id: 'practice', label: '📊 Übungstrades' },
    { id: 'history',  label: '📈 Signal-Historie' }
  ];

  return (
    <div className="app">
      <Sidebar active="backtest" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="🔬 Backtesting & Paper Trading"
          subtitle="Nur Paper-Trades — keine echten Orders"
        />
        <div className="content page-enter">

          {/* Tab Navigation */}
          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 0, marginBottom: 20 }}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '10px 18px',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
                  borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                  transition: 'all .15s'
                }}
              >
                {tab.label}
              </button>
            ))}

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setStrategyOpen(o => !o)}
              >
                📋 Strategie-Regeln {strategyOpen ? '▲' : '▼'}
              </button>
            </div>
          </div>

          {/* Collapsible Strategy Rules */}
          {strategyOpen && (
            <StrategyPanel open={strategyOpen} onToggle={() => setStrategyOpen(o => !o)} />
          )}

          {/* Tab Content */}
          {activeTab === 'practice' && <PracticeTradesTab sessionId={sessionId} />}
          {activeTab === 'history'  && <SignalHistoryTab  sessionId={sessionId} />}

        </div>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<BacktestPage />);
