// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - JOURNAL MIT STRATEGIE-CHECKLISTE
// ═══════════════════════════════════════════════════════════════

const EMPTY_CHECKLIST = {
  ema200Checked: false, biasSet: '', keyZonesMarked: false,
  inKeyZone: false, higherLowLowerHigh: false, noChop: false,
  clearTrendCandle: false, breakoutConfirmed: false, rsiFilter: false,
  rsiNotExtreme: false, slPlaced: false, tpRatio: '', tradeWorthIt: false,
  matchesBias: false, canExplain: false, clearMinded: false,
  tradeExecuted: false, outcome: '', notes: ''
};

const JournalPage = ({ user }) => {
  const [loading, setLoading]         = useState(true);
  const [date, setDate]               = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries]         = useState([]);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showNotes, setShowNotes]     = useState(false);
  const [checklist, setChecklist]     = useState({ ...EMPTY_CHECKLIST });

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    loadEntries(sessionId, date);

    const pendingSignal = localStorage.getItem('signal_for_journal');
    if (pendingSignal) {
      try {
        const sig = JSON.parse(pendingSignal);
        localStorage.removeItem('signal_for_journal');
        setChecklist(prev => ({
          ...prev,
          biasSet: sig.direction === 'LONG' ? 'LONG' : sig.direction === 'SHORT' ? 'SHORT' : '',
          notes: `Signal: ${sig.symbol} ${sig.direction} · Score: ${sig.ai_score ?? '?'}/100 · Entry: $${(sig.ai_entry ?? sig.price ?? 0).toFixed(2)} · TP: $${(sig.ai_tp ?? 0).toFixed(2)} · SL: $${(sig.ai_sl ?? 0).toFixed(2)}\n${sig.ai_reason ?? ''}`.trim()
        }));
        setShowChecklist(true);
      } catch (_) {}
    }
  }, [date]);

  const loadEntries = async (sessionId, selectedDate) => {
    try {
      const sid = sessionId || localStorage.getItem('wavescout_session');
      const res = await fetch(`${API_URL}/checklist?date=${selectedDate}`, {
        headers: { 'X-Session-ID': sid }
      });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const data = await res.json();
      setEntries(
        (data || [])
          .filter(item => item.type === 'journal' || item.type === 'strategy')
          .map(item => ({
            ...item,
            data: typeof item.data === 'string' ? JSON.parse(item.data) : item.data
          }))
      );
      setLoading(false);
    } catch (err) {
      console.error('Error loading entries:', err);
      setLoading(false);
    }
  };

  const refresh = useCallback(() => {
    loadEntries(localStorage.getItem('wavescout_session'), date);
  }, [date]);

  const saveStrategyChecklist = async () => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      const res = await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ date, type: 'strategy', checklistData: { ...checklist, timestamp: Date.now() } })
      });
      if (res.ok) {
        setShowChecklist(false);
        setChecklist({ ...EMPTY_CHECKLIST });
        refresh();
      }
    } catch (err) {
      console.error('Error saving checklist:', err);
    }
  };

  const saveNotes = async (noteText) => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      const res = await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ date, type: 'journal', checklistData: { text: noteText, timestamp: Date.now() } })
      });
      if (res.ok) { setShowNotes(false); refresh(); }
    } catch (err) {
      console.error('Error saving notes:', err);
    }
  };

  const completedChecks = [
    checklist.ema200Checked, checklist.keyZonesMarked, checklist.inKeyZone,
    checklist.higherLowLowerHigh, checklist.noChop, checklist.clearTrendCandle,
    checklist.breakoutConfirmed, checklist.rsiFilter, checklist.rsiNotExtreme,
    checklist.slPlaced, checklist.tradeWorthIt, checklist.matchesBias,
    checklist.canExplain, checklist.clearMinded
  ].filter(Boolean).length;

  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('de-DE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Trading Journal</h2>
        <p className="subtitle">{dateLabel} · {entries.length} Einträge</p>
      </div>

      {/* Date Picker & Actions */}
      <div className="card">
        <div className="card-body">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="date"
              value={date}
              onChange={(e) => { setDate(e.target.value); setLoading(true); }}
              className="input"
              style={{ maxWidth: 180 }}
            />
            <button className="btn btn-primary" onClick={() => setShowChecklist(true)}>
              <Icon name="checklist" size={14}/> Strategie-Checkliste
            </button>
            <button className="btn" onClick={() => setShowNotes(true)}>
              <Icon name="plus" size={14}/> Notiz
            </button>
          </div>
        </div>
      </div>

      {/* New checklist form */}
      {showChecklist && (
        <StrategyChecklistForm
          checklist={checklist}
          setChecklist={setChecklist}
          completedChecks={completedChecks}
          totalChecks={14}
          onSave={saveStrategyChecklist}
          onCancel={() => { setShowChecklist(false); setChecklist({ ...EMPTY_CHECKLIST }); }}
        />
      )}

      {/* New note form */}
      {showNotes && (
        <NoteModal onSave={saveNotes} onCancel={() => setShowNotes(false)}/>
      )}

      {/* Entries */}
      {entries.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <Icon name="book" size={40} style={{ opacity: 0.15, marginBottom: 14 }}/>
            <p style={{ color: 'var(--text-tertiary)' }}>Keine Einträge für dieses Datum</p>
          </div>
        </div>
      ) : (
        entries.map((entry, i) => (
          <EntryCard key={entry.id || i} entry={entry} date={date} onUpdate={refresh}/>
        ))
      )}
    </div>
  );
};

