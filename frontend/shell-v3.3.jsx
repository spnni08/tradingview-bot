// WaveScout — shared shell MIT AUTH
const { useState, useEffect, useRef } = React;

// Sidebar mit User Info & Logout
const Sidebar = ({ active, user, onLogout }) => {
  const NAV = [
    { id: 'dashboard', label: 'Home', icon: 'home', file: 'index.html' },
    { id: 'journal', label: 'Journal', icon: 'journal', file: 'journal.html' },
    { id: 'statistiken', label: 'Statistiken', icon: 'stats', file: 'statistiken.html' },
    { id: 'einstellungen', label: 'Einstellungen', icon: 'settings', file: 'einstellungen.html' },
  ];

  // Add Admin menu for admin users
  if (user?.role === 'admin') {
    NAV.push({ id: 'admin', label: 'Admin', icon: 'shield', file: 'admin.html' });
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4">
            <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 2 0"/>
          </svg>
        </div>
        <div>
          <div className="brand-name">WAVESCOUT</div>
          <div className="brand-sub">Trading Intel</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.map(n => (
          <a key={n.id}
             href={n.file}
             className={`nav-item ${active === n.id ? 'active' : ''}`}
             data-tip={`Öffne ${n.label}`}>
            <Icon name={n.icon} className="ico" />
            <span>{n.label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar-bottom">
        {user && (
          <div className="user-card">
            <div className="user-avatar">{user.username.charAt(0)}</div>
            <div className="user-info">
              <div className="user-name">{user.username}</div>
              <div className="user-role">{user.role === 'admin' ? 'Administrator' : 'Benutzer'}</div>
            </div>
            <button className="user-logout" onClick={onLogout} data-tip="Abmelden">
              <Icon name="logout" size={14}/>
            </button>
          </div>
        )}
        <div className="sidebar-foot">WAVESCOUT<br/>© 2026 · v3.3.0</div>
      </div>
    </aside>
  );
};

// Icons - erweitert mit logout & shield
const Icon = ({ name, size = 16, className = '' }) => {
  const paths = {
    home: <><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></>,
    signal: <><path d="M3 12h3l3-8 4 16 3-8h5"/></>,
    chart: <><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/></>,
    journal: <><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M8 8h8M8 12h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
    stats: <><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/></>,
    shield: <><path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z"/></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
    bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
    moon: <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>,
    target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></>,
    chevronDown: <><path d="m6 9 6 6 6-6"/></>,
    chevronRight: <><path d="m9 18 6-6-6-6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    check: <><path d="m5 12 5 5L20 7"/></>,
    x: <><path d="M18 6 6 18M6 6l12 12"/></>,
    bolt: <><path d="m13 2-9 12h7l-1 8 9-12h-7z"/></>,
    book: <><path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/></>,
    filter: <><path d="M3 4h18l-7 9v6l-4-2v-4z"/></>,
    refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  };

  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
};

// Topbar (unchanged)
const Topbar = ({ title, subtitle, kpis }) => {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const fmt = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtD = time.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      <div className="topbar-spacer"></div>

      <div className="status-pill" data-tip="System online">
        <span className="status-dot status-pulse"></span>
        System Aktiv
      </div>

      {kpis && (
        <div className="kpi-strip">
          {kpis.map((k, i) => (
            <div className="kpi" key={i} data-tip={k.tip}>
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-value" style={{color: k.color}}>{k.value}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'var(--font-mono)'}}>
        <Icon name="clock" size={14}/>
        <div style={{display:'flex', flexDirection:'column', lineHeight:1.1}}>
          <span>{fmt}</span>
          <span style={{fontSize:10, color:'var(--text-quaternary)'}}>{fmtD}</span>
        </div>
      </div>

      <button className="icon-btn" data-tip="Dark Mode aktiv">
        <Icon name="moon" size={16}/>
      </button>
    </header>
  );
};

// CountUp (unchanged)
const CountUp = ({ to, prefix = '', suffix = '', duration = 900, decimals = 0, sign = false }) => {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf, start;
    const step = (ts) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(to * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);

  const display = v.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const signStr = sign && to > 0 ? '+' : '';
  return <span>{signStr}{prefix}{display}{suffix}</span>;
};

// AssetChip (unchanged)
const AssetChip = ({ symbol, mono = true }) => {
  const code = symbol.replace('USDT', '').toLowerCase();
  const letter = symbol.slice(0, 2).toUpperCase();
  return (
    <span className="asset-chip">
      <span className={`asset-icon ${code}`}>{letter}</span>
      <span>{symbol}</span>
    </span>
  );
};

// Shortcuts & Hints (unchanged from original)
const ShortcutsOverlay = () => { return null; };
const HintChip = () => { return null; };

// Export
Object.assign(window, {
  Icon, Sidebar, Topbar, ShortcutsOverlay, HintChip, CountUp, AssetChip
});
