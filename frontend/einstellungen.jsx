// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - EINSTELLUNGEN
// ═══════════════════════════════════════════════════════════════

const BROKERS = [
  { id: 'bybit',    name: 'Bybit',    logo: '⚡', features: ['Futures','Spot','Options'], popular: true },
  { id: 'binance',  name: 'Binance',  logo: '🟡', features: ['Futures','Spot','Margin'],  popular: true },
  { id: 'kraken',   name: 'Kraken',   logo: '🟣', features: ['Futures','Spot','Staking'], popular: true },
  { id: 'coinbase', name: 'Coinbase', logo: '🔵', features: ['Spot','Advanced'],           popular: false },
  { id: 'okx',      name: 'OKX',      logo: '⚫', features: ['Futures','Spot','Options'],  popular: false },
  { id: 'mexc',     name: 'MEXC',     logo: '🔷', features: ['Futures','Spot'],            popular: false },
  { id: 'bitget',   name: 'Bitget',   logo: '🟢', features: ['Futures','Spot','Copy'],     popular: false },
  { id: 'kucoin',   name: 'KuCoin',   logo: '🟩', features: ['Futures','Spot','Bot'],      popular: false },
];

const WEBHOOK_URL = 'https://tradingview-bot.spnn08.workers.dev/webhook';

// ─── Admin: Trade Check Panel ────────────────────────────────

