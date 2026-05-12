// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.6 - NEWS / MARKET RADAR PAGE
// ═══════════════════════════════════════════════════════════════

const SCOPE_LABELS = {
  MACRO:         { label: 'Makro',       color: 'var(--wait)' },
  REGULATION:    { label: 'Regulierung', color: '#a78bfa' },
  EXCHANGE:      { label: 'Exchange',    color: 'var(--blue-400)' },
  COIN_SPECIFIC: { label: 'Coin',        color: 'var(--win)' },
  GLOBAL:        { label: 'Global',      color: 'var(--text-secondary)' },
};

const IMPACT_COLORS = {
  HIGH:    'var(--loss)',
  MEDIUM:  'var(--wait)',
  LOW:     'var(--text-tertiary)',
};

const NEWS_FILTERS = [
  { id: 'all',    label: 'Alle' },
  { id: 'HIGH',   label: 'High Impact' },
  { id: 'MACRO',  label: 'Makro' },
  { id: 'REGULATION', label: 'Regulierung' },
  { id: 'EXCHANGE',   label: 'Exchanges' },
  { id: 'BTC',    label: 'BTC' },
  { id: 'ETH',    label: 'ETH' },
  { id: 'SOL',    label: 'SOL' },
  { id: 'today',  label: 'Heute' },
];

function NewsDetailModal({ event, onClose, isAdmin }) {
  if (!event) return null;
  const affected = (() => { try { return JSON.parse(event.affected_markets || event.affected_symbols || '[]'); } catch { return []; } })();
  const syms = (() => { try { return JSON.parse(event.affected_symbols || '[]'); } catch { return []; } })();
  const scope = SCOPE_LABELS[event.affected_scope] || SCOPE_LABELS.GLOBAL;
  const impactColor = IMPACT_COLORS[event.impact] || IMPACT_COLORS.LOW;
  const eventDate = event.event_time ? new Date(event.event_time) : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-1)', borderRadius: 16, maxWidth: 680, width: '100%', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 24px 56px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, lineHeight: 1.4, flex: 1 }}>{event.title}</h3>
            <button onClick={onClose} style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 16, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {event.impact && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: 'var(--bg-0)', border: `1px solid ${impactColor}`, color: impactColor }}>{event.impact} IMPACT</span>}
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: 'var(--bg-0)', border: '1px solid var(--border)', color: scope.color }}>{scope.label}</span>
            {event.category && <span className="badge badge-tag">{event.category}</span>}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px' }}>

          {/* Meta row */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
            {eventDate && <span>🕒 {eventDate.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
            {event.source && <span>📡 {event.source}</span>}
          </div>

          {/* Affected coins */}
          {syms.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 8 }}>BETROFFENE COINS</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {syms.map(s => <span key={s} className="badge badge-tag" style={{ fontSize: 12 }}>{s}</span>)}
              </div>
            </div>
          )}

          {/* Affected markets */}
          {affected.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 8 }}>BETROFFENE MÄRKTE</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {affected.map(m => <span key={m} className="badge badge-tag" style={{ fontSize: 12 }}>{m}</span>)}
              </div>
            </div>
          )}

          {/* Summary */}
          {event.summary && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 8 }}>ZUSAMMENFASSUNG</div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{event.summary}</p>
            </div>
          )}

          {/* Long text */}
          {event.long_text && event.long_text !== event.summary && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 8 }}>VOLLTEXT</div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>{event.long_text}</p>
            </div>
          )}

          {/* Source link */}
          {event.source_url && (
            <a
              href={event.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--blue-400)', fontWeight: 500, textDecoration: 'none', padding: '8px 14px', background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }}
            >
              <Icon name="external" size={13}/> Zur Quelle
            </a>
          )}

          {/* Admin raw info */}
          {isAdmin && event.radar_status && (
            <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--bg-0)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '.08em', marginBottom: 6 }}>ADMIN INFO</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                Radar-Status: {event.radar_status} · ID: {event.id} · Updated: {event.updated_at ? new Date(event.updated_at).toLocaleString('de-DE') : '–'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewsCard({ event, onClick }) {
  const affected = (() => { try { return JSON.parse(event.affected_symbols || event.affected_markets || '[]'); } catch { return []; } })();
  const scope = SCOPE_LABELS[event.affected_scope] || SCOPE_LABELS.GLOBAL;
  const impactColor = IMPACT_COLORS[event.impact] || IMPACT_COLORS.LOW;
  const eventDate = event.event_time ? new Date(event.event_time) : null;
  const ageMs = Date.now() - (event.event_time || 0);
  const ageH = Math.floor(ageMs / 3600000);
  const ageStr = ageH < 1 ? 'gerade eben' : ageH < 24 ? `vor ${ageH}h` : `vor ${Math.floor(ageH / 24)}d`;

  return (
    <div
      onClick={onClick}
      style={{
        padding: '16px 20px', borderRadius: 12, cursor: 'pointer',
        background: 'var(--bg-2)', border: '1px solid var(--border)',
        transition: 'border-color .15s, background .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--blue-500)'; e.currentTarget.style.background = 'var(--bg-3)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-2)'; }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {event.impact === 'HIGH' && (
          <div style={{ width: 3, borderRadius: 2, background: 'var(--loss)', alignSelf: 'stretch', flexShrink: 0 }}/>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: scope.color }}>{scope.label}</span>
            {event.impact && <span style={{ fontSize: 11, color: impactColor, fontWeight: 600 }}>{event.impact}</span>}
            {affected.filter(s => s !== 'ALL').map(s => <span key={s} className="badge badge-tag" style={{ fontSize: 10 }}>{s}</span>)}
            <span style={{ fontSize: 11, color: 'var(--text-quaternary)', marginLeft: 'auto' }}>{ageStr}</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6, lineHeight: 1.4 }}>{event.title}</div>
          {event.summary && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{event.summary}</div>}
        </div>
      </div>
    </div>
  );
}

