// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - SHARED SHELL: NAVBAR + SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useCallback, useRef, useMemo } = React;
const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ═══════════════════════════════════════════════════════════════
// ICON COMPONENT
// ═══════════════════════════════════════════════════════════════

const Icon = ({ name, size = 16, className = '', style = {} }) => {
  const paths = {
    home:      <><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></>,
    signal:    <path d="M3 12h3l3-8 4 16 3-8h5"/>,
    chart:     <><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/></>,
    journal:   <><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M8 8h8M8 12h6"/></>,
    settings:  <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
    stats:     <><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/></>,
    shield:    <path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z"/>,
    logout:    <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
    bell:      <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
    moon:      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>,
    sun:       <><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></>,
    clock:     <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>,
    target:    <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></>,
    bolt:      <path d="m13 2-9 12h7l-1 8 9-12h-7z"/>,
    book:      <><path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/></>,
    check:     <path d="m5 12 5 5L20 7"/>,
    plus:      <path d="M12 5v14M5 12h14"/>,
    x:         <><path d="M18 6 6 18"/><path d="M6 6l12 12"/></>,
    edit:      <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></>,
    save:      <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>,
    calendar:  <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
    checklist: <><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
    users:     <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    filter:    <><path d="M3 4h18l-7 9v6l-4-2v-4z"/></>,
    refresh:   <><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></>,
    external:  <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></>,
    key:       <><circle cx="8" cy="15" r="4"/><path d="M15 8h.01M11.5 11.5l7-7M16 7l2 2"/></>,
    trash:     <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></>,
    chevron:   <path d="m6 9 6 6 6-6"/>,
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
// NAVBAR
// ═══════════════════════════════════════════════════════════════

const Navbar = ({ page, setPage, user, onLogout }) => {
  const [time, setTime] = useState(new Date());
  const [lightMode, setLightMode] = useState(() => localStorage.getItem('theme') === 'light');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const NAV = [
    { id: 'dashboard',     label: 'Dashboard' },
    { id: 'backtest',      label: 'Backtest' },
    { id: 'journal',       label: 'Journal' },
    { id: 'statistiken',   label: 'Statistiken' },
    { id: 'einstellungen', label: 'Einstellungen' },
  ];
  if (user?.role === 'admin') NAV.push({ id: 'admin', label: 'Admin' });

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', lightMode ? 'light' : 'dark');
    localStorage.setItem('theme', lightMode ? 'light' : 'dark');
  }, [lightMode]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const timeStr = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  return (
    <nav className="navbar">
      {/* Brand */}
      <button className="navbar-brand" onClick={() => setPage('dashboard')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>
        </svg>
        <span className="navbar-brand-name">WAVESCOUT</span>
      </button>

      <div className="navbar-divider"/>

      {/* Nav links */}
      <div className="navbar-nav">
        {NAV.map(n => (
          <button
            key={n.id}
            className={`navbar-link${page === n.id ? ' active' : ''}`}
            onClick={() => setPage(n.id)}
          >
            {n.label}
          </button>
        ))}
        <a
          href="https://waveboard-e54ed.web.app/waveboard/dashboard"
          target="_blank"
          rel="noopener noreferrer"
          className="navbar-link"
        >
          Waveboard
          <Icon name="external" size={11} style={{ marginLeft: 3, opacity: 0.45 }}/>
        </a>
      </div>

      {/* Right section */}
      <div className="navbar-right">
        <div className="status-pill">
          <span className="status-dot status-pulse"/>
          LIVE
        </div>

        <span className="navbar-time">{timeStr}</span>

        <button
          className="icon-btn"
          onClick={() => setLightMode(m => !m)}
          title={lightMode ? 'Dark Mode' : 'Light Mode'}
        >
          <Icon name={lightMode ? 'moon' : 'sun'} size={15}/>
        </button>

        {user && (
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button className="user-btn" onClick={() => setMenuOpen(m => !m)}>
              <span className="user-avatar-sm">{(user.username || 'U').charAt(0).toUpperCase()}</span>
              <span className="user-btn-name">{user.username}</span>
              <Icon name="chevron" size={13} style={{ opacity: 0.4 }}/>
            </button>
            {menuOpen && (
              <div className="user-dropdown">
                <div className="user-dropdown-header">
                  <div className="user-dropdown-name">{user.username}</div>
                  <div className="user-dropdown-role">{user.role === 'admin' ? 'Administrator' : 'Benutzer'}</div>
                </div>
                <button
                  className="user-dropdown-item"
                  onClick={() => { setMenuOpen(false); onLogout(); }}
                >
                  <Icon name="logout" size={14}/>
                  Abmelden
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
};

// ═══════════════════════════════════════════════════════════════
// SHARED STAT CARD
// ═══════════════════════════════════════════════════════════════

const StatCard = ({ label, value, sub, subTone = 'muted', icon }) => (
  <div className="stat" data-tip={sub}>
    <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {icon && <Icon name={icon} size={11}/>}
      {label}
    </div>
    <div className="value">{value}</div>
    {sub && <div className={`sub ${subTone}`}>{sub}</div>}
  </div>
);

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
// COUNT-UP ANIMATION
// ═══════════════════════════════════════════════════════════════

const CountUp = ({ to, prefix = '', suffix = '', duration = 900, decimals = 0, sign = false }) => {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let startTime;
    let rafId;
    const animate = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(to * eased);
      if (progress < 1) rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [to, duration]);

  const formatted = value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return <span>{sign && to > 0 ? '+' : ''}{prefix}{formatted}{suffix}</span>;
};

// ═══════════════════════════════════════════════════════════════
// SHARED HELPER
// ═══════════════════════════════════════════════════════════════

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'gerade eben';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  return `vor ${Math.floor(hours / 24)}d`;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

Object.assign(window, { Icon, Navbar, StatCard, AssetChip, CountUp, getTimeAgo });
