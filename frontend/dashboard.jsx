// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.6 - DASHBOARD
// ═══════════════════════════════════════════════════════════════

const { useRef, useCallback } = React;

const LIVE_INTERVAL_MS       = 30 * 1000;
const RADAR_INTERVAL_MS      = 5  * 60 * 1000;
const BIAS_INTERVAL_MS       = 60 * 1000;

// ─── Live-Modus toggle button ─────────────────────────────────

function LiveModeButton({ liveMode, onToggle, refreshing }) {
  return (
    <button
      onClick={onToggle}
      title={liveMode ? 'Live-Modus stoppen' : 'Live-Modus starten'}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
        border: `1px solid ${liveMode ? 'rgba(16,185,129,.45)' : 'var(--border)'}`,
        background: liveMode ? 'rgba(16,185,129,.1)' : 'var(--bg-2)',
        color: liveMode ? 'var(--win)' : 'var(--text-tertiary)',
        cursor: 'pointer', transition: 'all .2s', fontFamily: 'var(--font-mono)',
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: liveMode ? 'var(--win)' : 'var(--text-quaternary)',
        animation: liveMode ? 'pulse 1.5s infinite' : 'none',
      }}/>
      {liveMode
        ? (refreshing ? 'LIVE …' : 'LIVE AKTIV')
        : 'LIVE GESTOPPT'}
    </button>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────

