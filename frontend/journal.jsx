// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.6 - TRADING JOURNAL
// A) Morgenroutine  B) Pre-Trade Checkliste  C) After-Trade Review
// ═══════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────

function sid() { return localStorage.getItem('wavescout_session'); }

function useToast() {
  const [toast, setToast] = React.useState(null);
  const show = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };
  return [toast, show];
}

function Toast({ toast }) {
  if (!toast) return null;
  const isErr = toast.type === 'error';
  return (
    <div style={{
      position: 'fixed', top: 64, right: 20, zIndex: 9999,
      padding: '12px 18px', borderRadius: 10, fontSize: 13, fontWeight: 500,
      background: isErr ? 'var(--bg-error)' : 'var(--bg-success)',
      border: `1px solid ${isErr ? 'rgba(240,68,68,.4)' : 'rgba(16,185,129,.4)'}`,
      color: isErr ? 'var(--loss)' : 'var(--win)',
      boxShadow: '0 4px 16px rgba(0,0,0,.25)', maxWidth: 320, animation: 'fadeIn .2s ease'
    }}>
      {toast.msg}
    </div>
  );
}

function CheckRow({ label, checked, onChange }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}/>
      <span>{label}</span>
    </label>
  );
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Coin Sidebar ─────────────────────────────────────────────

