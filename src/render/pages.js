// src/render/pages.js
//
// HTMX-MPA HTML-Shell + Seiten-/Sektions-Renderer (Dashboard, Journal, News,
// Backtesting, Statistiken, Einstellungen/Admin). Reine String-Builder ohne
// env/DB-Zugriff: sie bekommen bereits aufbereitete Daten übergeben und geben
// HTML zurück. Aus worker.js ausgelagert (Schritt 3 Modularisierung), ohne
// Verhaltensänderung. Einzige externe Abhängigkeit: computeWinRate (src/stats.js).
//
// Hinweis: Viele `function ...` weiter unten stehen INNERHALB von Template-
// Literalen — das ist Client-seitiges JS, das an den Browser ausgeliefert wird,
// kein Modul-Scope.

import { computeWinRate } from '../stats.js';
const CSS_STYLES = `/* ═══════════════════════════════════════════════════════════════
   WAVESCOUT v3.5 — DESIGN SYSTEM
   ═══════════════════════════════════════════════════════════ */
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg-0:#0A0E1A;--bg-1:#111827;--bg-2:#151B2B;--bg-3:#1E2840;--bg-4:#2A3450;
  --gradient-body:linear-gradient(160deg,#0A0E1A 0%,#111827 100%);
  --gradient-card-hero:linear-gradient(135deg,#1E293B 0%,#0F172A 100%);
  --gradient-sidebar:linear-gradient(180deg,#111827 0%,#0A0E1A 100%);
  --text-primary:#F1F5F9;--text-secondary:#94A3B8;--text-tertiary:#64748B;--text-quaternary:#4A5568;
  --border:#1F2937;--border-hover:rgba(255,255,255,0.14);--border-focus:rgba(59,130,246,0.6);
  --blue-500:#3B82F6;--blue-600:#2563EB;--blue-400:#60A5FA;--accent:#3B82F6;
  --win:#10b981;--loss:#f04f4f;--wait:#f59e0b;
  --bg-success:rgba(16,185,129,0.09);--bg-error:rgba(240,79,79,0.09);--bg-warning:rgba(245,158,11,0.09);
  --shadow-sm:0 1px 3px rgba(0,0,0,0.4),0 1px 2px rgba(0,0,0,0.2);
  --shadow-md:0 4px 12px rgba(0,0,0,0.4),0 2px 4px rgba(0,0,0,0.2);
  --shadow-lg:0 12px 32px rgba(0,0,0,0.5),0 4px 8px rgba(0,0,0,0.3);
  --font-main:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono','Courier New',monospace;
  --gap:16px;--gap-lg:24px;--radius:12px;--radius-sm:8px;--radius-lg:16px;
  --sidebar-w:220px;--sidebar-w-collapsed:56px;
}
[data-theme="light"]{
  --bg-0:#F8FAFC;--bg-1:#EFF6FF;--bg-2:#FFFFFF;--bg-3:#EFF6FF;--bg-4:#DBEAFE;
  --gradient-body:linear-gradient(160deg,#F8FAFC 0%,#EFF6FF 100%);
  --gradient-card-hero:linear-gradient(135deg,#FFFFFF 0%,#EFF6FF 100%);
  --gradient-sidebar:linear-gradient(180deg,#EFF6FF 0%,#F8FAFC 100%);
  --text-primary:#0F172A;--text-secondary:#64748B;--text-tertiary:#94A3B8;--text-quaternary:#CBD5E1;
  --border:#E2E8F0;--border-hover:rgba(0,0,0,0.14);--border-focus:rgba(59,130,246,0.5);
  --blue-500:#2563EB;--blue-600:#1D4ED8;--blue-400:#3B82F6;--accent:#2563EB;
  --shadow-sm:0 1px 3px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.05);
  --shadow-md:0 4px 12px rgba(0,0,0,0.08),0 2px 4px rgba(0,0,0,0.04);
  --shadow-lg:0 12px 32px rgba(0,0,0,0.10),0 4px 8px rgba(0,0,0,0.06);
  --bg-success:rgba(16,185,129,0.07);--bg-error:rgba(240,79,79,0.07);--bg-warning:rgba(245,158,11,0.07);
}
[data-theme="light"] .card{box-shadow:var(--shadow-sm)}
[data-theme="light"] .stat{box-shadow:var(--shadow-sm)}
[data-theme="light"] .score-ring::before{background:#ffffff}
[data-theme="light"] .tbl thead{background:var(--bg-2)}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:var(--font-main);background:var(--gradient-body);background-attachment:fixed;color:var(--text-primary);line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.2}
h1{font-size:1.875rem}h2{font-size:1.375rem}h3{font-size:1rem}h4{font-size:0.9375rem}
a{color:var(--blue-400);text-decoration:none}
a:hover{text-decoration:underline}
.content{flex:1;padding:var(--gap-lg);max-width:1600px;width:100%;margin:0 auto}
.page-header{margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.page-header h2{font-size:1.2rem;font-weight:700;margin-bottom:4px;letter-spacing:-0.01em}
.page-header .subtitle{font-size:12.5px;color:var(--text-tertiary)}
.subtitle{font-size:12px;color:var(--text-tertiary);margin-top:3px}
.card{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:var(--gap);box-shadow:var(--shadow-sm);transition:box-shadow 0.2s}
.card:hover{box-shadow:var(--shadow-md)}
.card-head{padding:15px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:var(--bg-1)}
.card-head h3{flex:1;font-size:14px;font-weight:600;letter-spacing:0.01em}
.card-head .ico{opacity:0.45;flex-shrink:0}
.card-head .actions{display:flex;gap:6px;align-items:center}
.card-body{padding:20px}
.grid{display:grid;gap:var(--gap);margin-bottom:var(--gap)}
.grid-2{grid-template-columns:repeat(2,1fr)}
.grid-3{grid-template-columns:repeat(3,1fr)}
.grid-4{grid-template-columns:repeat(4,1fr)}
@media(max-width:1100px){.grid-4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:700px){.grid,.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}.content{padding:16px 14px}}
.stat{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;display:flex;flex-direction:column;gap:6px;box-shadow:var(--shadow-sm);transition:box-shadow 0.2s,transform 0.2s;cursor:default}
.stat:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.stat .label{font-size:11px;color:var(--text-quaternary);font-weight:600;text-transform:uppercase;letter-spacing:0.07em}
.stat .value{font-size:28px;font-weight:700;font-family:var(--font-mono);line-height:1.1;letter-spacing:-0.02em}
.stat .sub{font-size:12px}.stat .sub.muted{color:var(--text-tertiary)}.stat .sub.win{color:var(--win)}.stat .sub.loss{color:var(--loss)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 16px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;transition:all 0.13s;font-family:var(--font-main);white-space:nowrap;background:var(--bg-3);color:var(--text-secondary);border:1px solid var(--border);letter-spacing:0.01em}
.btn:hover{background:var(--bg-4);color:var(--text-primary);border-color:var(--border-hover)}
.btn:active{transform:scale(0.97)}
.btn:disabled{opacity:0.4;cursor:not-allowed;transform:none}
.btn-primary{background:var(--blue-500);color:white;border-color:transparent;box-shadow:0 2px 8px rgba(59,130,246,0.3)}
.btn-primary:hover{background:var(--blue-600);border-color:transparent;box-shadow:0 4px 12px rgba(59,130,246,0.4)}
.btn-ghost{background:transparent;color:var(--text-tertiary);border:none}
.btn-ghost:hover{background:var(--bg-3);color:var(--text-primary);border:none}
.btn-danger{background:rgba(240,79,79,0.1);color:var(--loss);border:1px solid rgba(240,79,79,0.2)}
.btn-danger:hover{background:rgba(240,79,79,0.18);border-color:rgba(240,79,79,0.45);color:var(--loss)}
.btn-sm{padding:5px 11px;font-size:12px}
.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:5px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em}
.badge-tag{background:var(--bg-3);color:var(--text-quaternary);border:1px solid var(--border)}
.badge-long{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-short{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-win{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-loss{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-wait{background:rgba(245,158,11,0.12);color:var(--wait)}
.badge-bullish{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-bearish{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-neutral{background:var(--bg-3);color:var(--text-tertiary)}
.input,input[type="text"],input[type="email"],input[type="password"],input[type="number"],input[type="date"],select,textarea{width:100%;padding:9px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13.5px;font-family:var(--font-main);transition:border-color 0.15s,box-shadow 0.15s;outline:none}
.input:focus,input:focus,select:focus,textarea:focus{border-color:var(--blue-500);background:var(--bg-1);box-shadow:0 0 0 3px rgba(59,130,246,0.12)}
label{font-size:13px;font-weight:500;color:var(--text-secondary)}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl thead{background:var(--bg-0)}
.tbl th{padding:10px 16px;text-align:left;font-weight:600;font-size:11px;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.07em;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:none}
.tbl tbody tr{transition:background 0.1s}
.tbl tbody tr:hover{background:rgba(255,255,255,0.025)}
[data-theme="light"] .tbl tbody tr:hover{background:rgba(0,0,0,0.025)}
.mono{font-family:var(--font-mono)}.muted{color:var(--text-tertiary)}.win{color:var(--win)}.loss{color:var(--loss)}
.spinner-lg,.spinner-sm{border:2.5px solid var(--bg-4);border-top-color:var(--blue-500);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0}
.spinner-lg{width:44px;height:44px}.spinner-sm{width:15px;height:15px;border-width:2px}
@keyframes spin{to{transform:rotate(360deg)}}
.page-enter{animation:fadeUp 0.28s ease-out}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.asset-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;background:var(--bg-3);border:1px solid var(--border);border-radius:6px;font-size:12.5px;font-weight:600;font-family:var(--font-mono);white-space:nowrap}
.asset-icon{width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,var(--blue-500),#6366f1);display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:white;font-weight:700;flex-shrink:0}
.score-ring{width:96px;height:96px;border-radius:50%;background:conic-gradient(var(--score-color,var(--blue-500)) calc(var(--pct) * 1%),var(--bg-3) calc(var(--pct) * 1%));display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;transition:filter 0.3s}
.score-ring.score-high{filter:drop-shadow(0 0 10px rgba(16,185,129,0.35))}
.score-ring.score-med{filter:drop-shadow(0 0 8px rgba(245,158,11,0.3))}
.score-ring.score-low{filter:drop-shadow(0 0 8px rgba(240,79,79,0.25))}
.score-ring::before{content:'';position:absolute;width:76px;height:76px;border-radius:50%;background:var(--bg-1)}
.score-text{font-size:26px;font-weight:700;font-family:var(--font-mono);position:relative;z-index:1;letter-spacing:-0.02em}
.score-sub{font-size:9px;color:var(--text-quaternary);position:relative;z-index:1;font-weight:700;letter-spacing:0.12em;text-transform:uppercase}
.signal-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.signal-meta .cell{display:flex;flex-direction:column;gap:3px}
.signal-meta .l{font-size:10px;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.07em;font-weight:600}
.signal-meta .v{font-size:15px;font-weight:700}
.bias-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);transition:background 0.1s}
.bias-row:last-child{border-bottom:none}
.best-signal-card{background:var(--gradient-card-hero);border-color:rgba(59,130,246,0.2)}
.best-signal-card .card-head{background:transparent;border-bottom-color:rgba(59,130,246,0.15)}
.best-signal-card .card-body{padding:22px}
.best-signal-grid{display:grid;grid-template-columns:1fr auto;gap:24px}
.portfolio-card{background:var(--gradient-card-hero);border-color:rgba(59,130,246,0.15)}
.portfolio-card .card-head{background:transparent;border-bottom-color:rgba(59,130,246,0.1)}
.user-avatar-sm{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--blue-500),#6366f1);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700;flex-shrink:0}
.status-pill{display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:20px;font-size:10.5px;font-weight:700;color:var(--win);white-space:nowrap;letter-spacing:0.04em}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--win);flex-shrink:0}
.status-pulse{animation:pulse 2.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.45;transform:scale(0.75)}}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:var(--sidebar-w);background:var(--gradient-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100;transition:width 0.2s ease;overflow:hidden}
.sidebar.collapsed{width:var(--sidebar-w-collapsed)}
.sidebar.collapsed .sidebar-brand-name,.sidebar.collapsed .link-label,.sidebar.collapsed .sidebar-user-info{display:none}
.sidebar-brand{display:flex;align-items:center;gap:10px;padding:0 14px;height:54px;border-bottom:1px solid var(--border);flex-shrink:0}
.sidebar-brand-name{font-weight:700;font-size:13px;letter-spacing:0.12em;color:var(--text-primary);white-space:nowrap;overflow:hidden}
.sidebar-toggle{margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:color 0.15s,background 0.15s}
.sidebar-toggle:hover{color:var(--text-primary);background:var(--bg-3)}
.sidebar-nav{flex:1;padding:12px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;overflow-x:hidden}
.sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--text-secondary);font-family:var(--font-main);text-decoration:none;transition:background 0.12s,color 0.12s;white-space:nowrap;overflow:hidden;width:100%}
.sidebar-link:hover{background:var(--bg-2);color:var(--text-primary);text-decoration:none}
.sidebar-link.active{background:rgba(59,130,246,0.12);color:var(--blue-400)}
.sidebar-link .link-label{white-space:nowrap;overflow:hidden}
.sidebar-sep{height:1px;background:var(--border);margin:8px 8px;flex-shrink:0}
.sidebar-bottom{padding:8px;border-top:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:2px}
.sidebar-user-btn{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:none;background:none;cursor:pointer;width:100%;font-family:var(--font-main);transition:background 0.12s;overflow:hidden}
.sidebar-user-btn:hover{background:var(--bg-2)}
.sidebar-user-info{text-align:left;overflow:hidden}
.sidebar-user-name{font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-user-role{font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em}
.app-with-sidebar{display:flex;min-height:100vh}
.app-main{flex:1;margin-left:var(--sidebar-w);transition:margin-left 0.2s ease;min-height:100vh}
.app-main.sidebar-collapsed{margin-left:var(--sidebar-w-collapsed)}
.sidebar-status{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--win)}
@media(max-width:768px){.best-signal-grid{grid-template-columns:1fr}.signal-meta{grid-template-columns:1fr 1fr}}
`;

