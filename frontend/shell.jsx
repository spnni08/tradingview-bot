// WaveScout — shared shell (Sidebar, Topbar, helpers)
const { useState, useEffect, useRef } = React;

// ───── Icons (inline SVG, lucide-style strokes) ─────
const Icon = ({ name, size = 16, className = '' }) => {
  const paths = {
    home: <><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></>,
    signal: <><path d="M3 12h3l3-8 4 16 3-8h5"/></>,
    chart: <><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/></>,
    backtest: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 4v16"/></>,
    strategy: <><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></>,
    journal: <><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M8 8h8M8 12h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
    stats: <><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/></>,
    trades: <><path d="M3 7h13l-3-3M21 17H8l3 3"/></>,
    bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></>,
    moon: <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>,
    flame: <><path d="M12 2s4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 1-3s-3 2-3 6a6 6 0 0 0 12 0c0-5-6-12-6-12z"/></>,
    target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></>,
    info: <><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></>,
    chevronDown: <><path d="m6 9 6 6 6-6"/></>,
    chevronLeft: <><path d="m15 18-6-6 6-6"/></>,
    chevronRight: <><path d="m9 18 6-6-6-6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    star: <><path d="m12 2 3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></>,
    starFilled: <><path d="m12 2 3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" fill="currentColor"/></>,
    check: <><path d="m5 12 5 5L20 7"/></>,
    x: <><path d="M18 6 6 18M6 6l18 18"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
    more: <><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></>,
    refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
    filter: <><path d="M3 4h18l-7 9v6l-4-2v-4z"/></>,
    note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></>,
    ring: <><circle cx="12" cy="12" r="9"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></>,
    money: <><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
    globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></>,
    shield: <><path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z"/></>,
    receipt: <><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
    bolt: <><path d="m13 2-9 12h7l-1 8 9-12h-7z"/></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></>,
    db: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/></>,
    book: <><path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/></>,
  };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
};

// ───── Sidebar ─────
const NAV = [
  { id: 'dashboard', label: 'Home', icon: 'home', file: 'index.html' },
  { id: 'signale', label: 'Signale', icon: 'signal', file: 'index.html' },
  { id: 'analyse', label: 'Analyse', icon: 'chart', file: 'index.html' },
  { id: 'backtest', label: 'Backtest', icon: 'backtest', file: 'index.html' },
  { id: 'strategie', label: 'Strategie', icon: 'strategy', file: 'index.html' },
  { id: 'journal', label: 'Journal', icon: 'journal', file: 'journal.html' },
  { id: 'statistiken', label: 'Statistiken', icon: 'stats', file: 'statistiken.html' },
  { id: 'einstellungen', label: 'Einstellungen', icon: 'settings', file: 'einstellungen.html' },
];

const Sidebar = ({ active }) => (
  <aside className="sidebar">
    <div className="brand">
      <div className="brand-mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
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
      <div className="morning-brief-card">
        <h4>☀ Morning Brief</h4>
        <p>Tägliche Marktanalyse, jeden Tag um 08:00.</p>
        <button className="btn btn-sm btn-primary" data-tip="Brief jetzt öffnen">Brief öffnen</button>
      </div>
      <div className="sidebar-foot">WAVESCOUT<br/>© 2026 · v1.2.0</div>
    </div>
  </aside>
);

// ───── Topbar ─────
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

      <div className="status-pill" data-tip="Alle Systeme online">
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

      <button className="icon-btn" data-tip="Light / Dark Mode">
        <Icon name="moon" size={16}/>
      </button>

      <button className="icon-btn" data-tip="3 neue Benachrichtigungen">
        <Icon name="bell" size={16}/>
        <span className="badge">3</span>
      </button>

      <div className="avatar" data-tip="Markus · markus@trader.de">
        <div className="avatar-img">M</div>
        <Icon name="chevronDown" size={14}/>
      </div>
    </header>
  );
};

// ───── Shortcuts Overlay (toggle with `?`) ─────
const ShortcutsOverlay = () => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      // ignore if typing in input
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (['input','textarea','select'].includes(tag)) return;
      if (e.key === '?') { e.preventDefault(); setOpen(o => !o); }
      if (e.key === 'Escape') setOpen(false);
      if (!open) {
        if (e.key === 'g') {
          // poor-man's "go to" — listen for next key
          const next = (e2) => {
            if (e2.key === 'd') location.href = 'index.html';
            if (e2.key === 'j') location.href = 'journal.html';
            if (e2.key === 's') location.href = 'statistiken.html';
            if (e2.key === ',') location.href = 'einstellungen.html';
            window.removeEventListener('keydown', next);
          };
          window.addEventListener('keydown', next, { once: true });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const rows = [
    { d: 'Dashboard', k: ['G', 'D'] },
    { d: 'Journal', k: ['G', 'J'] },
    { d: 'Statistiken', k: ['G', 'S'] },
    { d: 'Einstellungen', k: ['G', ','] },
    { d: 'Suche öffnen', k: ['⌘', 'K'] },
    { d: 'Neuer Journal-Eintrag', k: ['N'] },
    { d: 'Bestes Signal traden', k: ['T'] },
    { d: 'Diese Übersicht', k: ['?'] },
    { d: 'Schließen', k: ['Esc'] },
  ];
  return (
    <div className="shortcuts-overlay" onClick={() => setOpen(false)}>
      <div className="shortcuts-panel" onClick={e => e.stopPropagation()}>
        <h2>Tastenkürzel</h2>
        <p>Drücke <span className="kbd">?</span> jederzeit, um diese Übersicht zu öffnen.</p>
        {rows.map((r, i) => (
          <div className="shortcut-row" key={i}>
            <span className="desc">{r.d}</span>
            <span className="kbd-group">{r.k.map((k, j) => <span className="kbd" key={j}>{k}</span>)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const HintChip = () => (
  <button className="hint-chip" onClick={() => {
    const e = new KeyboardEvent('keydown', { key: '?' });
    window.dispatchEvent(e);
  }} data-tip="Tastenkürzel">
    <span className="kbd">?</span>
    <span>Tastenkürzel</span>
  </button>
);

// ───── CountUp ─────
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

// ───── Sparklines (subtle) ─────
const Spark = ({ points, color = 'var(--blue-400)', w = 100, h = 28 }) => {
  const max = Math.max(...points), min = Math.min(...points);
  const range = max - min || 1;
  const path = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="spark-line" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={path} stroke={color} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};

// ───── Chart Placeholder ─────
const ChartPlaceholder = ({ title = 'Live-Chart in Vorbereitung', sub = 'Bald verfügbar', height = 200 }) => (
  <div className="chart-placeholder" style={{height}}>
    <div className="label">
      <Icon name="chart" size={20} />
      <div>{title}</div>
      <div className="sub">{sub}</div>
    </div>
  </div>
);

// ───── Asset Icon (text fallback) ─────
const AssetChip = ({ symbol, mono = true }) => {
  const code = symbol.replace('USDT', '').toLowerCase();
  const letter = symbol.slice(0, 2).toUpperCase();
  return (
    <span className="asset-chip">
      <span className={`asset-icon ${code}`}>{letter}</span>
      <span className={mono ? '' : ''}>{symbol}</span>
    </span>
  );
};

// ───── Export to window (Babel scripts don't share scope) ─────
Object.assign(window, {
  Icon, Sidebar, Topbar, ShortcutsOverlay, HintChip, CountUp, Spark, ChartPlaceholder, AssetChip
});
