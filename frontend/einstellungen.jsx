// WaveScout — Einstellungen
const { useState } = React;

const SECTIONS = [
  { id: 'profile', label: 'Profil', icon: 'home' },
  { id: 'risk', label: 'Risiko', icon: 'shield' },
  { id: 'signals', label: 'Signale', icon: 'signal' },
  { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell' },
  { id: 'appearance', label: 'Darstellung', icon: 'moon' },
  { id: 'integrations', label: 'Integrationen', icon: 'globe' },
  { id: 'data', label: 'Daten & Privatsphäre', icon: 'db' },
];

const Toggle = ({ on, onChange }) => (
  <label className="switch">
    <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)}/>
    <span className="slider"></span>
  </label>
);

const Einstellungen = () => {
  const [active, setActive] = useState('profile');
  const [t, setT] = useState({
    autoExec: false, riskAlerts: true, dailyBrief: true, push: true,
    sound: false, telegram: true, dark: true, tooltips: true,
  });
  const set = (k, v) => setT(s => ({...s, [k]: v}));

  const kpis = [
    { label: 'Plan', value: 'Pro', color: 'var(--blue-300)', tip: 'Pro · monatlich' },
    { label: 'Geräte', value: <CountUp to={2}/>, color: 'var(--text-primary)' },
    { label: 'API-Keys', value: <CountUp to={1}/>, color: 'var(--text-primary)' },
  ];

  return (
    <div className="app">
      <Sidebar active="einstellungen"/>
      <main className="main">
        <Topbar title="Einstellungen" subtitle="Konfiguriere WaveScout nach deinen Bedürfnissen" kpis={kpis}/>
        <div className="content page-enter">
          <div className="settings-grid">
            <nav className="card settings-nav" style={{padding: 8}}>
              {SECTIONS.map(s => (
                <button
                  key={s.id}
                  className={`settings-nav-item ${active === s.id ? 'active' : ''}`}
                  onClick={() => setActive(s.id)}
                  data-tip={`Zu ${s.label}`}>
                  <Icon name={s.icon} size={14}/>
                  <span>{s.label}</span>
                </button>
              ))}
            </nav>

            <div className="settings-section">

              {/* Profile */}
              <div className="card">
                <div className="card-head">
                  <Icon name="home" className="ico"/>
                  <h3>Profil</h3>
                </div>
                <div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Name</div>
                      <div className="desc">Dein Anzeigename in der App</div>
                    </div>
                    <div className="control">
                      <input className="num-input" style={{width: 180, fontFamily: 'var(--font-sans)'}} defaultValue="Markus Weber"/>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">E-Mail</div>
                      <div className="desc">Für Benachrichtigungen und Login</div>
                    </div>
                    <div className="control">
                      <input className="num-input" style={{width: 220, fontFamily: 'var(--font-sans)'}} defaultValue="markus@trader.de"/>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Sprache</div>
                      <div className="desc">Anzeigesprache der Oberfläche</div>
                    </div>
                    <div className="control">
                      <select className="select" defaultValue="de">
                        <option value="de">Deutsch</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Zeitzone</div>
                      <div className="desc">Für Zeitstempel und Brief-Versand</div>
                    </div>
                    <div className="control">
                      <select className="select" defaultValue="cet">
                        <option value="cet">Europa/Berlin (CET)</option>
                        <option value="utc">UTC</option>
                        <option value="est">America/New_York</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Risk */}
              <div className="card">
                <div className="card-head">
                  <Icon name="shield" className="ico" style={{color: 'var(--blue-300)'}}/>
                  <h3>Risiko-Limits</h3>
                  <div className="actions"><span className="badge badge-tag">Wichtig</span></div>
                </div>
                <div>
                  <div className="setting-row risk">
                    <div>
                      <div className="label">Max. Risiko pro Trade</div>
                      <div className="desc">Maximaler Verlust pro einzelnem Trade in % des Kapitals</div>
                    </div>
                    <div className="control">
                      <input className="num-input" type="number" defaultValue="2"/>
                      <span className="suffix">%</span>
                    </div>
                  </div>
                  <div className="setting-row risk">
                    <div>
                      <div className="label">Max. Tages-Verlust</div>
                      <div className="desc">Bei Erreichen werden neue Trades blockiert</div>
                    </div>
                    <div className="control">
                      <input className="num-input" type="number" defaultValue="5"/>
                      <span className="suffix">%</span>
                    </div>
                  </div>
                  <div className="setting-row risk">
                    <div>
                      <div className="label">Max. parallele Trades</div>
                      <div className="desc">Anzahl gleichzeitiger offener Positionen</div>
                    </div>
                    <div className="control">
                      <input className="num-input" type="number" defaultValue="3"/>
                    </div>
                  </div>
                  <div className="setting-row risk">
                    <div>
                      <div className="label">Risiko-Alerts</div>
                      <div className="desc">Warnung bei Annäherung an Limits</div>
                    </div>
                    <div className="control">
                      <Toggle on={t.riskAlerts} onChange={v => set('riskAlerts', v)}/>
                    </div>
                  </div>
                </div>
              </div>

              {/* Signals */}
              <div className="card">
                <div className="card-head">
                  <Icon name="signal" className="ico"/>
                  <h3>Signal-Einstellungen</h3>
                </div>
                <div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Mindest-Confidence</div>
                      <div className="desc">Signale unter diesem Score werden ausgeblendet</div>
                    </div>
                    <div className="control">
                      <input className="num-input" type="number" defaultValue="65"/>
                      <span className="suffix">/ 100</span>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Beobachtete Assets</div>
                      <div className="desc">Welche Coins WaveScout analysiert</div>
                    </div>
                    <div className="control">
                      <span className="badge badge-tag">5 ausgewählt</span>
                      <button className="btn btn-sm btn-ghost">Bearbeiten</button>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Auto-Ausführung</div>
                      <div className="desc">Trades automatisch ausführen wenn Confidence ≥ 90</div>
                    </div>
                    <div className="control">
                      <Toggle on={t.autoExec} onChange={v => set('autoExec', v)}/>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="label">Morning Brief</div>
                      <div className="desc">Tägliche Zusammenfassung um 08:00</div>
                    </div>
                    <div className="control">
                      <Toggle on={t.dailyBrief} onChange={v => set('dailyBrief', v)}/>
                    </div>
                  </div>
                </div>
              </div>

              {/* Notifications */}
              <div className="card">
                <div className="card-head">
                  <Icon name="bell" className="ico"/>
                  <h3>Benachrichtigungen</h3>
                </div>
                <div>
                  <div className="setting-row">
                    <div><div className="label">Push (Browser)</div><div className="desc">Web-Push für neue Signale</div></div>
                    <div className="control"><Toggle on={t.push} onChange={v => set('push', v)}/></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">Sound</div><div className="desc">Akustischer Hinweis bei A-Setups</div></div>
                    <div className="control"><Toggle on={t.sound} onChange={v => set('sound', v)}/></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">Telegram</div><div className="desc">@WaveScoutBot · verbunden</div></div>
                    <div className="control"><Toggle on={t.telegram} onChange={v => set('telegram', v)}/></div>
                  </div>
                </div>
              </div>

              {/* Appearance */}
              <div className="card">
                <div className="card-head">
                  <Icon name="moon" className="ico"/>
                  <h3>Darstellung</h3>
                </div>
                <div>
                  <div className="setting-row">
                    <div><div className="label">Dark Mode</div><div className="desc">Light Mode bald verfügbar</div></div>
                    <div className="control"><Toggle on={t.dark} onChange={v => set('dark', v)}/></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">Tooltips anzeigen</div><div className="desc">Hover-Hinweise auf interaktiven Elementen</div></div>
                    <div className="control"><Toggle on={t.tooltips} onChange={v => set('tooltips', v)}/></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">Datumsformat</div><div className="desc">Beispiel: 04.05.2026</div></div>
                    <div className="control">
                      <select className="select" defaultValue="dmy">
                        <option value="dmy">DD.MM.YYYY</option>
                        <option value="mdy">MM/DD/YYYY</option>
                        <option value="iso">YYYY-MM-DD</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Integrations */}
              <div className="card">
                <div className="card-head">
                  <Icon name="globe" className="ico"/>
                  <h3>Integrationen</h3>
                </div>
                <div>
                  <div className="setting-row">
                    <div><div className="label">Bybit</div><div className="desc">API-Verbindung · zuletzt sync 2 min</div></div>
                    <div className="control"><span className="badge badge-tag" style={{color: 'var(--win)'}}>Verbunden</span><button className="btn btn-sm btn-ghost">Trennen</button></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">Binance</div><div className="desc">Nicht verbunden</div></div>
                    <div className="control"><button className="btn btn-sm">Verbinden</button></div>
                  </div>
                  <div className="setting-row">
                    <div><div className="label">TradingView</div><div className="desc">Charts & Webhooks</div></div>
                    <div className="control"><button className="btn btn-sm">Verbinden</button></div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </main>
      <ShortcutsOverlay/>
      <HintChip/>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Einstellungen/>);