const DashboardPage = ({ user, navigate }) => {

  // ── State ─────────────────────────────────────────────────────
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [data, setData]             = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [toast, setToast]           = useState(null);
  const [todayBias, setTodayBias]   = useState(null);
  const [radar, setRadar]           = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [liveMode, setLiveMode]     = useState(() => {
    const saved = localStorage.getItem('wavescout_livemode');
    return saved !== 'false'; // default: true
  });

  // ── Interval refs ─────────────────────────────────────────────
  const liveRef  = useRef(null);
  const radarRef = useRef(null);
  const biasRef  = useRef(null);

  // ── Toast ─────────────────────────────────────────────────────
  const showToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  // ── Fetch helpers ─────────────────────────────────────────────
  const loadLiveData = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/dashboard/live`, { credentials: 'include' });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadTodayBias = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/today-bias`, { credentials: 'include' });
      if (res.ok) setTodayBias(await res.json());
    } catch { /* non-critical */ }
  }, []);

  const loadMarketRadar = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/market-radar`, { credentials: 'include' });
      if (res.ok) setRadar(await res.json());
    } catch { /* non-critical */ }
  }, []);

  // ── Polling management ────────────────────────────────────────
  const stopPolling = useCallback(() => {
    [liveRef, radarRef, biasRef].forEach(ref => {
      if (ref.current) { clearInterval(ref.current); ref.current = null; }
    });
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    liveRef.current  = setInterval(() => loadLiveData(true), LIVE_INTERVAL_MS);
    radarRef.current = setInterval(loadMarketRadar, RADAR_INTERVAL_MS);
    biasRef.current  = setInterval(loadTodayBias,   BIAS_INTERVAL_MS);
  }, [loadLiveData, loadMarketRadar, loadTodayBias, stopPolling]);

  // ── Live toggle ───────────────────────────────────────────────
  const handleToggleLive = useCallback(() => {
    const next = !liveMode;
    setLiveMode(next);
    localStorage.setItem('wavescout_livemode', String(next));
    if (next) {
      loadLiveData(false);
      loadMarketRadar();
      loadTodayBias();
      startPolling();
      showToast('Live-Modus gestartet', 'info');
    } else {
      stopPolling();
      showToast('Live-Modus gestoppt — manuelle Aktualisierung möglich', 'warn');
    }
  }, [liveMode, loadLiveData, loadMarketRadar, loadTodayBias, startPolling, stopPolling]);

  // ── Manual refresh ────────────────────────────────────────────
  const handleManualRefresh = useCallback(() => {
    loadLiveData(false);
    loadTodayBias();
    loadMarketRadar();
  }, [loadLiveData, loadTodayBias, loadMarketRadar]);

  // ── Mount: initial load + conditional polling ─────────────────
  useEffect(() => {
    loadLiveData(false);
    loadTodayBias();
    loadMarketRadar();
    if (liveMode) startPolling();
    return () => stopPolling(); // cleanup on unmount / page switch
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Signal actions ────────────────────────────────────────────
  const handleExecuteTrade = async (signal) => {
    const MAX_AGE_MS = 2 * 60 * 60 * 1000;
    const signalAge = Date.now() - new Date(signal.created_at).getTime();
    if (signalAge > MAX_AGE_MS) {
      const ageH = Math.floor(signalAge / 3600000);
      const ageM = Math.floor((signalAge % 3600000) / 60000);
      showToast(`Signal ist ${ageH}h ${ageM}m alt — zu alt für Demo-Trade (max. 2h).`, 'warn');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/practice-trades/manual`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ signalId: signal.id })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Fehler beim Erstellen des Demo-Trades', 'error');
      } else {
        showToast(`Demo-Trade für ${signal.symbol} ${signal.direction} geöffnet!`, 'success');
      }
    } catch (_) {
      showToast('Netzwerkfehler beim Erstellen des Demo-Trades', 'error');
    }
  };

  const handleSaveToJournal = (signal) => {
    localStorage.setItem('signal_for_journal', JSON.stringify(signal));
    navigate('journal');
  };

  const handleIgnoreSignal = async (signal) => {
    try {
      await fetch(`${API_URL}/signals/${signal.id}`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ outcome: 'IGNORED' })
      });
      loadLiveData(false);
      showToast(`Signal ${signal.symbol} ${signal.direction} ignoriert.`, 'info');
    } catch (err) {
      console.error('Ignore error:', err);
    }
  };

  // ── Render ────────────────────────────────────────────────────
  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  if (error && !data) return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
      <p style={{ color: 'var(--text-tertiary)', marginBottom: 16 }}>Backend nicht erreichbar: {error}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn" onClick={handleManualRefresh}>
          <Icon name="refresh" size={14}/> Neu laden
        </button>
        {!liveMode && (
          <button className="btn btn-primary" onClick={handleToggleLive}>
            Live-Modus starten
          </button>
        )}
      </div>
    </div>
  );

  const stats         = data?.stats || {};
  const bestSignal    = data?.bestSignal || null;
  const latestSignals = Array.isArray(data?.latestSignals) ? data.latestSignals : [];
  const marketBias    = data?.marketBias || null;
  const todayPnL      = stats.todayPnL  ?? 0;
  const totalPnL      = stats.totalPnL  ?? 0;
  const winRate       = stats.winRate   ?? 0;
  const equity        = stats.equity    ?? stats.startingCapital ?? 0;
  const startCap      = stats.startingCapital ?? 10000;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Morgen';
    if (h < 18) return 'Tag';
    return 'Abend';
  })();

  const lastUpdStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '–';

  return (
    <div className="content page-enter">
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 64, right: 20, zIndex: 9999,
          padding: '12px 18px', borderRadius: 10, fontSize: 13, fontWeight: 500,
          background: toast.type === 'warn' ? 'var(--bg-warning)' : toast.type === 'error' ? 'var(--bg-error)' : 'var(--bg-success)',
          border: `1px solid ${toast.type === 'warn' ? 'rgba(245,158,11,.4)' : toast.type === 'error' ? 'rgba(239,68,68,.4)' : 'rgba(16,185,129,.4)'}`,
          color: toast.type === 'warn' ? 'var(--wait)' : toast.type === 'error' ? 'var(--loss)' : 'var(--win)',
          boxShadow: '0 4px 16px rgba(0,0,0,.25)', maxWidth: 360, animation: 'fadeIn .2s ease'
        }}>
          {toast.msg}
        </div>
      )}

      {/* Error banner (non-fatal: data exists but last refresh failed) */}
      {error && data && (
        <div style={{
          margin: '0 0 16px', padding: '10px 16px', borderRadius: 10,
          background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)',
          fontSize: 13, color: 'var(--loss)', display: 'flex', alignItems: 'center', gap: 10
        }}>
          <span>⚠️</span>
          <span>Letzte Aktualisierung fehlgeschlagen: {error}</span>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={handleManualRefresh}>
            Retry
          </button>
        </div>
      )}

      {/* Page header */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2>Guten {greeting}, {user?.username || 'Trader'}</h2>
            <p className="subtitle">
              {stats.open ?? '–'} offene Signale · {stats.totalTrades ?? '–'} Total Trades
              {lastUpdated && (
                <span style={{ color: 'var(--text-quaternary)' }}> · Aktualisiert {lastUpdStr}</span>
              )}
            </p>
          </div>

          {/* Right controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            {/* Bias indicator */}
            {todayBias?.bias ? (
              <span style={{
                display: 'flex', alignItems: 'center', gap: 7, fontSize: 13,
                padding: '5px 12px', borderRadius: 20,
                background: todayBias.bias === 'LONG' ? 'rgba(16,185,129,.12)' : todayBias.bias === 'SHORT' ? 'rgba(239,68,68,.12)' : 'var(--bg-2)',
                border: `1px solid ${todayBias.bias === 'LONG' ? 'rgba(16,185,129,.35)' : todayBias.bias === 'SHORT' ? 'rgba(239,68,68,.35)' : 'var(--border)'}`,
                color: todayBias.bias === 'LONG' ? 'var(--win)' : todayBias.bias === 'SHORT' ? 'var(--loss)' : 'var(--text-tertiary)',
                fontWeight: 600
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }}/>
                Bias: {todayBias.bias}
              </span>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('journal')}
                style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--loss)', display: 'inline-block', animation: 'pulse 1.5s infinite' }}/>
                Morgenroutine fehlt
              </button>
            )}

            {/* Live-Modus toggle */}
            <LiveModeButton liveMode={liveMode} onToggle={handleToggleLive} refreshing={refreshing}/>
          </div>
        </div>
      </div>

      {/* Equity + Manual Refresh strip */}
      <div className="card portfolio-card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, marginBottom: 3 }}>Portfolio-Wert</div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                ${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div style={{ width: 1, height: 36, background: 'var(--border)' }}/>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, marginBottom: 3 }}>Gesamt PnL</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: totalPnL >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                {totalPnL >= 0 ? '+' : '-'}${Math.abs(totalPnL).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div style={{ width: 1, height: 36, background: 'var(--border)' }}/>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, marginBottom: 3 }}>Startkapital</div>
              <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                ${startCap.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {!liveMode && (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  Live-Modus aus
                </span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleManualRefresh}
                disabled={refreshing}
                title="Manuell aktualisieren"
              >
                {refreshing
                  ? <div className="spinner-sm"/>
                  : <Icon name="refresh" size={14}/>}
              </button>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Equity-Verlauf</span>
            <div style={{ flex: 1, height: 28, borderRadius: 4, background: 'rgba(59,130,246,0.06)', border: '1px dashed rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)' }}>— Sparkline folgt —</span>
            </div>
          </div>
        </div>
      </div>

      {/* Best signal + Market bias */}
      <div className="grid grid-2" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <BestSignalCard
          signal={bestSignal}
          onExecuteTrade={handleExecuteTrade}
          onSaveToJournal={handleSaveToJournal}
          onIgnore={handleIgnoreSignal}
        />
        <MarketBiasCard marketBias={marketBias}/>
      </div>

      {/* Market radar */}
      <CryptoMarketRadar radar={radar}/>

      {/* KPI strip */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard
          label="Trades gesamt"
          value={(stats.totalTrades || 0).toString()}
          sub={`${stats.wins || 0}W · ${stats.losses || 0}L · ${stats.open || 0} offen`}
        />
        <StatCard
          label="Win-Rate"
          value={stats.totalTrades ? `${winRate.toFixed(1)}%` : '–'}
          sub="Alle abgeschlossenen Trades"
          subTone={winRate >= 50 ? 'win' : 'loss'}
        />
        <StatCard
          label="Heute PnL"
          value={(todayPnL >= 0 ? '+' : '-') + `$${Math.abs(todayPnL).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub="Profit & Loss heute"
          subTone={todayPnL >= 0 ? 'win' : 'loss'}
        />
        <StatCard
          label="System"
          value={liveMode ? 'LIVE' : 'PAUSE'}
          sub={liveMode ? `Auto-Refresh ${LIVE_INTERVAL_MS / 1000}s` : 'Manueller Refresh aktiv'}
          subTone={liveMode ? 'win' : 'loss'}
          icon="signal"
        />
      </div>

      {/* Latest signals table */}
      <LatestTradesCard signals={latestSignals} onViewAll={() => navigate('backtest')}/>
    </div>
  );
};

// ─── Crypto Market Radar ──────────────────────────────────────

const CryptoMarketRadar = ({ radar }) => {
  const status = radar?.status || 'NORMAL';
  const statusMeta = status === 'RISK_OFF'
    ? { icon: '🔴', label: 'RISK-OFF', color: 'var(--loss)' }
    : status === 'CAUTION'
      ? { icon: '🟡', label: 'VORSICHT', color: 'var(--wait)' }
      : { icon: '🟢', label: 'NORMAL', color: 'var(--win)' };
  const events = Array.isArray(radar?.events) ? radar.events.slice(0, 6) : [];

  return (
    <div className="card" style={{ marginTop: 'var(--gap)' }}>
      <div className="card-head">
        <Icon name="chart" className="ico"/>
        <h3>Crypto Market Radar</h3>
        <div className="actions">
          <span className="badge" style={{ borderColor: statusMeta.color, color: statusMeta.color }}>
            {statusMeta.icon} {statusMeta.label}
          </span>
        </div>
      </div>
      <div className="card-body">
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          {radar?.summary || 'Market Radar noch nicht geladen'}
        </p>
        {events.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Keine relevanten Events gefunden.</p>
        ) : events.map((event, idx) => (
          <div key={`${event.id || event.title}_${idx}`} style={{
            padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8,
            background: 'rgba(255,255,255,.01)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{event.title}</div>
              <span className={`badge ${event.impact === 'HIGH' ? 'badge-short' : event.impact === 'MEDIUM' ? 'badge-tag' : ''}`}>{event.impact}</span>
            </div>
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 4 }}>
              {event.category} · {(event.affected_markets || []).join(' / ')} · {event.source}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, color: 'var(--text-quaternary)', fontSize: 11 }}>
          <span>Aktualisiert: {radar?.updated_at ? new Date(radar.updated_at).toLocaleTimeString('de-DE') : '–'}</span>
          <span>{radar?.disclaimer || 'Nur Marktübersicht. Keine Finanzberatung.'}</span>
        </div>
      </div>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────

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
          <span className="badge badge-tag" title={`Erkannt: ${new Date(signal.created_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`}>{getTimeAgo(signal.created_at)}</span>
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
              {signal.risk_reward != null && (
                <div className="cell">
                  <div className="l">R:R</div>
                  <div className="v mono">1:{signal.risk_reward.toFixed(1)}</div>
                </div>
              )}
            </div>

            {signal.ai_reason && (
              <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-0)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, borderLeft: '3px solid var(--blue-500)' }}>
                <div style={{ fontSize: 11, color: 'var(--blue-400)', marginBottom: 4, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="cpu" size={11}/>KI-Analyse
                </div>
                {signal.ai_reason}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {(() => {
                const MAX_AGE_MS = 2 * 60 * 60 * 1000;
                const signalAge = Date.now() - new Date(signal.created_at).getTime();
                const tooOld = signalAge > MAX_AGE_MS;
                const nearLimit = signalAge > 60 * 60 * 1000;
                return (
                  <button
                    className="btn btn-primary"
                    onClick={() => onExecuteTrade(signal)}
                    disabled={tooOld}
                    title={tooOld ? 'Signal zu alt — Demo-Trade nur bis 2h nach Signal möglich' : nearLimit ? 'Achtung: Signal bald zu alt' : ''}
                    style={nearLimit && !tooOld ? { backgroundColor: 'var(--wait)', borderColor: 'var(--wait)' } : {}}
                  >
                    <Icon name="bolt" size={14}/> {tooOld ? 'Zu alt' : 'Demo-Trade'}
                  </button>
                );
              })()}
              <button className="btn" onClick={() => onSaveToJournal(signal)}>
                <Icon name="book" size={14}/> Journal
              </button>
              <button className="btn btn-ghost" onClick={() => onIgnore(signal)}>
                Ignorieren
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            {(() => {
              const sc = signal.ai_score || 0;
              const scoreColor = sc >= 75 ? 'var(--win)' : sc >= 60 ? 'var(--wait)' : 'var(--loss)';
              const scoreClass = sc >= 75 ? 'score-high' : sc >= 60 ? 'score-med' : 'score-low';
              return (
                <div className={`score-ring ${scoreClass}`} style={{ '--pct': sc, '--score-color': scoreColor }}>
                  <div className="score-text" style={{ color: scoreColor }}>{sc}</div>
                  <div className="score-sub">SCORE</div>
                </div>
              );
            })()}
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', maxWidth: 110 }}>
              {(signal.ai_score || 0) >= 75 ? 'Sehr starkes Setup' : (signal.ai_score || 0) >= 65 ? 'Gutes Setup' : 'Mittleres Setup'}
            </div>
            {signal.ai_risk && (
              <span className={`badge ${signal.ai_risk === 'LOW' ? 'badge-win' : signal.ai_risk === 'HIGH' ? 'badge-loss' : 'badge-wait'}`}>
                {signal.ai_risk} RISK
              </span>
            )}
            {signal.telegram_sent === 1 && (
              <span className="badge badge-win" style={{ fontSize: 10 }}>📱 Telegram</span>
            )}
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
        <Icon name="signal" size={32} style={{ opacity: 0.15, marginBottom: 10 }}/>
        <p style={{ color: 'var(--text-tertiary)' }}>Keine Snapshot-Daten</p>
        <p style={{ fontSize: 12, color: 'var(--text-quaternary)', marginTop: 6 }}>Wird befüllt sobald TradingView SNAPSHOTs sendet</p>
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
      <div className="card-body" style={{ padding: '12px 18px 18px' }}>
        {marketBias.map((item, i) => (
          <div className="bias-row" key={i} style={{ paddingTop: 10, paddingBottom: 10 }}>
            <AssetChip symbol={item.symbol}/>
            <div style={{ flex: 1, margin: '0 12px', height: 24, borderRadius: 4, background: 'rgba(59,130,246,0.05)', border: '1px dashed rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 9, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)' }}>spark</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                ${item.price != null ? item.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`badge ${item.trend === 'bullish' ? 'badge-bullish' : item.trend === 'bearish' ? 'badge-bearish' : 'badge-neutral'}`}>
                  {(item.trend || 'neutral').toUpperCase()}
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
      <div className="card-head"><Icon name="signal" className="ico"/><h3>Letzte Signale</h3></div>
      <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
        <Icon name="signal" size={32} style={{ opacity: 0.15, marginBottom: 10 }}/>
        <p style={{ color: 'var(--text-tertiary)' }}>Heute noch keine Signale vorhanden</p>
        <p style={{ fontSize: 12, color: 'var(--text-quaternary)', marginTop: 6 }}>Warten auf TradingView Webhooks…</p>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Letzte Signale · {signals.length}</h3>
        <div className="actions">
          <button className="btn btn-sm btn-ghost" onClick={onViewAll}>Alle anzeigen →</button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Zeit</th><th>Asset</th><th>Richtung</th>
              <th>Entry</th><th>TP</th><th>SL</th><th>R:R</th><th>Score</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => (
              <tr key={i}>
                <td className="mono muted" style={{ fontSize: 11 }}>{getTimeAgo(s.created_at)}</td>
                <td><AssetChip symbol={s.symbol}/></td>
                <td><span className={`badge ${s.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{s.direction}</span></td>
                <td className="mono">${(s.ai_entry || s.price || 0).toFixed(2)}</td>
                <td className="mono win">{s.ai_tp ? `$${s.ai_tp.toFixed(2)}` : '–'}</td>
                <td className="mono loss">{s.ai_sl ? `$${s.ai_sl.toFixed(2)}` : '–'}</td>
                <td className="mono">{s.risk_reward != null ? `1:${s.risk_reward.toFixed(1)}` : '–'}</td>
                <td className="mono">{s.ai_score || 0}</td>
                <td>
                  <span className={`badge ${s.outcome === 'WIN' ? 'badge-win' : s.outcome === 'LOSS' ? 'badge-loss' : s.outcome === 'IGNORED' ? 'badge-neutral' : 'badge-wait'}`}>
                    {s.outcome || 'OPEN'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

window.DashboardPage = DashboardPage;
