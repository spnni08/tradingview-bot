// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - EINSTELLUNGEN
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const EinstellungenPage = () => {
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState({
    broker: 'bybit',
    apiKey: '',
    apiSecret: '',
    testnet: true,
    notifications: true,
    telegramEnabled: true,
    autoTrade: false,
    riskPerTrade: 2,
    maxOpenTrades: 3
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      window.location.href = 'login.html';
      return;
    }

    const parsedUser = JSON.parse(userData);
    setUser(parsedUser);

    if (parsedUser.mustChangePassword) {
      window.location.href = 'change-password.html';
      return;
    }

    loadSettings();
  }, []);

  const loadSettings = () => {
    const savedSettings = localStorage.getItem('wavescout_settings');
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings));
    }
  };

  const handleSave = () => {
    localStorage.setItem('wavescout_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
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

  return (
    <div className="app">
      <Sidebar active="einstellungen" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="⚙️ Einstellungen"
          subtitle="Trading-Konfiguration & Präferenzen"
        />
        <div className="content page-enter">

          {/* Broker Settings */}
          <div className="card">
            <div className="card-head">
              <Icon name="settings" className="ico"/>
              <h3>Broker Konfiguration</h3>
            </div>
            <div className="card-body">
              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Broker
                </label>
                <select
                  value={settings.broker}
                  onChange={(e) => setSettings({...settings, broker: e.target.value})}
                  className="input"
                  style={{width: '100%', maxWidth: 300}}
                >
                  <option value="bybit">Bybit</option>
                  <option value="binance">Binance</option>
                  <option value="mexc">MEXC</option>
                </select>
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  API Key
                </label>
                <input
                  type="text"
                  value={settings.apiKey}
                  onChange={(e) => setSettings({...settings, apiKey: e.target.value})}
                  placeholder="Dein API Key"
                  className="input"
                  style={{width: '100%'}}
                />
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  API Secret
                </label>
                <input
                  type="password"
                  value={settings.apiSecret}
                  onChange={(e) => setSettings({...settings, apiSecret: e.target.value})}
                  placeholder="Dein API Secret"
                  className="input"
                  style={{width: '100%'}}
                />
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.testnet}
                    onChange={(e) => setSettings({...settings, testnet: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Testnet verwenden</span>
                </label>
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
              <div style={{marginBottom: 20}}>
                <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12}}>
                  <input
                    type="checkbox"
                    checked={settings.autoTrade}
                    onChange={(e) => setSettings({...settings, autoTrade: e.target.checked})}
                  />
                  <span style={{fontSize: 13, fontWeight: 500}}>Auto-Trading aktivieren</span>
                </label>
                <p style={{fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 24}}>
                  Signale werden automatisch ausgeführt
                </p>
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Risiko pro Trade: {settings.riskPerTrade}%
                </label>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="0.5"
                  value={settings.riskPerTrade}
                  onChange={(e) => setSettings({...settings, riskPerTrade: parseFloat(e.target.value)})}
                  style={{width: '100%', maxWidth: 300}}
                />
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Max. offene Trades: {settings.maxOpenTrades}
                </label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={settings.maxOpenTrades}
                  onChange={(e) => setSettings({...settings, maxOpenTrades: parseInt(e.target.value)})}
                  style={{width: '100%', maxWidth: 300}}
                />
              </div>
            </div>
          </div>

          {/* Notification Settings */}
          <div className="card">
            <div className="card-head">
              <Icon name="bell" className="ico"/>
              <h3>Benachrichtigungen</h3>
            </div>
            <div className="card-body">
              <div style={{marginBottom: 12}}>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.notifications}
                    onChange={(e) => setSettings({...settings, notifications: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Browser-Benachrichtigungen</span>
                </label>
              </div>

              <div>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.telegramEnabled}
                    onChange={(e) => setSettings({...settings, telegramEnabled: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Telegram-Benachrichtigungen</span>
                </label>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div style={{display: 'flex', gap: 12}}>
            <button className="btn btn-primary" onClick={handleSave}>
              <Icon name="check" size={14}/>
              Einstellungen speichern
            </button>
            {saved && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--win)'
              }}>
                ✓ Gespeichert
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<EinstellungenPage/>);
