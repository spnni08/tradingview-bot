// ═══════════════════════════════════════════════════════════════
// WAVESCOUT - EINSTELLUNGEN (v3.7 two-column layout)
// ═══════════════════════════════════════════════════════════════

const BROKERS = [
  { id: 'bybit',    name: 'Bybit',    logo: '⚡', features: ['Futures','Spot','Options'], popular: true },
  { id: 'binance',  name: 'Binance',  logo: '🟡', features: ['Futures','Spot','Margin'],  popular: true },
  { id: 'blofin',   name: 'BloFin',   logo: '🔶', features: ['Futures','Spot','Copy'],    popular: true },
  { id: 'kraken',   name: 'Kraken',   logo: '🟣', features: ['Futures','Spot','Staking'], popular: true },
  { id: 'coinbase', name: 'Coinbase', logo: '🔵', features: ['Spot','Advanced'],           popular: false },
  { id: 'okx',      name: 'OKX',      logo: '⚫', features: ['Futures','Spot','Options'],  popular: false },
  { id: 'mexc',     name: 'MEXC',     logo: '🔷', features: ['Futures','Spot'],            popular: false },
  { id: 'bitget',   name: 'Bitget',   logo: '🟢', features: ['Futures','Spot','Copy'],     popular: false },
  { id: 'kucoin',   name: 'KuCoin',   logo: '🟩', features: ['Futures','Spot','Bot'],      popular: false },
];

const WEBHOOK_URL = 'https://tradingview-bot.spnn08.workers.dev/webhook';

// ─── Admin: Trade Check Panel ─────────────────────────────────

function AdminTradeCheckPanel() {
  const [result,     setResult]     = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [eodRes,     setEodRes]     = useState(null);
  const [eodLoad,    setEodLoad]    = useState(false);
  const [rowLoading, setRowLoading] = useState({});
  const [rowResults, setRowResults] = useState({});

  const runBulkCheck = async () => {
    setLoading(true); setResult(null); setRowResults({});
    try {
      const res = await fetch(`${API_URL}/admin/check-open-trades`, {
        credentials: 'include', method: 'POST' });
      setResult(await res.json());
    } catch (e) { setResult({ success: false, error: e.message }); }
    setLoading(false);
  };

  const runSingleCheck = async (id) => {
    setRowLoading(p => ({ ...p, [id]: true }));
    try {
      const res = await fetch(`${API_URL}/admin/check-trade/${id}`, {
        credentials: 'include', method: 'POST' });
      const data = await res.json();
      setRowResults(p => ({ ...p, [id]: data }));
    } catch (e) { setRowResults(p => ({ ...p, [id]: { success: false, error: e.message } })); }
    setRowLoading(p => ({ ...p, [id]: false }));
  };

  const runEodCheck = async () => {
    setEodLoad(true); setEodRes(null);
    try {
      const res = await fetch(`${API_URL}/admin/eod-check`, {
        credentials: 'include', method: 'POST' });
      setEodRes(await res.json());
    } catch (e) { setEodRes({ success: false, error: e.message }); }
    setEodLoad(false);
  };

  const fmtPrice = (p) => p != null ? `$${Number(p).toFixed(2)}` : '–';
  const noTrades = result?.success && result.checked === 0;
  const noPrices = result?.success && result.checked > 0 && result.no_price === result.checked;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Bulk check */}
      <div className="card">
        <div className="card-head"><Icon name="target" className="ico"/><h3>Offene Trades prüfen</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
            Vergleicht alle offenen Signale mit dem letzten Snapshot-Preis (aus PRICE_UPDATE-Webhooks).
            TP oder SL erreicht → Outcome wird gesetzt.
          </p>
          <button className="btn btn-primary" onClick={runBulkCheck} disabled={loading}>
            {loading ? <div className="spinner-sm"/> : <Icon name="refresh" size={14}/>}
            {loading ? 'Prüfe…' : 'Alle offenen Trades prüfen'}
          </button>

          {result && !result.success && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-error)', borderRadius: 8, border: '1px solid rgba(240,68,68,.3)', fontSize: 13, color: 'var(--loss)' }}>
              Fehler: {result.error}
            </div>
          )}
          {noTrades && (
            <div style={{ marginTop: 12, padding: '16px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              Keine offenen Trades vorhanden.
            </div>
          )}
          {noPrices && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 8, border: '1px solid rgba(245,158,11,.3)', fontSize: 13, color: 'var(--wait)' }}>
              Keine aktuellen Preise vorhanden — erst PRICE_UPDATE-Webhooks senden, dann erneut prüfen.
            </div>
          )}

          {result?.success && result.checked > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                {[
                  ['Geprüft',      result.checked,   'var(--text-primary)'],
                  ['Geschlossen',  result.closed,    result.closed  > 0 ? 'var(--win)'  : 'var(--text-tertiary)'],
                  ['Noch offen',   result.open,      'var(--text-secondary)'],
                  ['Kein Preis',   result.no_price,  result.no_price > 0 ? 'var(--wait)' : 'var(--text-tertiary)'],
                  ['Übersprungen', result.skipped,   'var(--text-tertiary)'],
                ].map(([label, val, color]) => (
                  <div key={label} style={{ padding: '8px 14px', background: 'var(--bg-0)', borderRadius: 8, border: '1px solid var(--border)', textAlign: 'center', minWidth: 76 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color }}>{val ?? 0}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</div>
                  </div>
                ))}
              </div>

              {result.results?.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl" style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Richtung</th>
                        <th>Entry</th>
                        <th style={{ color: 'var(--win)' }}>TP</th>
                        <th style={{ color: 'var(--loss)' }}>SL</th>
                        <th>Letzter Preis</th>
                        <th>Ergebnis</th>
                        <th>Grund</th>
                        <th/>
                      </tr>
                    </thead>
                    <tbody>
                      {result.results.map((r) => {
                        const rr = rowResults[r.id] || {};
                        const status  = rr.status  || r.status;
                        const outcome = rr.outcome  || r.outcome;
                        const price   = rr.price    ?? r.price;
                        const message = rr.message  || r.message;
                        const isCheckable = r.status === 'open' || r.status === 'no_price';
                        const dirColor = r.direction === 'LONG' ? 'var(--win)' : r.direction === 'SHORT' ? 'var(--loss)' : 'var(--text-tertiary)';
                        const outcomeLabel = status === 'closed' ? (outcome || 'CLOSED')
                          : status === 'skipped' ? 'SKIPPED'
                          : status === 'no_price' ? 'NO_PRICE'
                          : 'OPEN';
                        const outcomeCls = outcome === 'WIN' ? 'badge-win' : outcome === 'LOSS' ? 'badge-loss' : status === 'no_price' ? 'badge-wait' : '';
                        return (
                          <tr key={r.id}>
                            <td><span className="badge badge-tag">{r.symbol}</span></td>
                            <td><span style={{ color: dirColor, fontWeight: 600, fontSize: 11 }}>{r.direction || '–'}</span></td>
                            <td className="mono">{fmtPrice(r.entry)}</td>
                            <td className="mono" style={{ color: 'var(--win)' }}>{fmtPrice(r.tp)}</td>
                            <td className="mono" style={{ color: 'var(--loss)' }}>{fmtPrice(r.sl)}</td>
                            <td className="mono">{fmtPrice(price)}</td>
                            <td><span className={`badge ${outcomeCls}`}>{outcomeLabel}</span></td>
                            <td style={{ color: 'var(--text-tertiary)', fontSize: 11, maxWidth: 180 }}>{message}</td>
                            <td>
                              {isCheckable && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }}
                                  onClick={() => runSingleCheck(r.id)}
                                  disabled={rowLoading[r.id]}
                                >
                                  {rowLoading[r.id]
                                    ? <div className="spinner-sm" style={{ width: 10, height: 10 }}/>
                                    : <><Icon name="target" size={11}/> Prüfen</>}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* EOD check */}
      <div className="card">
        <div className="card-head"><Icon name="clock" className="ico"/><h3>Tages-Endcheck (EOD)</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6, lineHeight: 1.6 }}>
            Wie der Bulk-Check, aber Signale jünger als 30 Minuten werden übersprungen. Ideal als manueller 23:59-Check.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
            Für Cron-Betrieb: Cloudflare Workers Cron Trigger auf <code>23:59 UTC</code> → <code>POST /admin/eod-check</code>.
          </p>
          <button className="btn btn-ghost" onClick={runEodCheck} disabled={eodLoad}>
            {eodLoad ? <div className="spinner-sm"/> : <Icon name="clock" size={14}/>}
            {eodLoad ? 'Prüfe…' : 'EOD-Check jetzt ausführen'}
          </button>
          {eodRes && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: eodRes.success ? 'var(--bg-success)' : 'var(--bg-error)', borderRadius: 8, border: `1px solid ${eodRes.success ? 'rgba(16,185,129,.3)' : 'rgba(240,68,68,.3)'}`, fontSize: 13 }}>
              {eodRes.success
                ? `EOD: ${eodRes.checked} geprüft, ${eodRes.closed} geschlossen`
                : `Fehler: ${eodRes.error}`}
            </div>
          )}
        </div>
      </div>

      {/* Price source info */}
      <div className="card">
        <div className="card-head"><Icon name="signal" className="ico"/><h3>Preis-Quelle</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Quelle: <strong>snapshots</strong>-Tabelle (letzter bekannter PRICE_UPDATE-Preis pro Symbol).
            Kein externer API-Aufruf — kein Snapshot bedeutet Trade bleibt offen.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Admin: Webhook Tester ────────────────────────────────────

