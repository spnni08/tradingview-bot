// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - ADMIN PANEL
// System · Telegram · AI · Webhook · DB · Sessions · Users
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useRef } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ─── Small helpers ───────────────────────────────────────────

function sid() { return localStorage.getItem('wavescout_session'); }

function StatusDot({ ok, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
        background: ok === null ? 'var(--text-quaternary)' : ok ? 'var(--win)' : 'var(--loss)',
        boxShadow: ok ? '0 0 6px var(--win)' : undefined
      }}/>
      <span style={{ fontSize: 13, color: ok === null ? 'var(--text-tertiary)' : ok ? 'var(--win)' : 'var(--loss)', fontWeight: 600 }}>
        {ok === null ? 'Unbekannt' : ok ? 'OK' : 'Nicht konfiguriert'}
      </span>
      {label && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>· {label}</span>}
    </div>
  );
}

function ResultBox({ result }) {
  if (!result) return null;
  return (
    <div style={{
      marginTop: 14, padding: '12px 16px', borderRadius: 10,
      background: result.ok || result.success ? 'var(--bg-success)' : 'var(--bg-error)',
      border: `1px solid ${result.ok || result.success ? 'var(--win)' : 'var(--loss)'}`,
      display: 'flex', alignItems: 'flex-start', gap: 12
    }}>
      <span style={{ fontSize: 18, marginTop: 1 }}>{result.ok || result.success ? '✅' : '❌'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: result.ok || result.success ? 'var(--win)' : 'var(--loss)' }}>
          {result.ok || result.success ? 'Erfolgreich' : 'Fehler'}
        </div>
        <pre style={{
          margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)'
        }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ─── Section: System Status ──────────────────────────────────

function SystemStatusCard({ status, onRefresh }) {
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>System Status</h3>
        <div className="actions">
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>↻ Refresh</button>
          <span className="badge badge-tag">{status?.version || '–'}</span>
        </div>
      </div>
      <div className="card-body">
        {!status ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Lade Status…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20 }}>

            {/* Service Status */}
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 12 }}>SERVICES</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Datenbank (D1)</span>
                  <StatusDot ok={status.db}/>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Telegram Bot</span>
                  <StatusDot ok={status.telegram}/>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Anthropic AI</span>
                  <StatusDot ok={status.anthropic}/>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Webhook Secret</span>
                  <StatusDot ok={status.webhook}/>
                </div>
              </div>
            </div>

            {/* Table Counts */}
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 12 }}>DATENBANK — ZEILEN</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(status.tables || {}).map(([table, count]) => (
                  <div key={table} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{table}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: count === null ? 'var(--loss)' : 'var(--text-primary)' }}>
                      {count === null ? '✗ n/a' : count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section: Telegram ───────────────────────────────────────

function TelegramCard({ status }) {
  const [testing, setTesting]         = useState(false);
  const [testResult, setTestResult]   = useState(null);
  const [customMsg, setCustomMsg]     = useState('');
  const [sending, setSending]         = useState(false);
  const [sendResult, setSendResult]   = useState(null);
  const [signalResult, setSignalResult] = useState(null);
  const [sendingSignal, setSendingSignal] = useState(false);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch(`${API_URL}/test-telegram`, { headers: { 'X-Session-ID': sid() } });
      setTestResult(await res.json());
    } catch (e) { setTestResult({ success: false, message: e.message }); }
    finally { setTesting(false); }
  };

  const handleSendCustom = async () => {
    if (!customMsg.trim()) return;
    setSending(true); setSendResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ message: customMsg })
      });
      setSendResult(await res.json());
    } catch (e) { setSendResult({ success: false, message: e.message }); }
    finally { setSending(false); }
  };

  const handleTestSignalAlert = async () => {
    setSendingSignal(true); setSignalResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({
          message: `🟢 <b>BTCUSDT</b> LONG\n\n⭐⭐⭐ Score: <b>82/100</b>\n📊 Timeframe: 5\n💰 Entry: $80,000.00\n🎯 TP: $81,600.00\n🛑 SL: $79,200.00\n\n📡 Dies ist ein Test-Signal aus dem Admin-Panel`
        })
      });
      setSignalResult(await res.json());
    } catch (e) { setSignalResult({ success: false, message: e.message }); }
    finally { setSendingSignal(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="bell" className="ico"/>
        <h3>Telegram Integration</h3>
        <div className="actions">
          <StatusDot ok={status?.telegram ?? null}/>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Quick Tests */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>SCHNELLTEST</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? <><div className="spinner-sm"/> Sende…</> : '🔔 Verbindung testen'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleTestSignalAlert} disabled={sendingSignal}>
              {sendingSignal ? <><div className="spinner-sm"/> Sende…</> : '📊 Test-Signal Alert'}
            </button>
          </div>
          {testResult && <ResultBox result={{ ...testResult, ok: testResult.success }}/>}
          {signalResult && <ResultBox result={{ ...signalResult, ok: signalResult.success }}/>}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>EIGENE NACHRICHT</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>
            HTML-Formatierung erlaubt: <code style={{ background: 'var(--bg-2)', padding: '1px 4px', borderRadius: 4 }}>&lt;b&gt;</code> <code style={{ background: 'var(--bg-2)', padding: '1px 4px', borderRadius: 4 }}>&lt;i&gt;</code> <code style={{ background: 'var(--bg-2)', padding: '1px 4px', borderRadius: 4 }}>&lt;code&gt;</code>
          </div>
          <textarea
            value={customMsg}
            onChange={e => setCustomMsg(e.target.value)}
            placeholder="Nachricht eingeben… z.B. 🚨 <b>System-Warnung</b>: Manueller Test"
            className="input"
            style={{ width: '100%', minHeight: 90, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 13 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={handleSendCustom} disabled={sending || !customMsg.trim()}>
              {sending ? <><div className="spinner-sm"/> Sende…</> : '📤 Senden'}
            </button>
          </div>
          {sendResult && <ResultBox result={{ ...sendResult, ok: sendResult.success }}/>}
        </div>

      </div>
    </div>
  );
}

// ─── Section: AI Status ──────────────────────────────────────

function AIStatusCard({ status }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult]   = useState(null);

  const handleTest = async () => {
    setTesting(true); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/test-ai`, {
        method: 'POST',
        headers: { 'X-Session-ID': sid() }
      });
      setResult(await res.json());
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setTesting(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="chart" className="ico"/>
        <h3>Anthropic AI</h3>
        <div className="actions">
          <StatusDot ok={status?.anthropic ?? null}/>
        </div>
      </div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>KONFIGURATION</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['Modell', 'claude-sonnet-4-5'],
                ['Fallback', 'Rule-based (automatisch)'],
                ['Telegram-Threshold', 'Score ≥ 55'],
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{k}</div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {result?.ok && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>LETZTER TEST</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  ['Latenz', result.latencyMs + ' ms'],
                  ['Modell', result.model || '–'],
                  ['Input Tokens', result.inputTokens?.toString() || '–'],
                  ['Output Tokens', result.outputTokens?.toString() || '–'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{k}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: k === 'Latenz' ? (result.latencyMs < 1000 ? 'var(--win)' : 'var(--loss)') : 'var(--text-primary)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={handleTest} disabled={testing}>
            {testing ? <><div className="spinner-sm"/> Teste…</> : '🤖 API Verbindung testen'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Token-Nutzung & Limits → Anthropic Console
          </span>
        </div>

        {result && !result.ok && (
          <ResultBox result={result}/>
        )}
        {result?.ok && (
          <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--bg-success)', border: '1px solid var(--win)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>✅</span>
            <span style={{ fontSize: 13, color: 'var(--win)', fontWeight: 600 }}>API verbunden · {result.latencyMs}ms Latenz · Modell: {result.model}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section: Webhook Tester ─────────────────────────────────

function WebhookTesterCard() {
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(null); // 'SNAPSHOT' | 'SIGNAL' | null

  const send = async (type) => {
    setLoading(type); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/test-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ type })
      });
      setResult(await res.json());
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setLoading(null); }
  };

  const payloads = {
    SNAPSHOT: `{
  "symbol": "BTCUSDT",
  "event_type": "SNAPSHOT",
  "timeframe": "5",
  "price": 80000,
  "rsi": 55,
  "ema50": 79800,
  "ema200": 78000,
  "trend": "bullish",
  "trend_1h": "GREEN"
}`,
    SIGNAL: `{
  "symbol": "BTCUSDT",
  "event_type": "SIGNAL",
  "timeframe": "5",
  "price": 80000,
  "direction": "LONG",
  "trigger": "ADMIN_TEST",
  "action": "BUY",
  "rsi": 55
}`
  };

  const [preview, setPreview] = useState('SNAPSHOT');

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Webhook Tester</h3>
        <div className="actions">
          <span className="badge badge-tag">Simuliert echte TradingView Payloads</span>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Left: Controls */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 12 }}>TEST SENDEN</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className={`btn btn-sm ${preview === 'SNAPSHOT' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPreview('SNAPSHOT')}
            >
              📸 SNAPSHOT — Marktdaten
            </button>
            <button
              className={`btn btn-sm ${preview === 'SIGNAL' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPreview('SIGNAL')}
            >
              📊 SIGNAL — Trade-Signal
            </button>
          </div>

          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: '100%' }}
            onClick={() => send(preview)}
            disabled={loading !== null}
          >
            {loading === preview
              ? <><div className="spinner-sm"/> Sende {preview}…</>
              : `▶ ${preview} senden`
            }
          </button>

          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
            {preview === 'SNAPSHOT'
              ? 'Speichert in snapshots-Tabelle und evaluiert offene Practice Trades.'
              : 'Erstellt Signal + Practice Trade, analysiert mit AI, sendet Telegram falls Score ≥ 55.'}
          </div>

          {result && <ResultBox result={result}/>}
        </div>

        {/* Right: Payload Preview */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 12 }}>PAYLOAD VORSCHAU</div>
          <pre style={{
            background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '12px 14px', fontSize: 12, color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)', whiteSpace: 'pre', overflowX: 'auto',
            margin: 0, lineHeight: 1.6
          }}>
            {payloads[preview]}
          </pre>
        </div>

      </div>
    </div>
  );
}

// ─── Section: DB Maintenance ─────────────────────────────────

function DBMaintenanceCard({ onStatusRefresh }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [setupResult, setSetupResult] = useState(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  const handleCleanup = async () => {
    setConfirmCleanup(false);
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/db-cleanup`, {
        method: 'POST', headers: { 'X-Session-ID': sid() }
      });
      const data = await res.json();
      setResult(data);
      onStatusRefresh();
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setLoading(false); }
  };

  const handleSetupDB = async () => {
    setSetupLoading(true); setSetupResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/setup-db`, {
        method: 'POST', headers: { 'X-Session-ID': sid() }
      });
      const data = await res.json();
      setSetupResult({ ok: data.success, results: data.results });
      onStatusRefresh();
    } catch (e) { setSetupResult({ ok: false, error: e.message }); }
    finally { setSetupLoading(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="settings" className="ico"/>
        <h3>Datenbank Wartung</h3>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>SCHEMA MIGRATION</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
              Erstellt fehlende Tabellen (<code style={{ fontSize: 11 }}>IF NOT EXISTS</code>) und fügt neue Spalten hinzu. Sicher jederzeit ausführbar.
            </p>
            <button className="btn btn-ghost btn-sm" onClick={handleSetupDB} disabled={setupLoading}>
              {setupLoading ? <><div className="spinner-sm"/> Migriere…</> : '🔧 Setup DB ausführen'}
            </button>
            {setupResult && (
              <div style={{ marginTop: 10 }}>
                {(setupResult.results || [setupResult.error]).map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', padding: '2px 0' }}>{r}</div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>BEREINIGUNG</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
              Löscht alte Snapshots (max 500 behalten), abgelaufene Sessions und Practice Trades älter als 90 Tage.
            </p>
            {confirmCleanup ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 12, color: 'var(--loss)' }}>Wirklich bereinigen?</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm" style={{ color: 'var(--loss)', borderColor: 'var(--loss)' }} onClick={handleCleanup} disabled={loading}>
                    Ja, bereinigen
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmCleanup(false)}>Abbrechen</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--loss)' }} onClick={() => setConfirmCleanup(true)} disabled={loading}>
                {loading ? <><div className="spinner-sm"/> Bereinige…</> : '🗑 DB bereinigen'}
              </button>
            )}
            {result && (
              <div style={{ marginTop: 10 }}>
                {(result.results || []).map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', padding: '2px 0' }}>{r}</div>
                ))}
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}

// ─── Section: Active Sessions ────────────────────────────────

function SessionsCard() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/sessions`, { headers: { 'X-Session-ID': sid() } });
      if (res.ok) setSessions(await res.json());
    } catch (_) {}
    finally { setLoading(false); }
  };

  const handleKick = async (sessionId) => {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST', headers: { 'X-Session-ID': sessionId }
      });
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (_) {}
  };

  const mySid = sid();

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="users" className="ico"/>
        <h3>Aktive Sessions</h3>
        <div className="actions">
          <span className="badge badge-tag">{sessions.length} aktiv</span>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻</button>
        </div>
      </div>
      {loading ? (
        <div className="card-body" style={{ textAlign: 'center', padding: 30 }}>
          <div className="spinner-lg" style={{ margin: '0 auto' }}/>
        </div>
      ) : sessions.length === 0 ? (
        <div className="card-body" style={{ textAlign: 'center', padding: 30, color: 'var(--text-tertiary)', fontSize: 13 }}>
          Keine aktiven Sessions
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>User</th><th>Rolle</th><th>Angemeldet</th><th>Läuft ab</th><th></th></tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => {
                const isMe = s.id === mySid;
                return (
                  <tr key={i} style={{ background: isMe ? 'rgba(59,130,246,0.05)' : undefined }}>
                    <td style={{ fontWeight: 600 }}>
                      {s.username}
                      {isMe && <span className="badge badge-wait" style={{ marginLeft: 6, fontSize: 10 }}>ICH</span>}
                    </td>
                    <td>
                      <span className={`badge ${s.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>{s.role}</span>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {new Date(s.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {new Date(s.expires_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td>
                      {!isMe && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--loss)' }}
                          title="Session beenden"
                          onClick={() => handleKick(s.id)}
                        >
                          <Icon name="logout" size={13}/>
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
  );
}

// ─── Section: Data Cleanup & Live Mode ───────────────────────

function DataCleanupCard({ onRefresh }) {
  const [mode, setMode]           = useState(null);
  const [liveStartedAt, setLiveStartedAt] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState(null);
  const [resetKeyword, setResetKeyword] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [deleteTestOnLive, setDeleteTestOnLive] = useState(true);
  const { show: showToast, ToastEl } = useAdminToast();

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/settings`, { headers: { 'X-Session-ID': sid() } });
      if (res.ok) {
        const data = await res.json();
        setMode(data.mode || 'test');
        setLiveStartedAt(data.live_started_at ? parseInt(data.live_started_at) : null);
      }
    } catch (_) {}
  };

  const handleDelete = async (type, label) => {
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/delete-signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ type })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`${label} gelöscht (${data.deleted ?? '✓'})`);
        if (onRefresh) onRefresh();
      } else {
        showToast(data.error || 'Fehler', 'err');
      }
    } catch (e) { showToast(e.message, 'err'); }
    finally { setLoading(false); }
  };

  const handleResetAll = async () => {
    if (resetKeyword !== 'RESET') return;
    setShowResetConfirm(false);
    setResetKeyword('');
    await handleDelete('all', 'Alle Signale');
  };

  const handleLiveStart = async () => {
    setShowLiveConfirm(false);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/live-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ deleteTestSignals: deleteTestOnLive })
      });
      const data = await res.json();
      if (data.success) {
        setMode('live');
        setLiveStartedAt(data.liveStartedAt);
        showToast(`Live-Modus gestartet${data.deletedSignals ? ` · ${data.deletedSignals} Test-Signale gelöscht` : ''}`);
        if (onRefresh) onRefresh();
      } else {
        showToast(data.error || 'Fehler', 'err');
      }
    } catch (e) { showToast(e.message, 'err'); }
    finally { setLoading(false); }
  };

  return (
    <div className="card">
      {ToastEl}
      <div className="card-head">
        <Icon name="trash" className="ico" style={{ color: 'var(--loss)' }}/>
        <h3>Daten-Bereinigung & Live-Start</h3>
        <div className="actions">
          <span className={`badge ${mode === 'live' ? 'badge-win' : 'badge-wait'}`}>
            {mode === 'live' ? 'LIVE' : 'TEST'}
          </span>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Mode status */}
        {mode === 'live' && liveStartedAt && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(16,185,129,.08)', border: '1px solid rgba(16,185,129,.2)', fontSize: 13, color: 'var(--win)' }}>
            Live-Modus aktiv seit {new Date(liveStartedAt).toLocaleString('de-DE')}
          </div>
        )}

        {/* Partial deletes */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 12 }}>SIGNALE SELEKTIV LÖSCHEN</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-secondary)' }} onClick={() => handleDelete('test', 'Test-Signale')} disabled={loading}>
              🧪 Test-Signale löschen
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-secondary)' }} onClick={() => handleDelete('wait', 'WAIT-Signale')} disabled={loading}>
              ⏳ WAIT-Signale löschen
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-secondary)' }} onClick={() => handleDelete('skipped', 'SKIPPED-Signale')} disabled={loading}>
              ⏭ SKIPPED löschen
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-secondary)' }} onClick={() => handleDelete('practice', 'Practice Trades')} disabled={loading}>
              📝 Practice Trades löschen
            </button>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

          {/* RESET ALL */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>CLEAN START</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
              Löscht <strong>alle Signale</strong>, Loss-Gründe und Practice Trades unwiderruflich.
            </p>
            <button
              className="btn btn-sm"
              style={{ color: 'var(--loss)', borderColor: 'rgba(239,68,68,.4)' }}
              onClick={() => setShowResetConfirm(true)}
              disabled={loading}
            >
              💥 Alles löschen (RESET)
            </button>
          </div>

          {/* LIVE START */}
          {mode !== 'live' && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>LIVE-MODUS STARTEN</div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
                Schaltet von Test- auf Live-Betrieb um. Setzt <code style={{ fontSize: 11 }}>mode=live</code> und speichert den Startzeitpunkt.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <input
                  type="checkbox"
                  id="delTestOnLive"
                  checked={deleteTestOnLive}
                  onChange={e => setDeleteTestOnLive(e.target.checked)}
                />
                <label htmlFor="delTestOnLive" style={{ fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  Test-Signale dabei löschen
                </label>
              </div>
              <button
                className="btn btn-sm"
                style={{ color: 'var(--win)', borderColor: 'rgba(16,185,129,.4)' }}
                onClick={() => setShowLiveConfirm(true)}
                disabled={loading}
              >
                🚀 Live-Modus starten
              </button>
            </div>
          )}
        </div>

      </div>

      {/* RESET confirm modal */}
      {showResetConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }} onClick={() => { setShowResetConfirm(false); setResetKeyword(''); }}>
          <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 420, width: '90%', border: '1px solid rgba(239,68,68,.4)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: 'var(--loss)', marginBottom: 8 }}>⚠️ Kompletter Reset</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
              Diese Aktion löscht <strong>alle Signale, Loss-Gründe und Practice Trades</strong> unwiderruflich. Tippe <strong>RESET</strong> zum Bestätigen.
            </p>
            <input
              className="input"
              style={{ width: '100%', marginBottom: 14, borderColor: 'rgba(239,68,68,.4)' }}
              placeholder="RESET eingeben"
              value={resetKeyword}
              onChange={e => setResetKeyword(e.target.value)}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn btn-sm"
                style={{ color: 'var(--loss)', borderColor: 'rgba(239,68,68,.4)', opacity: resetKeyword === 'RESET' ? 1 : 0.4 }}
                onClick={handleResetAll}
                disabled={resetKeyword !== 'RESET'}
              >
                Alles löschen
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowResetConfirm(false); setResetKeyword(''); }}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}

      {/* Live start confirm modal */}
      {showLiveConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }} onClick={() => setShowLiveConfirm(false)}>
          <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 380, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: 'var(--win)', marginBottom: 8 }}>🚀 Live-Modus starten?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              {deleteTestOnLive
                ? 'Wechselt zu Live-Betrieb und löscht alle Test-Signale. Kann nicht rückgängig gemacht werden.'
                : 'Wechselt zu Live-Betrieb. Test-Signale bleiben erhalten.'}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={handleLiveStart}>Bestätigen</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowLiveConfirm(false)}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Toast ───────────────────────────────────────────────────

