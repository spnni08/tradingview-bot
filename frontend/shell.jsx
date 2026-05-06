// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - SHELL MIT USER & LOGOUT
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

// ═══════════════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════════════

const Sidebar = ({ active, user, onLogout }) => {
  const NAV = [
    { id: 'dashboard', label: 'Home', icon: 'home', file: 'index.html' },
    { id: 'journal', label: 'Journal', icon: 'journal', file: 'journal.html' },
    { id: 'backtest', label: 'Backtest', icon: 'chart', file: 'backtest.html' },
    { id: 'statistiken', label: 'Statistiken', icon: 'stats', file: 'statistiken.html' },
    { id: 'einstellungen', label: 'Einstellungen', icon: 'settings', file: 'einstellungen.html' },
  ];

  // Add Admin for admins
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
          <a
            key={n.id}
            href={n.file}
            className={`nav-item ${active === n.id ? 'active' : ''}`}
            data-tip={`Öffne ${n.label}`}
          >
            <Icon name={n.icon} className="ico" />
            <span>{n.label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar-bottom">
        {user && (
          <div className="user-card">
            <div className="user-avatar">
              {user.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="user-info">
              <div className="user-name">{user.username || 'Unbekannt'}</div>
              <div className="user-role">
                {user.role === 'admin' ? 'Administrator' : 'Benutzer'}
              </div>
            </div>
            <button
              className="user-logout"
              onClick={onLogout}
              data-tip="Abmelden"
            >
              <Icon name="logout" size={14}/>
            </button>
          </div>
        )}
        <div className="sidebar-foot">
          WAVESCOUT © 2026 · v3.3.0
        </div>
      </div>
    </aside>
  );
};

// ═══════════════════════════════════════════════════════════════
// TOPBAR
// ═══════════════════════════════════════════════════════════════

const Topbar = ({ title, subtitle, kpis }) => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeStr = time.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  const dateStr = time.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

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
              <span className="kpi-value" style={{color: k.color}}>
                {k.value}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--text-tertiary)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)'
      }}>
        <Icon name="clock" size={14}/>
        <div style={{display: 'flex', flexDirection: 'column', lineHeight: 1.2}}>
          <span style={{fontWeight: 600}}>{timeStr}</span>
          <span style={{fontSize: 10, opacity: 0.6}}>{dateStr}</span>
        </div>
      </div>

      <button className="icon-btn" data-tip="Dark Mode aktiv">
        <Icon name="moon" size={16}/>
      </button>
    </header>
  );
};

// ═══════════════════════════════════════════════════════════════
// ICON COMPONENT
// ═══════════════════════════════════════════════════════════════

const Icon = ({ name, size = 16, className = '', style = {} }) => {
  const paths = {
    home: <><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></>,
    signal: <path d="M3 12h3l3-8 4 16 3-8h5"/>,
    chart: <><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/></>,
    journal: <><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M8 8h8M8 12h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
    stats: <><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/></>,
    shield: <path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z"/>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
    bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>,
    clock: <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>,
    target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></>,
    bolt: <path d="m13 2-9 12h7l-1 8 9-12h-7z"/>,
    book: <><path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/></>,
  };

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {paths[name] || <circle cx="12" cy="12" r="10"/>}
    </svg>
  );
};

// ═══════════════════════════════════════════════════════════════
// ASSET CHIP
// ═══════════════════════════════════════════════════════════════

const AssetChip = ({ symbol }) => {
  const code = (symbol || '').replace('USDT', '').toLowerCase();
  const letter = (symbol || 'XX').slice(0, 2).toUpperCase();
  
  return (
    <span className="asset-chip">
      <span className={`asset-icon ${code}`}>{letter}</span>
      <span>{symbol}</span>
    </span>
  );
};

// ═══════════════════════════════════════════════════════════════
// COUNTER-UP ANIMATION
// ═══════════════════════════════════════════════════════════════

const CountUp = ({ to, prefix = '', suffix = '', duration = 900, decimals = 0, sign = false }) => {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let startTime;
    let rafId;

    const animate = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      
      setValue(to * eased);

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [to, duration]);

  const formatted = value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });

  const signStr = sign && to > 0 ? '+' : '';

  return <span>{signStr}{prefix}{formatted}{suffix}</span>;
};

// ═══════════════════════════════════════════════════════════════
// EXPORT TO WINDOW
// ═══════════════════════════════════════════════════════════════

Object.assign(window, {
  Icon,
  Sidebar,
  Topbar,
  AssetChip,
  CountUp
});
