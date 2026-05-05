// WaveScout — Einstellungen page mit Broker-Auswahl
const { useState, useEffect } = React;

const Einstellungen = () => {
  const [settings, setSettings] = useState({
    broker: "bybit",
    apiKey: "",
    apiSecret: "",
    testnet: true,
    defaultLeverage: 5,
    maxRiskPercent: 2,
    minConfidenceScore: 65,
    telegramEnabled: true,
    autoTrade: false
  });

  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const API_URL = window.location.hostname.includes('localhost') 
    ? 'http://localhost:8787' 
    : 'https://tradingview-bot.spnn08.workers.dev';

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await fetch(`${API_URL}/settings?user=default`);
      if (response.ok) {
        const data = await response.json();
        setSettings(data);
      }
    } catch (error) {
      console.error('Fehler beim Laden der Einstellungen:', error);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    setSaved(false);
    try {
      const response = await fetch(`${API_URL}/settings?user=default&secret=WaveWatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      if (response.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (error) {
      console.error('Fehler beim Speichern:', error);
      alert('Fehler beim Speichern der Einstellungen');
    }
  };

  const handleChange = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const brokers = [
    { id: 'bybit', name: 'Bybit', logo: '🟡', testnetSupport: true },
    { id: 'binance', name: 'Binance', logo: '🟨', testnetSupport: true },
    { id: 'mexc', name: 'MEXC', logo: '🔵', testnetSupport: false }
  ];

  if (loading) {
    return (
      <div className="app">
        <Sidebar active="einstellungen" />
        <main className="main">
          <div style={{display:'flex', alignItems:'center', justifyContent:'center', height:'100vh'}}>
            <div className="spinner"></div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar active="einstellungen" />
      <main className="main">
        <Topbar
          title="Einstellungen ⚙️"
          subtitle="Broker verbinden, Trading-Parameter anpassen"
        />

        <div className="content page-enter">
          
          {/* Broker Selection */}
          <div className="card">
            <div className="card-head">
              <Icon name="link" className="ico"/>
              <h3>Broker-Verbindung</h3>
              {saved && (
                <div className="actions">
                  <span className="badge badge-win" style={{animation:'fadeIn 0.3s'}}>
                    ✓ Gespeichert
                  </span>
                </div>
              )}
            </div>
            <div className="card-body">
              
              <div className="form-group">
                <label>Broker auswählen</label>
                <div className="broker-grid">
                  {brokers.map(broker => (
                    <div 
                      key={broker.id}
                      className={`broker-card ${settings.broker === broker.id ? 'active' : ''}`}
                      onClick={() => handleChange('broker', broker.id)}
                    >
                      <div className="broker-logo">{broker.logo}</div>
                      <div className="broker-name">{broker.name}</div>
                      {broker.testnetSupport && (
                        <div className="broker-badge">Testnet ✓</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label>API Key</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Dein API Key"
                  value={settings.apiKey}
                  onChange={(e) => handleChange('apiKey', e.target.value)}
                />
                <div className="hint">
                  Erstelle einen API Key in deinem {brokers.find(b => b.id === settings.broker)?.name} Account.
                </div>
              </div>

              <div className="form-group">
                <label>API Secret</label>
                <input
                  type="password"
                  className="input"
                  placeholder="Dein API Secret"
                  value={settings.apiSecret}
                  onChange={(e) => handleChange('apiSecret', e.target.value)}
                />
                <div className="hint">
                  Wird verschlüsselt gespeichert. Niemals mit anderen teilen.
                </div>
              </div>

              {brokers.find(b => b.id === settings.broker)?.testnetSupport && (
                <div className="form-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.testnet}
                      onChange={(e) => handleChange('testnet', e.target.checked)}
                    />
                    <span>Testnet verwenden (empfohlen für Tests)</span>
                  </label>
                  <div className="hint">
                    Mit Testnet kannst du ohne echtes Geld testen. Aktiviere es für die ersten Trades.
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* Trading Parameters */}
          <div className="card">
            <div className="card-head">
              <Icon name="target" className="ico"/>
              <h3>Trading-Parameter</h3>
            </div>
            <div className="card-body">

              <div className="form-group">
                <label>Standard-Hebel (Leverage)</label>
                <input
                  type="number"
                  className="input"
                  min="1"
                  max="125"
                  value={settings.defaultLeverage}
                  onChange={(e) => handleChange('defaultLeverage', parseInt(e.target.value) || 5)}
                />
                <div className="hint">
                  Empfohlen: 5x-10x für Anfänger, max. 20x für Erfahrene.
                </div>
              </div>

              <div className="form-group">
                <label>Max. Risiko pro Trade (%)</label>
                <input
                  type="number"
                  className="input"
                  min="0.5"
                  max="5"
                  step="0.5"
                  value={settings.maxRiskPercent}
                  onChange={(e) => handleChange('maxRiskPercent', parseFloat(e.target.value) || 2)}
                />
                <div className="hint">
                  Empfohlen: 1-2% deines Kapitals pro Trade. Nie mehr als 5%.
                </div>
              </div>

              <div className="form-group">
                <label>Minimum Confidence Score</label>
                <input
                  type="number"
                  className="input"
                  min="50"
                  max="90"
                  value={settings.minConfidenceScore}
                  onChange={(e) => handleChange('minConfidenceScore', parseInt(e.target.value) || 65)}
                />
                <div className="hint">
                  Nur Signale über diesem Score werden ausgeführt. Empfohlen: 65-75.
                </div>
              </div>

            </div>
          </div>

          {/* Notifications & Automation */}
          <div className="card">
            <div className="card-head">
              <Icon name="bell" className="ico"/>
              <h3>Benachrichtigungen & Automatisierung</h3>
            </div>
            <div className="card-body">

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.telegramEnabled}
                    onChange={(e) => handleChange('telegramEnabled', e.target.checked)}
                  />
                  <span>Telegram-Benachrichtigungen aktivieren</span>
                </label>
                <div className="hint">
                  Du erhältst Push-Benachrichtigungen für alle neuen Signale.
                </div>
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.autoTrade}
                    onChange={(e) => handleChange('autoTrade', e.target.checked)}
                  />
                  <span>Auto-Trading aktivieren (gefährlich!)</span>
                </label>
                <div className="hint" style={{color: 'var(--warn)'}}>
                  ⚠️ Trades werden automatisch ohne deine Bestätigung ausgeführt. Nur mit Testnet empfohlen!
                </div>
              </div>

            </div>
          </div>

          {/* Save Button */}
          <div style={{display:'flex', justifyContent:'flex-end', gap:12}}>
            <button className="btn" onClick={() => loadSettings()}>
              <Icon name="refresh" size={14}/>
              Zurücksetzen
            </button>
            <button className="btn btn-primary" onClick={saveSettings}>
              <Icon name="check" size={14}/>
              Einstellungen speichern
            </button>
          </div>

        </div>
      </main>
      <ShortcutsOverlay />
      <HintChip />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<Einstellungen/>);
