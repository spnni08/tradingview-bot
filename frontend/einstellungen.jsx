// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - EINSTELLUNGEN MIT BROKER-AUSWAHL
// Schönes Design mit Broker-Cards und Logos
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// Broker-Datenbank
const BROKERS = [
  {
    id: 'bybit',
    name: 'Bybit',
    logo: '⚡',
    color: '#F7A600',
    features: ['Futures', 'Spot', 'Options'],
    popular: true
  },
  {
    id: 'binance',
    name: 'Binance',
    logo: '🟡',
    color: '#F3BA2F',
    features: ['Futures', 'Spot', 'Margin'],
    popular: true
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    logo: '🔵',
    color: '#0052FF',
    features: ['Spot', 'Advanced'],
    popular: false
  },
  {
    id: 'kraken',
    name: 'Kraken',
    logo: '🟣',
    color: '#5741D9',
    features: ['Futures', 'Spot', 'Staking'],
    popular: true
  },
  {
    id: 'okx',
    name: 'OKX',
    logo: '⚫',
    color: '#000000',
    features: ['Futures', 'Spot', 'Options'],
    popular: false
  },
  {
    id: 'mexc',
    name: 'MEXC',
    logo: '🔷',
    color: '#0066FF',
    features: ['Futures', 'Spot'],
    popular: false
  },
  {
    id: 'bitget',
    name: 'Bitget',
    logo: '🟢',
    color: '#00D897',
    features: ['Futures', 'Spot', 'Copy Trading'],
    popular: false
  },
  {
    id: 'kucoin',
    name: 'KuCoin',
    logo: '🟩',
    color: '#24AE8F',
    features: ['Futures', 'Spot', 'Trading Bot'],
    popular: false
  },
  {
    id: 'huobi',
    name: 'Huobi',
    logo: '🔴',
    color: '#2EAEF7',
    features: ['Futures', 'Spot'],
    popular: false
  },
  {
    id: 'gateio',
    name: 'Gate.io',
    logo: '🌐',
    color: '#17E3A4',
    features: ['Futures', 'Spot', 'Margin'],
    popular: false
  }
];

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
    maxOpenTrades: 3,
    minScore: 65,
    useStopLoss: true,
    useTakeProfit: true,
    trailingStop: false
  });
  const [saved, setSaved] = useState(false);
  const [showBrokerModal, setShowBrokerModal] = useState(false);

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

  const selectedBroker = BROKERS.find(b => b.id === settings.broker) || BROKERS[0];

  return (
    <div className="app">
      <Sidebar active="einstellungen" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="⚙️ Einstellungen"
          subtitle="Trading-Konfiguration & Präferenzen"
        />
        <div className="content page-enter">

          {/* Broker Selection */}
          <div className="card">
            <div className="card-head">
              <Icon name="settings" className="ico"/>
              <h3>Broker Auswahl</h3>
            </div>
            <div className="card-body">
              <div 
                onClick={() => setShowBrokerModal(true)}
                style={{
                  padding: 20,
                  background: 'var(--bg-1)',
                  borderRadius: 12,
                  border: '2px solid var(--border)',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--blue-500)';
                  e.currentTarget.style.background = 'var(--bg-2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.background = 'var(--bg-1)';
                }}
              >
                <div style={{
                  fontSize: 48,
                  lineHeight: 1
                }}>
                  {selectedBroker.logo}
                </div>
                <div style={{flex: 1}}>
                  <div style={{fontSize: 20, fontWeight: 600, marginBottom: 4}}>
                    {selectedBroker.name}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    display: 'flex',
                    gap: 8
                  }}>
                    {selectedBroker.features.map((f, i) => (
                      <span key={i} className="badge badge-tag">{f}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <button className="btn btn-sm">
                    Ändern →
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Broker Modal */}
          {showBrokerModal && (
            <BrokerModal
              brokers={BROKERS}
              selected={settings.broker}
              onSelect={(brokerId) => {
                setSettings({...settings, broker: brokerId});
                setShowBrokerModal(false);
              }}
              onClose={() => setShowBrokerModal(false)}
            />
          )}

          {/* API Configuration */}
          <div className="card">
            <div className="card-head">
              <Icon name="key" className="ico"/>
              <h3>API Konfiguration · {selectedBroker.name}</h3>
            </div>
            <div className="card-body">
              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  API Key
                </label>
                <input
                  type="text"
                  value={settings.apiKey}
                  onChange={(e) => setSettings({...settings, apiKey: e.target.value})}
                  placeholder={`Dein ${selectedBroker.name} API Key`}
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
                  placeholder={`Dein ${selectedBroker.name} API Secret`}
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
                  <span style={{fontSize: 13}}>Testnet verwenden (empfohlen zum Testen)</span>
                </label>
              </div>

              <div style={{
                padding: 12,
                background: 'var(--bg-warning)',
                borderRadius: 8,
                border: '1px solid rgba(255, 193, 7, 0.3)',
                fontSize: 12,
                color: 'var(--text-secondary)'
              }}>
                ⚠️ <strong>Sicherheitshinweis:</strong> API-Keys werden nur lokal im Browser gespeichert. 
                Verwende Keys mit eingeschränkten Rechten (nur Trading, kein Withdrawal).
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
                  Signale mit Score ≥ {settings.minScore} werden automatisch ausgeführt
                </p>
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Risiko pro Trade: {settings.riskPerTrade}%
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="5"
                  step="0.5"
                  value={settings.riskPerTrade}
                  onChange={(e) => setSettings({...settings, riskPerTrade: parseFloat(e.target.value)})}
                  style={{width: '100%', maxWidth: 400}}
                />
                <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4}}>
                  Bei $10,000 Account = ${(10000 * settings.riskPerTrade / 100).toFixed(2)} pro Trade
                </div>
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Minimaler Signal-Score: {settings.minScore}
                </label>
                <input
                  type="range"
                  min="50"
                  max="90"
                  step="5"
                  value={settings.minScore}
                  onChange={(e) => setSettings({...settings, minScore: parseInt(e.target.value)})}
                  style={{width: '100%', maxWidth: 400}}
                />
                <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4}}>
                  Nur Signale ≥ {settings.minScore} werden berücksichtigt
                </div>
              </div>

              <div style={{marginBottom: 20}}>
                <label style={{display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500}}>
                  Max. gleichzeitige Trades: {settings.maxOpenTrades}
                </label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={settings.maxOpenTrades}
                  onChange={(e) => setSettings({...settings, maxOpenTrades: parseInt(e.target.value)})}
                  style={{width: '100%', maxWidth: 400}}
                />
              </div>

              <div style={{marginBottom: 12}}>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.useStopLoss}
                    onChange={(e) => setSettings({...settings, useStopLoss: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Stop-Loss immer setzen</span>
                </label>
              </div>

              <div style={{marginBottom: 12}}>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.useTakeProfit}
                    onChange={(e) => setSettings({...settings, useTakeProfit: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Take-Profit immer setzen</span>
                </label>
              </div>

              <div>
                <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <input
                    type="checkbox"
                    checked={settings.trailingStop}
                    onChange={(e) => setSettings({...settings, trailingStop: e.target.checked})}
                  />
                  <span style={{fontSize: 13}}>Trailing Stop verwenden</span>
                </label>
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
          <div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
            <button className="btn btn-primary" onClick={handleSave}>
              <Icon name="check" size={14}/>
              Einstellungen speichern
            </button>
            {saved && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--win)',
                animation: 'fadeIn 0.3s'
              }}>
                ✓ Erfolgreich gespeichert
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// BROKER MODAL
// ═══════════════════════════════════════════════════════════════

const BrokerModal = ({ brokers, selected, onSelect, onClose }) => {
  const popular = brokers.filter(b => b.popular);
  const others = brokers.filter(b => !b.popular);

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20
      }}
      onClick={onClose}
    >
      <div 
        style={{
          background: 'var(--bg-0)',
          borderRadius: 16,
          maxWidth: 900,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 32
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24}}>
          <h2 style={{fontSize: 24, fontWeight: 600}}>Broker auswählen</h2>
          <button 
            onClick={onClose}
            style={{
              background: 'var(--bg-1)',
              border: 'none',
              width: 32,
              height: 32,
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--text-primary)'
            }}
          >
            ×
          </button>
        </div>

        <div style={{marginBottom: 32}}>
          <h3 style={{fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--text-secondary)'}}>
            BELIEBT
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 12
          }}>
            {popular.map(broker => (
              <BrokerCard
                key={broker.id}
                broker={broker}
                selected={broker.id === selected}
                onSelect={() => onSelect(broker.id)}
              />
            ))}
          </div>
        </div>

        <div>
          <h3 style={{fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--text-secondary)'}}>
            WEITERE BROKER
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 12
          }}>
            {others.map(broker => (
              <BrokerCard
                key={broker.id}
                broker={broker}
                selected={broker.id === selected}
                onSelect={() => onSelect(broker.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const BrokerCard = ({ broker, selected, onSelect }) => {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: 16,
        background: selected ? 'var(--bg-2)' : 'var(--bg-1)',
        border: `2px solid ${selected ? 'var(--blue-500)' : hovered ? 'var(--border-hover)' : 'var(--border)'}`,
        borderRadius: 12,
        cursor: 'pointer',
        transition: 'all 0.2s',
        position: 'relative'
      }}
    >
      {selected && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 20,
          height: 20,
          background: 'var(--blue-500)',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: 12,
          fontWeight: 'bold'
        }}>
          ✓
        </div>
      )}
      
      <div style={{fontSize: 40, marginBottom: 8}}>
        {broker.logo}
      </div>
      <div style={{fontSize: 16, fontWeight: 600, marginBottom: 8}}>
        {broker.name}
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4
      }}>
        {broker.features.map((f, i) => (
          <span 
            key={i}
            style={{
              fontSize: 10,
              padding: '2px 6px',
              background: 'var(--bg-0)',
              borderRadius: 4,
              color: 'var(--text-tertiary)'
            }}
          >
            {f}
          </span>
        ))}
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<EinstellungenPage/>);