function AdminTradeCheckPanel() {
  const [result,   setResult]  = useState(null);
  const [loading,  setLoading] = useState(false);
  const [eodRes,   setEodRes]  = useState(null);
  const [eodLoad,  setEodLoad] = useState(false);
  const sid = () => localStorage.getItem('wavescout_session');

  const runBulkCheck = async () => {
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/check-open-trades`, { method: 'POST', headers: { 'X-Session-ID': sid() } });
      const data = await res.json();
      setResult(data);
    } catch (e) { setResult({ success: false, error: e.message }); }
    setLoading(false);
  };

  const runEodCheck = async () => {
    setEodLoad(true); setEodRes(null);
    try {
      const res = await fetch(`${API_URL}/admin/eod-check`, { method: 'POST', headers: { 'X-Session-ID': sid() } });
      const data = await res.json();
      setEodRes(data);
    } catch (e) { setEodRes({ success: false, error: e.message }); }
    setEodLoad(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Bulk check */}
      <div className="card">
        <div className="card-head"><Icon name="target" className="ico"/><h3>Offene Trades prüfen</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
            Prüft alle offenen Signale gegen den letzten bekannten Preis aus der Snapshots-Tabelle.
            Wenn TP oder SL erreicht wurde, wird das Outcome gesetzt. Kein Preis = wird übersprungen.
          </p>
          <button className="btn btn-primary" onClick={runBulkCheck} disabled={loading}>
            {loading ? <div className="spinner-sm"/> : <Icon name="refresh" size={14}/>}
            {loading ? 'Prüfe…' : 'Jetzt alle offenen Trades prüfen'}
          </button>
          {result && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                {[
                  { label: 'Geprüft', val: result.checked, color: 'var(--text-primary)' },
                  { label: 'Geschlossen', val: result.closed, color: result.closed > 0 ? 'var(--win)' : 'var(--text-tertiary)' },
                  { label: 'Noch offen', val: result.open, color: 'var(--text-secondary)' },
                  { label: 'Kein Preis', val: result.no_price, color: 'var(--wait)' },
                  { label: 'Übersprungen', val: result.skipped, color: 'var(--text-tertiary)' },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ padding: '8px 14px', background: 'var(--bg-0)', borderRadius: 8, border: '1px solid var(--border)', textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color }}>{val ?? 0}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</div>
                  </div>
                ))}
              </div>
              {result.results && result.results.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl" style={{ fontSize: 12 }}>
                    <thead><tr><th>ID</th><th>Symbol</th><th>Status</th><th>Outcome</th><th>Preis</th><th>Meldung</th></tr></thead>
                    <tbody>
                      {result.results.map((r, i) => (
                        <tr key={i}>
                          <td className="mono" style={{ fontSize: 10 }}>{String(r.id || '').slice(0, 12)}</td>
                          <td><span className="badge badge-tag">{r.symbol}</span></td>
                          <td><span className={`badge ${r.status === 'closed' ? 'badge-win' : r.status === 'no_price' ? 'badge-wait' : ''}`}>{r.status}</span></td>
                          <td className="mono">{r.outcome || '–'}</td>
                          <td className="mono">{r.price ? `$${Number(r.price).toFixed(2)}` : '–'}</td>
                          <td style={{ color: 'var(--text-tertiary)' }}>{r.message}</td>
                        </tr>
                      ))}
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
            Wie der Bulk-Check, aber Signale jünger als 30 Minuten werden übersprungen.
            Ideal als manueller 23:59-Check.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
            Für automatischen Cron-Betrieb: Cloudflare Workers Cron Trigger für <code>23:59 Europe/Berlin</code> einrichten und Route <code>POST /admin/eod-check</code> aufrufen.
          </p>
          <button className="btn btn-ghost" onClick={runEodCheck} disabled={eodLoad}>
            {eodLoad ? <div className="spinner-sm"/> : <Icon name="clock" size={14}/>}
            {eodLoad ? 'Prüfe…' : 'EOD-Check jetzt ausführen'}
          </button>
          {eodRes && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: eodRes.success ? 'var(--bg-success)' : 'var(--bg-error)', borderRadius: 8, border: `1px solid ${eodRes.success ? 'rgba(16,185,129,.3)' : 'rgba(240,68,68,.3)'}`, fontSize: 13 }}>
              {eodRes.success
                ? `✅ EOD-Check abgeschlossen — ${eodRes.checked} geprüft, ${eodRes.closed} geschlossen`
                : `❌ Fehler: ${eodRes.error}`}
            </div>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="card">
        <div className="card-head"><Icon name="signal" className="ico"/><h3>Preis-Quelle</h3></div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            Genutzte Preisquelle: <strong>snapshots</strong>-Tabelle (letzter bekannter Preis pro Symbol aus PRICE_UPDATE-Webhooks).
            Kein externer API-Aufruf. Wenn kein Snapshot vorhanden ist, wird der Trade übersprungen und bleibt offen.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Admin: Users Panel ──────────────────────────────────────

function AdminUsersPanel() {
  const sid = () => localStorage.getItem('wavescout_session');
  return (
    <div className="card">
      <div className="card-head"><Icon name="users" className="ico"/><h3>Nutzer &amp; Rollen</h3></div>
      <div className="card-body">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Für die vollständige Nutzerverwaltung und Rollenzuweisung bitte den Admin-Bereich nutzen.
        </p>
        <a href="#" onClick={e => { e.preventDefault(); window.dispatchEvent(new CustomEvent('wavescout-navigate', { detail: 'admin' })); }} className="btn btn-ghost btn-sm">
          <Icon name="shield" size={13}/> Zum Admin-Panel
        </a>
      </div>
    </div>
  );
}

// ─── Main Settings Page ──────────────────────────────────────

const EinstellungenPage = ({ user }) => {
  const [settings, setSettings] = useState({
    broker: 'bybit', apiKey: '', apiSecret: '', testnet: true,
    notifications: true, telegramEnabled: true, autoTrade: false,
    riskPerTrade: 2, maxOpenTrades: 3, minScore: 65,
    useStopLoss: true, useTakeProfit: true, trailingStop: false
  });
  const [saved, setSaved] = useState(false);
  const [showBrokerModal, setShowBrokerModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [adminSection, setAdminSection] = useState('tradecheck');
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    const s = localStorage.getItem('wavescout_settings');
    if (s) { try { setSettings(JSON.parse(s)); } catch (_) {} }
  }, []);

  const handleSave = () => {
    localStorage.setItem('wavescout_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(WEBHOOK_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const selectedBroker = BROKERS.find(b => b.id === settings.broker) || BROKERS[0];

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Einstellungen</h2>
        <p className="subtitle">Trading-Konfiguration &amp; Präferenzen</p>
      </div>

      {/* Webhook Info */}
      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>TradingView Webhook</h3>
          <div className="actions"><span className="badge badge-win">LIVE</span></div>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
            Diese URL in TradingView unter <strong>Alerts → Webhook URL</strong> eintragen.
            Für SIGNAL-Alerts und SNAPSHOT-Alerts die gleiche URL verwenden.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{
              flex: 1, padding: '10px 14px', background: 'var(--bg-0)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 13,
              color: 'var(--text-secondary)', wordBreak: 'break-all'
            }}>
              {WEBHOOK_URL}
            </div>
            <button className="btn btn-sm" onClick={handleCopyWebhook} style={{ flexShrink: 0 }}>
              {copied ? <><Icon name="check" size={13}/> Kopiert</> : <><Icon name="save" size={13}/> Kopieren</>}
            </button>
          </div>
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)', fontSize: 12, color: 'var(--text-secondary)' }}>
            <strong>Beispiel-Payload (SIGNAL):</strong>
            <pre style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-tertiary)' }}>
{`{"symbol": "BTCUSDT", "event_type": "SIGNAL", "timeframe": "5", "price": {{close}}, "direction": "LONG", "trigger": "EMA_CROSS", "action": "BUY"}`}
            </pre>
          </div>
        </div>
      </div>

      {/* Broker */}
      <div className="card">
        <div className="card-head">
          <Icon name="settings" className="ico"/>
          <h3>Broker</h3>
        </div>
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

      {showBrokerModal && (
        <BrokerModal
          brokers={BROKERS}
          selected={settings.broker}
          onSelect={id => { setSettings({ ...settings, broker: id }); setShowBrokerModal(false); }}
          onClose={() => setShowBrokerModal(false)}
        />
      )}

      {/* API Config */}
      <div className="card">
        <div className="card-head">
          <Icon name="key" className="ico"/>
          <h3>API Konfiguration · {selectedBroker.name}</h3>
        </div>
        <div className="card-body">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>API Key</label>
            <input type="text" value={settings.apiKey} onChange={e => setSettings({ ...settings, apiKey: e.target.value })} placeholder={`${selectedBroker.name} API Key`} className="input" style={{ width: '100%' }}/>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>API Secret</label>
            <input type="password" value={settings.apiSecret} onChange={e => setSettings({ ...settings, apiSecret: e.target.value })} placeholder={`${selectedBroker.name} API Secret`} className="input" style={{ width: '100%' }}/>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
            <input type="checkbox" checked={settings.testnet} onChange={e => setSettings({ ...settings, testnet: e.target.checked })}/>
            Testnet verwenden
          </label>
          <div style={{ padding: '10px 14px', background: 'var(--bg-warning)', borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)', fontSize: 12, color: 'var(--text-secondary)' }}>
            API-Keys werden nur lokal im Browser gespeichert. Nur Trading-Rechte vergeben, kein Withdrawal.
          </div>
        </div>
      </div>

      {/* Trading Settings */}
      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/>
          <h3>Trading Einstellungen</h3>
        </div>
        <div className="card-body">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>
            <input type="checkbox" checked={settings.autoTrade} onChange={e => setSettings({ ...settings, autoTrade: e.target.checked })}/>
            Auto-Trading aktivieren (Score ≥ {settings.minScore})
          </label>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
              Risiko pro Trade: <span style={{ color: 'var(--blue-500)' }}>{settings.riskPerTrade}%</span>
            </label>
            <input type="range" min="0.5" max="5" step="0.5" value={settings.riskPerTrade} onChange={e => setSettings({ ...settings, riskPerTrade: parseFloat(e.target.value) })} style={{ width: '100%', maxWidth: 360 }}/>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
              Minimaler Score: <span style={{ color: 'var(--blue-500)' }}>{settings.minScore}</span>
            </label>
            <input type="range" min="50" max="90" step="5" value={settings.minScore} onChange={e => setSettings({ ...settings, minScore: parseInt(e.target.value) })} style={{ width: '100%', maxWidth: 360 }}/>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
              Max. gleichzeitige Trades: <span style={{ color: 'var(--blue-500)' }}>{settings.maxOpenTrades}</span>
            </label>
            <input type="range" min="1" max="10" step="1" value={settings.maxOpenTrades} onChange={e => setSettings({ ...settings, maxOpenTrades: parseInt(e.target.value) })} style={{ width: '100%', maxWidth: 360 }}/>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              ['useStopLoss', 'Stop-Loss immer setzen'],
              ['useTakeProfit', 'Take-Profit immer setzen'],
              ['trailingStop', 'Trailing Stop verwenden'],
            ].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })}/>
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className="card">
        <div className="card-head">
          <Icon name="bell" className="ico"/>
          <h3>Benachrichtigungen</h3>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              ['notifications', 'Browser-Benachrichtigungen'],
              ['telegramEnabled', 'Telegram-Benachrichtigungen'],
            ].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })}/>
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={handleSave}>
          <Icon name="check" size={14}/> Speichern
        </button>
        {saved && (
          <span style={{ color: 'var(--win)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14}/> Gespeichert
          </span>
        )}
      </div>

      {/* Admin Section */}
      {isAdmin && (
        <>
          <div style={{ marginTop: 32, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="shield" size={16} style={{ color: 'var(--blue-400)' }}/>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Admin-Bereich</h3>
            <span className="badge badge-tag" style={{ fontSize: 10 }}>NUR ADMIN</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16, alignItems: 'start' }}>
            {/* Admin sub-nav */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                { id: 'tradecheck', label: 'Trade Check',   icon: 'target'  },
                { id: 'users',      label: 'User / Rollen', icon: 'users'   },
              ].map(item => (
                <button key={item.id} onClick={() => setAdminSection(item.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                  borderRadius: 10, border: `1px solid ${adminSection === item.id ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
                  background: adminSection === item.id ? 'rgba(59,130,246,.08)' : 'var(--bg-2)',
                  color: adminSection === item.id ? 'var(--blue-400)' : 'var(--text-secondary)',
                  fontSize: 13, fontWeight: adminSection === item.id ? 600 : 400,
                  cursor: 'pointer', fontFamily: 'var(--font-main)', transition: 'all .15s', textAlign: 'left'
                }}>
                  <Icon name={item.icon} size={14}/> {item.label}
                </button>
              ))}
            </div>

            {/* Admin section content */}
            <div>
              {adminSection === 'tradecheck' && <AdminTradeCheckPanel/>}
              {adminSection === 'users'      && <AdminUsersPanel/>}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ─── Broker Modal ────────────────────────────────────────────

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