function CoinSidebar({ symbols, selected, statuses, onSelect, onRemove, newSymbol, onNewSymbolChange, onAddSymbol, addingSymbol, date, onDateChange }) {
  const [hovered, setHovered] = useState(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="card">
        <div className="card-body" style={{ padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 6 }}>DATUM</div>
          <input
            type="date"
            value={date}
            onChange={e => onDateChange(e.target.value)}
            className="input"
            style={{ width: '100%', fontSize: 13 }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 10 }}>COINS</div>

          {symbols.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', padding: '12px 0' }}>
              Noch keine Coins
            </div>
          )}

          {symbols.map(s => (
            <div
              key={s}
              onMouseEnter={() => setHovered(s)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
                borderRadius: 7, cursor: 'pointer', marginBottom: 2,
                background: selected === s ? 'rgba(59,130,246,.12)' : hovered === s ? 'var(--bg-2)' : 'transparent',
                transition: 'background .1s',
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: statuses[s] ? 'var(--win)' : 'rgba(240,68,68,.6)',
              }}/>
              <span style={{
                flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                color: selected === s ? 'var(--blue-500)' : 'var(--text-primary)',
              }}>
                {s}
              </span>
              {hovered === s && (
                <button
                  onClick={e => { e.stopPropagation(); onRemove(s); }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '1px 5px', color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1,
                    borderRadius: 4,
                  }}
                  title="Entfernen"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={newSymbol}
                onChange={e => onNewSymbolChange(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && onAddSymbol()}
                placeholder="XRPUSDT"
                className="input"
                style={{ flex: 1, fontSize: 11, padding: '5px 8px' }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={onAddSymbol}
                disabled={addingSymbol || !newSymbol.trim()}
                style={{ padding: '5px 10px', fontSize: 16, lineHeight: 1 }}
              >
                {addingSymbol ? <div className="spinner-sm"/> : '+'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Collapsible Section ──────────────────────────────────────

function CollapsibleSection({ title, icon, defaultOpen, locked, children }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div style={{ marginBottom: 'var(--gap)' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px',
          cursor: 'pointer', userSelect: 'none',
          borderBottom: '1px solid var(--border)',
          marginBottom: open ? 12 : 0,
        }}
      >
        {icon && <Icon name={icon} size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}/>}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {locked && <span style={{ fontSize: 11, marginLeft: 2 }}>🔒</span>}
        <span style={{
          marginLeft: 'auto', fontSize: 14, color: 'var(--text-tertiary)',
          display: 'inline-block', transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform .2s',
        }}>▾</span>
      </div>
      {open && children}
    </div>
  );
}

// ─── Status Banner ────────────────────────────────────────────

function StatusBanner({ symbol, date, routineDone, bias }) {
  const isToday = date === todayDate();
  const biasColor = bias === 'LONG' ? 'var(--win)' : bias === 'SHORT' ? 'var(--loss)' : 'var(--text-secondary)';
  return (
    <div style={{
      padding: '10px 16px', borderRadius: 10,
      background: routineDone ? 'rgba(16,185,129,.08)' : 'rgba(240,68,68,.08)',
      border: `1px solid ${routineDone ? 'rgba(16,185,129,.25)' : 'rgba(240,68,68,.2)'}`,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: routineDone ? 'var(--win)' : 'var(--loss)',
        display: 'inline-block', animation: routineDone ? 'none' : 'pulse 1.5s infinite',
      }}/>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
        {symbol}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {new Date(date + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: routineDone ? 'var(--win)' : 'var(--loss)' }}>
        {routineDone ? 'Routine abgeschlossen' : isToday ? 'Morgenroutine fehlt · Trading gesperrt' : 'Keine Routine für diesen Tag'}
      </span>
      {routineDone && bias && (
        <span style={{ fontSize: 13, color: biasColor, fontWeight: 700 }}>
          · Bias: {bias}
        </span>
      )}
    </div>
  );
}

// ─── Tab A: Morgenroutine ─────────────────────────────────────

function MorgenroutineTab({ symbol, date, onRoutineChange }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [toast, showToast]    = useToast();
  const [form, setForm] = useState({
    bias: '',
    chart_opened: false,
    ema200_checked: false,
    ema_direction: '',
    key_zones_marked: false,
    zone_notes: '',
    bias_reason: '',
  });
  const [saved, setSaved] = useState(null);

  useEffect(() => { load(); }, [date, symbol]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/morning-routine?date=${date}&symbol=${symbol}`, { headers: { 'X-Session-ID': sid() } });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const data = await res.json();
      if (data && data.id) {
        setSaved(data);
        setForm({
          bias:            data.bias || '',
          chart_opened:    !!data.chart_opened,
          ema200_checked:  !!data.ema200_checked,
          ema_direction:   data.ema_direction || '',
          key_zones_marked: !!data.key_zones_marked,
          zone_notes:      data.zone_notes || '',
          bias_reason:     data.bias_reason || '',
        });
        onRoutineChange({ done: !!data.completed_at, bias: data.bias });
      } else {
        setSaved(null);
        setForm({ bias: '', chart_opened: false, ema200_checked: false, ema_direction: '', key_zones_marked: false, zone_notes: '', bias_reason: '' });
        onRoutineChange({ done: false, bias: null });
      }
    } catch {
      setSaved(null);
      onRoutineChange({ done: false, bias: null });
    }
    setLoading(false);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.bias) { showToast('Bitte Bias auswählen', 'error'); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/morning-routine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ date, symbol, ...form })
      });
      if (res.ok) {
        showToast('Morgenroutine gespeichert', 'success');
        load();
      } else {
        showToast('Fehler beim Speichern', 'error');
      }
    } catch { showToast('Fehler beim Speichern', 'error'); }
    setSaving(false);
  };

  const isDone   = saved?.completed_at != null;
  const checks   = [form.chart_opened, form.ema200_checked, !!form.ema_direction, form.key_zones_marked].filter(Boolean).length;
  const totalChk = 4;
  const pct      = Math.round((checks / totalChk) * 100);
  const pcColor  = pct === 100 ? 'var(--win)' : pct >= 50 ? 'var(--wait)' : 'var(--loss)';

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner-lg"/></div>;

  return (
    <>
      <Toast toast={toast}/>

      <div className="card">
        <div className="card-head">
          <Icon name="calendar" className="ico"/>
          <h3>Morgenroutine · {symbol}</h3>
          <div className="actions">
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: pcColor, fontSize: 13 }}>
              {checks}/{totalChk} ({pct}%)
            </span>
          </div>
        </div>
        <div className="card-body">
          {/* Progress bar */}
          <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pcColor, borderRadius: 4, transition: 'width 0.3s' }}/>
          </div>

          {/* Schritt 1 */}
          <div className="checklist-group">
            <div className="checklist-group-title">Schritt 1 · Chart &amp; EMA 200 (4H)</div>
            <CheckRow label="Chart geöffnet &amp; bereit" checked={form.chart_opened} onChange={v => set('chart_opened', v)}/>
            <CheckRow label="EMA 200 auf 4H geprüft" checked={form.ema200_checked} onChange={v => set('ema200_checked', v)}/>
            <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>EMA-Richtung:</span>
              <select value={form.ema_direction} onChange={e => set('ema_direction', e.target.value)} className="input" style={{ width: 'auto', minWidth: 180 }}>
                <option value="">-- wählen --</option>
                <option value="above">Preis über EMA (bullish)</option>
                <option value="below">Preis unter EMA (bearish)</option>
                <option value="flat">EMA flach / Seitwärts</option>
              </select>
            </div>
          </div>

          {/* Schritt 2 */}
          <div className="checklist-group">
            <div className="checklist-group-title">Schritt 2 · Key-Zonen (15min)</div>
            <CheckRow label="1–2 Key-Zonen auf 15min markiert" checked={form.key_zones_marked} onChange={v => set('key_zones_marked', v)}/>
            <textarea
              value={form.zone_notes}
              onChange={e => set('zone_notes', e.target.value)}
              placeholder={`Zonen notieren: z.B. ${symbol}: Support bei 42.500, Resistance bei 44.200`}
              className="input"
              rows={2}
              style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
            />
          </div>

          {/* Tages-Bias */}
          <div className="checklist-group">
            <div className="checklist-group-title">Tages-Bias</div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              {['LONG', 'SHORT', 'KEIN_TRADE'].map(b => (
                <button
                  key={b}
                  className={`btn ${form.bias === b ? (b === 'LONG' ? 'btn-primary' : b === 'SHORT' ? 'btn-danger' : 'btn-ghost active') : 'btn-ghost'}`}
                  style={{ fontWeight: 700 }}
                  onClick={() => set('bias', b)}
                >
                  {b === 'LONG' ? '▲ LONG' : b === 'SHORT' ? '▼ SHORT' : '— KEIN TRADE'}
                </button>
              ))}
            </div>
            <textarea
              value={form.bias_reason}
              onChange={e => set('bias_reason', e.target.value)}
              placeholder="Begründung: Warum dieser Bias? (EMA-Lage, Struktur, News...)"
              className="input"
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <div className="spinner-sm"/> : <Icon name="save" size={14}/>}
            {isDone ? 'Routine aktualisieren' : 'Routine abschließen'}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Tab B: Pre-Trade Checkliste ──────────────────────────────

const EMPTY_PRE = {
  signal_id: '',
  bias_match: false,
  in_key_zone: false,
  structure_confirmed: false,
  no_chop: false,
  trend_candle: false,
  break_confirmed: false,
  rsi_ok: false,
  rsi_not_extreme: false,
  sl_logical: false,
  rr_ok: false,
  can_explain: false,
  notes: '',
};

function PreTradeTab({ symbol, date, routineDone }) {
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [checklists, setChecklists] = useState([]);
  const [locked, setLocked]     = useState(false);
  const [lockReason, setLockReason] = useState('');
  const [showNew, setShowNew]   = useState(false);
  const [form, setForm]         = useState({ ...EMPTY_PRE });
  const [toast, showToast]      = useToast();

  useEffect(() => { load(); }, [date, symbol]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/pre-trade-checklist?date=${date}&symbol=${symbol}`, { headers: { 'X-Session-ID': sid() } });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const data = await res.json();
      if (data && data.locked) {
        setLocked(true);
        setLockReason(data.reason || `Bitte zuerst die Morgenroutine für ${symbol} abschließen.`);
        setChecklists([]);
      } else {
        setLocked(false);
        setLockReason('');
        setChecklists(Array.isArray(data) ? data : []);
      }
    } catch { setChecklists([]); }
    setLoading(false);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/pre-trade-checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ date, symbol, ...form })
      });
      if (res.ok) {
        showToast('Checkliste gespeichert', 'success');
        setForm({ ...EMPTY_PRE });
        setShowNew(false);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Fehler beim Speichern', 'error');
      }
    } catch { showToast('Fehler beim Speichern', 'error'); }
    setSaving(false);
  };

  const PRE_CHECKS = [
    ['bias_match',          'Passt zum Tages-Bias'],
    ['in_key_zone',         'Preis in markierter Key-Zone'],
    ['structure_confirmed', 'Marktstruktur bestätigt (HL/LH)'],
    ['no_chop',             'Kein Chop / kein Seitwärtsmarkt'],
    ['trend_candle',        'Klare Trendkerze sichtbar'],
    ['break_confirmed',     'Bruch des lokalen High/Low bestätigt'],
    ['rsi_ok',              'RSI-Filter erfüllt (>40 / <60)'],
    ['rsi_not_extreme',     'RSI nicht extrem (<70 und >30)'],
    ['sl_logical',          'SL logisch unter/über Struktur'],
    ['rr_ok',               'Risk-Reward ≥ 1:1.5'],
    ['can_explain',         'Könnte ich diesen Trade erklären?'],
  ];

  const completedCount = PRE_CHECKS.filter(([k]) => form[k]).length;
  const pct = Math.round((completedCount / PRE_CHECKS.length) * 100);
  const pcColor = pct >= 80 ? 'var(--win)' : pct >= 55 ? 'var(--wait)' : 'var(--loss)';

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner-lg"/></div>;

  // Locked state
  if (locked) {
    return (
      <div className="card">
        <div className="card-body" style={{ padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 14 }}>🔒</div>
          <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Pre-Trade Checkliste gesperrt</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{lockReason}</p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 8 }}>
            Schließe zuerst die <strong>Morgenroutine</strong> für <strong>{symbol}</strong> oben ab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Toast toast={toast}/>

      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{checklists.length} Einträge für {symbol}</span>
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowNew(s => !s)}>
              <Icon name="plus" size={13}/> {showNew ? 'Schließen' : 'Neue Checkliste'}
            </button>
          </div>
        </div>
      </div>

      {showNew && (
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-head">
            <Icon name="checklist" className="ico"/>
            <h3>Pre-Trade Checkliste · {symbol}</h3>
            <div className="actions">
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: pcColor, fontSize: 13 }}>
                {completedCount}/{PRE_CHECKS.length} ({pct}%)
              </span>
            </div>
          </div>
          <div className="card-body">
            <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden', marginBottom: 18 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: pcColor, borderRadius: 4, transition: 'width 0.3s' }}/>
            </div>

            <div className="checklist-group">
              <div className="checklist-group-title">Signal-Referenz (optional)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Signal-ID:</span>
                <input type="text" value={form.signal_id} onChange={e => set('signal_id', e.target.value)} placeholder="z.B. abc123" className="input" style={{ width: 200 }}/>
              </div>
            </div>

            <div className="checklist-group">
              <div className="checklist-group-title">Marktstruktur &amp; Bias</div>
              {PRE_CHECKS.slice(0, 4).map(([k, label]) => (
                <CheckRow key={k} label={label} checked={form[k]} onChange={v => set(k, v)}/>
              ))}
            </div>

            <div className="checklist-group">
              <div className="checklist-group-title">Entry-Bestätigung</div>
              {PRE_CHECKS.slice(4, 8).map(([k, label]) => (
                <CheckRow key={k} label={label} checked={form[k]} onChange={v => set(k, v)}/>
              ))}
            </div>

            <div className="checklist-group">
              <div className="checklist-group-title">Risk &amp; Final Check</div>
              {PRE_CHECKS.slice(8).map(([k, label]) => (
                <CheckRow key={k} label={label} checked={form[k]} onChange={v => set(k, v)}/>
              ))}
            </div>

            <div className="checklist-group">
              <div className="checklist-group-title">Notizen</div>
              <textarea
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
                placeholder="Zusätzliche Gedanken zum Trade..."
                className="input"
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? <div className="spinner-sm"/> : <Icon name="save" size={14}/>}
                Speichern
              </button>
              <button className="btn btn-ghost" onClick={() => { setShowNew(false); setForm({ ...EMPTY_PRE }); }}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}

      {checklists.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="checklist" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>Für {symbol} wurden heute noch keine Pre-Trade Checklisten dokumentiert</p>
          </div>
        </div>
      ) : (
        checklists.map((c, i) => {
          const done = ['bias_match','in_key_zone','structure_confirmed','no_chop','trend_candle','break_confirmed','rsi_ok','rsi_not_extreme','sl_logical','rr_ok','can_explain'].filter(k => c[k]).length;
          return (
            <div className="card" key={c.id || i} style={{ marginBottom: 'var(--gap)' }}>
              <div className="card-head">
                <Icon name="checklist" className="ico"/>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(c.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                </span>
                {c.signal_id && (
                  <span className="badge badge-tag" style={{ marginLeft: 8 }}>SIG: {c.signal_id.slice(0, 8)}</span>
                )}
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: done >= 9 ? 'var(--win)' : done >= 6 ? 'var(--wait)' : 'var(--loss)' }}>
                  {done}/11
                </span>
              </div>
              {c.notes && (
                <div className="card-body" style={{ paddingTop: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{c.notes}</div>
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

// ─── Tab C: After-Trade Review ────────────────────────────────

const EMPTY_REVIEW = {
  signal_id: '',
  direction: '',
  entry_price: '',
  sl_price: '',
  tp_price: '',
  exit_price: '',
  outcome: '',
  followed_plan: false,
  no_fomo: false,
  waited_confirmation: false,
  respected_sl: false,
  no_revenge: false,
  respected_tp: false,
  felt_confident: false,
  trade_emotion: '',
  mistakes: '',
  lessons: '',
  would_retake: false,
};

function AfterTradeTab({ symbol, date }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [reviews, setReviews] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm]       = useState({ ...EMPTY_REVIEW });
  const [toast, showToast]    = useToast();

  useEffect(() => { load(); }, [date, symbol]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/trade-review?date=${date}&symbol=${symbol}`, { headers: { 'X-Session-ID': sid() } });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const data = await res.json();
      setReviews(Array.isArray(data) ? data : []);
    } catch { setReviews([]); }
    setLoading(false);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.direction || !form.outcome) {
      showToast('Richtung und Ergebnis sind Pflichtfelder', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/trade-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({
          date,
          symbol,
          instrument: symbol,
          ...form,
          entry_price: parseFloat(form.entry_price) || null,
          sl_price:    parseFloat(form.sl_price)    || null,
          tp_price:    parseFloat(form.tp_price)    || null,
          exit_price:  parseFloat(form.exit_price)  || null,
        })
      });
      if (res.ok) {
        showToast('Review gespeichert', 'success');
        setForm({ ...EMPTY_REVIEW });
        setShowNew(false);
        load();
      } else {
        showToast('Fehler beim Speichern', 'error');
      }
    } catch { showToast('Fehler beim Speichern', 'error'); }
    setSaving(false);
  };

  const DISCIPLINE = [
    ['followed_plan',        'Plan eingehalten'],
    ['no_fomo',              'Kein FOMO-Entry'],
    ['waited_confirmation',  'Auf Bestätigung gewartet'],
    ['respected_sl',         'Stop-Loss respektiert'],
    ['no_revenge',           'Kein Revenge-Trading'],
    ['respected_tp',         'Take-Profit respektiert'],
    ['felt_confident',       'Sicher &amp; klar beim Entry'],
    ['would_retake',         'Würde den Trade wieder nehmen'],
  ];

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner-lg"/></div>;

  return (
    <>
      <Toast toast={toast}/>

      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{reviews.length} Reviews für {symbol}</span>
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowNew(s => !s)}>
              <Icon name="plus" size={13}/> {showNew ? 'Schließen' : 'Neues Review'}
            </button>
          </div>
        </div>
      </div>

      {showNew && (
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-head">
            <Icon name="book" className="ico"/>
            <h3>After-Trade Review · {symbol}</h3>
          </div>
          <div className="card-body">

            {/* Trade-Daten */}
            <div className="checklist-group">
              <div className="checklist-group-title">Trade-Daten · {symbol}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Richtung *</div>
                  <select value={form.direction} onChange={e => set('direction', e.target.value)} className="input" style={{ width: '100%' }}>
                    <option value="">-- wählen --</option>
                    <option value="LONG">LONG</option>
                    <option value="SHORT">SHORT</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Entry</div>
                  <input type="number" step="any" value={form.entry_price} onChange={e => set('entry_price', e.target.value)} placeholder="0.00" className="input" style={{ width: '100%' }}/>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Stop Loss</div>
                  <input type="number" step="any" value={form.sl_price} onChange={e => set('sl_price', e.target.value)} placeholder="0.00" className="input" style={{ width: '100%' }}/>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Take Profit</div>
                  <input type="number" step="any" value={form.tp_price} onChange={e => set('tp_price', e.target.value)} placeholder="0.00" className="input" style={{ width: '100%' }}/>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Exit-Preis</div>
                  <input type="number" step="any" value={form.exit_price} onChange={e => set('exit_price', e.target.value)} placeholder="0.00" className="input" style={{ width: '100%' }}/>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Ergebnis *</span>
                <div className="outcome-bar">
                  {['WIN','LOSS','BE','OPEN'].map(o => (
                    <button key={o} className={`outcome-btn ${form.outcome === o ? (o === 'WIN' ? 'active-win' : o === 'LOSS' ? 'active-loss' : o === 'BE' ? 'active-be' : 'active-open') : ''}`} onClick={() => set('outcome', o)}>
                      {o === 'BE' ? 'B/E' : o}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Disziplin */}
            <div className="checklist-group">
              <div className="checklist-group-title">Disziplin &amp; Psychologie</div>
              {DISCIPLINE.map(([k, label]) => (
                <CheckRow key={k} label={label} checked={form[k]} onChange={v => set(k, v)}/>
              ))}

              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Gefühl beim Trade:</span>
                <select value={form.trade_emotion} onChange={e => set('trade_emotion', e.target.value)} className="input" style={{ width: 'auto', minWidth: 180 }}>
                  <option value="">-- wählen --</option>
                  <option value="calm">Ruhig &amp; fokussiert</option>
                  <option value="nervous">Nervös</option>
                  <option value="greedy">Gierig</option>
                  <option value="fearful">Ängstlich</option>
                  <option value="frustrated">Frustriert</option>
                  <option value="confident">Selbstsicher</option>
                </select>
              </div>
            </div>

            {/* Auswertung */}
            <div className="checklist-group">
              <div className="checklist-group-title">Auswertung</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Was lief nicht gut / Fehler:</div>
                <textarea value={form.mistakes} onChange={e => set('mistakes', e.target.value)} placeholder="Was hätte ich besser machen können?" className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}/>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Lernpunkte / Lessons:</div>
                <textarea value={form.lessons} onChange={e => set('lessons', e.target.value)} placeholder="Was nehme ich aus diesem Trade mit?" className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}/>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? <div className="spinner-sm"/> : <Icon name="save" size={14}/>}
                Review speichern
              </button>
              <button className="btn btn-ghost" onClick={() => { setShowNew(false); setForm({ ...EMPTY_REVIEW }); }}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="book" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>Für {symbol} wurden heute noch keine Trades dokumentiert</p>
          </div>
        </div>
      ) : (
        reviews.map((r, i) => {
          const disc = ['followed_plan','no_fomo','waited_confirmation','respected_sl','no_revenge','respected_tp','felt_confident'].filter(k => r[k]).length;
          return (
            <div className="card" key={r.id || i} style={{ marginBottom: 'var(--gap)' }}>
              <div className="card-head">
                <Icon name="book" className="ico"/>
                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.instrument || symbol}</span>
                {r.direction && (
                  <span className={`badge ${r.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{r.direction}</span>
                )}
                {r.outcome && (
                  <span className={`badge ${r.outcome === 'WIN' ? 'badge-win' : r.outcome === 'LOSS' ? 'badge-loss' : 'badge-wait'}`}>
                    {r.outcome === 'BE' ? 'B/E' : r.outcome}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(r.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
                  {r.entry_price && <span>Entry: <strong className="mono">${r.entry_price}</strong></span>}
                  {r.sl_price    && <span>SL: <strong className="mono loss">${r.sl_price}</strong></span>}
                  {r.tp_price    && <span>TP: <strong className="mono win">${r.tp_price}</strong></span>}
                  {r.exit_price  && <span>Exit: <strong className="mono">${r.exit_price}</strong></span>}
                  <span>Disziplin: <strong style={{ color: disc >= 6 ? 'var(--win)' : disc >= 4 ? 'var(--wait)' : 'var(--loss)' }}>{disc}/7</strong></span>
                  {r.trade_emotion && <span>Gefühl: <strong>{r.trade_emotion}</strong></span>}
                </div>
                {r.lessons && (
                  <div style={{ padding: '8px 12px', background: 'var(--bg-0)', borderRadius: 8, borderLeft: '3px solid var(--border)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                    {r.lessons}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────

const JournalPage = ({ user }) => {
  const [symbols, setSymbols]           = useState([]);
  const [symbol, setSymbol]             = useState(() => localStorage.getItem('journal_symbol') || null);
  const [date, setDate]                 = useState(todayDate());
  const [routineStatus, setRoutineStatus] = useState({ done: false, bias: null });
  const [symbolStatuses, setSymbolStatuses] = useState({});
  const [loadingSymbols, setLoadingSymbols] = useState(true);
  const [newSymbol, setNewSymbol]       = useState('');
  const [addingSymbol, setAddingSymbol] = useState(false);

  useEffect(() => { loadSymbols(); }, []);

  useEffect(() => {
    if (symbols.length > 0) loadStatuses();
  }, [date, symbols]);

  const loadSymbols = async () => {
    setLoadingSymbols(true);
    try {
      const res = await fetch(`${API_URL}/journal/symbols`, { headers: { 'X-Session-ID': sid() } });
      if (res.status === 401) { localStorage.removeItem('wavescout_session'); window.location.href = 'login.html'; return; }
      const data = await res.json();
      const list = data.symbols || [];
      setSymbols(list);
      if (list.length > 0) {
        const stored = localStorage.getItem('journal_symbol');
        const pick = list.includes(stored) ? stored : list[0];
        setSymbol(pick);
        localStorage.setItem('journal_symbol', pick);
      }
    } catch {}
    setLoadingSymbols(false);
  };

  const loadStatuses = async () => {
    try {
      const res = await fetch(`${API_URL}/morning-routine/status?date=${date}`, { headers: { 'X-Session-ID': sid() } });
      if (res.ok) setSymbolStatuses(await res.json());
    } catch {}
  };

  const changeSymbol = (s) => {
    localStorage.setItem('journal_symbol', s);
    setSymbol(s);
    setRoutineStatus({ done: false, bias: null });
  };

  const handleRoutineChange = (status) => {
    setRoutineStatus(status);
    if (status.done) setSymbolStatuses(prev => ({ ...prev, [symbol]: true }));
  };

  const removeSymbol = async (s) => {
    try {
      const res = await fetch(`${API_URL}/journal/symbols`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ action: 'remove', symbol: s })
      });
      if (res.ok) {
        const data = await res.json();
        setSymbols(data.symbols);
        if (symbol === s) {
          const next = data.symbols[0] || null;
          setSymbol(next);
          if (next) localStorage.setItem('journal_symbol', next);
        }
      }
    } catch {}
  };

  const addSymbol = async () => {
    const sym = newSymbol.toUpperCase().trim();
    if (!sym) return;
    setAddingSymbol(true);
    try {
      const res = await fetch(`${API_URL}/journal/symbols`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sid() },
        body: JSON.stringify({ symbol: sym })
      });
      if (res.ok) {
        const data = await res.json();
        setSymbols(data.symbols);
        setNewSymbol('');
        if (!symbol) changeSymbol(sym);
      }
    } catch {}
    setAddingSymbol(false);
  };

  if (loadingSymbols) {
    return (
      <div className="content page-enter" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div className="spinner-lg"/>
      </div>
    );
  }

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Trading Journal</h2>
        <p className="subtitle">Morgenroutine · Pre-Trade Checkliste · After-Trade Review</p>
      </div>

      <div style={{ display: 'flex', gap: 'var(--gap)', alignItems: 'flex-start' }}>

        {/* ── Coin Sidebar ──────────────────────────────────── */}
        <div style={{ width: 200, flexShrink: 0 }}>
          <CoinSidebar
            symbols={symbols}
            selected={symbol}
            statuses={symbolStatuses}
            date={date}
            onSelect={changeSymbol}
            onRemove={removeSymbol}
            newSymbol={newSymbol}
            onNewSymbolChange={setNewSymbol}
            onAddSymbol={addSymbol}
            addingSymbol={addingSymbol}
            onDateChange={setDate}
          />
        </div>

        {/* ── Main Content ──────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!symbol ? (
            <div className="card">
              <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
                <Icon name="book" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
                <p style={{ color: 'var(--text-tertiary)' }}>
                  Kein Coin ausgewählt. Füge einen Coin in der Sidebar hinzu.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Status Banner */}
              <div className="card" style={{ marginBottom: 'var(--gap)' }}>
                <div className="card-body" style={{ padding: '12px 20px' }}>
                  <StatusBanner symbol={symbol} date={date} routineDone={routineStatus.done} bias={routineStatus.bias}/>
                </div>
              </div>

              {/* Section A: Morgenroutine */}
              <CollapsibleSection title="Morgenroutine" icon="calendar" defaultOpen={true}>
                <MorgenroutineTab symbol={symbol} date={date} onRoutineChange={handleRoutineChange}/>
              </CollapsibleSection>

              {/* Section B: Pre-Trade Checkliste */}
              <CollapsibleSection title="Pre-Trade Checkliste" icon="checklist" defaultOpen={false} locked={!routineStatus.done}>
                <PreTradeTab symbol={symbol} date={date} routineDone={routineStatus.done}/>
              </CollapsibleSection>

              {/* Section C: After-Trade Review */}
              <CollapsibleSection title="After-Trade Review" icon="book" defaultOpen={false}>
                <AfterTradeTab symbol={symbol} date={date}/>
              </CollapsibleSection>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

window.JournalPage = JournalPage;