function useAdminToast() {
  const [toast, setToast] = useState(null);
  const show = (msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };
  const ToastEl = toast ? (
    <div style={{
      position: 'fixed', top: 64, right: 20, zIndex: 9999,
      padding: '12px 18px', borderRadius: 10, fontSize: 13, fontWeight: 500,
      background: toast.type === 'ok' ? 'var(--bg-success)' : 'var(--bg-error)',
      border: `1px solid ${toast.type === 'ok' ? 'rgba(16,185,129,.4)' : 'rgba(239,68,68,.4)'}`,
      color: toast.type === 'ok' ? 'var(--win)' : 'var(--loss)',
      boxShadow: '0 4px 16px rgba(0,0,0,.25)',
      animation: 'fadeIn .2s ease'
    }}>
      {toast.type === 'ok' ? '✅ ' : '❌ '}{toast.msg}
    </div>
  ) : null;
  return { show, ToastEl };
}

// ─── Confirm Modal ────────────────────────────────────────────

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }} onClick={onCancel}>
      <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 380, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-primary" onClick={onConfirm}>Bestätigen</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Admin Page ─────────────────────────────────────────

const AdminPage = ({ user }) => {
  const [loading, setLoading]         = useState(true);
  const [users, setUsers]             = useState([]);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [status, setStatus]           = useState(null);
  const [showCreateUser, setShowCreateUser]   = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [confirm, setConfirm]         = useState(null);
  const { show: showToast, ToastEl }   = useAdminToast();

  useEffect(() => {
    if (user?.role !== 'admin') return;
    loadAll();
    const iv = setInterval(loadAll, 30000);
    return () => clearInterval(iv);
  }, []);

  const loadAll = async () => {
    try {
      const [usersRes, statusRes] = await Promise.all([
        fetch(`${API_URL}/users`,         { headers: { 'X-Session-ID': sid() } }),
        fetch(`${API_URL}/admin/status`,  { headers: { 'X-Session-ID': sid() } })
      ]);
      if (usersRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const usersData = usersRes.ok ? await usersRes.json() : [];
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      setOnlineUsers(new Set(usersData.filter(u => u.last_seen && u.last_seen > fiveMinAgo).map(u => u.id)));
      setUsers(usersData);
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (err) {
      console.error('Admin load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async (userData) => {
    try {
      const res = await fetch(`${API_URL}/admin/create-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify(userData)
      });
      if (res.ok) { setShowCreateUser(false); loadAll(); showToast('User erstellt'); }
      else { const e = await res.json(); showToast(e.error || 'Fehler', 'err'); }
    } catch (e) { showToast(e.message, 'err'); }
  };

  const handleBlockUser = (userId, block) => {
    setConfirm({
      message: `User wirklich ${block ? 'sperren' : 'entsperren'}?`,
      onConfirm: async () => {
        setConfirm(null);
        try {
          await fetch(`${API_URL}/admin/block-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
            body: JSON.stringify({ userId, blocked: block })
          });
          loadAll();
          showToast(block ? 'User gesperrt' : 'User entsperrt');
        } catch (_) {}
      }
    });
  };

  const handleLogoutUser = (userId) => {
    setConfirm({
      message: 'User wirklich ausloggen?',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await fetch(`${API_URL}/admin/logout-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
            body: JSON.stringify({ userId })
          });
          loadAll();
          showToast('User ausgeloggt');
        } catch (_) {}
      }
    });
  };

  const handleChangePassword = async (userId, newPassword) => {
    try {
      const res = await fetch(`${API_URL}/admin/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ userId, newPassword })
      });
      if (res.ok) { setShowChangePassword(false); setSelectedUser(null); showToast('Passwort geändert'); }
      else showToast('Fehler beim Ändern des Passworts', 'err');
    } catch (_) {}
  };

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  const onlineCount = users.filter(u => onlineUsers.has(u.id)).length;

  return (
    <div className="content page-enter">
      {ToastEl}
      {confirm && (
        <ConfirmModal
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      <div className="page-header">
        <h2>Administration</h2>
        <p className="subtitle">{users.length} Benutzer · {onlineCount} online</p>
      </div>

      {/* Top KPIs */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Total Users" value={users.length.toString()} sub="Registriert"/>
        <StatCard label="Online" value={onlineCount.toString()} sub="Aktiv (5 min)" subTone="win"/>
        <StatCard label="Admins" value={users.filter(u => u.role === 'admin').length.toString()} sub="Administratoren"/>
        <StatCard label="Gesperrt" value={users.filter(u => u.blocked).length.toString()} sub="Blockiert" subTone={users.filter(u => u.blocked).length > 0 ? 'loss' : 'muted'}/>
      </div>

      {/* System Status */}
      <SystemStatusCard status={status} onRefresh={loadAll}/>

      {/* Telegram + AI side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <TelegramCard status={status}/>
        <AIStatusCard status={status}/>
      </div>

      {/* Webhook Tester */}
      <WebhookTesterCard/>

      {/* DB Maintenance */}
      <DBMaintenanceCard onStatusRefresh={loadAll}/>

      {/* Data Cleanup & Live Mode */}
      <DataCleanupCard onRefresh={loadAll}/>

      {/* Active Sessions */}
      <SessionsCard/>

      {/* User Management */}
      <div className="card">
        <div className="card-head">
          <Icon name="users" className="ico"/>
          <h3>Benutzer-Verwaltung</h3>
          <div className="actions">
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreateUser(true)}>
              <Icon name="plus" size={12}/> Neuer User
            </button>
          </div>
        </div>
        {users.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>Keine Benutzer</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Status</th><th>Benutzer</th><th>Rolle</th><th>Zuletzt gesehen</th><th>Erstellt</th><th>Aktionen</th></tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={i} style={{ opacity: u.blocked ? 0.55 : 1 }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: onlineUsers.has(u.id) ? 'var(--win)' : 'var(--text-quaternary)' }}/>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {onlineUsers.has(u.id) ? 'ONLINE' : 'OFFLINE'}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: u.blocked ? 'var(--text-quaternary)' : 'var(--blue-500)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                          {(u.username || 'U').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{u.username}</div>
                          {u.email && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{u.email}</div>}
                        </div>
                        {u.blocked && <span className="badge badge-loss" style={{ marginLeft: 6 }}>GESPERRT</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>
                        {u.role === 'admin' ? 'ADMIN' : 'USER'}
                      </span>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {u.last_seen ? new Date(u.last_seen).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'}
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {new Date(u.created_at).toLocaleDateString('de-DE')}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" title="Passwort ändern" onClick={() => { setSelectedUser(u); setShowChangePassword(true); }}>
                          <Icon name="key" size={13}/>
                        </button>
                        {onlineUsers.has(u.id) && (
                          <button className="btn btn-ghost btn-sm" title="Ausloggen" onClick={() => handleLogoutUser(u.id)}>
                            <Icon name="logout" size={13}/>
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-sm"
                          title={u.blocked ? 'Entsperren' : 'Sperren'}
                          onClick={() => handleBlockUser(u.id, !u.blocked)}
                          style={{ color: u.blocked ? 'var(--win)' : 'var(--loss)' }}
                        >
                          {u.blocked ? <Icon name="check" size={13}/> : <Icon name="x" size={13}/>}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateUser && (
        <CreateUserModal onClose={() => setShowCreateUser(false)} onCreate={handleCreateUser}/>
      )}
      {showChangePassword && selectedUser && (
        <ChangePasswordModal
          user={selectedUser}
          onClose={() => { setShowChangePassword(false); setSelectedUser(null); }}
          onSave={handleChangePassword}
        />
      )}
    </div>
  );
};

// ─── Create User Modal ───────────────────────────────────────

const CreateUserModal = ({ onClose, onCreate }) => {
  const [formData, setFormData] = useState({ username: '', email: '', password: '', role: 'user', skipPasswordChange: false });
  const [err, setErr] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.username || !formData.email || !formData.password) { setErr('Bitte alle Felder ausfüllen'); return; }
    if (formData.password.length < 8) { setErr('Passwort muss mindestens 8 Zeichen haben'); return; }
    setErr('');
    onCreate(formData);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 440, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: 20 }}>Neuen User anlegen</h2>
        <form onSubmit={handleSubmit}>
          {err && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-error)', border: '1px solid rgba(239,68,68,.3)', fontSize: 13, color: 'var(--loss)', marginBottom: 14 }}>
              {err}
            </div>
          )}
          {[
            { label: 'Benutzername', key: 'username', type: 'text', placeholder: 'z.B. peter' },
            { label: 'Email', key: 'email', type: 'email', placeholder: 'peter@example.com' },
            { label: 'Passwort', key: 'password', type: 'password', placeholder: 'Mindestens 8 Zeichen' },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key} style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>{label}</label>
              <input type={type} value={formData[key]} onChange={e => setFormData({ ...formData, [key]: e.target.value })} placeholder={placeholder} className="input" style={{ width: '100%' }}/>
            </div>
          ))}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Rolle</label>
            <select value={formData.role} onChange={e => setFormData({ ...formData, role: e.target.value })} className="input" style={{ width: '100%' }}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="skipPwChange"
              checked={formData.skipPasswordChange}
              onChange={e => setFormData({ ...formData, skipPasswordChange: e.target.checked })}
            />
            <label htmlFor="skipPwChange" style={{ fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              Passwortänderung beim ersten Login überspringen
            </label>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Erstellen</button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ─── Change Password Modal ───────────────────────────────────

const ChangePasswordModal = ({ user, onClose, onSave }) => {
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 400, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: 6 }}>Passwort ändern</h2>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 20 }}>Für: <strong>{user.username}</strong></p>
        {pwErr && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-error)', border: '1px solid rgba(239,68,68,.3)', fontSize: 13, color: 'var(--loss)', marginBottom: 14 }}>
            {pwErr}
          </div>
        )}
        <form onSubmit={e => {
          e.preventDefault();
          if (pw.length < 8) { setPwErr('Mindestens 8 Zeichen'); return; }
          setPwErr('');
          onSave(user.id, pw);
        }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Neues Passwort</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Mindestens 8 Zeichen" className="input" style={{ width: '100%' }} autoFocus/>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Ändern</button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  );
};

window.AdminPage = AdminPage;