function AdminWebhookTester() {
  const DEFAULT = `{"symbol":"BTCUSDT","event_type":"SIGNAL","timeframe":"5","price":50000,"direction":"LONG","trigger":"EMA_CROSS","action":"BUY"}`;
  const [payload,  setPayload]  = useState(DEFAULT);
  const [loading,  setLoading]  = useState(false);
  const [response, setResponse] = useState(null);

  const send = async () => {
    setLoading(true); setResponse(null);
    try {
      let body;
      try { body = JSON.parse(payload); } catch { setResponse({ ok: false, error: 'Ungültiges JSON' }); setLoading(false); return; }
      const res = await fetch(`${API_URL}/admin/test-webhook`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
      setResponse({ ok: res.ok, status: res.status, body: parsed });
    } catch (e) { setResponse({ ok: false, error: e.message }); }
    setLoading(false);
  };

  return (
    <div className="card">
      <div className="card-head"><Icon name="bolt" className="ico"/><h3>Webhook Tester</h3></div>
      <div className="card-body">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
          Test-Payload direkt an den Worker senden. <code>event_type: "SIGNAL"</code> erzeugt ein echtes Signal — nur für Tests verwenden.
        </p>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 6 }}>PAYLOAD (JSON)</div>
          <textarea
            value={payload}
            onChange={e => setPayload(e.target.value)}
            rows={4}
            className="input"
            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>
        <button className="btn btn-ghost" onClick={send} disabled={loading}>
          {loading ? <div className="spinner-sm"/> : <Icon name="bolt" size={14}/>}
          {loading ? 'Sende…' : 'Senden'}
        </button>
        {response && (
          <div style={{ marginTop: 12, padding: '12px 14px', background: response.ok ? 'var(--bg-success)' : 'var(--bg-error)', borderRadius: 8, border: `1px solid ${response.ok ? 'rgba(16,185,129,.3)' : 'rgba(240,68,68,.3)'}` }}>
            {response.error
              ? <div style={{ fontSize: 13, color: 'var(--loss)' }}>Fehler: {response.error}</div>
              : <>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: response.ok ? 'var(--win)' : 'var(--loss)' }}>HTTP {response.status}</div>
                  <pre style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                    {typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2)}
                  </pre>
                </>
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Admin Test-Signal Panel ──────────────────────────────────

function AdminTestSignalPanel() {
  const [score,     setScore]     = useState(97);
  const [symbol,    setSymbol]    = useState('BTCUSDT');
  const [direction, setDirection] = useState('LONG');
  const [loading,   setLoading]   = useState(false);
  const [result,    setResult]    = useState(null);

  const send = async () => {
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/test-signal`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, symbol, direction }),
      });
      setResult(await res.json());
    } catch (e) { setResult({ success: false, error: e.message }); }
    setLoading(false);
  };

  const willTelegram = score >= 80;
  const willNtfy     = score >= 95;

  return (
    <div className="card">
      <div className="card-head"><Icon name="bolt" className="ico"/><h3>Test-Signal senden</h3></div>
      <div className="card-body">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
          Sendet ein simuliertes Signal durch die Benachrichtigungs-Pipeline. Kein Datenbankeintrag wird erstellt.
        </p>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
            Score: <span style={{ color: 'var(--blue-500)', fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>{score}</span><span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>/100</span>
          </label>
          <input type="range" min={1} max={100} value={score}
            onChange={e => setScore(parseInt(e.target.value))}
            style={{ width: '100%', maxWidth: 360, marginBottom: 8 }}/>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[70, 80, 90, 95, 97, 100].map(v => (
              <button key={v}
                className={`btn btn-sm${score === v ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => setScore(v)}
                style={{ padding: '3px 10px', fontSize: 12 }}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, maxWidth: 360 }}>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em' }}>SYMBOL</label>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} className="input" style={{ width: '100%' }}>
              {['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em' }}>RICHTUNG</label>
            <select value={direction} onChange={e => setDirection(e.target.value)} className="input" style={{ width: '100%' }}>
              <option>LONG</option>
              <option>SHORT</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[['Telegram', willTelegram, '≥80'], ['ntfy.sh', willNtfy, '≥95']].map(([label, active, threshold]) => (
            <span key={label} style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 20,
              background: active ? 'rgba(16,185,129,0.1)' : 'var(--bg-2)',
              border: `1px solid ${active ? 'rgba(16,185,129,0.35)' : 'var(--border)'}`,
              color: active ? 'var(--win)' : 'var(--text-tertiary)',
              fontWeight: active ? 600 : 400,
            }}>
              {active ? '✓' : '✗'} {label} ({threshold})
            </span>
          ))}
        </div>
        <button className="btn btn-primary" onClick={send} disabled={loading}>
          {loading ? <div className="spinner-sm"/> : <Icon name="bolt" size={14}/>}
          {loading ? 'Sende…' : 'Test-Signal senden'}
        </button>
        {result && (
          <div style={{ marginTop: 14, padding: '12px 16px', background: result.success ? 'var(--bg-success)' : 'var(--bg-error)', borderRadius: 10, border: `1px solid ${result.success ? 'rgba(16,185,129,.3)' : 'rgba(240,68,68,.3)'}` }}>
            {result.error ? (
              <div style={{ fontSize: 13, color: 'var(--loss)' }}>Fehler: {result.error}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontWeight: 600, color: 'var(--win)', fontSize: 13 }}>Signal gesendet — Score {result.score} · {result.symbol} {result.direction}</div>
                <div style={{ fontSize: 13 }}>Telegram: <span style={{ color: result.telegram ? 'var(--win)' : result.score >= 80 ? 'var(--loss)' : 'var(--text-tertiary)', fontWeight: 600 }}>{result.telegram ? '✓ gesendet' : result.score >= 80 ? '✗ Fehler' : '– (Score < 80)'}</span></div>
                <div style={{ fontSize: 13 }}>ntfy.sh: <span style={{ color: result.ntfy ? 'var(--win)' : result.score >= 95 ? 'var(--loss)' : 'var(--text-tertiary)', fontWeight: 600 }}>{result.ntfy ? '✓ gesendet' : result.score >= 95 ? '✗ Fehler' : '– (Score < 95)'}</span></div>
                {result.errors?.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--wait)', marginTop: 4, padding: '6px 10px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
                    ⚠ {result.errors.join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Admin Section (internal sub-nav) ────────────────────────

const ADMIN_SUBS = [
  { id: 'verwaltung',  label: 'Verwaltung',      icon: 'users'   },
  { id: 'testsignal',  label: 'Test-Signal',     icon: 'bolt'    },
  { id: 'tradecheck',  label: 'Trade Check',     icon: 'target'  },
  { id: 'webhook',     label: 'Webhook Tester',  icon: 'signal'  },
  { id: 'webhook-log', label: 'Webhook-Log',     icon: 'list'    },
  { id: 'kapital',     label: 'Kapital-Reset',   icon: 'coins'   },
  { id: 'system',      label: 'System',          icon: 'settings'},
];

// ─── AUFGABE 1: Strategie-Übersicht (Vergleich + Admin-Toggle) ───────
function StratStat({ label, value, tone }) {
  const color = tone === 'win' ? 'var(--win)' : tone === 'loss' ? 'var(--loss)' : 'var(--text-primary)';
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function StrategyOverviewPanel({ user, navigate }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const isAdmin = user?.role === 'admin';

  const load = async () => {
    try {
      const res = await fetch(`${API_URL}/strategies/overview`, { credentials: 'include' });
      setRows(res.ok ? await res.json() : []);
    } catch (_) { setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (s) => {
    if (!isAdmin) return;
    setBusy(s.key);
    try {
      const res = await fetch(`${API_URL}/admin/strategy-toggle`, {
        credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: s.key, paused: s.status === 'active' }),
      });
      if (res.ok) {
        const d = await res.json();
        setRows(prev => prev.map(r => r.key === s.key ? { ...r, status: d.status } : r));
      }
    } catch (_) {} finally { setBusy(null); }
  };

  // Klick auf Karte → Signal-Historie gefiltert auf diese Strategie.
  const openTrades = (key) => {
    try { localStorage.setItem('wavescout_strategy_filter', key); } catch (_) {}
    window.dispatchEvent(new CustomEvent('wavescout-open-strategy', { detail: key }));
    if (navigate) navigate('backtest');
  };

  const fmtTime = (ms) => ms
    ? new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '–';

  if (rows === null) return <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner-lg" style={{ margin: '0 auto' }}/></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Vergleich aller {rows.length} Strategien nebeneinander. Klick auf eine Karte öffnet die gefilterte Signal-Historie.
        {isAdmin ? ' Der Toggle pausiert eine Strategie (keine NEUEN Trades; offene Trades bleiben unberührt).' : ''}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {rows.map(s => (
          <div key={s.key} className="card" style={{ cursor: 'pointer', opacity: s.status === 'paused' ? 0.68 : 1 }}
               onClick={() => openTrades(s.key)} title="Zur gefilterten Signal-Historie">
            <div className="card-head">
              <h3 style={{ fontSize: 14 }}>{s.label}</h3>
              <div className="actions">
                <span className={`badge ${s.assetClass === 'forex' ? 'badge-wait' : 'badge-tag'}`}>
                  {s.assetClass === 'forex' ? 'Forex' : 'Krypto'}
                </span>
              </div>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className={`badge ${s.status === 'active' ? 'badge-win' : 'badge-loss'}`}>
                  {s.status === 'active' ? '● Aktiv' : '⏸ Pausiert'}
                </span>
                {isAdmin && (
                  <button className="btn btn-ghost btn-sm" disabled={busy === s.key}
                          onClick={(e) => { e.stopPropagation(); toggle(s); }}>
                    {busy === s.key ? '…' : s.status === 'active' ? 'Pausieren' : 'Aktivieren'}
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <StratStat label="Offen"       value={s.openTrades}/>
                <StratStat label="Geschlossen" value={s.closedTrades}/>
                <StratStat label="Win-Rate"    value={`${s.winRate}%`} tone={s.winRate >= 50 ? 'win' : 'loss'}/>
                <StratStat label="Ø Win"       value={`${s.avgWinPct}%`} tone="win"/>
                <StratStat label="Ø Loss"      value={`${s.avgLossPct}%`} tone="loss"/>
                <StratStat label="Expectancy"  value={s.expectancy} tone={s.expectancy >= 0 ? 'win' : 'loss'}/>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                Letztes Signal: {fmtTime(s.lastSignalAt)} · <span className="mono">{s.key}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Top-Level-Seite „Strategien" (Hauptnavigation) ──────────────────
// Macht die Strategie-Übersicht als eigener Menüpunkt sichtbar. Vorher war
// StrategyOverviewPanel nur als Admin-Sub-Tab erreichbar (dreifach versteckt:
// nur isAdmin → User-Dropdown „Admin" → Einstellungen → Sub-Tab). Inhalt
// identisch (StrategyOverviewPanel), nur als eigenständige Route.
function StrategienPage({ user, navigate }) {
  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Strategien</h2>
        <p className="subtitle">Übersicht &amp; Performance aller Handelsstrategien</p>
      </div>
      <StrategyOverviewPanel user={user} navigate={navigate}/>
    </div>
  );
}

function AdminSection({ user, navigate }) {
  const [sub, setSub] = useState('verwaltung');
  // Orphaned Voll-Admin-Panel (admin.jsx) defensiv referenzieren (lädt nach dieser Datei).
  const AdminFullPanel = (typeof AdminPage !== 'undefined') ? AdminPage : (typeof window !== 'undefined' ? window.AdminPage : null);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {ADMIN_SUBS.map(item => (
          <button
            key={item.id}
            onClick={() => setSub(item.id)}
            style={{
              padding: '7px 14px', borderRadius: 8,
              border: `1px solid ${sub === item.id ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
              background: sub === item.id ? 'rgba(59,130,246,.08)' : 'var(--bg-2)',
              color: sub === item.id ? 'var(--blue-400)' : 'var(--text-secondary)',
              fontSize: 12, fontWeight: sub === item.id ? 600 : 400,
              cursor: 'pointer', fontFamily: 'var(--font-main)', transition: 'all .15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Icon name={item.icon} size={13}/> {item.label}
          </button>
        ))}
      </div>
      {sub === 'verwaltung' && (AdminFullPanel
        ? <AdminFullPanel user={user}/>
        : <div style={{ padding: 20, color: 'var(--text-tertiary)', fontSize: 13 }}>Admin-Panel konnte nicht geladen werden.</div>)}
      {sub === 'testsignal'  && <AdminTestSignalPanel/>}
      {sub === 'tradecheck'  && <AdminTradeCheckPanel/>}
      {sub === 'webhook'     && <AdminWebhookTester/>}
      {sub === 'webhook-log' && (typeof AdminWebhookLogPanel !== 'undefined' ? <AdminWebhookLogPanel/> : <div className="muted" style={{ padding: 20 }}>Lädt…</div>)}
      {sub === 'kapital'     && (typeof CapitalResetCard !== 'undefined' ? <CapitalResetCard/> : <div className="muted" style={{ padding: 20 }}>Lädt…</div>)}
      {sub === 'system'      && <SystemSection/>}
    </div>
  );
}

// ─── Account Section ─────────────────────────────────────────

function AccountSection({ user }) {
  return (
    <div className="card">
      <div className="card-head"><Icon name="users" className="ico"/><h3>Account</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 4 }}>BENUTZERNAME</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{user?.username || '–'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 4 }}>ROLLE</div>
            <span className="badge badge-tag" style={{ fontSize: 12 }}>{user?.role || '–'}</span>
          </div>
          {user?.email && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 4 }}>E-MAIL</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{user.email}</div>
            </div>
          )}
        </div>
        <a href="change-password.html" className="btn btn-ghost btn-sm">
          <Icon name="key" size={13}/> Passwort ändern
        </a>
      </div>
    </div>
  );
}

// ─── Design Section ───────────────────────────────────────────

function DesignSection() {
  const [lightMode, setLightMode] = useState(() => localStorage.getItem('theme') === 'light');

  const toggle = () => {
    const next = !lightMode;
    setLightMode(next);
    document.documentElement.setAttribute('data-theme', next ? 'light' : 'dark');
    localStorage.setItem('theme', next ? 'light' : 'dark');
  };

  return (
    <div className="card">
      <div className="card-head"><Icon name="sun" className="ico"/><h3>Design</h3></div>
      <div className="card-body">
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={lightMode} onChange={toggle}/>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Light Mode</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>Helles Theme aktivieren (auch über Sidebar-Toggle änderbar)</div>
          </div>
        </label>
      </div>
    </div>
  );
}

// ─── Trading Section ──────────────────────────────────────────

function TradingSection({ settings, setSettings, onSave, saved }) {
  return (
    <div className="card">
      <div className="card-head"><Icon name="chart" className="ico"/><h3>Trading</h3></div>
      <div className="card-body">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, marginBottom: 20 }}>
          <input type="checkbox" checked={settings.autoTrade} onChange={e => setSettings({ ...settings, autoTrade: e.target.checked })}/>
          Auto-Trading aktivieren (Score ≥ {settings.minScore})
        </label>

        {[
          { key: 'riskPerTrade',  label: 'Risiko pro Trade',          suffix: '%', min: 0.5, max: 5,  step: 0.5, parse: parseFloat },
          { key: 'minScore',      label: 'Minimaler Score',           suffix: '',  min: 50,  max: 90, step: 5,   parse: parseInt   },
          { key: 'maxOpenTrades', label: 'Max. gleichzeitige Trades', suffix: '',  min: 1,   max: 10, step: 1,   parse: parseInt   },
        ].map(({ key, label, suffix, min, max, step, parse }) => (
          <div key={key} style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
              {label}: <span style={{ color: 'var(--blue-500)' }}>{settings[key]}{suffix}</span>
            </label>
            <input type="range" min={min} max={max} step={step} value={settings[key]}
              onChange={e => setSettings({ ...settings, [key]: parse(e.target.value) })}
              style={{ width: '100%', maxWidth: 360 }}/>
          </div>
        ))}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {[
            ['useStopLoss',   'Stop-Loss immer setzen'],
            ['useTakeProfit', 'Take-Profit immer setzen'],
            ['trailingStop',  'Trailing Stop verwenden'],
          ].map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })}/>
              {label}
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary btn-sm" onClick={onSave}>
            <Icon name="check" size={13}/> Speichern
          </button>
          {saved && (
            <span style={{ color: 'var(--win)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="check" size={12}/> Gespeichert
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Notifications Section ────────────────────────────────────

function NotificationsSection({ settings, setSettings, onSave, saved }) {
  const [ntfyLoading, setNtfyLoading] = useState(false);
  const [ntfyResult,  setNtfyResult]  = useState(null);
  const [pushTestLoading, setPushTestLoading] = useState(false);
  const [pushTestResult,  setPushTestResult]  = useState(null);
  const [pushState,   setPushState]   = useState('checking'); // checking | unavailable | unsubscribed | subscribing | subscribed | error
  const [pushMsg,     setPushMsg]     = useState('');
  const [vapidKey,    setVapidKey]    = useState(null);

  useEffect(() => { checkPushState(); }, []);

  const checkPushState = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState('unavailable'); return;
    }
    try {
      const res = await fetch(`${API_URL}/push/vapid-public-key`, { credentials: 'include' });
      const { key } = await res.json();
      if (!key) { setPushState('unavailable'); setPushMsg('VAPID_PUBLIC_KEY nicht konfiguriert'); return; }
      setVapidKey(key);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setPushState(sub ? 'subscribed' : 'unsubscribed');
    } catch (e) {
      setPushState('error'); setPushMsg(e.message);
    }
  };

  const subscribePush = async () => {
    setPushState('subscribing'); setPushMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPushState('unsubscribed'); setPushMsg('Berechtigung verweigert'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
      await fetch(`${API_URL}/push/subscribe`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      setPushState('subscribed'); setPushMsg('');
    } catch (e) {
      setPushState('unsubscribed'); setPushMsg(e.message);
    }
  };

  const unsubscribePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(`${API_URL}/push/subscribe`, {
          method: 'DELETE', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setPushState('unsubscribed'); setPushMsg('');
    } catch (e) {
      setPushMsg(e.message);
    }
  };

  const testNtfy = async () => {
    setNtfyLoading(true); setNtfyResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/test-ntfy`, { credentials: 'include' });
      const d = await res.json();
      setNtfyResult({ ok: d.success, msg: d.success ? 'ntfy OK ✓' : (d.message || 'Fehler') });
    } catch (e) {
      setNtfyResult({ ok: false, msg: e.message });
    }
    setNtfyLoading(false);
  };

  const testWebPush = async () => {
    setPushTestLoading(true); setPushTestResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/test-push`, { method: 'POST', credentials: 'include' });
      const d = await res.json();
      setPushTestResult({ ok: d.success, msg: d.success ? `Push gesendet (${d.sent || 0} Geräte)` : (d.error || 'Fehler') });
    } catch (e) {
      setPushTestResult({ ok: false, msg: e.message });
    }
    setPushTestLoading(false);
  };

  const pushDot = pushState === 'subscribed' ? 'var(--win)' : pushState === 'unavailable' || pushState === 'error' ? 'var(--loss)' : 'var(--text-quaternary)';
  const pushLabel = pushState === 'subscribed' ? 'Aktiv' : pushState === 'unavailable' ? 'Nicht verfügbar' : pushState === 'checking' ? 'Wird geprüft…' : pushState === 'subscribing' ? 'Wird aktiviert…' : 'Inaktiv';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
      {/* Browser Push */}
      <div className="card">
        <div className="card-head"><Icon name="bell" className="ico"/><h3>Browser Push</h3>
          <div className="actions">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pushDot, display: 'inline-block' }}/>
              <span style={{ color: pushDot, fontWeight: 600 }}>{pushLabel}</span>
            </span>
          </div>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
            Erhalte Push-Benachrichtigungen direkt im Browser oder auf dem iPhone (PWA) für Signale mit Score&nbsp;≥&nbsp;80 — auch wenn die App im Hintergrund ist.
          </p>
          {pushState === 'unavailable' ? (
            <div style={{ fontSize: 13, color: 'var(--loss)' }}>
              {pushMsg || 'Push nicht unterstützt (kein Service Worker / kein HTTPS).'}
            </div>
          ) : pushState === 'subscribed' ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--win)' }}>✓ Dieses Gerät erhält Push-Benachrichtigungen</span>
              <button className="btn btn-ghost btn-sm" onClick={unsubscribePush}>Deaktivieren</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={subscribePush}
                disabled={pushState === 'checking' || pushState === 'subscribing'}>
                {pushState === 'subscribing' ? <><div className="spinner-sm"/> Aktiviere…</> : <><Icon name="bell" size={13}/> Push aktivieren</>}
              </button>
              {pushMsg && <span style={{ fontSize: 12, color: 'var(--loss)' }}>{pushMsg}</span>}
            </div>
          )}
          {pushState === 'unsubscribed' && (
            <p style={{ fontSize: 11, color: 'var(--text-quaternary)', marginTop: 10 }}>
              Auf iPhone: WAVESCOUT muss als PWA zum Home-Bildschirm hinzugefügt sein (iOS 16.4+).
            </p>
          )}
        </div>
      </div>

      {/* Settings toggles */}
      <div className="card">
        <div className="card-head"><Icon name="bell" className="ico"/><h3>Benachrichtigungseinstellungen</h3></div>
        <div className="card-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
            {[
              ['telegramEnabled', 'Telegram-Benachrichtigungen'],
            ].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })}/>
                {label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
            <button className="btn btn-primary btn-sm" onClick={onSave}>
              <Icon name="check" size={13}/> Speichern
            </button>
            {saved && (
              <span style={{ color: 'var(--win)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="check" size={12}/> Gespeichert
              </span>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>NTFY.SH TEST</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Sendet einen Test-Push via ntfy.sh (Score&nbsp;97, BTCUSDT). Benötigt das Secret <code>NTFY_TOPIC</code>.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" onClick={testNtfy} disabled={ntfyLoading}>
                {ntfyLoading ? 'Sende...' : 'ntfy Test senden'}
              </button>
              {ntfyResult && (
                <span style={{ fontSize: 13, color: ntfyResult.ok ? 'var(--win)' : 'var(--loss)' }}>
                  {ntfyResult.msg}
                </span>
              )}
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>BROWSER PUSH TEST</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Sendet eine Test-Benachrichtigung an alle aktiven Browser-Push-Subscriptions.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" onClick={testWebPush} disabled={pushTestLoading}>
                {pushTestLoading ? 'Sende...' : <><Icon name="bell" size={13}/> Push Test senden</>}
              </button>
              {pushTestResult && (
                <span style={{ fontSize: 13, color: pushTestResult.ok ? 'var(--win)' : 'var(--loss)' }}>
                  {pushTestResult.msg}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Broker / API Section ─────────────────────────────────────

function BrokerSection({ settings, setSettings, onSave, saved, showBrokerModal, setShowBrokerModal }) {
  const [copied, setCopied] = useState(false);
  const [atConfig, setAtConfig] = useState({
    broker: settings.broker || 'bybit',
    apiKey: '', apiSecret: '', passphrase: '',
    testnet: true, enabled: false, tradeAmount: 10, minScore: 75,
  });
  const [atSaving, setAtSaving] = useState(false);
  const [atSaved,  setAtSaved]  = useState(false);
  const [atLoaded, setAtLoaded] = useState(false);
  const [atError,  setAtError]  = useState(null);
  const selectedBroker = BROKERS.find(b => b.id === settings.broker) || BROKERS[0];

  // Load autotrade config from backend on mount
  useEffect(() => {
    fetch(`${API_URL}/broker-config`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.configured) {
          setAtConfig(prev => ({
            ...prev,
            broker: d.broker || prev.broker,
            testnet: d.testnet ?? prev.testnet,
            enabled: d.enabled ?? prev.enabled,
            tradeAmount: d.tradeAmount || prev.tradeAmount,
            minScore: d.minScore || prev.minScore,
          }));
        }
        setAtLoaded(true);
      })
      .catch(() => setAtLoaded(true));
  }, []);

  const saveAtConfig = async () => {
    setAtSaving(true); setAtError(null);
    try {
      const body = { ...atConfig, broker: settings.broker };
      const res = await fetch(`${API_URL}/broker-config`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // Clear secret fields from state after save (don't keep in memory)
        setAtConfig(prev => ({ ...prev, apiSecret: '', passphrase: '' }));
        setAtSaved(true);
        setTimeout(() => setAtSaved(false), 2500);
      } else {
        const err = await res.json().catch(() => ({}));
        setAtError(err.error || 'Fehler beim Speichern');
      }
    } catch { setAtError('Netzwerkfehler'); }
    setAtSaving(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(WEBHOOK_URL)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Webhook info */}
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>TradingView Webhook</h3>
          <div className="actions"><span className="badge badge-win">LIVE</span></div>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
            Diese URL in TradingView unter <strong>Alerts → Webhook URL</strong> eintragen.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <div style={{
              flex: 1, padding: '10px 14px', background: 'var(--bg-0)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 13,
              color: 'var(--text-secondary)', wordBreak: 'break-all'
            }}>
              {WEBHOOK_URL}
            </div>
            <button className="btn btn-sm" onClick={handleCopy} style={{ flexShrink: 0 }}>
              {copied ? <><Icon name="check" size={13}/> Kopiert</> : <><Icon name="save" size={13}/> Kopieren</>}
            </button>
          </div>
          <div style={{ padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)', fontSize: 12, color: 'var(--text-secondary)' }}>
            <strong>Beispiel-Payload (SIGNAL):</strong>
            <pre style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
{`{"symbol":"BTCUSDT","event_type":"SIGNAL","timeframe":"5","price":{{close}},"direction":"LONG","trigger":"EMA_CROSS","action":"BUY"}`}
            </pre>
          </div>
        </div>
      </div>

      {/* Broker picker */}
      <div className="card">
        <div className="card-head"><Icon name="settings" className="ico"/><h3>Broker</h3></div>
        <div className="card-body">
          <div
            onClick={() => setShowBrokerModal(true)}
            style={{
              padding: '16px 20px', background: 'var(--bg-0)', borderRadius: 10,
              border: '1px solid var(--border)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 14, transition: 'border-color 0.2s'
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--blue-500)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
          >
            <span style={{ fontSize: 36 }}>{selectedBroker.logo}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedBroker.name}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {selectedBroker.features.map((f, i) => <span key={i} className="badge badge-tag">{f}</span>)}
              </div>
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Ändern →</span>
          </div>
        </div>
      </div>

      {/* Autotrade config */}
      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/>
          <h3>Autotrade Konfiguration</h3>
          <div className="actions">
            {atConfig.enabled
              ? <span className="badge badge-win">AKTIV</span>
              : <span className="badge badge-tag">INAKTIV</span>}
          </div>
        </div>
        <div className="card-body">

          {!atLoaded ? (
            <div style={{ padding: 20, textAlign: 'center' }}><div className="spinner-sm"/></div>
          ) : (
            <>
              {/* Autotrade on/off */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={atConfig.enabled}
                  onChange={e => setAtConfig(c => ({ ...c, enabled: e.target.checked }))}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Autotrade aktivieren</div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    Bei qualifizierten Signalen automatisch echte Orders platzieren
                  </div>
                </div>
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.05em' }}>BETRAG PRO TRADE (USDT)</label>
                  <input
                    type="number" min="1" step="1"
                    value={atConfig.tradeAmount}
                    onChange={e => setAtConfig(c => ({ ...c, tradeAmount: parseFloat(e.target.value) || 10 }))}
                    className="input" style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.05em' }}>MIN. SCORE</label>
                  <input
                    type="number" min="55" max="100" step="5"
                    value={atConfig.minScore}
                    onChange={e => setAtConfig(c => ({ ...c, minScore: parseInt(e.target.value) || 75 }))}
                    className="input" style={{ width: '100%' }}
                  />
                </div>
              </div>

              {/* API credentials */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.05em' }}>API KEY</label>
                <input
                  type="text"
                  value={atConfig.apiKey}
                  onChange={e => setAtConfig(c => ({ ...c, apiKey: e.target.value }))}
                  placeholder={`${selectedBroker.name} API Key`}
                  className="input" style={{ width: '100%' }}
                  autoComplete="off"
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.05em' }}>API SECRET</label>
                <input
                  type="password"
                  value={atConfig.apiSecret}
                  onChange={e => setAtConfig(c => ({ ...c, apiSecret: e.target.value }))}
                  placeholder="Leer lassen um bestehenden Key zu behalten"
                  className="input" style={{ width: '100%' }}
                  autoComplete="new-password"
                />
              </div>
              {settings.broker === 'blofin' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.05em' }}>PASSPHRASE (BloFin)</label>
                  <input
                    type="password"
                    value={atConfig.passphrase}
                    onChange={e => setAtConfig(c => ({ ...c, passphrase: e.target.value }))}
                    placeholder="BloFin API Passphrase"
                    className="input" style={{ width: '100%' }}
                    autoComplete="new-password"
                  />
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={atConfig.testnet}
                  onChange={e => setAtConfig(c => ({ ...c, testnet: e.target.checked }))}
                />
                <span>
                  Testnet / Demo-Modus{' '}
                  <span style={{ fontSize: 12, color: atConfig.testnet ? 'var(--win)' : 'var(--loss)', fontWeight: 600 }}>
                    {atConfig.testnet ? '(kein echtes Geld)' : '(LIVE — echtes Geld!)'}
                  </span>
                </span>
              </label>

              {!atConfig.testnet && atConfig.enabled && (
                <div style={{ padding: '10px 14px', background: 'rgba(240,68,68,.08)', borderRadius: 8, border: '1px solid rgba(240,68,68,.3)', fontSize: 12, color: 'var(--loss)', marginBottom: 14, fontWeight: 600 }}>
                  ⚠️ LIVE-MODUS aktiv — Signale ab Score {atConfig.minScore} öffnen echte Positionen mit {atConfig.tradeAmount} USDT
                </div>
              )}

              <div style={{ padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
                API-Keys werden verschlüsselt auf dem Server gespeichert. Nur Trading-Rechte vergeben — <strong>kein Withdrawal-Recht</strong>.
              </div>

              {atError && (
                <div style={{ padding: '8px 14px', background: 'rgba(240,68,68,.08)', borderRadius: 8, fontSize: 12, color: 'var(--loss)', marginBottom: 12 }}>
                  {atError}
                </div>
              )}

              <button className="btn btn-primary" onClick={saveAtConfig} disabled={atSaving}>
                {atSaving ? <div className="spinner-sm"/> : <Icon name="save" size={14}/>}
                {atSaved ? 'Gespeichert ✓' : 'Auf Server speichern'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── System Section ───────────────────────────────────────────

function SystemSection() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-head"><Icon name="settings" className="ico"/><h3>System Info</h3></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              ['Worker Runtime', 'Cloudflare Workers'],
              ['Datenbank',      'Cloudflare D1 (SQLite)'],
              ['Frontend',       'Cloudflare Pages'],
              ['React',          '18 (Babel Standalone)'],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 3 }}>{k.toUpperCase()}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><Icon name="external" className="ico"/><h3>Cloudflare Dashboard</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
            Logs, Metrics, Bindings und Cron-Trigger im Cloudflare Dashboard verwalten.
          </p>
          <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            <Icon name="external" size={13}/> Cloudflare Dashboard öffnen
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Settings Page ───────────────────────────────────────

const EinstellungenPage = ({ user, navigate }) => {
  const [settings, setSettings] = useState({
    broker: 'bybit', apiKey: '', apiSecret: '', testnet: true,
    notifications: true, telegramEnabled: true, autoTrade: false,
    riskPerTrade: 2, maxOpenTrades: 3, minScore: 65,
    useStopLoss: true, useTakeProfit: true, trailingStop: false
  });
  const [saved,           setSaved]           = useState(false);
  const [activeSection,   setActiveSection]   = useState('account');
  const [showBrokerModal, setShowBrokerModal] = useState(false);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    const s = localStorage.getItem('wavescout_settings');
    if (s) { try { setSettings(JSON.parse(s)); } catch (_) {} }
  }, []);

  useEffect(() => {
    const valid = ['account','design','trading','notifications','broker'];
    if (isAdmin) valid.push('admin');
    const h = (e) => { if (valid.includes(e.detail)) setActiveSection(e.detail); };
    window.addEventListener('wavescout-settings-section', h);
    return () => window.removeEventListener('wavescout-settings-section', h);
  }, [isAdmin]);

  const handleSave = () => {
    localStorage.setItem('wavescout_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const SECTIONS = [
    { id: 'account',       label: 'Account',           icon: 'users'    },
    { id: 'design',        label: 'Design',             icon: 'sun'      },
    { id: 'trading',       label: 'Trading',            icon: 'chart'    },
    { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell'     },
    { id: 'broker',        label: 'Broker / API',       icon: 'key'      },
    ...(isAdmin ? [
      { id: 'admin', label: 'Admin', icon: 'shield', adminOnly: true },
    ] : []),
  ];

  const renderContent = () => {
    switch (activeSection) {
      case 'account':       return <AccountSection user={user}/>;
      case 'design':        return <DesignSection/>;
      case 'trading':       return <TradingSection settings={settings} setSettings={setSettings} onSave={handleSave} saved={saved}/>;
      case 'notifications': return <NotificationsSection settings={settings} setSettings={setSettings} onSave={handleSave} saved={saved}/>;
      case 'broker':        return <BrokerSection settings={settings} setSettings={setSettings} onSave={handleSave} saved={saved} showBrokerModal={showBrokerModal} setShowBrokerModal={setShowBrokerModal}/>;
      case 'admin':         return isAdmin ? <AdminSection user={user} navigate={navigate}/> : null;
      default:              return <AccountSection user={user}/>;
    }
  };

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Einstellungen</h2>
        <p className="subtitle">Konfiguration &amp; Verwaltung</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left sidebar nav */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 20 }}>
          {SECTIONS.map((sec, i) => {
            const showDivider = sec.adminOnly && (i === 0 || !SECTIONS[i - 1].adminOnly);
            return (
              <React.Fragment key={sec.id}>
                {showDivider && (
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 0 6px' }}/>
                )}
                <button
                  onClick={() => setActiveSection(sec.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                    borderRadius: 10, border: 'none',
                    background: activeSection === sec.id ? 'rgba(59,130,246,.1)' : 'transparent',
                    color: activeSection === sec.id ? 'var(--blue-400)' : 'var(--text-secondary)',
                    fontSize: 13, fontWeight: activeSection === sec.id ? 600 : 400,
                    cursor: 'pointer', fontFamily: 'var(--font-main)', transition: 'all .15s',
                    textAlign: 'left', width: '100%',
                  }}
                >
                  <Icon name={sec.icon} size={15} style={{ flexShrink: 0 }}/>
                  <span style={{ flex: 1 }}>{sec.label}</span>
                  {sec.adminOnly && (
                    <span style={{ fontSize: 9, padding: '2px 5px', background: 'rgba(59,130,246,.15)', color: 'var(--blue-400)', borderRadius: 4, fontWeight: 700, letterSpacing: '0.06em' }}>ADMIN</span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Right content area */}
        <div>{renderContent()}</div>
      </div>

      {showBrokerModal && (
        <BrokerModal
          brokers={BROKERS}
          selected={settings.broker}
          onSelect={id => { setSettings({ ...settings, broker: id }); setShowBrokerModal(false); }}
          onClose={() => setShowBrokerModal(false)}
        />
      )}
    </div>
  );
};

// ─── Broker Modal ─────────────────────────────────────────────

const BrokerModal = ({ brokers, selected, onSelect, onClose }) => (
  <div
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
    onClick={onClose}
  >
    <div
      style={{ background: 'var(--bg-1)', borderRadius: 16, maxWidth: 760, width: '100%', maxHeight: '85vh', overflow: 'auto', padding: 28 }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Broker auswählen</h2>
        <button onClick={onClose} style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 18, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
        {brokers.map(broker => (
          <div
            key={broker.id}
            onClick={() => onSelect(broker.id)}
            style={{
              padding: 14, borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s',
              background: broker.id === selected ? 'var(--bg-2)' : 'var(--bg-0)',
              border: `2px solid ${broker.id === selected ? 'var(--blue-500)' : 'var(--border)'}`,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>{broker.logo}</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{broker.name}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {broker.features.map((f, i) => <span key={i} style={{ fontSize: 10, padding: '2px 5px', background: 'var(--bg-1)', borderRadius: 4, color: 'var(--text-tertiary)' }}>{f}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

window.EinstellungenPage = EinstellungenPage;