const NewsPage = ({ user }) => {
  const [events,   setEvents]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [detail,   setDetail]   = useState(null);
  const [filter,   setFilter]   = useState('all');
  const [lastUpdate, setLastUpdate] = useState(null);
  const sessionId = localStorage.getItem('wavescout_session');
  const isAdmin = user?.role === 'admin';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/market-radar`, { headers: { 'X-Session-ID': sessionId } });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const data = res.ok ? await res.json() : {};
      setEvents(data.events || []);
      setLastUpdate(data.updatedAt || null);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const today = new Date().toDateString();
  const filtered = events.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'HIGH') return e.impact === 'HIGH';
    if (filter === 'today') return new Date(e.event_time || 0).toDateString() === today;
    if (['MACRO','REGULATION','EXCHANGE'].includes(filter)) return e.affected_scope === filter;
    // coin filter
    const syms = (() => { try { return JSON.parse(e.affected_symbols || '[]'); } catch { return []; } })();
    return syms.includes(filter);
  });

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>News &amp; Market Radar</h2>
        <p className="subtitle">Krypto-Marktnews · BTC/ETH/SOL · Makro-Events · Regulierung</p>
      </div>

      {detail && <NewsDetailModal event={detail} onClose={() => setDetail(null)} isAdmin={isAdmin}/>}

      {/* Header bar */}
      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              {lastUpdate ? `Aktualisiert: ${new Date(lastUpdate).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}` : ''}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading} style={{ marginLeft: 'auto' }}>
              <Icon name="refresh" size={13}/> {loading ? 'Lade…' : 'Aktualisieren'}
            </button>
          </div>
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {NEWS_FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '6px 14px', borderRadius: 20, border: `1px solid ${filter === f.id ? 'var(--blue-500)' : 'var(--border)'}`,
            background: filter === f.id ? 'rgba(59,130,246,.12)' : 'var(--bg-2)',
            color: filter === f.id ? 'var(--blue-400)' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: filter === f.id ? 700 : 400, cursor: 'pointer', fontFamily: 'var(--font-main)',
            transition: 'all .15s'
          }}>{f.label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)', alignSelf: 'center' }}>{filtered.length} Events</span>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/><p style={{ color: 'var(--text-tertiary)' }}>Lade News…</p></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="bell" size={40} style={{ opacity: 0.12, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>{events.length === 0 ? 'Keine News verfügbar — RSS-Feeds werden geladen.' : 'Keine Events für diesen Filter'}</p>
            {events.length === 0 && <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={load}>Erneut laden</button>}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((e, i) => (
            <NewsCard key={e.id || i} event={e} onClick={() => setDetail(e)}/>
          ))}
        </div>
      )}
    </div>
  );
};

window.NewsPage = NewsPage;