// ─── Entry Card ──────────────────────────────────────────────

const EntryCard = ({ entry, date, onUpdate }) => {
  const [editing, setEditing]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const [editData, setEditData]   = useState(null);
  const isStrategy = entry.type === 'strategy';

  const startEdit = () => {
    setEditData(isStrategy ? { ...entry.data } : { text: entry.data.text || '' });
    setEditing(true);
  };

  const cancelEdit = () => { setEditing(false); setEditData(null); };

  const saveEdit = async () => {
    setSaving(true);
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({
          id: entry.id,
          date: entry.date || date,
          type: entry.type,
          checklistData: {
            ...(isStrategy ? editData : { text: editData.text }),
            timestamp: entry.data.timestamp || Date.now()
          }
        })
      });
      setEditing(false);
      setEditData(null);
      onUpdate();
    } catch (err) {
      console.error('Error saving edit:', err);
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async () => {
    if (!window.confirm('Diesen Eintrag wirklich löschen?')) return;
    setDeleting(true);
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/checklist/${entry.id}`, {
        method: 'DELETE',
        headers: { 'X-Session-ID': sessionId }
      });
      onUpdate();
    } catch (err) {
      console.error('Error deleting entry:', err);
      setDeleting(false);
    }
  };

  const quickSetOutcome = async (outcome) => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({
          id: entry.id, date: entry.date || date, type: entry.type,
          checklistData: { ...entry.data, outcome, tradeExecuted: true }
        })
      });
      onUpdate();
    } catch (err) {
      console.error('Error updating outcome:', err);
    }
  };

  const currentOutcome = isStrategy ? entry.data.outcome : null;

  return (
    <div className="card">
      <div className="card-head">
        <Icon name={isStrategy ? 'checklist' : 'book'} className="ico"/>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {new Date(entry.created_at).toLocaleTimeString('de-DE')}
        </span>
        {isStrategy && <span className="badge badge-tag" style={{ marginLeft: 8 }}>STRATEGIE</span>}
        <div className="actions" style={{ marginLeft: 'auto' }}>
          {editing ? (
            <>
              <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving}>
                {saving ? <div className="spinner-sm"/> : <Icon name="save" size={13}/>}
                Speichern
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                <Icon name="x" size={13}/> Abbrechen
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost btn-sm" onClick={startEdit}>
                <Icon name="edit" size={13}/> Bearbeiten
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={deleteEntry}
                disabled={deleting}
                style={{ color: 'var(--loss)' }}
                title="Eintrag löschen"
              >
                <Icon name="trash" size={13}/>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card-body">
        {!editing && (
          isStrategy ? (
            <StrategyChecklistDisplay
              data={entry.data}
              currentOutcome={currentOutcome}
              onQuickOutcome={quickSetOutcome}
            />
          ) : (
            <div style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
              {entry.data.text}
            </div>
          )
        )}

        {editing && editData && (
          <div className="edit-section">
            {isStrategy ? (
              <StrategyChecklistForm
                checklist={editData}
                setChecklist={setEditData}
                completedChecks={Object.values(editData).filter(v => v === true).length}
                totalChecks={14}
                embedded
              />
            ) : (
              <textarea
                value={editData.text}
                onChange={(e) => setEditData({ text: e.target.value })}
                className="input"
                rows={8}
                style={{ width: '100%' }}
                autoFocus
                placeholder="Notiz bearbeiten..."
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Strategy Checklist Display ──────────────────────────────

const StrategyChecklistDisplay = ({ data, currentOutcome, onQuickOutcome }) => {
  const checks = [
    data.ema200Checked, data.keyZonesMarked, data.inKeyZone, data.higherLowLowerHigh,
    data.noChop, data.clearTrendCandle, data.breakoutConfirmed, data.rsiFilter,
    data.rsiNotExtreme, data.slPlaced, data.tradeWorthIt, data.matchesBias,
    data.canExplain, data.clearMinded
  ].filter(Boolean).length;

  const outcomes = [
    { key: 'WIN', label: 'WIN', cls: 'active-win' },
    { key: 'LOSS', label: 'LOSS', cls: 'active-loss' },
    { key: 'BE', label: 'B/E', cls: 'active-be' },
    { key: 'OPEN', label: 'OPEN', cls: 'active-open' },
  ];

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        {data.biasSet && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Bias</span>
            <span className={`badge badge-${data.biasSet.toLowerCase() === 'long' ? 'win' : data.biasSet.toLowerCase() === 'short' ? 'loss' : 'wait'}`}>
              {data.biasSet}
            </span>
          </div>
        )}
        {data.tpRatio && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>R:R</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{data.tpRatio}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Checks</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: checks >= 10 ? 'var(--win)' : 'var(--wait)' }}>
            {checks}/14
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: data.notes ? 12 : 0 }}>
        <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
          Ergebnis
        </span>
        <div className="outcome-bar">
          {outcomes.map(({ key, label, cls }) => (
            <button
              key={key}
              className={`outcome-btn ${currentOutcome === key ? cls : ''}`}
              onClick={() => onQuickOutcome(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {data.notes && (
        <div style={{
          marginTop: 12, padding: '10px 12px', background: 'var(--bg-0)',
          borderRadius: 8, lineHeight: 1.7, color: 'var(--text-secondary)',
          borderLeft: '3px solid var(--border)', whiteSpace: 'pre-wrap'
        }}>
          {data.notes}
        </div>
      )}
    </div>
  );
};

// ─── Strategy Checklist Form ─────────────────────────────────

const StrategyChecklistForm = ({ checklist, setChecklist, completedChecks, totalChecks, onSave, onCancel, embedded = false }) => {
  const pct = Math.round((completedChecks / totalChecks) * 100);
  const progressColor = pct >= 70 ? 'var(--win)' : pct >= 40 ? 'var(--wait)' : 'var(--loss)';

  const row = (label, key) => (
    <label className="check-row" key={key}>
      <input type="checkbox" checked={!!checklist[key]} onChange={(e) => setChecklist({ ...checklist, [key]: e.target.checked })}/>
      <span>{label}</span>
    </label>
  );

  const body = (
    <>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Fortschritt</span>
          <span style={{ fontWeight: 700, color: progressColor, fontFamily: 'var(--font-mono)' }}>
            {completedChecks}/{totalChecks} ({pct}%)
          </span>
        </div>
        <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: progressColor, borderRadius: 4, transition: 'width 0.3s ease' }}/>
        </div>
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 1 · Morgen-Routine (4H / 1H)</div>
        {row('EMA 200 auf 4H geprüft', 'ema200Checked')}
        <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Bias:</span>
          <select value={checklist.biasSet} onChange={(e) => setChecklist({ ...checklist, biasSet: e.target.value })} className="input" style={{ width: 'auto', minWidth: 200 }}>
            <option value="">-- wählen --</option>
            <option value="LONG">LONG (Preis über EMA 200)</option>
            <option value="SHORT">SHORT (Preis unter EMA 200)</option>
            <option value="KEIN_TRADE">KEIN TRADE (EMA flach)</option>
          </select>
        </div>
        {row('1-2 Key-Zonen auf 15min markiert', 'keyZonesMarked')}
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 2 · Zonenanalyse (15min)</div>
        {row('Preis in markierter Key-Zone', 'inKeyZone')}
        {row('Higher Low (Long) / Lower High (Short) sichtbar', 'higherLowLowerHigh')}
        {row('Kein Chop, kein Seitwärtsmarkt', 'noChop')}
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 3 · Entry (5-10min)</div>
        {row('Klare Trendkerze (starker Body, wenig Docht)', 'clearTrendCandle')}
        {row('Bruch von lokalem High (Long) / Low (Short)', 'breakoutConfirmed')}
        {row('RSI >40 steigend (Long) / RSI <60 fallend (Short)', 'rsiFilter')}
        {row('RSI nicht extrem (<70 und >30)', 'rsiNotExtreme')}
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Risk Management</div>
        {row('SL logisch unter/über Struktur platziert', 'slPlaced')}
        <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>TP Ratio:</span>
          <input type="text" value={checklist.tpRatio} onChange={(e) => setChecklist({ ...checklist, tpRatio: e.target.value })} placeholder="z.B. 1:2" className="input" style={{ width: 100 }}/>
          <span style={{ fontSize: 12, color: 'var(--text-quaternary)', whiteSpace: 'nowrap' }}>Mindestens 1:1.5</span>
        </div>
        {row('Trade lohnt sich wirklich?', 'tradeWorthIt')}
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Final Check</div>
        {row('Passt der Trade zum Tages-Bias?', 'matchesBias')}
        {row('Könnte ich diesen Trade jemandem erklären?', 'canExplain')}
        {row('Ruhig und klar im Kopf?', 'clearMinded')}
      </div>

      <div className="checklist-group">
        <div className="checklist-group-title">Trade Ergebnis</div>
        {row('Trade ausgeführt', 'tradeExecuted')}
        {checklist.tradeExecuted && (
          <div style={{ margin: '8px 0 8px 26px' }}>
            <div className="outcome-bar">
              {[
                { key: 'WIN', label: 'WIN', cls: 'active-win' },
                { key: 'LOSS', label: 'LOSS', cls: 'active-loss' },
                { key: 'BE', label: 'B/E', cls: 'active-be' },
                { key: 'OPEN', label: 'OPEN', cls: 'active-open' },
              ].map(({ key, label, cls }) => (
                <button key={key} className={`outcome-btn ${checklist.outcome === key ? cls : ''}`} onClick={() => setChecklist({ ...checklist, outcome: key })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          value={checklist.notes}
          onChange={(e) => setChecklist({ ...checklist, notes: e.target.value })}
          placeholder="Notizen: Was lief gut? Was würdest du anders machen?"
          className="input"
          rows={4}
          style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
        />
      </div>

      {!embedded && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={onSave}>
            <Icon name="save" size={14}/> Checkliste speichern
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
        </div>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="checklist" className="ico"/>
        <h3>Top-Down Strategie — Checkliste</h3>
        <div className="actions">
          <span style={{ fontSize: 12, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)', marginRight: 8 }}>
            {completedChecks}/{totalChecks}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            <Icon name="x" size={13}/> Schließen
          </button>
        </div>
      </div>
      <div className="card-body">{body}</div>
    </div>
  );
};

// ─── Note Modal ──────────────────────────────────────────────

const NoteModal = ({ onSave, onCancel }) => {
  const [noteText, setNoteText] = useState('');
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="book" className="ico"/>
        <h3>Neue Notiz</h3>
        <div className="actions">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}><Icon name="x" size={13}/></button>
        </div>
      </div>
      <div className="card-body">
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Was hast du heute gelernt? Welche Trades liefen gut?"
          className="input"
          rows={6}
          style={{ width: '100%', resize: 'vertical' }}
          autoFocus
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => onSave(noteText)} disabled={!noteText.trim()}>
            <Icon name="save" size={14}/> Speichern
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
};

window.JournalPage = JournalPage;