function _svgIcon(name, size = 16) {
  const paths = {
    home:     '<path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/>',
    chart:    '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/>',
    book:     '<path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/>',
    bell:     '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    stats:    '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    bolt:     '<path d="m13 2-9 12h7l-1 8 9-12h-7z"/>',
    target:   '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    cpu:      '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
    chevron:  '<path d="m6 9 6 6 6-6"/>',
    moon:     '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    signal:   '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4 12 14l-4-4-6 6"/>',
    clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    users:    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    key:      '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2 10.94 12.06M21 2h-4.5M21 2v4.5M16.5 7.5l-2 2"/>',
  };
  const d = paths[name] || '<circle cx="12" cy="12" r="10"/>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtNum(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function _fmtPct(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function _fmtDate(ts) {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const _FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

function _renderSidebar(activePage, user) {
  const nav = [
    { id: 'dashboard',   label: 'Dashboard',  icon: 'home',     path: '/dashboard' },
    { id: 'backtesting', label: 'Backtesting', icon: 'chart',    path: '/backtesting' },
    { id: 'journal',     label: 'Journal',     icon: 'book',     path: '/journal' },
    { id: 'news',        label: 'News',        icon: 'bell',     path: '/news' },
    { id: 'statistiken', label: 'Statistiken', icon: 'stats',    path: '/analytics' },
  ];
  const initials = _esc((user?.username || '?').charAt(0).toUpperCase());
  const username = _esc(user?.username || '');
  const role     = _esc(user?.role || 'user');
  return `
<nav class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--blue-400)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 2 0"/>
    </svg>
    <span class="sidebar-brand-name">WAVESCOUT</span>
    <button class="sidebar-toggle" onclick="toggleSidebar()" title="Sidebar ein/ausblenden">${_svgIcon('chevron', 13)}</button>
  </div>
  <div class="sidebar-nav">
    ${nav.map(n => `
    <a href="${n.path}" class="sidebar-link${activePage === n.id ? ' active' : ''}"
       hx-get="${n.path}" hx-target="#content" hx-push-url="true" hx-swap="innerHTML">
      ${_svgIcon(n.icon, 15)}<span class="link-label">${n.label}</span>
    </a>`).join('')}
  </div>
  <div class="sidebar-sep"></div>
  <div class="sidebar-bottom">
    <a href="/settings" class="sidebar-link${activePage === 'einstellungen' ? ' active' : ''}"
       hx-get="/settings" hx-target="#content" hx-push-url="true" hx-swap="innerHTML">
      ${_svgIcon('settings', 15)}<span class="link-label">Einstellungen</span>
    </a>
    <div class="sidebar-user-btn">
      <div class="user-avatar-sm">${initials}</div>
      <div class="sidebar-user-info">
        <div class="sidebar-user-name">${username}</div>
        <div class="sidebar-user-role">${role}</div>
      </div>
    </div>
    <a href="/logout" class="sidebar-link">${_svgIcon('logout', 15)}<span class="link-label">Abmelden</span></a>
  </div>
</nav>`;
}

function _htmlPage({ title = 'WAVESCOUT', content, activePage, user }) {
  return `<!DOCTYPE html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${_esc(title)} — WAVESCOUT</title>
  ${_FONT_LINK}
  <link rel="stylesheet" href="/styles.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer><\/script>
</head>
<body>
  <div class="app-with-sidebar">
    ${_renderSidebar(activePage, user)}
    <main class="app-main" id="content">${content}</main>
  </div>
  <script>
    (function(){
      const t = localStorage.getItem('wavescout_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', t);
    })();
    function toggleSidebar() {
      const s = document.getElementById('sidebar');
      const m = document.getElementById('content');
      s.classList.toggle('collapsed');
      if (m) m.classList.toggle('sidebar-collapsed');
      localStorage.setItem('wavescout_sidebar', s.classList.contains('collapsed') ? '1' : '0');
    }
    document.addEventListener('htmx:afterSettle', function() {
      const path = window.location.pathname;
      document.querySelectorAll('.sidebar-link[href]').forEach(el => {
        el.classList.toggle('active', el.getAttribute('href') === path);
      });
    });
    window.addEventListener('DOMContentLoaded', function() {
      if (localStorage.getItem('wavescout_sidebar') === '1') toggleSidebar();
    });
  <\/script>
</body>
</html>`;
}

function _renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAVESCOUT — Login</title>
  ${_FONT_LINK}
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--bg-0:#060F1F;--bg-1:#0A1628;--border:rgba(148,175,230,0.14);--text-primary:#E8EEFB;--text-secondary:#94A8CC;--text-tertiary:#5E739B;--blue-500:#3B82F6;--blue-600:#2563EB;--font-main:'Geist',-apple-system,sans-serif}
    body{background:linear-gradient(rgba(6,15,31,0.82),rgba(6,15,31,0.82)),#060F1F;color:var(--text-primary);font-family:var(--font-main);min-height:100vh;display:flex;align-items:center;justify-content:center}
    .login-container{width:100%;max-width:420px;padding:20px}
    .login-card{background:rgba(8,18,34,0.62);backdrop-filter:blur(14px);border:1px solid rgba(135,163,218,0.28);border-radius:16px;padding:40px;box-shadow:0 20px 54px rgba(2,8,20,0.58)}
    .logo{text-align:center;margin-bottom:32px}
    .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,var(--blue-500),var(--blue-600));border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
    .logo-text{font-size:24px;font-weight:700;letter-spacing:-0.02em}
    .logo-sub{font-size:12px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.1em;margin-top:4px}
    .form-group{margin-bottom:20px}
    .form-group label{display:block;font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:8px}
    .input{width:100%;background:rgba(4,11,25,0.72);border:1px solid rgba(124,152,205,0.24);border-radius:8px;padding:12px 14px;font-size:14px;color:var(--text-primary);font-family:var(--font-main);transition:all 0.2s;outline:none}
    .input:focus{border-color:var(--blue-500);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
    .btn{width:100%;background:linear-gradient(180deg,var(--blue-500),var(--blue-600));border:1px solid var(--blue-500);border-radius:8px;padding:12px;font-size:14px;font-weight:600;color:white;cursor:pointer;transition:all 0.2s;font-family:var(--font-main)}
    .btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(59,130,246,0.4)}
    .error-msg{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;font-size:13px;color:#FCA5A5;margin-bottom:20px}
    .info-text{font-size:12px;color:var(--text-tertiary);text-align:center;margin-top:24px;padding-top:24px;border-top:1px solid var(--border)}
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="logo">
        <div class="logo-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4">
            <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 2 0"/>
          </svg>
        </div>
        <div class="logo-text">WAVESCOUT</div>
        <div class="logo-sub">Trading Intel</div>
      </div>
      ${error ? `<div class="error-msg">${_esc(error)}</div>` : ''}
      <form method="POST" action="/login">
        <div class="form-group">
          <label for="username">Benutzername</label>
          <input type="text" class="input" id="username" name="username" placeholder="Benutzername" required autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">Passwort</label>
          <input type="password" class="input" id="password" name="password" placeholder="Dein Passwort" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn">Anmelden</button>
      </form>
      <div class="info-text">Bei Problemen wende dich an einen Administrator.</div>
    </div>
  </div>
</body>
</html>`;
}

function _renderChangePwPage(error = '') {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAVESCOUT — Passwort ändern</title>
  ${_FONT_LINK}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#060F1F;color:#E8EEFB;font-family:'Geist',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:rgba(8,18,34,0.7);border:1px solid rgba(148,175,230,0.2);border-radius:16px;padding:40px;max-width:420px;width:calc(100% - 40px)}
    h2{font-size:20px;margin-bottom:8px}
    p{font-size:13px;color:#94A8CC;margin-bottom:24px}
    label{display:block;font-size:13px;font-weight:600;color:#94A8CC;margin-bottom:8px}
    input{width:100%;background:rgba(4,11,25,0.72);border:1px solid rgba(124,152,205,0.24);border-radius:8px;padding:12px 14px;font-size:14px;color:#E8EEFB;font-family:inherit;outline:none;margin-bottom:20px}
    input:focus{border-color:#3B82F6}
    button{width:100%;background:linear-gradient(180deg,#3B82F6,#2563EB);border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;color:white;cursor:pointer;font-family:inherit}
    .error-msg{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;font-size:13px;color:#FCA5A5;margin-bottom:20px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Passwort ändern</h2>
    <p>Bitte setze ein neues Passwort für dein Konto.</p>
    ${error ? `<div class="error-msg">${_esc(error)}</div>` : ''}
    <form method="POST" action="/change-password">
      <label for="newPassword">Neues Passwort</label>
      <input type="password" id="newPassword" name="newPassword" placeholder="Mindestens 8 Zeichen" required autocomplete="new-password">
      <button type="submit">Passwort speichern</button>
    </form>
  </div>
</body>
</html>`;
}

function _renderDashboardContent(data) {
  const { stats: s = {}, bestSignal, latestSignals, marketBias } = data;
  const pnlColor = v => (v >= 0 ? 'color:var(--win)' : 'color:var(--loss)');
  const pnlSign  = v => (v >= 0 ? '+' : '');

  const forexSessionWidget = `
<div id="forex-session-bar" style="display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:8px;background:var(--bg-1);border:1px solid var(--border);margin-bottom:16px;font-size:13px">
  <span id="forex-session-icon" style="font-size:16px">🌐</span>
  <div>
    <span style="color:var(--text-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.05em">Forex-Session</span>
    <div style="display:flex;align-items:center;gap:8px;margin-top:1px">
      <span id="forex-session-name" style="font-weight:700;font-size:14px">Wird geladen…</span>
      <span id="forex-session-desc" style="color:var(--text-tertiary);font-size:11px"></span>
    </div>
  </div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
    <span id="forex-session-dot" style="width:8px;height:8px;border-radius:50%;background:#6b7280;display:inline-block"></span>
    <span id="forex-session-time" style="font-family:var(--font-mono);font-size:12px;color:var(--text-tertiary)"></span>
  </div>
</div>
<script>
(function() {
  function getForexSession(h, m) {
    var t = h * 60 + m;
    var inAsia   = t >= 0   && t < 9*60;
    var inLondon = t >= 8*60 && t < 17*60;
    var inNY     = t >= 13*60 && t < 22*60;
    if (inLondon && inNY) return { name: 'London/NY-Overlap', color: '#10b981', icon: '🔥', desc: 'Höchste Liquidität · 13:00–17:00 UTC' };
    if (inLondon)          return { name: 'London-Session',    color: '#3b82f6', icon: '🏦', desc: '08:00–17:00 UTC' };
    if (inNY)              return { name: 'NY-Session',        color: '#f59e0b', icon: '🗽', desc: '13:00–22:00 UTC' };
    if (inAsia)            return { name: 'Asia-Session',      color: '#8b5cf6', icon: '🌏', desc: '00:00–09:00 UTC' };
    return { name: 'Off-Session', color: '#6b7280', icon: '😴', desc: 'Ruhige Phase' };
  }
  function updateForexSession() {
    var now = new Date();
    var h = now.getUTCHours(), mi = now.getUTCMinutes(), s = now.getUTCSeconds();
    var sess = getForexSession(h, mi);
    var pad2 = function(n){return n<10?'0'+n:String(n);};
    var timeStr = pad2(h)+':'+pad2(mi)+':'+pad2(s)+' UTC';
    var nameEl = document.getElementById('forex-session-name');
    var descEl = document.getElementById('forex-session-desc');
    var dotEl  = document.getElementById('forex-session-dot');
    var iconEl = document.getElementById('forex-session-icon');
    var timeEl = document.getElementById('forex-session-time');
    if (nameEl) nameEl.textContent = sess.name;
    if (nameEl) nameEl.style.color = sess.color;
    if (descEl) descEl.textContent = sess.desc;
    if (dotEl)  dotEl.style.background = sess.color;
    if (iconEl) iconEl.textContent = sess.icon;
    if (timeEl) timeEl.textContent = timeStr;
  }
  updateForexSession();
  setInterval(updateForexSession, 1000);
})();
</script>`;

  const statCards = `
<div class="grid grid-4">
  <div class="stat">
    <div class="label">Portfolio</div>
    <div class="value" style="font-size:22px">${_fmtNum(s.equity)} USDT</div>
    <div class="sub muted">Start: ${_fmtNum(s.startingCapital)} USDT</div>
  </div>
  <div class="stat">
    <div class="label">Gesamt P&amp;L</div>
    <div class="value" style="font-size:22px;${pnlColor(s.totalPnL)}">${pnlSign(s.totalPnL)}${_fmtNum(s.totalPnL)} USDT</div>
    <div class="sub muted">Heute: <span style="${pnlColor(s.todayPnL)}">${pnlSign(s.todayPnL)}${_fmtNum(s.todayPnL)}</span></div>
  </div>
  <div class="stat">
    <div class="label">Win-Rate</div>
    <div class="value" style="font-size:22px">${_fmtPct(s.winRate)}</div>
    <div class="sub muted">${s.wins || 0}W / ${s.losses || 0}L (${s.totalTrades || 0} Total)</div>
  </div>
  <div class="stat">
    <div class="label">Offene / Abgelehnte</div>
    <div class="value" style="font-size:22px">${s.open || 0} <span style="font-size:14px;color:var(--text-tertiary)">/ ${(s.rejected || 0) + (s.skipped || 0)}</span></div>
    <div class="sub muted">Offen · <span style="color:var(--loss)">${s.rejected || 0} abgelehnt</span> · ${s.skipped || 0} übersprungen</div>
  </div>
</div>`;

  let bestSignalHtml = '';
  if (bestSignal) {
    const score = bestSignal.ai_score || 0;
    const pct   = Math.min(100, score);
    const scoreClass = score >= 80 ? 'score-high' : score >= 65 ? 'score-med' : 'score-low';
    const scoreColor = score >= 80 ? 'var(--win)' : score >= 65 ? 'var(--wait)' : 'var(--loss)';
    const dirClass   = bestSignal.direction === 'LONG' ? 'badge-long' : 'badge-short';
    bestSignalHtml = `
<div class="card best-signal-card">
  <div class="card-head">
    <span class="ico">${_svgIcon('bolt', 14)}</span>
    <h3>Bestes offenes Signal</h3>
    <span class="badge ${dirClass}">${_esc(bestSignal.direction || '')}</span>
  </div>
  <div class="card-body">
    <div class="best-signal-grid">
      <div>
        <div style="font-size:24px;font-weight:700;font-family:var(--font-mono);margin-bottom:8px">${_esc(bestSignal.symbol || '')}</div>
        <div class="signal-meta">
          <div class="cell"><div class="l">Einstieg</div><div class="v">${_fmtNum(bestSignal.entry_price, 4)}</div></div>
          <div class="cell"><div class="l">Take Profit</div><div class="v" style="color:var(--win)">${_fmtNum(bestSignal.tp_price, 4)}</div></div>
          <div class="cell"><div class="l">Stop Loss</div><div class="v" style="color:var(--loss)">${_fmtNum(bestSignal.sl_price, 4)}</div></div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--text-quaternary)">${_fmtDate(bestSignal.created_at)}${bestSignal.telegram_sent ? ' <span class="badge badge-win" style="font-size:10px;margin-left:6px">📱 Telegram</span>' : ''}</div>
        ${bestSignal.ai_reason ? `<div style="margin-top:14px;padding:10px 12px;background:var(--bg-0);border-radius:8px;font-size:13px;line-height:1.6;border-left:3px solid var(--blue-500)"><div style="font-size:11px;color:var(--blue-400);margin-bottom:4px;font-weight:600">${_svgIcon('cpu', 11)} KI-Analyse</div>${_esc(bestSignal.ai_reason)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:center">
        <div class="score-ring ${scoreClass}" style="--pct:${pct};--score-color:${scoreColor}">
          <div class="score-text">${score}</div>
          <div class="score-sub">SCORE</div>
        </div>
      </div>
    </div>
  </div>
</div>`;
  } else {
    bestSignalHtml = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine offenen Signale</div></div>`;
  }

  let biasHtml = '';
  if (marketBias && marketBias.length > 0) {
    biasHtml = `
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart', 14)}</span><h3>Markt-Bias</h3></div>
  <div class="card-body" style="padding:0">
    ${marketBias.map(b => {
      const tc  = b.trend === 'bullish' ? 'badge-bullish' : b.trend === 'bearish' ? 'badge-bearish' : 'badge-neutral';
      const cc  = b.change >= 0 ? 'var(--win)' : 'var(--loss)';
      return `<div class="bias-row" style="padding:11px 20px">
        <div class="asset-chip"><div class="asset-icon">${_esc((b.symbol || '?').charAt(0))}</div>${_esc(b.symbol || '')}</div>
        <div style="flex:1;font-size:13px;font-family:var(--font-mono);font-weight:600">${_fmtNum(b.price, 2)}</div>
        <div style="font-size:13px;font-weight:600;color:${cc}">${b.change >= 0 ? '+' : ''}${_fmtNum(b.change, 2)}%</div>
        <span class="badge ${tc}">${_esc(b.trend || 'neutral')}</span>
        ${b.rsi != null ? `<div style="font-size:11px;color:var(--text-quaternary)">RSI ${_fmtNum(b.rsi, 1)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>
</div>`;
  }

  let signalsHtml = '';
  if (latestSignals && latestSignals.length > 0) {
    signalsHtml = `
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart', 14)}</span><h3>Letzte Signale</h3></div>
  <div style="overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th>Symbol</th><th>Richtung</th><th>Score</th>
        <th>Einstieg</th><th>TP</th><th>SL</th>
        <th>Ergebnis</th><th>Zeit</th>
      </tr></thead>
      <tbody>
        ${latestSignals.map(sig => {
          const dc = sig.direction === 'LONG' ? 'badge-long' : sig.direction === 'SHORT' ? 'badge-short' : '';
          const oc = sig.outcome === 'WIN' ? 'win' : sig.outcome === 'LOSS' ? 'loss' : 'muted';
          const outcomeLabel = sig.outcome === 'REJECTED'
            ? `<span style="color:var(--loss);font-size:11px" title="${_esc(sig.telegram_reason || '')}">✗ Abgelehnt</span>`
            : sig.outcome === 'SKIPPED'
            ? `<span style="color:var(--text-tertiary);font-size:11px">⏭ Übersprungen</span>`
            : `<span class="${oc}">${_esc(sig.outcome || 'OPEN')}</span>`;
          return `<tr${sig.outcome === 'REJECTED' ? ' style="opacity:0.65"' : ''}>
            <td style="font-family:var(--font-mono);font-weight:600">${_esc(sig.symbol || '')}</td>
            <td>${sig.direction ? `<span class="badge ${dc}">${_esc(sig.direction)}</span>` : '—'}</td>
            <td class="mono">${sig.ai_score != null ? sig.ai_score : '—'}</td>
            <td class="mono">${_fmtNum(sig.ai_entry || sig.entry_price, 4)}</td>
            <td class="mono" style="color:var(--win)">${_fmtNum(sig.ai_tp || sig.tp_price, 4)}</td>
            <td class="mono" style="color:var(--loss)">${_fmtNum(sig.ai_sl || sig.sl_price, 4)}</td>
            <td>${outcomeLabel}</td>
            <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(sig.created_at)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>`;
  }

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Dashboard</h2>
    <div class="subtitle">Live Portfolio &amp; Signale — WAVESCOUT v3.5</div>
  </div>
  ${forexSessionWidget}
  ${statCards}
  <div class="grid grid-2" style="margin-bottom:0">
    <div>${bestSignalHtml}${biasHtml}</div>
    <div>${signalsHtml}</div>
  </div>
</div>`;
}

function _renderPlaceholderPage(pageName) {
  const labels = { backtesting: 'Backtesting', statistiken: 'Statistiken', einstellungen: 'Einstellungen' };
  const label = labels[pageName] || pageName;
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>${_esc(label)}</h2>
    <div class="subtitle">HTMX-Migration in Arbeit</div>
  </div>
  <div class="card">
    <div class="card-body" style="text-align:center;padding:60px;color:var(--text-tertiary)">
      <div style="font-size:32px;margin-bottom:16px">🔨</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:8px">In Bearbeitung</div>
      <div style="font-size:13px">Diese Seite wird in der nächsten Migrationsphase umgesetzt.</div>
    </div>
  </div>
</div>`;
}

// ── Journal helpers ─────────────────────────────────────────────

function _renderJournalTable(signals, outcome) {
  if (!signals || signals.length === 0) {
    return `<div id="journal-table" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine Trades für diesen Filter</div>`;
  }
  const rows = signals.map(s => {
    const dirClass = s.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const oc       = s.outcome === 'WIN' ? 'win' : s.outcome === 'LOSS' ? 'loss' : s.outcome === 'BE' ? '' : 'muted';
    const pnl      = s.exit_price && s.entry_price
      ? (s.direction === 'LONG'
          ? ((s.exit_price - s.entry_price) / s.entry_price * 100)
          : ((s.entry_price - s.exit_price) / s.entry_price * 100))
      : null;
    const pnlStr   = pnl != null ? `<span style="${pnl >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%</span>` : '—';
    return `<tr>
      <td style="font-family:var(--font-mono);font-weight:600">${_esc(s.symbol || '')}</td>
      <td><span class="badge ${dirClass}">${_esc(s.direction || '')}</span></td>
      <td class="mono">${s.ai_score || '—'}</td>
      <td class="mono">${_fmtNum(s.entry_price, 4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(s.tp_price, 4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(s.sl_price, 4)}</td>
      <td>${pnlStr}</td>
      <td class="${oc}" style="font-weight:600">${_esc(s.outcome || 'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(s.created_at)}</td>
    </tr>`;
  }).join('');
  return `<div id="journal-table" style="overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th>Symbol</th><th>Richtung</th><th>Score</th>
        <th>Einstieg</th><th>TP</th><th>SL</th>
        <th>P&amp;L %</th><th>Ergebnis</th><th>Zeit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _renderJournalContent({ history, practiceData, outcome }) {
  const outcomes = ['all', 'OPEN', 'WIN', 'LOSS', 'BE'];
  const outcomeLabels = { all: 'Alle', OPEN: 'Offen', WIN: 'Win', LOSS: 'Loss', BE: 'Break Even' };
  const filterBar = outcomes.map(o => {
    const active = o === outcome;
    const bg = active ? (o === 'WIN' ? 'rgba(16,185,129,0.15)' : o === 'LOSS' ? 'rgba(240,79,79,0.15)' : 'rgba(59,130,246,0.15)') : 'var(--bg-3)';
    const color = active ? (o === 'WIN' ? 'var(--win)' : o === 'LOSS' ? 'var(--loss)' : o === 'OPEN' ? 'var(--blue-400)' : 'var(--text-primary)') : 'var(--text-secondary)';
    return `<button
      hx-get="/journal?outcome=${o}"
      hx-target="#journal-table"
      hx-swap="outerHTML"
      style="padding:6px 14px;border-radius:20px;border:1px solid var(--border);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main);background:${bg};color:${color};transition:all .12s">
      ${outcomeLabels[o]}
    </button>`;
  }).join('');

  // Practice trade stats
  const pt = practiceData || [];
  const ptOpen   = pt.filter(t => t.status === 'OPEN').length;
  const ptWins   = pt.filter(t => t.status === 'WIN').length;
  const ptLosses = pt.filter(t => t.status === 'LOSS').length;
  const ptClosed = ptWins + ptLosses;
  const ptWR     = ptClosed > 0 ? (ptWins / ptClosed * 100).toFixed(1) : '—';

  const ptRows = pt.slice(0, 20).map(t => {
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const sc = t.status === 'WIN' ? 'win' : t.status === 'LOSS' ? 'loss' : 'muted';
    const rp = t.result_pct != null ? `<span style="${t.result_pct >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${t.result_pct >= 0 ? '+' : ''}${Number(t.result_pct).toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(t.symbol || '')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction || '')}</span></td>
      <td class="mono">${_fmtNum(t.entry_price, 4)}</td>
      <td class="mono">${t.exit_price ? _fmtNum(t.exit_price, 4) : '—'}</td>
      <td>${rp}</td>
      <td class="${sc}" style="font-weight:600">${_esc(t.status || 'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(t.created_at)}</td>
    </tr>`;
  }).join('');

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Journal</h2>
    <div class="subtitle">Trade-Historie &amp; Practice Trades — ${history.length} Signale</div>
  </div>

  <div class="card" style="margin-bottom:var(--gap)">
    <div class="card-head">
      <span class="ico">${_svgIcon('chart', 14)}</span>
      <h3>Signal-Historie</h3>
      <div class="actions" style="gap:4px">${filterBar}</div>
    </div>
    ${_renderJournalTable(history, outcome)}
  </div>

  <div class="card">
    <div class="card-head">
      <span class="ico">${_svgIcon('target', 14)}</span>
      <h3>Practice Trades</h3>
      <div style="display:flex;gap:12px;font-size:12px;color:var(--text-tertiary)">
        <span>${ptOpen} offen</span>
        <span style="color:var(--win)">${ptWins}W</span>
        <span style="color:var(--loss)">${ptLosses}L</span>
        <span>WR ${ptWR}%</span>
      </div>
    </div>
    ${pt.length === 0
      ? `<div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px;font-size:13px">Keine Practice Trades vorhanden</div>`
      : `<div style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>Symbol</th><th>Richtung</th><th>Einstieg</th><th>Ausstieg</th><th>P&amp;L %</th><th>Status</th><th>Zeit</th></tr></thead>
          <tbody>${ptRows}</tbody>
        </table></div>`}
  </div>
</div>`;
}

// ── News helpers ────────────────────────────────────────────────

const _NEWS_SCOPE_LABELS = {
  MACRO: 'Makro', REGULATION: 'Regulierung', EXCHANGE: 'Exchange',
  COIN_SPECIFIC: 'Coin', GLOBAL: 'Global',
};
const _NEWS_SCOPE_COLORS = {
  MACRO: 'var(--wait)', REGULATION: '#a78bfa', EXCHANGE: 'var(--blue-400)',
  COIN_SPECIFIC: 'var(--win)', GLOBAL: 'var(--text-secondary)',
};
const _NEWS_IMPACT_COLORS = { HIGH: 'var(--loss)', MEDIUM: 'var(--wait)', LOW: 'var(--text-tertiary)' };

function _applyNewsFilter(events, filter) {
  if (!filter || filter === 'all') return events;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (filter === 'today')  return events.filter(e => e.event_time && e.event_time >= today.getTime());
  if (filter === 'HIGH')   return events.filter(e => e.impact === 'HIGH');
  if (filter === 'MACRO')  return events.filter(e => e.affected_scope === 'MACRO');
  if (filter === 'REGULATION') return events.filter(e => e.affected_scope === 'REGULATION');
  if (filter === 'EXCHANGE')   return events.filter(e => e.affected_scope === 'EXCHANGE');
  // Symbol filters
  return events.filter(e => {
    try { return (JSON.parse(e.affected_symbols || '[]')).includes(filter + 'USDT') || e.title?.includes(filter); }
    catch { return e.title?.includes(filter); }
  });
}

function _renderNewsList(events, filter) {
  const filtered = _applyNewsFilter(events, filter);
  if (!filtered.length) {
    return `<div id="news-list" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine News für diesen Filter</div>`;
  }
  const cards = filtered.map(e => {
    const impactColor = _NEWS_IMPACT_COLORS[e.impact] || _NEWS_IMPACT_COLORS.LOW;
    const scopeLabel  = _NEWS_SCOPE_LABELS[e.affected_scope] || 'Global';
    const scopeColor  = _NEWS_SCOPE_COLORS[e.affected_scope] || 'var(--text-secondary)';
    const dateStr     = e.event_time ? _fmtDate(e.event_time) : '—';
    const href        = e.source_url ? ` href="${_esc(e.source_url)}" target="_blank" rel="noopener"` : '';
    return `<a${href} style="display:block;text-decoration:none;color:inherit">
      <div class="card" style="margin-bottom:10px;transition:box-shadow .15s${e.impact === 'HIGH' ? ';border-left:3px solid var(--loss)' : ''}">
        <div class="card-body" style="padding:16px 20px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;align-items:center">
            ${e.impact ? `<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;background:var(--bg-0);border:1px solid ${impactColor};color:${impactColor}">${_esc(e.impact)}</span>` : ''}
            <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;background:var(--bg-0);border:1px solid var(--border);color:${scopeColor}">${_esc(scopeLabel)}</span>
            ${e.category ? `<span class="badge badge-tag">${_esc(e.category)}</span>` : ''}
          </div>
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;line-height:1.4">${_esc(e.title || '')}</div>
          ${e.summary ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">${_esc(e.summary)}</div>` : ''}
          <div style="display:flex;gap:16px;font-size:11px;color:var(--text-quaternary)">
            ${e.source ? `<span>📡 ${_esc(e.source)}</span>` : ''}
            <span>🕒 ${dateStr}</span>
            ${e.source_url ? `<span style="color:var(--blue-400)">↗ Artikel lesen</span>` : ''}
          </div>
        </div>
      </div>
    </a>`;
  }).join('');
  return `<div id="news-list">${cards}</div>`;
}

function _renderNewsContent({ events, filter }) {
  const filters = [
    { id: 'all',         label: 'Alle' },
    { id: 'HIGH',        label: 'High Impact' },
    { id: 'MACRO',       label: 'Makro' },
    { id: 'REGULATION',  label: 'Regulierung' },
    { id: 'EXCHANGE',    label: 'Exchanges' },
    { id: 'BTC',         label: 'BTC' },
    { id: 'ETH',         label: 'ETH' },
    { id: 'SOL',         label: 'SOL' },
    { id: 'today',       label: 'Heute' },
  ];
  const filterBar = filters.map(f => {
    const active = f.id === filter;
    return `<button
      hx-get="/news?filter=${f.id}"
      hx-target="#news-list"
      hx-swap="outerHTML"
      style="padding:5px 13px;border-radius:20px;border:1px solid var(--border);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main);background:${active ? 'rgba(59,130,246,0.15)' : 'var(--bg-3)'};color:${active ? 'var(--blue-400)' : 'var(--text-secondary)'};transition:all .12s">
      ${f.label}
    </button>`;
  }).join('');

  const highCount = events.filter(e => e.impact === 'HIGH').length;
  const statusBadge = highCount > 0
    ? `<span style="font-size:12px;font-weight:600;color:var(--loss);padding:3px 10px;background:rgba(240,79,79,0.1);border:1px solid rgba(240,79,79,0.25);border-radius:20px">${highCount} High Impact</span>`
    : `<span class="status-pill"><span class="status-dot status-pulse"></span>Kein High Impact</span>`;

  return `
<div class="content page-enter">
  <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div>
      <h2>News &amp; Market Radar</h2>
      <div class="subtitle">${events.length} Events geladen</div>
    </div>
    ${statusBadge}
  </div>

  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--gap);padding:4px 0">
    ${filterBar}
  </div>

  ${_renderNewsList(events, filter)}
</div>`;
}

// ── Backtesting helpers ─────────────────────────────────────────

function _renderBTTabBar(activeTab, isTrader) {
  const tabs = [
    { id: 'practice',      label: 'Übungstrades'        },
    { id: 'history',       label: 'Signal-Historie'      },
    ...(isTrader ? [
      { id: 'strategy',    label: 'Strategie-Labor'      },
      { id: 'compare',     label: 'Strategie-Vergleich'  },
      { id: 'regelanalyse',label: 'Regel-Analyse'        },
    ] : []),
    { id: 'loss',          label: 'Loss-Analyse'         },
    { id: 'biasstats',     label: 'Bias-Statistiken'     },
    { id: 'suggestions',   label: 'Vorschläge'           },
  ];
  const btns = tabs.map(t => {
    const active = t.id === activeTab;
    return `<button
      hx-get="/backtesting?tab=${t.id}"
      hx-target="#bt-section"
      hx-swap="innerHTML"
      hx-push-url="true"
      style="background:none;border:none;padding:10px 18px;cursor:pointer;font-size:14px;
             font-weight:${active ? 600 : 400};font-family:var(--font-main);white-space:nowrap;
             color:${active ? 'var(--blue-500)' : 'var(--text-secondary)'};
             border-bottom:2px solid ${active ? 'var(--blue-500)' : 'transparent'};
             margin-bottom:-1px;transition:all .15s"
      id="bt-tab-${t.id}">${t.label}</button>`;
  }).join('');
  return `<div style="overflow-x:auto;margin-bottom:20px;padding-bottom:1px">
  <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);min-width:max-content">${btns}</div>
</div>`;
}

function _renderBTPracticeTab(practiceTrades, practiceStats) {
  const ps = practiceStats || {};
  const statRow = `
<div class="grid grid-4" style="margin-bottom:var(--gap)">
  <div class="stat"><div class="label">Gesamt</div><div class="value" style="font-size:22px">${ps.total || 0}</div></div>
  <div class="stat"><div class="label">Offen</div><div class="value" style="font-size:22px">${ps.open || 0}</div></div>
  <div class="stat"><div class="label">Win-Rate</div><div class="value" style="font-size:22px">${_fmtPct(ps.winRate)}</div><div class="sub muted">${ps.wins || 0}W / ${ps.losses || 0}L</div></div>
  <div class="stat"><div class="label">Ø Win %</div><div class="value" style="font-size:22px;color:var(--win)">+${_fmtNum(ps.avgWinPct)}</div><div class="sub loss">Loss Ø −${_fmtNum(Math.abs(ps.avgLossPct || 0))}</div></div>
</div>`;
  const pts = practiceTrades || [];
  if (!pts.length) return statRow + `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Practice Trades vorhanden</div></div>`;
  const rows = pts.map(t => {
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const sc = t.status === 'WIN' ? 'win' : t.status === 'LOSS' ? 'loss' : 'muted';
    const rp = t.result_pct != null ? `<span style="${t.result_pct >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${t.result_pct >= 0 ? '+' : ''}${Number(t.result_pct).toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(t.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction||'')}</span></td>
      <td class="mono">${_fmtNum(t.entry_price,4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(t.tp_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(t.sl_price,4)}</td>
      <td class="mono">${t.exit_price ? _fmtNum(t.exit_price,4) : '—'}</td>
      <td>${rp}</td>
      <td class="${sc}" style="font-weight:600">${_esc(t.status||'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(t.created_at)}</td>
    </tr>`;
  }).join('');
  return statRow + `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Einstieg</th><th>TP</th><th>SL</th><th>Ausstieg</th><th>P&L%</th><th>Status</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTHistoryTab(history, stats) {
  const s = stats || {};
  const statRow = `
<div class="grid grid-4" style="margin-bottom:var(--gap)">
  <div class="stat"><div class="label">Trades Total</div><div class="value" style="font-size:22px">${s.total||0}</div></div>
  <div class="stat"><div class="label">Win-Rate</div><div class="value" style="font-size:22px">${_fmtPct(s.winRate)}</div><div class="sub muted">${s.wins||0}W / ${s.losses||0}L</div></div>
  <div class="stat"><div class="label">Break Even</div><div class="value" style="font-size:22px">${s.be||0}</div></div>
  <div class="stat"><div class="label">Offen</div><div class="value" style="font-size:22px">${s.open||0}</div></div>
</div>`;
  const hist = history || [];
  if (!hist.length) return statRow + `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Signale vorhanden</div></div>`;
  const rows = hist.map(sig => {
    const dc = sig.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const oc = sig.outcome === 'WIN' ? 'win' : sig.outcome === 'LOSS' ? 'loss' : 'muted';
    const pnl = sig.exit_price && sig.entry_price
      ? (sig.direction === 'LONG' ? (sig.exit_price - sig.entry_price) / sig.entry_price * 100 : (sig.entry_price - sig.exit_price) / sig.entry_price * 100)
      : null;
    const pnlHtml = pnl != null ? `<span style="${pnl>=0?'color:var(--win)':'color:var(--loss)'}">${pnl>=0?'+':''}${pnl.toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(sig.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(sig.direction||'')}</span></td>
      <td class="mono">${sig.ai_score||'—'}</td>
      <td class="mono">${_fmtNum(sig.entry_price,4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(sig.tp_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(sig.sl_price,4)}</td>
      <td>${pnlHtml}</td>
      <td class="${oc}" style="font-weight:600">${_esc(sig.outcome||'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(sig.created_at)}</td>
    </tr>`;
  }).join('');
  return statRow + `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Score</th><th>Einstieg</th><th>TP</th><th>SL</th><th>P&L%</th><th>Ergebnis</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTStrategyTab(strategies) {
  const strats = strategies || [];
  if (!strats.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Strategien vorhanden</div></div>`;
  const cards = strats.map(s => {
    const cfg = s.config || {};
    const isActive = !!s.active;
    const isProtected = !!s.protected;
    return `<div class="card" style="margin-bottom:10px;${isActive ? 'border-left:3px solid var(--blue-500)' : ''}">
      <div class="card-body" style="padding:16px 20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="flex:1">
            <div style="font-weight:700;font-size:15px">${_esc(s.name||'')}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">v${_esc(s.version||'1.0')} · ID: ${_esc(s.id||'').slice(-8)}</div>
          </div>
          ${isActive ? '<span class="badge badge-win">AKTIV</span>' : ''}
          ${isProtected ? '<span class="badge badge-tag">Standard</span>' : ''}
          ${!isActive ? `<button onclick="activateStrategy('${_esc(s.id)}',this)" style="padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-3);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main)">Aktivieren</button>` : ''}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-tertiary)">
          ${cfg.min_trade_score != null ? `<span>Min Score: <b style="color:var(--text-primary)">${cfg.min_trade_score}</b></span>` : ''}
          ${cfg.min_telegram_score != null ? `<span>Telegram: <b style="color:var(--text-primary)">${cfg.min_telegram_score}</b></span>` : ''}
          ${cfg.tp_pct != null ? `<span>TP: <b style="color:var(--win)">${cfg.tp_pct}%</b></span>` : ''}
          ${cfg.sl_pct != null ? `<span>SL: <b style="color:var(--loss)">${cfg.sl_pct}%</b></span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div>${cards}</div>
  <script>
  function activateStrategy(id, btn) {
    if (!confirm('Strategie aktivieren?')) return;
    btn.disabled = true; btn.textContent = '...';
    fetch('/strategies/' + id + '/activate', { method:'POST', credentials:'include' })
      .then(r => r.json())
      .then(d => { if (d.success) location.reload(); else { btn.disabled=false; btn.textContent='Aktivieren'; alert(d.error||'Fehler'); } })
      .catch(() => { btn.disabled=false; btn.textContent='Aktivieren'; });
  }
  <\/script>`;
}

function _renderBTCompareTab(strategies, history) {
  const hist = history || [];
  const strats = strategies || [];
  if (!strats.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Strategien zum Vergleichen</div></div>`;
  const withSignals = strats.map(s => {
    const sigs = hist.filter(h => h.strategy_id === s.id || (!h.strategy_id && s.is_default));
    const closed = sigs.filter(h => h.outcome === 'WIN' || h.outcome === 'LOSS');
    const wins = sigs.filter(h => h.outcome === 'WIN').length;
    const wr = closed.length > 0 ? computeWinRate(wins, closed.length - wins).toFixed(1) : '—';
    const scores = sigs.map(h => h.ai_score).filter(Boolean);
    const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : '—';
    return { ...s, totalSigs: sigs.length, closedSigs: closed.length, wins, winRate: wr, avgScore };
  });
  const rows = withSignals.map(s => `<tr>
    <td style="font-weight:600">${_esc(s.name||'')} ${s.active ? '<span class="badge badge-win" style="margin-left:4px">Aktiv</span>' : ''}</td>
    <td class="mono">${s.totalSigs}</td>
    <td class="mono">${s.closedSigs}</td>
    <td class="mono">${s.wins}</td>
    <td class="mono" style="font-weight:700;${parseFloat(s.winRate)>=50?'color:var(--win)':s.winRate!=='—'?'color:var(--loss)':''}">${s.winRate !== '—' ? s.winRate+'%' : '—'}</td>
    <td class="mono">${s.avgScore}</td>
  </tr>`).join('');
  return `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Strategie</th><th>Signale</th><th>Closed</th><th>Wins</th><th>Win-Rate</th><th>Ø Score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTRegelTab(history) {
  const hist = history || [];
  if (!hist.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Daten</div></div>`;
  const closed = hist.filter(h => h.outcome === 'WIN' || h.outcome === 'LOSS');
  // Group by symbol
  const bySym = {};
  closed.forEach(h => {
    const s = h.symbol || 'Unknown';
    if (!bySym[s]) bySym[s] = { symbol: s, wins: 0, losses: 0 };
    if (h.outcome === 'WIN') bySym[s].wins++;
    else bySym[s].losses++;
  });
  const symRows = Object.values(bySym)
    .sort((a,b) => (b.wins+b.losses) - (a.wins+a.losses))
    .slice(0, 20)
    .map(r => {
      const total = r.wins + r.losses;
      const wr = computeWinRate(r.wins, r.losses);
      const pct = wr.toFixed(1);
      const barColor = wr >= 60 ? 'var(--win)' : wr >= 40 ? 'var(--wait)' : 'var(--loss)';
      return `<tr>
        <td class="mono" style="font-weight:600">${_esc(r.symbol)}</td>
        <td class="mono">${total}</td>
        <td class="mono win">${r.wins}</td>
        <td class="mono loss">${r.losses}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${Math.min(100,wr)}%;background:${barColor};border-radius:3px"></div>
            </div>
            <span style="font-size:12px;font-weight:700;color:${barColor};width:42px;text-align:right">${pct}%</span>
          </div>
        </td>
      </tr>`;
    }).join('');

  // By direction
  const long = closed.filter(h => h.direction === 'LONG');
  const short = closed.filter(h => h.direction === 'SHORT');
  const longWR = long.length ? (long.filter(h=>h.outcome==='WIN').length/long.length*100).toFixed(1) : '—';
  const shortWR = short.length ? (short.filter(h=>h.outcome==='WIN').length/short.length*100).toFixed(1) : '—';
  return `
<div class="grid grid-2" style="margin-bottom:var(--gap)">
  <div class="card">
    <div class="card-head"><h3>LONG-Trades</h3><span class="badge badge-long">LONG</span></div>
    <div class="card-body" style="padding:20px;text-align:center">
      <div style="font-size:32px;font-weight:700;font-family:var(--font-mono);color:var(--win)">${longWR}%</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${long.length} Trades</div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>SHORT-Trades</h3><span class="badge badge-short">SHORT</span></div>
    <div class="card-body" style="padding:20px;text-align:center">
      <div style="font-size:32px;font-weight:700;font-family:var(--font-mono);color:var(--loss)">${shortWR}%</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${short.length} Trades</div>
    </div>
  </div>
</div>
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('stats',14)}</span><h3>Win-Rate nach Symbol</h3></div>
  <div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Trades</th><th>Win</th><th>Loss</th><th>Win-Rate</th></tr></thead>
    <tbody>${symRows}</tbody>
  </table></div>
</div>`;
}

function _renderBTLossTab(history) {
  const hist = history || [];
  const losses = hist.filter(h => h.outcome === 'LOSS');
  if (!losses.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Loss-Trades vorhanden</div></div>`;
  const scoreGroups = { '<60': [], '60-69': [], '70-79': [], '80+': [] };
  losses.forEach(l => {
    const sc = l.ai_score || 0;
    if (sc < 60) scoreGroups['<60'].push(l);
    else if (sc < 70) scoreGroups['60-69'].push(l);
    else if (sc < 80) scoreGroups['70-79'].push(l);
    else scoreGroups['80+'].push(l);
  });
  const groupCards = Object.entries(scoreGroups).map(([range, items]) => {
    if (!items.length) return '';
    return `<div class="stat"><div class="label">Score ${range}</div><div class="value" style="font-size:22px;color:var(--loss)">${items.length}</div><div class="sub muted">Losses</div></div>`;
  }).join('');
  const rows = losses.slice(0, 50).map(l => {
    const dc = l.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(l.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(l.direction||'')}</span></td>
      <td class="mono">${l.ai_score||'—'}</td>
      <td class="mono">${_fmtNum(l.entry_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(l.sl_price,4)}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(l.created_at)}</td>
    </tr>`;
  }).join('');
  return `
<div class="grid grid-4" style="margin-bottom:var(--gap)">${groupCards}</div>
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart',14)}</span><h3>Loss-Trades (letzte 50)</h3></div>
  <div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Score</th><th>Einstieg</th><th>SL</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

function _renderBTBiasTab(biasData) {
  const b = biasData || {};
  const card = (title, data, color) => {
    const d = data || {};
    return `<div class="stat">
      <div class="label">${title}</div>
      <div class="value" style="font-size:22px;color:${color || 'var(--text-primary)'}">${_fmtPct(d.winRate)}</div>
      <div class="sub muted">${d.wins||0}W / ${d.losses||0}L (${d.total||0})</div>
    </div>`;
  };
  return `
<div class="grid grid-3" style="margin-bottom:var(--gap)">
  ${card('Offizielle Trades', b.official, 'var(--blue-400)')}
  ${card('Alle Trades', b.all, 'var(--text-primary)')}
  ${card('Vor Morgenroutine', b.beforeRoutine, 'var(--wait)')}
</div>
<div class="card">
  <div class="card-body">
    <p style="font-size:13px;color:var(--text-tertiary);line-height:1.6">
      Bias-Statistiken zeigen, wie gut Trades mit dem Tages-Bias übereinstimmen.
      <b>Offizielle Trades</b> sind jene, die als <code>counts_for_strategy=1</code> markiert sind.
      <b>Vor Morgenroutine</b> sind Signale die vor der täglichen Analyse eingegangen sind.
    </p>
  </div>
</div>`;
}

function _renderBTSuggestionsTab(suggestions) {
  const suggs = suggestions || [];
  if (!suggs.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Vorschläge verfügbar</div></div>`;
  const priorityColor = p => p === 'high' ? 'var(--loss)' : p === 'medium' ? 'var(--wait)' : 'var(--text-tertiary)';
  const priorityBg    = p => p === 'high' ? 'rgba(240,79,79,0.08)' : p === 'medium' ? 'rgba(245,158,11,0.08)' : 'var(--bg-2)';
  const cards = suggs.map(s => `
  <div style="border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:10px;background:${priorityBg(s.priority)};${s.priority==='high'?'border-left:3px solid var(--loss)':''}">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div style="font-weight:700;font-size:14px;flex:1">${_esc(s.title||'')}</div>
      <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--bg-0);color:${priorityColor(s.priority)};text-transform:uppercase;letter-spacing:.06em">${_esc(s.priority||'')}</span>
    </div>
    <div style="font-size:13px;color:var(--text-secondary);line-height:1.5">${_esc(s.message||'')}</div>
    ${s.action ? `<div style="margin-top:8px;font-size:12px;font-weight:600;color:var(--blue-400)">→ ${_esc(s.action)}</div>` : ''}
  </div>`).join('');
  return `<div>${cards}</div>`;
}

function _getBTTabContent(tab, data) {
  if (tab === 'practice')     return _renderBTPracticeTab(data.practiceTrades, data.practiceStats);
  if (tab === 'history')      return _renderBTHistoryTab(data.history, data.stats);
  if (tab === 'strategy')     return _renderBTStrategyTab(data.strategies);
  if (tab === 'compare')      return _renderBTCompareTab(data.strategies, data.history);
  if (tab === 'regelanalyse') return _renderBTRegelTab(data.history);
  if (tab === 'loss')         return _renderBTLossTab(data.history);
  if (tab === 'biasstats')    return _renderBTBiasTab(data.biasData);
  if (tab === 'suggestions')  return _renderBTSuggestionsTab(data.suggestions);
  return _renderBTPracticeTab(data.practiceTrades, data.practiceStats);
}

function _renderBacktestContent(tab, data, session) {
  const isTrader  = session?.role === 'admin' || session?.role === 'trader';
  const tabBar    = _renderBTTabBar(tab, isTrader);
  const tabContent = _getBTTabContent(tab, data);
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Backtesting &amp; Strategie-Labor</h2>
    <div class="subtitle">Practice Trades · Strategie-Versionen · Loss-Analyse · Vorschläge</div>
  </div>
  <div id="bt-section">
    ${tabBar}
    <div id="backtest-content">${tabContent}</div>
  </div>
</div>`;
}

// ─── Phase 4: Statistiken ───────────────────────────────────────

function _fmtDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function _renderPnLChart(history) {
  const closed = history
    .filter(t => (t.outcome === 'WIN' || t.outcome === 'LOSS') && t.ai_entry && t.exit_price)
    .sort((a, b) => a.created_at - b.created_at);
  if (closed.length < 2) return '';
  let cum = 0;
  const points = closed.map(t => {
    const diff = t.exit_price - t.ai_entry;
    cum += t.direction === 'LONG' ? diff : -diff;
    return cum;
  });
  const W = 100, H = 60;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = v => H - ((v - min) / range) * H;
  const toX = i => (i / (points.length - 1)) * W;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fill  = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const last  = points[points.length - 1];
  const color = last >= 0 ? 'var(--win)' : 'var(--loss)';
  const badge = `<span class="badge ${last >= 0 ? 'badge-win' : 'badge-loss'}">${last >= 0 ? '+' : ''}$${_fmtNum(last)}</span>`;
  return `
<div class="card">
  <div class="card-head">
    ${_svgIcon('chart', 16)}<h3>Kumulativer PnL (Dollar)</h3>
    <div class="actions">${badge}</div>
  </div>
  <div class="card-body" style="padding:12px 20px 16px">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:90px" preserveAspectRatio="none">
      <defs>
        <linearGradient id="statPnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${zero > 0 && zero < H ? `<line x1="0" y1="${zero.toFixed(1)}" x2="${W}" y2="${zero.toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>` : ''}
      <path d="${fill}" fill="url(#statPnlGrad)"/>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.2"/>
    </svg>
  </div>
</div>`;
}

function _renderStatistikenContent({ stats, history, analytics, breakdown }) {
  const totalClosed = stats.wins + stats.losses;
  const winRate = computeWinRate(stats.wins, stats.losses);

  // Score distribution
  const sg = { '90–100': 0, '75–89': 0, '60–74': 0, '<60': 0 };
  history.forEach(t => {
    const s = t.ai_score || 0;
    if (s >= 90) sg['90–100']++;
    else if (s >= 75) sg['75–89']++;
    else if (s >= 60) sg['60–74']++;
    else sg['<60']++;
  });
  const scoreBars = Object.entries(sg).map(([lbl, cnt]) => {
    const pct = history.length > 0 ? (cnt / history.length * 100) : 0;
    return `
<div style="margin-bottom:14px">
  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
    <span style="color:var(--text-secondary)">Score ${lbl}</span>
    <span class="mono" style="color:var(--text-primary)">${cnt} (${pct.toFixed(0)}%)</span>
  </div>
  <div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
    <div style="height:100%;width:${pct.toFixed(1)}%;background:var(--blue-500);border-radius:3px"></div>
  </div>
</div>`;
  }).join('');

  // Direction breakdown rows
  const dirRows = (breakdown.directions || []).map(d => {
    const closed = d.wins + d.losses;
    const pct = computeWinRate(d.wins, d.losses);
    const cls = d.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `
<div style="margin-bottom:20px">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span class="badge ${cls}">${_esc(d.direction)}</span>
      <span style="font-size:13px;color:var(--text-tertiary)">${d.total} Trades</span>
    </div>
    <div class="mono" style="font-size:13px;font-weight:600;color:${d.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${d.winRate}%</div>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:6px">
    <span style="font-size:12px;color:var(--win)">${d.wins}W</span>
    <span style="font-size:12px;color:var(--text-tertiary)">·</span>
    <span style="font-size:12px;color:var(--loss)">${d.losses}L</span>
    <span style="font-size:12px;color:var(--text-tertiary)">·</span>
    <span style="font-size:12px;color:var(--text-tertiary)">${d.total - closed} offen</span>
  </div>
  <div style="height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden;display:flex">
    ${closed > 0 ? `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--win)"></div><div style="height:100%;width:${(100 - pct).toFixed(1)}%;background:var(--loss);opacity:0.6"></div>` : ''}
  </div>
</div>`;
  }).join('') || `<p style="color:var(--text-tertiary);text-align:center;padding:20px 0">Noch keine Daten</p>`;

  // Timeframe table rows
  const tfRows = (breakdown.timeframes || []).map(tf =>
    `<tr>
      <td class="mono">${_esc(String(tf.timeframe))}m</td>
      <td class="mono">${tf.total}</td>
      <td class="mono win">${tf.wins}</td>
      <td class="mono loss">${tf.losses}</td>
      <td class="mono" style="color:${tf.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${tf.winRate}%</td>
    </tr>`
  ).join('');

  const tfSection = tfRows
    ? `<table class="tbl"><thead><tr><th>TF</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr></thead><tbody>${tfRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Symbol table rows
  const symRows = (breakdown.symbols || []).slice(0, 8).map(s =>
    `<tr>
      <td class="mono" style="font-weight:600">${_esc(s.symbol)}</td>
      <td class="mono">${s.total}</td>
      <td class="mono win">${s.wins}</td>
      <td class="mono loss">${s.losses}</td>
      <td class="mono" style="color:${s.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${s.winRate}%</td>
    </tr>`
  ).join('');

  const symSection = symRows
    ? `<table class="tbl"><thead><tr><th>Symbol</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr></thead><tbody>${symRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Signal-class breakdown rows (NORMAL/STRONG/REVERSAL/...)
  const scRows = (breakdown.signalClasses || []).map(sc =>
    `<tr>
      <td class="mono" style="font-weight:600">${_esc(sc.signal_class)}</td>
      <td class="mono">${sc.total}</td>
      <td class="mono win">${sc.wins}</td>
      <td class="mono loss">${sc.losses}</td>
      <td class="mono" style="color:${sc.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${sc.winRate}%</td>
      <td class="mono" style="color:${sc.expectancy >= 0 ? 'var(--win)' : 'var(--loss)'}">${sc.expectancy.toFixed(2)}%</td>
    </tr>`
  ).join('');

  const scSection = scRows
    ? `<table class="tbl"><thead><tr><th>Klasse</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th><th>Expectancy</th></tr></thead><tbody>${scRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Recent trades table
  const recentRows = history.slice(0, 10).map(t => {
    const oc = t.outcome === 'WIN' ? 'win' : t.outcome === 'LOSS' ? 'loss' : 'muted';
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `<tr>
      <td class="mono muted" style="font-size:11px">${_fmtDate(t.created_at)}</td>
      <td class="mono" style="font-weight:600">${_esc(t.symbol || '')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction || '')}</span></td>
      <td class="mono muted">${_esc(String(t.timeframe || ''))}m</td>
      <td class="mono">${t.ai_score || 0}/100</td>
      <td><span class="mono ${oc}" style="font-size:12px;font-weight:600">${_esc(t.outcome || '')}</span></td>
    </tr>`;
  }).join('');

  const convRate = (analytics.totalSignals || stats.total) > 0
    ? ((totalClosed / (analytics.totalSignals || stats.total)) * 100).toFixed(1)
    : '0.0';

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Statistiken &amp; Analytics</h2>
    <div class="subtitle">${stats.total} Total Signale · ${totalClosed} abgeschlossen · ${stats.open} offen</div>
  </div>

  <div class="grid grid-4" style="margin-bottom:var(--gap)">
    <div class="stat"><div class="label">Abgeschlossen</div><div class="value" style="font-size:22px">${totalClosed}</div><div class="sub muted">${stats.total} Total Signale</div></div>
    <div class="stat"><div class="label">Expectancy <span class="muted" style="font-weight:400">(primär)</span></div><div class="value" style="font-size:22px;color:${(stats.expectancy || 0) >= 0 ? 'var(--win)' : 'var(--loss)'}">${(stats.expectancy || 0).toFixed(2)}%</div><div class="sub muted">Win-Rate ${winRate.toFixed(1)}% (sekundär)</div></div>
    <div class="stat"><div class="label">Gewonnen</div><div class="value" style="font-size:22px;color:var(--win)">${stats.wins}</div><div class="sub win">Profitable Trades</div></div>
    <div class="stat"><div class="label">Verloren</div><div class="value" style="font-size:22px;color:var(--loss)">${stats.losses}</div><div class="sub loss">Unprofitable Trades</div></div>
  </div>

  ${_renderPnLChart(history)}

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('signal', 16)}<h3>Long vs. Short</h3></div>
      <div class="card-body">${dirRows}</div>
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('clock', 16)}<h3>Performance nach Timeframe</h3></div>
      ${tfSection}
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('target', 16)}<h3>Performance nach Symbol</h3>
        <div class="actions"><span class="badge badge-tag">Top ${Math.min((breakdown.symbols || []).length, 8)}</span></div>
      </div>
      ${symSection}
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('chart', 16)}<h3>Score-Verteilung</h3></div>
      <div class="card-body">${scoreBars}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>Performance nach Signal-Klasse</h3></div>
    ${scSection}
  </div>

  <div class="grid grid-3" style="margin-bottom:var(--gap)">
    <div class="stat"><div class="label">Avg. Hold Time</div><div class="value" style="font-size:22px">${_fmtDuration(analytics.avgHoldTimeMs)}</div><div class="sub muted">Ø Trade-Dauer</div></div>
    <div class="stat"><div class="label">Total Signale</div><div class="value" style="font-size:22px">${analytics.totalSignals || stats.total}</div><div class="sub muted">Alle empfangenen Webhooks</div></div>
    <div class="stat"><div class="label">Conversion Rate</div><div class="value" style="font-size:22px">${convRate}%</div><div class="sub muted">Signale → abgeschl. Trades</div></div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>Letzte 10 Trades</h3></div>
    ${recentRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Zeit</th><th>Symbol</th><th>Richtung</th><th>TF</th><th>Score</th><th>Ergebnis</th></tr></thead><tbody>${recentRows}</tbody></table></div>`
      : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trades</p></div>`
    }
  </div>
</div>`;
}

// ─── Phase 5: Einstellungen + Admin ─────────────────────────────

const _WEBHOOK_DISPLAY_URL = 'https://tradingview-bot.spnn08.workers.dev/webhook';

function _renderSettingsNav(activeSection, isAdmin) {
  const secs = [
    { id: 'account',       label: 'Account',           icon: 'users'    },
    { id: 'design',        label: 'Design',             icon: 'moon'     },
    { id: 'trading',       label: 'Trading',            icon: 'chart'    },
    { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell'     },
    { id: 'broker',        label: 'Broker / API',       icon: 'cpu'      },
    ...(isAdmin ? [
      { id: 'admin',  label: 'Admin',  icon: 'bolt',     admin: true },
      { id: 'system', label: 'System', icon: 'settings', admin: true },
    ] : []),
  ];
  const items = secs.map((s, i) => {
    const active = s.id === activeSection;
    const divider = s.admin && i > 0 && !secs[i - 1].admin
      ? '<div style="height:1px;background:var(--border);margin:8px 0 6px"></div>' : '';
    return `${divider}<button
      hx-get="/settings?section=${s.id}"
      hx-target="#settings-section"
      hx-swap="innerHTML"
      hx-push-url="true"
      style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:none;
             background:${active ? 'rgba(59,130,246,.1)' : 'transparent'};
             color:${active ? 'var(--blue-500)' : 'var(--text-secondary)'};
             font-size:13px;font-weight:${active ? 600 : 400};cursor:pointer;
             font-family:var(--font-main);transition:all .15s;text-align:left;width:100%">
      ${_svgIcon(s.icon, 15)}
      <span style="flex:1">${_esc(s.label)}</span>
      ${s.admin ? '<span style="font-size:9px;padding:2px 5px;background:rgba(59,130,246,.15);color:var(--blue-500);border-radius:4px;font-weight:700">ADMIN</span>' : ''}
    </button>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;gap:2px;position:sticky;top:20px">${items}</div>`;
}

function _renderSettingsAccount(user) {
  return `<div class="card">
  <div class="card-head">${_svgIcon('users', 16)}<h3>Account</h3></div>
  <div class="card-body">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">BENUTZERNAME</div>
        <div style="font-size:14px;font-weight:600">${_esc(user.username || '–')}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">ROLLE</div>
        <span class="badge badge-tag" style="font-size:12px">${_esc(user.role || '–')}</span>
      </div>
      ${user.email ? `<div style="grid-column:1/-1">
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">E-MAIL</div>
        <div style="font-size:13px;color:var(--text-secondary)">${_esc(user.email)}</div>
      </div>` : ''}
    </div>
    <a href="/change-password" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--text-primary);text-decoration:none;transition:border-color .15s">
      ${_svgIcon('key', 13)} Passwort ändern
    </a>
  </div>
</div>`;
}

function _renderSettingsDesign() {
  return `<div class="card">
  <div class="card-head">${_svgIcon('moon', 16)}<h3>Design</h3></div>
  <div class="card-body">
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
      <input type="checkbox" id="theme-toggle" onchange="(function(el){const next=el.checked;document.documentElement.setAttribute('data-theme',next?'light':'dark');localStorage.setItem('theme',next?'light':'dark')})(this)">
      <div>
        <div style="font-size:13px;font-weight:500">Light Mode</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">Helles Theme aktivieren (auch über Sidebar-Toggle änderbar)</div>
      </div>
    </label>
  </div>
</div>
<script>(function(){const t=localStorage.getItem('theme');const cb=document.getElementById('theme-toggle');if(cb)cb.checked=t==='light'})();</script>`;
}

function _renderSettingsTrading() {
  const sliders = [
    { id: 'riskPerTrade',  label: 'Risiko pro Trade',          suffix: '%', min: 0.5, max: 5,  step: 0.5, def: 2, parse: 'parseFloat' },
    { id: 'minScore',      label: 'Minimaler Score',           suffix: '',  min: 75,  max: 90, step: 5,   def: 75, parse: 'parseInt'   },
    { id: 'maxOpenTrades', label: 'Max. gleichzeitige Trades', suffix: '',  min: 1,   max: 10, step: 1,   def: 3,  parse: 'parseInt'   },
  ];
  const sliderHtml = sliders.map(s =>
    `<div style="margin-bottom:20px">
      <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:500">
        ${s.label}: <span style="color:var(--blue-500)" id="${s.id}Label">${s.def}${s.suffix}</span>
      </label>
      <input type="range" id="${s.id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.def}" style="width:100%;max-width:360px"
        oninput="document.getElementById('${s.id}Label').textContent=this.value+'${s.suffix}'${s.id === 'minScore' ? ";document.getElementById('scoreLabel').textContent=this.value" : ''}">
    </div>`
  ).join('');
  const checks = [
    ['useStopLoss', 'Stop-Loss immer setzen', true],
    ['useTakeProfit', 'Take-Profit immer setzen', true],
    ['trailingStop', 'Trailing Stop verwenden', false],
  ];
  const checkHtml = checks.map(([id, label, def]) =>
    `<label style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" id="${id}"${def ? ' checked' : ''}> ${label}
    </label>`
  ).join('');
  return `<div class="card">
  <div class="card-head">${_svgIcon('chart', 16)}<h3>Trading</h3></div>
  <div class="card-body">
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;margin-bottom:20px">
      <input type="checkbox" id="autoTrade">
      Auto-Trading aktivieren (Score ≥ <span id="scoreLabel">65</span>)
    </label>
    ${sliderHtml}
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">${checkHtml}</div>
    <div style="display:flex;gap:12px;align-items:center">
      <button onclick="saveTradingSettings()" style="padding:8px 16px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">Speichern</button>
      <span id="tradingSaved" style="display:none;color:var(--win);font-size:12px">Gespeichert ✓</span>
    </div>
  </div>
</div>
<script>
(function(){
  try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
  if(s.autoTrade!=null)document.getElementById('autoTrade').checked=s.autoTrade;
  const setSlider=(id,v,suf)=>{if(v==null)return;document.getElementById(id).value=v;document.getElementById(id+'Label').textContent=v+(suf||'')};
  setSlider('riskPerTrade',s.riskPerTrade,'%');setSlider('minScore',s.minScore,'');setSlider('maxOpenTrades',s.maxOpenTrades,'');
  if(s.minScore){document.getElementById('scoreLabel').textContent=s.minScore;}
  ['useStopLoss','useTakeProfit','trailingStop'].forEach(k=>{if(s[k]!=null)document.getElementById(k).checked=s[k]});
  }catch(_){}
})();
function saveTradingSettings(){
  try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
  s.autoTrade=document.getElementById('autoTrade').checked;
  s.riskPerTrade=parseFloat(document.getElementById('riskPerTrade').value);
  s.minScore=parseInt(document.getElementById('minScore').value);
  s.maxOpenTrades=parseInt(document.getElementById('maxOpenTrades').value);
  ['useStopLoss','useTakeProfit','trailingStop'].forEach(k=>s[k]=document.getElementById(k).checked);
  localStorage.setItem('wavescout_settings',JSON.stringify(s));
  const el=document.getElementById('tradingSaved');el.style.display='inline';setTimeout(()=>el.style.display='none',2500);
  }catch(_){}
}
</script>`;
}

function _renderSettingsNotifications() {
  return `<div class="card">
  <div class="card-head">${_svgIcon('bell', 16)}<h3>Benachrichtigungen</h3></div>
  <div class="card-body">
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="notifBrowser" checked> Browser-Benachrichtigungen</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="notifTelegram" checked> Telegram-Benachrichtigungen</label>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px">
      <button onclick="saveNotifSettings()" style="padding:8px 16px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">Speichern</button>
      <span id="notifSaved" style="display:none;color:var(--win);font-size:12px">Gespeichert &#10003;</span>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:16px">
      <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">NTFY.SH TEST</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">Sendet einen Test-Push via ntfy.sh (Score&nbsp;97, BTCUSDT). Benoetigt das Secret <code>NTFY_TOPIC</code>.</div>
      <div style="display:flex;gap:10px;align-items:center">
        <button id="ntfy-test-btn" onclick="(async()=>{const btn=document.getElementById('ntfy-test-btn');const res=document.getElementById('ntfy-test-result');btn.disabled=true;btn.textContent='Sende...';try{const r=await fetch('/admin/test-ntfy',{credentials:'include'});const d=await r.json();res.textContent=d.success?'ntfy OK ✓':(d.message||'Fehler');res.style.color=d.success?'var(--win)':'var(--loss)';}catch(e){res.textContent=e.message;res.style.color='var(--loss)';}finally{btn.disabled=false;btn.textContent='ntfy Test senden';}})()"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">ntfy Test senden</button>
        <span id="ntfy-test-result" style="font-size:13px"></span>
      </div>
    </div>
  </div>
</div>
<script>
(function(){try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
if(s.notifications!=null)document.getElementById('notifBrowser').checked=s.notifications;
if(s.telegramEnabled!=null)document.getElementById('notifTelegram').checked=s.telegramEnabled;
}catch(_){}})();
function saveNotifSettings(){try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
s.notifications=document.getElementById('notifBrowser').checked;
s.telegramEnabled=document.getElementById('notifTelegram').checked;
localStorage.setItem('wavescout_settings',JSON.stringify(s));
const el=document.getElementById('notifSaved');el.style.display='inline';setTimeout(()=>el.style.display='none',2500);
}catch(_){}}
</script>`;
}

function _renderSettingsBroker() {
  const wh = _WEBHOOK_DISPLAY_URL;
  return `<div style="display:flex;flex-direction:column;gap:16px">
  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>TradingView Webhook</h3>
      <div class="actions"><span class="badge badge-win">LIVE</span></div>
    </div>
    <div class="card-body">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">
        Diese URL in TradingView unter <strong>Alerts → Webhook URL</strong> eintragen.
      </p>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        <div style="flex:1;padding:10px 14px;background:var(--bg-0);border:1px solid var(--border);border-radius:8px;font-family:var(--font-mono);font-size:13px;color:var(--text-secondary);word-break:break-all">${_esc(wh)}</div>
        <button id="copy-wh-btn" onclick="navigator.clipboard.writeText('${wh}').then(()=>{this.textContent='Kopiert ✓';setTimeout(()=>this.textContent='Kopieren',2000)})"
          style="flex-shrink:0;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Kopieren</button>
      </div>
      <div style="padding:10px 14px;background:rgba(245,158,11,.06);border-radius:8px;border:1px solid rgba(245,158,11,.3);font-size:12px;color:var(--text-secondary)">
        <strong>Beispiel-Payload (SIGNAL):</strong>
        <pre style="margin:6px 0 0;font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);white-space:pre-wrap">{"symbol":"BTCUSDT","event_type":"SIGNAL","timeframe":"5","price":{{close}},"direction":"LONG","trigger":"EMA_CROSS","action":"BUY"}</pre>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('chart', 16)}<h3>Autotrade Konfiguration</h3>
      <div class="actions" id="at-badge"><span class="badge badge-tag">INAKTIV</span></div>
    </div>
    <div id="at-loading" class="card-body" style="text-align:center;padding:20px;font-size:13px;color:var(--text-tertiary)">Lade Konfiguration…</div>
    <div id="at-form" class="card-body" style="display:none">
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:20px;cursor:pointer">
        <input type="checkbox" id="at-enabled">
        <div><div style="font-weight:600;font-size:13px">Autotrade aktivieren</div>
          <div style="font-size:12px;color:var(--text-tertiary)">Bei qualifizierten Signalen automatisch echte Orders platzieren</div></div>
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div><label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">BETRAG PRO TRADE (USDT)</label>
          <input type="number" id="at-amount" min="1" step="1" value="10" class="input" style="width:100%"></div>
        <div><label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">MIN. SCORE</label>
          <input type="number" id="at-minscore" min="55" max="100" step="5" value="75" class="input" style="width:100%"></div>
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">API KEY</label>
        <input type="text" id="at-apikey" class="input" style="width:100%" autocomplete="off" placeholder="Broker API Key">
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">API SECRET</label>
        <input type="password" id="at-secret" class="input" style="width:100%" placeholder="Leer lassen um bestehenden Key zu behalten" autocomplete="new-password">
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:16px">
        <input type="checkbox" id="at-testnet" checked onchange="updateAtWarning()">
        <span>Testnet / Demo-Modus <span id="at-testnet-lbl" style="font-size:12px;color:var(--win);font-weight:600">(kein echtes Geld)</span></span>
      </label>
      <div id="at-live-warn" style="display:none;padding:10px 14px;background:rgba(240,68,68,.08);border-radius:8px;border:1px solid rgba(240,68,68,.3);font-size:12px;color:var(--loss);margin-bottom:14px;font-weight:600">
        ⚠️ LIVE-MODUS aktiv — echte Orders werden platziert!
      </div>
      <div style="padding:10px 14px;background:rgba(245,158,11,.06);border-radius:8px;border:1px solid rgba(245,158,11,.3);font-size:12px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6">
        API-Keys werden verschlüsselt auf dem Server gespeichert. Nur Trading-Rechte vergeben — <strong>kein Withdrawal-Recht</strong>.
      </div>
      <div id="at-err" style="display:none;padding:8px 14px;background:rgba(240,68,68,.08);border-radius:8px;font-size:12px;color:var(--loss);margin-bottom:12px"></div>
      <button id="at-save" onclick="saveAtConfig()" style="padding:10px 20px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">
        Auf Server speichern
      </button>
    </div>
  </div>
</div>
<script>
function updateAtWarning(){
  const t=document.getElementById('at-testnet')?.checked,e=document.getElementById('at-enabled')?.checked;
  const lbl=document.getElementById('at-testnet-lbl'),warn=document.getElementById('at-live-warn');
  if(lbl){lbl.textContent=t?'(kein echtes Geld)':'(LIVE — echtes Geld!)';lbl.style.color=t?'var(--win)':'var(--loss)';}
  if(warn)warn.style.display=(!t&&e)?'block':'none';
}
(function(){
  fetch('/broker-config',{credentials:'include'}).then(r=>r.ok?r.json():null).then(d=>{
    document.getElementById('at-loading').style.display='none';
    document.getElementById('at-form').style.display='block';
    if(d?.configured){
      document.getElementById('at-enabled').checked=d.enabled||false;
      document.getElementById('at-amount').value=d.tradeAmount||10;
      document.getElementById('at-minscore').value=d.minScore||75;
      document.getElementById('at-testnet').checked=d.testnet!==false;
      if(d.apiKeyMasked)document.getElementById('at-apikey').placeholder=d.apiKeyMasked;
      const b=document.getElementById('at-badge');
      if(b)b.innerHTML=d.enabled?'<span class="badge badge-win">AKTIV</span>':'<span class="badge badge-tag">INAKTIV</span>';
    }
    updateAtWarning();
  }).catch(()=>{document.getElementById('at-loading').style.display='none';document.getElementById('at-form').style.display='block';});
  document.getElementById('at-enabled')?.addEventListener('change',updateAtWarning);
})();
async function saveAtConfig(){
  const btn=document.getElementById('at-save'),errEl=document.getElementById('at-err');
  btn.disabled=true;btn.textContent='Speichern…';errEl.style.display='none';
  try{
    const r=await fetch('/broker-config',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({enabled:document.getElementById('at-enabled').checked,tradeAmount:parseFloat(document.getElementById('at-amount').value)||10,
        minScore:parseInt(document.getElementById('at-minscore').value)||75,apiKey:document.getElementById('at-apikey').value,
        apiSecret:document.getElementById('at-secret').value,passphrase:'',testnet:document.getElementById('at-testnet').checked,broker:'bybit'})});
    if(r.ok){
      document.getElementById('at-secret').value='';
      btn.textContent='Gespeichert ✓';setTimeout(()=>btn.textContent='Auf Server speichern',2500);
      const b=document.getElementById('at-badge');if(b)b.innerHTML=document.getElementById('at-enabled').checked?'<span class="badge badge-win">AKTIV</span>':'<span class="badge badge-tag">INAKTIV</span>';
    }else{const e=await r.json().catch(()=>({}));errEl.textContent=e.error||'Fehler';errEl.style.display='block';btn.textContent='Auf Server speichern';}
  }catch(e){errEl.textContent='Netzwerkfehler';errEl.style.display='block';btn.textContent='Auf Server speichern';}
  btn.disabled=false;
}
</script>`;
}

function _renderSettingsSystem() {
  return `<div style="display:flex;flex-direction:column;gap:16px">
  <div class="card">
    <div class="card-head">${_svgIcon('settings', 16)}<h3>System Info</h3></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${[['Worker Runtime','Cloudflare Workers'],['Datenbank','Cloudflare D1 (SQLite)'],['Frontend','Cloudflare Pages'],['Framework','HTMX 2.0.4']].map(([k,v]) =>
          `<div><div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:3px">${k.toUpperCase()}</div>
          <div style="font-size:13px;color:var(--text-secondary)">${v}</div></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-head">${_svgIcon('bolt', 16)}<h3>Cloudflare Dashboard</h3></div>
    <div class="card-body">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Logs, Metrics, Bindings und Cron-Trigger im Cloudflare Dashboard verwalten.</p>
      <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer"
         style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);font-size:13px;color:var(--text-primary);text-decoration:none">
        ${_svgIcon('signal', 13)} Cloudflare Dashboard öffnen
      </a>
    </div>
  </div>
</div>`;
}

function _renderSettingsAdmin({ users = [], sessions = [], systemStatus = {} }) {
  const st = systemStatus;
  const dotColor = ok => ok ? 'var(--win)' : 'var(--loss)';
  const dotGlow  = ok => ok ? ';box-shadow:0 0 5px var(--win)' : '';
  const statusText = ok => ok ? 'OK' : 'Nicht konfiguriert';

  const serviceRows = [
    ['Datenbank (D1)', st.db], ['Telegram Bot', st.telegram],
    ['ntfy.sh', st.ntfy], ['Anthropic AI', st.anthropic], ['Webhook Secret', st.webhook],
  ].map(([label, ok]) => `<div style="display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:13px;color:var(--text-secondary)">${label}</span>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(ok)}${dotGlow(ok)}"></div>
      <span style="font-size:12px;color:${dotColor(ok)};font-weight:600">${statusText(ok)}</span>
    </div>
  </div>`).join('');

  const tableCountRows = Object.entries(st.tables || {}).map(([t, c]) =>
    `<div style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;color:var(--text-tertiary);font-family:var(--font-mono)">${t}</span>
      <span style="font-size:13px;font-weight:600;color:${c === null ? 'var(--loss)' : 'var(--text-primary)'}">${c === null ? '✗' : c.toLocaleString()}</span>
    </div>`
  ).join('');

  const sessionRows = sessions.map(s => `<tr>
    <td style="font-weight:600">${_esc(s.username || '')}</td>
    <td><span class="badge ${s.role === 'admin' ? 'badge-win' : 'badge-wait'}">${_esc(s.role || '')}</span></td>
    <td class="mono muted" style="font-size:11px">${_fmtDate(s.created_at)}</td>
    <td class="mono muted" style="font-size:11px">${_fmtDate(s.expires_at)}</td>
  </tr>`).join('');

  const now = Date.now();
  const userRows = users.map(u => {
    const online = u.last_seen && u.last_seen > now - 5 * 60 * 1000;
    return `<tr style="${u.blocked ? 'opacity:.55' : ''}">
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:7px;height:7px;border-radius:50%;background:${online ? 'var(--win)' : 'var(--text-quaternary)'}"></div>
          <span style="font-size:11px;color:var(--text-tertiary)">${online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:28px;height:28px;border-radius:50%;background:${u.blocked ? 'var(--text-quaternary)' : 'var(--blue-500)'};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0">
            ${_esc((u.username || 'U').charAt(0).toUpperCase())}
          </div>
          <div>
            <div style="font-weight:600">${_esc(u.username || '')}</div>
            ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${_esc(u.email)}</div>` : ''}
          </div>
          ${u.blocked ? '<span class="badge badge-loss" style="font-size:10px">GESPERRT</span>' : ''}
        </div>
      </td>
      <td>
        <select onchange="changeRole('${u.id}',this.value)" class="input" style="font-size:12px;padding:3px 6px;width:auto;min-width:100px">
          ${['admin','trader','viewer','extern'].map(r => `<option value="${r}"${u.role===r?' selected':''}>${r.toUpperCase()}</option>`).join('')}
        </select>
      </td>
      <td class="mono muted" style="font-size:11px">${u.last_seen ? _fmtDate(u.last_seen) : '–'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button title="Passwort ändern" onclick="showChangePwModal('${u.id}','${_esc(u.username || '')}')"
            style="padding:4px 8px;border-radius:6px;background:var(--bg-2);border:1px solid var(--border);cursor:pointer;font-size:12px">${_svgIcon('key', 13)}</button>
          <button title="${u.blocked ? 'Entsperren' : 'Sperren'}" onclick="toggleBlock('${u.id}',${!u.blocked})"
            style="padding:4px 8px;border-radius:6px;background:var(--bg-2);border:1px solid var(--border);cursor:pointer;font-size:12px;color:${u.blocked ? 'var(--win)' : 'var(--loss)'}">
            ${u.blocked ? '✓' : '✗'}
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<div style="display:flex;flex-direction:column;gap:16px">

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>System Status</h3>
      <div class="actions"><span class="badge badge-tag">${_esc(st.version || '–')}</span></div>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:12px">SERVICES</div>
          <div style="display:flex;flex-direction:column;gap:10px">${serviceRows}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:12px">DATENBANK — ZEILEN</div>
          <div style="display:flex;flex-direction:column;gap:8px">${tableCountRows}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('bell', 16)}<h3>Telegram Integration</h3>
      <div class="actions">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.telegram)}${dotGlow(st.telegram)}"></div>
          <span style="font-size:12px;color:${dotColor(st.telegram)};font-weight:600">${statusText(st.telegram)}</span>
        </div>
      </div>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SCHNELLTEST</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button onclick="adminAction('/test-telegram','GET','tg-result',d=>d.success?'Telegram OK ✓':(d.message||'Fehler'),d=>d.success)"
            style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🔔 Verbindung testen</button>
          <button onclick="sendTgSignal()"
            style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">📊 Test-Signal Alert</button>
        </div>
        <div id="tg-result" style="margin-top:8px"></div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">EIGENE NACHRICHT</div>
        <textarea id="tg-msg" class="input" rows="3" style="width:100%;font-family:var(--font-mono);font-size:13px;resize:vertical" placeholder="Nachricht (HTML: &lt;b&gt; &lt;i&gt; &lt;code&gt;)"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button onclick="sendTgCustom()" style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">📤 Senden</button>
        </div>
        <div id="tg-send-result" style="margin-top:8px"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('bell', 16)}<h3>ntfy.sh Integration</h3>
      <div class="actions">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.ntfy)}${dotGlow(st.ntfy)}"></div>
          <span style="font-size:12px;color:${dotColor(st.ntfy)};font-weight:600">${st.ntfy ? 'OK' : 'Nicht konfiguriert'}</span>
        </div>
      </div>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:13px;color:var(--text-secondary)">Sendet Push-Benachrichtigungen für Signale mit Score ≥ 95 via <b>ntfy.sh</b>.<br>Setzt das Worker-Secret <code>NTFY_TOPIC</code> voraus.</div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SCHNELLTEST</div>
        <button onclick="adminAction('/admin/test-ntfy','GET','ntfy-result',d=>d.success?'ntfy OK ✓':(d.message||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🔔 ntfy Test senden</button>
        <div id="ntfy-result" style="margin-top:8px"></div>
      </div>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('cpu', 16)}<h3>Anthropic AI</h3>
        <div class="actions">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.anthropic)}${dotGlow(st.anthropic)}"></div>
            <span style="font-size:12px;color:${dotColor(st.anthropic)};font-weight:600">${statusText(st.anthropic)}</span>
          </div>
        </div>
      </div>
      <div class="card-body">
        <button onclick="adminAction('/admin/test-ai','POST','ai-result',d=>d.ok?'AI OK · '+d.latencyMs+'ms · '+d.model:(d.error||'Fehler'),d=>d.ok)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🤖 API testen</button>
        <div id="ai-result" style="margin-top:8px"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('target', 16)}<h3>Trade Check</h3></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
        <button onclick="adminAction('/admin/check-open-trades','POST','check-result',d=>d.success?'Geprüft: '+d.checked+' · Geschlossen: '+(d.closed||0):(d.error||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Alle offenen Trades prüfen</button>
        <button onclick="adminAction('/admin/eod-check','POST','check-result',d=>d.success?'EOD: '+d.checked+' geprüft, '+(d.closed||0)+' geschlossen':(d.error||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">EOD-Check ausführen</button>
        <div id="check-result" style="margin-top:4px"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('settings', 16)}<h3>Datenbank Wartung</h3></div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">SCHEMA MIGRATION</div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Erstellt fehlende Tabellen und fügt neue Spalten hinzu. Sicher jederzeit ausführbar.</p>
          <button onclick="runSetupDB()" style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">🔧 Setup DB ausführen</button>
          <div id="setup-result" style="margin-top:8px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary)"></div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">BEREINIGUNG</div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Löscht alte Snapshots, abgelaufene Sessions und alte Practice Trades.</p>
          <button onclick="if(confirm('DB bereinigen?'))adminAction('/admin/db-cleanup','POST','cleanup-result',d=>(d.results||[]).join('\\n')||'OK',d=>d.success)"
            style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--loss);font-size:13px;cursor:pointer;font-family:var(--font-main)">🗑 DB bereinigen</button>
          <div id="cleanup-result" style="margin-top:8px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary)"></div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SIGNALE LÖSCHEN</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${['test','wait','skipped','practice'].map(t =>
            `<button onclick="if(confirm('${t}-Signale löschen?'))deleteSignals('${t}')"
              style="padding:7px 12px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:var(--font-main)">
              ${t === 'test' ? '🧪 Test' : t === 'wait' ? '⏳ WAIT' : t === 'skipped' ? '⏭ SKIPPED' : '📝 Practice'} löschen
            </button>`
          ).join('')}
        </div>
        <div id="delete-result" style="margin-top:8px;font-size:12px;color:var(--text-secondary)"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('users', 16)}<h3>Aktive Sessions</h3>
      <div class="actions"><span class="badge badge-tag">${sessions.length} aktiv</span></div>
    </div>
    ${sessionRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>User</th><th>Rolle</th><th>Angemeldet</th><th>Läuft ab</th></tr></thead><tbody>${sessionRows}</tbody></table></div>`
      : `<div class="card-body" style="text-align:center;padding:30px;color:var(--text-tertiary);font-size:13px">Keine aktiven Sessions</div>`
    }
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('users', 16)}<h3>Benutzer-Verwaltung</h3>
      <div class="actions">
        <button onclick="showCreateUserModal()"
          style="padding:6px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-main)">
          + Neuer User
        </button>
      </div>
    </div>
    ${userRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Status</th><th>Benutzer</th><th>Rolle</th><th>Zuletzt gesehen</th><th>Aktionen</th></tr></thead><tbody>${userRows}</tbody></table></div>`
      : `<div class="card-body" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine Benutzer</div>`
    }
  </div>

  <!-- Modal overlay -->
  <div id="modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center" onclick="closeModal()">
    <div id="modal-box" style="background:var(--bg-1);border-radius:14px;padding:28px;max-width:440px;width:90%;border:1px solid var(--border)" onclick="event.stopPropagation()">
      <div id="modal-html"></div>
    </div>
  </div>
  <div id="admin-toast" style="display:none;position:fixed;top:64px;right:20px;z-index:9999;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.25)"></div>

</div>
<script>
function adminToast(msg,type='ok'){
  const el=document.getElementById('admin-toast');if(!el)return;
  el.textContent=(type==='ok'?'✅ ':'❌ ')+msg;
  el.style.display='block';el.style.background=type==='ok'?'var(--bg-success)':'var(--bg-error)';
  el.style.border='1px solid '+(type==='ok'?'rgba(16,185,129,.4)':'rgba(239,68,68,.4)');
  el.style.color=type==='ok'?'var(--win)':'var(--loss)';
  setTimeout(()=>el.style.display='none',3000);
}
function showResultBox(elId,text,ok){
  const el=document.getElementById(elId);if(!el)return;
  el.style.marginTop='10px';el.style.padding='10px 14px';el.style.borderRadius='8px';el.style.whiteSpace='pre-wrap';
  el.style.background=ok?'var(--bg-success)':'var(--bg-error)';
  el.style.border='1px solid '+(ok?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)');
  el.style.fontSize='12px';el.style.fontFamily='var(--font-mono)';
  el.style.color=ok?'var(--win)':'var(--loss)';el.textContent=text;
}
async function adminAction(path,method,resultId,textFn,okFn){
  try{const r=await fetch(path,{credentials:'include',method});const d=await r.json();showResultBox(resultId,textFn(d),okFn(d));}
  catch(e){showResultBox(resultId,e.message,false);}
}
async function sendTgSignal(){
  try{const r=await fetch('/admin/telegram/send',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:'🟢 <b>BTCUSDT</b> LONG\n\n⭐⭐⭐ Score: <b>82/100</b>\n📡 Test-Signal aus Admin-Panel'})});
  const d=await r.json();showResultBox('tg-result',d.success?'Test-Signal gesendet ✓':(d.error||'Fehler'),d.success);
  }catch(e){showResultBox('tg-result',e.message,false);}
}
async function sendTgCustom(){
  const msg=document.getElementById('tg-msg')?.value?.trim();if(!msg)return;
  try{const r=await fetch('/admin/telegram/send',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
  const d=await r.json();showResultBox('tg-send-result',d.success?'Nachricht gesendet ✓':(d.error||'Fehler'),d.success);
  }catch(e){showResultBox('tg-send-result',e.message,false);}
}
async function runSetupDB(){
  try{const r=await fetch('/admin/setup-db',{credentials:'include',method:'POST'});const d=await r.json();
  document.getElementById('setup-result').textContent=(d.results||[d.error||'OK']).join('\\n');
  adminToast(d.success?'Setup erfolgreich':'Fehler',d.success?'ok':'err');
  }catch(e){document.getElementById('setup-result').textContent=e.message;}
}
async function deleteSignals(type){
  try{const r=await fetch('/admin/delete-signals',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});
  const d=await r.json();document.getElementById('delete-result').textContent=d.success?(d.deleted??'')+' gelöscht':(d.error||'Fehler');
  if(d.success)adminToast('Gelöscht');
  }catch(e){document.getElementById('delete-result').textContent=e.message;}
}
async function changeRole(userId,role){
  try{const r=await fetch('/admin/users/'+userId+'/role',{credentials:'include',method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});
  const d=await r.json();adminToast(d.success?'Rolle geändert auf '+role:(d.error||'Fehler'),d.success?'ok':'err');
  }catch(e){adminToast(e.message,'err');}
}
async function toggleBlock(userId,block){
  if(!confirm(block?'User sperren?':'User entsperren?'))return;
  try{const r=await fetch('/admin/block-user',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,blocked:block})});
  const d=await r.json();
  if(d.success){adminToast(block?'User gesperrt':'User entsperrt');htmx.ajax('GET','/settings?section=admin',{target:'#settings-section',swap:'innerHTML'});}
  else adminToast(d.error||'Fehler','err');
  }catch(e){adminToast(e.message,'err');}
}
function closeModal(){document.getElementById('modal-overlay').style.display='none';}
function openModal(html){document.getElementById('modal-html').innerHTML=html;document.getElementById('modal-overlay').style.display='flex';}
function showChangePwModal(userId,username){
  openModal(\`<h2 style="margin-bottom:6px">Passwort ändern</h2>
    <p style="color:var(--text-tertiary);font-size:13px;margin-bottom:20px">Für: <strong>\${username}</strong></p>
    <div style="margin-bottom:20px"><label style="display:block;margin-bottom:6px;font-size:13px">Neues Passwort</label>
    <input type="password" id="new-pw" class="input" style="width:100%" placeholder="Mindestens 8 Zeichen" autofocus></div>
    <div style="display:flex;gap:10px">
      <button onclick="doChangePw('\${userId}')" style="flex:1;padding:8px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Ändern</button>
      <button onclick="closeModal()" style="padding:8px 16px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Abbrechen</button>
    </div>\`);
}
async function doChangePw(userId){
  const pw=document.getElementById('new-pw')?.value;
  if(!pw||pw.length<8){alert('Mindestens 8 Zeichen');return;}
  try{const r=await fetch('/admin/change-password',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,newPassword:pw})});
  const d=await r.json();if(d.success){closeModal();adminToast('Passwort geändert');}else adminToast(d.error||'Fehler','err');
  }catch(e){adminToast(e.message,'err');}
}
function showCreateUserModal(){
  openModal(\`<h2 style="margin-bottom:20px">Neuen User anlegen</h2>
    <div id="cu-err" style="display:none;padding:10px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);font-size:13px;color:var(--loss);margin-bottom:14px"></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Benutzername</label>
      <input type="text" id="cu-username" class="input" style="width:100%" placeholder="z.B. peter" autofocus></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Email</label>
      <input type="email" id="cu-email" class="input" style="width:100%" placeholder="peter@example.com"></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Passwort</label>
      <input type="password" id="cu-pw" class="input" style="width:100%" placeholder="Mindestens 8 Zeichen"></div>
    <div style="margin-bottom:20px"><label style="display:block;margin-bottom:6px;font-size:13px">Rolle</label>
      <select id="cu-role" class="input" style="width:100%">
        <option value="viewer">VIEWER</option><option value="trader">TRADER</option><option value="admin">ADMIN</option>
      </select></div>
    <div style="display:flex;gap:10px">
      <button onclick="doCreateUser()" style="flex:1;padding:8px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Erstellen</button>
      <button onclick="closeModal()" style="padding:8px 16px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Abbrechen</button>
    </div>\`);
}
async function doCreateUser(){
  const u=document.getElementById('cu-username')?.value?.trim();
  const e=document.getElementById('cu-email')?.value?.trim();
  const p=document.getElementById('cu-pw')?.value;
  const role=document.getElementById('cu-role')?.value;
  const errEl=document.getElementById('cu-err');
  if(!u||!e||!p){errEl.textContent='Bitte alle Felder ausfüllen';errEl.style.display='block';return;}
  if(p.length<8){errEl.textContent='Passwort muss mindestens 8 Zeichen haben';errEl.style.display='block';return;}
  errEl.style.display='none';
  try{const r=await fetch('/admin/create-user',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,email:e,password:p,role})});
  const d=await r.json();
  if(d.success||d.id){closeModal();adminToast('User erstellt');htmx.ajax('GET','/settings?section=admin',{target:'#settings-section',swap:'innerHTML'});}
  else{errEl.textContent=d.error||'Fehler';errEl.style.display='block';}
  }catch(ex){errEl.textContent=ex.message;errEl.style.display='block';}
}
</script>`;
}

function _renderSettingsSection(section, data, session) {
  const isAdmin = session?.role === 'admin';
  switch (section) {
    case 'account':       return _renderSettingsAccount(session);
    case 'design':        return _renderSettingsDesign();
    case 'trading':       return _renderSettingsTrading();
    case 'notifications': return _renderSettingsNotifications();
    case 'broker':        return _renderSettingsBroker();
    case 'admin':         return isAdmin ? _renderSettingsAdmin(data) : _renderSettingsAccount(session);
    case 'system':        return isAdmin ? _renderSettingsSystem() : _renderSettingsAccount(session);
    default:              return _renderSettingsAccount(session);
  }
}

function _renderSettingsPage(section, data, session) {
  const isAdmin = session?.role === 'admin';
  const nav = _renderSettingsNav(section, isAdmin);
  const sectionHtml = _renderSettingsSection(section, data, session);
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Einstellungen</h2>
    <div class="subtitle">Konfiguration &amp; Verwaltung</div>
  </div>
  <div id="settings-section" style="display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start">
    ${nav}
    <div id="settings-content">${sectionHtml}</div>
  </div>
</div>`;
}

export {
  CSS_STYLES,
  _htmlPage,
  _renderLoginPage,
  _renderChangePwPage,
  _renderDashboardContent,
  _renderPlaceholderPage,
  _renderJournalTable,
  _renderJournalContent,
  _renderNewsList,
  _renderNewsContent,
  _renderBTTabBar,
  _getBTTabContent,
  _renderBacktestContent,
  _renderStatistikenContent,
  _renderSettingsNav,
  _renderSettingsSection,
  _renderSettingsPage,
};
