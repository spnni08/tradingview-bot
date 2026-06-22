// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.6 - DASHBOARD
// ═══════════════════════════════════════════════════════════════

const { useRef, useCallback } = React;

// ─── Equity Sparkline ─────────────────────────────────────────
function EquitySparkline({ points }) {
  if (!points || points.length < 2) {
    return (
      <div style={{ flex: 1, height: 28, borderRadius: 4, background: 'rgba(59,130,246,0.06)', border: '1px dashed rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)' }}>Noch keine geschlossenen Trades</span>
      </div>
    );
  }
  const W = 300, H = 28, PAD = 2;
  const vals = points.map(p => p.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const xs = points.map((_, i) => PAD + (i / (points.length - 1)) * (W - PAD * 2));
  const ys = vals.map(v => H - PAD - ((v - min) / range) * (H - PAD * 2));
  const polyline = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const areaPath = `M${xs[0]},${H} ` + xs.map((x, i) => `L${x},${ys[i]}`).join(' ') + ` L${xs[xs.length-1]},${H} Z`;
  const lastVal = vals[vals.length - 1];
  const firstVal = vals[0];
  const up = lastVal >= firstVal;
  const color = up ? 'var(--win)' : 'var(--loss)';
  const fillId = `sf-${Math.random().toString(36).slice(2,6)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ flex: 1, height: 28, overflow: 'visible', display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.01"/>
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${fillId})`}/>
      <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────
function _fmtDate(val) {
  const d = new Date(val);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function _fmtPct(n) {
  if (n == null || isNaN(n)) return '–';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function _calcPnL(s) {
  if (!s.exit_price || !s.ai_entry || s.ai_entry === 0) return 0;
  const pct = ((s.exit_price - s.ai_entry) / s.ai_entry) * 100;
  return s.direction === 'LONG' ? pct : -pct;
}

// ─── Signal Detail Modal ──────────────────────────────────────
function DashSignalModal({ signal, onClose, onExecuteTrade, onSaveToJournal, onIgnoreSignal }) {
  if (!signal) return null;
  const pnl        = _calcPnL(signal);
  const sc         = signal.ai_score || 0;
  const scoreColor = sc >= 80 ? 'var(--win)' : sc >= 65 ? 'var(--wait)' : 'var(--loss)';
  const fmt        = v => { const n = Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : '–'; };
  const rr         = signal.risk_reward;
  const safeParse  = (s, def) => { try { return JSON.parse(s) ?? def; } catch { return def; } };
  const matched    = safeParse(signal.matched_rules, []);
  const failed     = safeParse(signal.failed_rules, []);

  const MAX_AGE_MS = 2 * 60 * 60 * 1000;
  const tooOld = Date.now() - new Date(signal.created_at).getTime() > MAX_AGE_MS;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="modal-head" style={{ position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{signal.direction}</span>
            <h3 style={{ margin: 0 }}>{signal.symbol}</h3>
            {signal.timeframe && <span className="badge badge-tag" style={{ fontSize: 11 }}>{signal.timeframe}m</span>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 20px 20px' }}>
          {/* Score */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '16px 0 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'var(--font-mono)', color: scoreColor, lineHeight: 1 }}>{sc}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>Score</div>
            </div>
            <div style={{ width: 1, height: 40, background: 'var(--border)', flexShrink: 0 }}/>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: scoreColor }}>{signal.signal_quality || '–'}</div>
              {signal.ai_risk && <span className={`badge ${signal.ai_risk === 'LOW' ? 'badge-win' : signal.ai_risk === 'HIGH' ? 'badge-loss' : 'badge-wait'}`} style={{ marginTop: 4 }}>{signal.ai_risk} RISK</span>}
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Status</div>
              <span className={`badge ${signal.outcome === 'WIN' ? 'badge-win' : signal.outcome === 'LOSS' ? 'badge-loss' : signal.outcome === 'IGNORED' ? 'badge-neutral' : 'badge-wait'}`} style={{ marginTop: 4 }}>
                {signal.outcome || 'OPEN'}
              </span>
            </div>
          </div>

          {/* Prices */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
            {[
              ['Entry',      fmt(signal.ai_entry ?? signal.price), 'var(--text-primary)'],
              ['Take Profit', fmt(signal.ai_tp),                   'var(--win)'],
              ['Stop Loss',   fmt(signal.ai_sl),                   'var(--loss)'],
              ['Exit',        fmt(signal.exit_price),              pnl > 0 ? 'var(--win)' : pnl < 0 ? 'var(--loss)' : 'var(--text-primary)'],
              ['R:R',         rr ? `1:${parseFloat(rr).toFixed(1)}` : '–', rr >= 1.5 ? 'var(--win)' : rr ? 'var(--wait)' : 'var(--text-tertiary)'],
              ['PnL',         pnl !== 0 ? _fmtPct(pnl) : '–',   pnl > 0 ? 'var(--win)' : pnl < 0 ? 'var(--loss)' : 'var(--text-tertiary)'],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: 'var(--bg-0)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 3 }}>{l}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          {/* AI reason */}
          {signal.ai_reason && (
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 6 }}>KI-ANALYSE</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-0)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.6, borderLeft: '3px solid var(--blue-500)' }}>{signal.ai_reason}</div>
            </div>
          )}

          {/* Rules */}
          {(matched.length > 0 || failed.length > 0) && (
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>STRATEGIE-CHECK</div>
              {matched.map((r, i) => <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 4 }}><span style={{ color: 'var(--win)' }}>✓</span><span style={{ color: 'var(--text-secondary)' }}>{r}</span></div>)}
              {failed.map((r,  i) => <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 4 }}><span style={{ color: 'var(--loss)' }}>✗</span><span style={{ color: 'var(--text-secondary)' }}>{r}</span></div>)}
            </div>
          )}

          {/* Meta */}
          <div style={{ paddingTop: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
            {_fmtDate(signal.created_at)} · {signal.source || 'WEBHOOK'}
            {signal.telegram_sent ? ' · 📱 Telegram' : ''}
          </div>
        </div>

        <div className="modal-foot" style={{ position: 'sticky', bottom: 0, background: 'var(--bg-1)' }}>
          <button className="btn btn-primary" onClick={() => { onExecuteTrade(signal); onClose(); }} disabled={tooOld}
            title={tooOld ? 'Signal zu alt (max. 2h)' : ''}>
            <Icon name="bolt" size={14}/> {tooOld ? 'Zu alt' : 'Live ✓'}
          </button>
          <button className="btn" onClick={() => { onSaveToJournal(signal); onClose(); }}>
            <Icon name="book" size={14}/> Journal
          </button>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => { onIgnoreSignal(signal); onClose(); }}>
            Ignorieren
          </button>
        </div>
      </div>
    </div>
  );
}

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
    // AUFGABE 3: Kein separater Demo-/Übungstrade-Pfad mehr. Jedes Signal wird
    // automatisch auf dem Live-Pfad (signals) getrackt — es gibt nichts manuell
    // zu „eröffnen". Endpoint /practice-trades/manual wurde entfernt.
    showToast(`${signal.symbol} ${signal.direction} wird bereits automatisch live getrackt.`, 'success');
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
  const equityHistory = Array.isArray(data?.equityHistory) ? data.equityHistory : [];
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
            <span style={{ fontSize: 10, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.06em', flexShrink: 0 }}>Equity-Verlauf</span>
            <EquitySparkline points={equityHistory}/>
          </div>
        </div>
      </div>

      {/* Best signal + Market bias */}
      <div className="dash-top-grid">
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
      <div className="dash-stats-grid">
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
      <LatestTradesCard
        signals={latestSignals}
        onViewAll={() => navigate('backtest')}
        onExecuteTrade={handleExecuteTrade}
        onSaveToJournal={handleSaveToJournal}
        onIgnoreSignal={handleIgnoreSignal}
      />
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
                {signal.poc && <div style={{ fontSize: 10, color: 'var(--text-quaternary)', marginTop: 2 }}>
                  <span style={{ color: '#f97316' }}>POC {signal.poc.toFixed(2)}</span>
                  {signal.vah && <span style={{ color: '#2dd4bf' }}> · VAH {signal.vah.toFixed(2)}</span>}
                  {signal.val && <span style={{ color: '#2dd4bf' }}> · VAL {signal.val.toFixed(2)}</span>}
                </div>}
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
                    <Icon name="bolt" size={14}/> {tooOld ? 'Zu alt' : 'Live ✓'}
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
            {signal.vp_zone && signal.vp_zone !== 'none' && (
              <span className="badge badge-tag" style={{ fontSize: 10, background: 'rgba(20,184,166,0.15)', color: '#2dd4bf', border: '1px solid rgba(20,184,166,0.3)' }} title={`POC: ${signal.poc ?? '–'} · VAH: ${signal.vah ?? '–'} · VAL: ${signal.val ?? '–'}`}>
                📊 VP: {signal.vp_zone}
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

const LatestTradesCard = ({ signals, onViewAll, onExecuteTrade, onSaveToJournal, onIgnoreSignal }) => {
  const [dirFilter,    setDirFilter]    = useState('all');
  const [scoreFilter,  setScoreFilter]  = useState(0);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected,     setSelected]     = useState(null);

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

  const filtered = signals.filter(s => {
    if (dirFilter !== 'all' && s.direction !== dirFilter) return false;
    if (scoreFilter > 0 && (s.ai_score || 0) < scoreFilter) return false;
    if (statusFilter !== 'all') {
      const outcome = s.outcome || 'OPEN';
      if (statusFilter === 'OPEN' && outcome !== 'OPEN') return false;
      if (statusFilter !== 'OPEN' && outcome !== statusFilter) return false;
    }
    return true;
  });

  const isFiltered = dirFilter !== 'all' || scoreFilter > 0 || statusFilter !== 'all';

  const FilterPill = ({ active, onClick, children }) => (
    <button onClick={onClick} style={{
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? 'var(--blue-500)' : 'var(--border)'}`,
      background: active ? 'rgba(59,130,246,.15)' : 'transparent',
      color: active ? 'var(--blue-400)' : 'var(--text-tertiary)',
      transition: 'all .15s', whiteSpace: 'nowrap',
    }}>{children}</button>
  );

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Letzte Signale · {filtered.length}{isFiltered ? `/${signals.length}` : ''}</h3>
        <div className="actions">
          {isFiltered && (
            <button className="btn btn-sm btn-ghost" onClick={() => { setDirFilter('all'); setScoreFilter(0); setStatusFilter('all'); }}
              style={{ fontSize: 11, padding: '3px 8px' }}>
              Filter ✕
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onViewAll}>Alle anzeigen →</button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ padding: '8px 16px 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-quaternary)', fontWeight: 700, letterSpacing: '.06em', marginRight: 2 }}>FILTER</span>
        <FilterPill active={dirFilter === 'all'} onClick={() => setDirFilter('all')}>Alle</FilterPill>
        <FilterPill active={dirFilter === 'LONG'} onClick={() => setDirFilter(dirFilter === 'LONG' ? 'all' : 'LONG')}>LONG</FilterPill>
        <FilterPill active={dirFilter === 'SHORT'} onClick={() => setDirFilter(dirFilter === 'SHORT' ? 'all' : 'SHORT')}>SHORT</FilterPill>
        <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }}/>
        <FilterPill active={scoreFilter === 70} onClick={() => setScoreFilter(scoreFilter === 70 ? 0 : 70)}>70+</FilterPill>
        <FilterPill active={scoreFilter === 80} onClick={() => setScoreFilter(scoreFilter === 80 ? 0 : 80)}>80+</FilterPill>
        <FilterPill active={scoreFilter === 90} onClick={() => setScoreFilter(scoreFilter === 90 ? 0 : 90)}>90+</FilterPill>
        <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }}/>
        <FilterPill active={statusFilter === 'OPEN'} onClick={() => setStatusFilter(statusFilter === 'OPEN' ? 'all' : 'OPEN')}>OPEN</FilterPill>
        <FilterPill active={statusFilter === 'WIN'} onClick={() => setStatusFilter(statusFilter === 'WIN' ? 'all' : 'WIN')}>WIN</FilterPill>
        <FilterPill active={statusFilter === 'LOSS'} onClick={() => setStatusFilter(statusFilter === 'LOSS' ? 'all' : 'LOSS')}>LOSS</FilterPill>
      </div>

      {filtered.length === 0 ? (
        <div className="card-body" style={{ padding: '32px 20px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Keine Signale mit diesen Filtern</p>
        </div>
      ) : (
        <>
          {selected && (
            <DashSignalModal
              signal={selected}
              onClose={() => setSelected(null)}
              onExecuteTrade={onExecuteTrade || (() => {})}
              onSaveToJournal={onSaveToJournal || (() => {})}
              onIgnoreSignal={onIgnoreSignal || (() => {})}
            />
          )}
          {/* Desktop table */}
          <div className="signal-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Zeit</th><th>Asset</th><th>Richtung</th>
                  <th>Entry</th><th>TP</th><th>SL</th><th>R:R</th><th>Score</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setSelected(s)}>
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
          {/* Mobile card list */}
          <div className="signal-mobile-list">
            {filtered.map((s, i) => {
              const sc = s.ai_score || 0;
              const scoreColor = sc >= 90 ? 'var(--win)' : sc >= 75 ? 'var(--wait)' : 'var(--blue-400)';
              const outcomeCls = s.outcome === 'WIN' ? 'badge-win' : s.outcome === 'LOSS' ? 'badge-loss' : s.outcome === 'IGNORED' ? 'badge-neutral' : 'badge-wait';
              return (
                <div key={i} className="signal-mobile-row" style={{ cursor: 'pointer' }} onClick={() => setSelected(s)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AssetChip symbol={s.symbol}/>
                    <span className={`badge ${s.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{s.direction}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: scoreColor, fontSize: 13, marginLeft: 4 }}>{sc}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 2 }}>pts</span>
                    <span className={`badge ${outcomeCls}`} style={{ marginLeft: 'auto', fontSize: 10 }}>{s.outcome || 'OPEN'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>E&nbsp;${(s.ai_entry || s.price || 0).toFixed(2)}</span>
                    {s.ai_tp && <span style={{ color: 'var(--win)', fontFamily: 'var(--font-mono)' }}>TP&nbsp;${s.ai_tp.toFixed(2)}</span>}
                    {s.ai_sl && <span style={{ color: 'var(--loss)', fontFamily: 'var(--font-mono)' }}>SL&nbsp;${s.ai_sl.toFixed(2)}</span>}
                    <span style={{ marginLeft: 'auto' }}>{getTimeAgo(s.created_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

window.DashboardPage = DashboardPage;
