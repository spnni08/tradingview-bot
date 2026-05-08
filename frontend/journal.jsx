// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - JOURNAL MIT STRATEGIE-CHECKLISTE
// Basierend auf "Top-Down Daytrading Strategie" PDF
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useCallback } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const EMPTY_CHECKLIST = {
  ema200Checked: false,
  biasSet: '',
  keyZonesMarked: false,
  inKeyZone: false,
  higherLowLowerHigh: false,
  noChop: false,
  clearTrendCandle: false,
  breakoutConfirmed: false,
  rsiFilter: false,
  rsiNotExtreme: false,
  slPlaced: false,
  tpRatio: '',
  tradeWorthIt: false,
  matchesBias: false,
  canExplain: false,
  clearMinded: false,
  tradeExecuted: false,
  outcome: '',
  notes: ''
};

const JournalPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState([]);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [checklist, setChecklist] = useState({ ...EMPTY_CHECKLIST });

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

    loadEntries(sessionId, date);

    // Auto-open checklist if a signal was saved from dashboard
    const pendingSignal = localStorage.getItem('signal_for_journal');
    if (pendingSignal) {
      try {
        const sig = JSON.parse(pendingSignal);
        localStorage.removeItem('signal_for_journal');
        setChecklist(prev => ({
          ...prev,
          biasSet: sig.direction === 'LONG' ? 'LONG' : sig.direction === 'SHORT' ? 'SHORT' : '',
          tpRatio: '',
          notes: `Signal: ${sig.symbol} ${sig.direction} · Score: ${sig.ai_score ?? '?'}/100 · Entry: $${(sig.ai_entry ?? sig.price ?? 0).toFixed(2)} · TP: $${(sig.ai_tp ?? 0).toFixed(2)} · SL: $${(sig.ai_sl ?? 0).toFixed(2)}\n${sig.ai_reason ?? ''}`.trim()
        }));
        setShowChecklist(true);
      } catch (_) {}
    }
  }, [date]);

  const loadEntries = async (sessionId, selectedDate) => {
    try {
      const sid = sessionId || localStorage.getItem('wavescout_session');
      const response = await fetch(`${API_URL}/checklist?date=${selectedDate}`, {
        headers: { 'X-Session-ID': sid }
      });

      const data = await response.json();

      const journalEntries = (data || [])
        .filter(item => item.type === 'journal' || item.type === 'strategy')
        .map(item => ({
          ...item,
          data: typeof item.data === 'string' ? JSON.parse(item.data) : item.data
        }));

      setEntries(journalEntries);
      setLoading(false);
    } catch (err) {
      console.error('Error loading entries:', err);
      setLoading(false);
    }
  };

  const refresh = useCallback(() => {
    const sid = localStorage.getItem('wavescout_session');
    loadEntries(sid, date);
  }, [date]);

  const saveStrategyChecklist = async () => {
    const sessionId = localStorage.getItem('wavescout_session');

    try {
      const response = await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({
          date,
          type: 'strategy',
          checklistData: { ...checklist, timestamp: Date.now() }
        })
      });

      if (response.ok) {
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
      const response = await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({
          date,
          type: 'journal',
          checklistData: { text: noteText, timestamp: Date.now() }
        })
      });

      if (response.ok) {
        setShowNotes(false);
        refresh();
      }
    } catch (err) {
      console.error('Error saving notes:', err);
    }
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

  const completedChecks = [
    checklist.ema200Checked, checklist.keyZonesMarked,
    checklist.inKeyZone, checklist.higherLowLowerHigh, checklist.noChop,
    checklist.clearTrendCandle, checklist.breakoutConfirmed,
    checklist.rsiFilter, checklist.rsiNotExtreme,
    checklist.slPlaced, checklist.tradeWorthIt,
    checklist.matchesBias, checklist.canExplain, checklist.clearMinded
  ].filter(Boolean).length;
  const totalChecks = 14;

  return (
    <div className="app">
      <Sidebar active="journal" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="📔 Trading Journal"
          subtitle={`${entries.length} Eintrag${entries.length !== 1 ? 'e' : ''} · ${new Date(date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`}
        />
        <div className="content page-enter">

          {/* Date Picker & Actions */}
          <div className="card">
            <div className="card-head">
              <Icon name="calendar" className="ico" />
              <h3>Datum & Aktionen</h3>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="input"
                  style={{ maxWidth: 200 }}
                />
                <button className="btn btn-primary" onClick={() => setShowChecklist(true)}>
                  <Icon name="checklist" size={14} />
                  Strategie-Checkliste
                </button>
                <button className="btn" onClick={() => setShowNotes(true)}>
                  <Icon name="plus" size={14} />
                  Notiz hinzufügen
                </button>
              </div>
            </div>
          </div>

          {/* Strategie Checkliste (new entry) */}
          {showChecklist && (
            <StrategyChecklistForm
              checklist={checklist}
              setChecklist={setChecklist}
              completedChecks={completedChecks}
              totalChecks={totalChecks}
              onSave={saveStrategyChecklist}
              onCancel={() => { setShowChecklist(false); setChecklist({ ...EMPTY_CHECKLIST }); }}
            />
          )}

          {/* Notiz Modal */}
          {showNotes && (
            <NoteModal onSave={saveNotes} onCancel={() => setShowNotes(false)} />
          )}

          {/* Entries List */}
          {loading ? (
            <div className="card">
              <div className="card-body" style={{ padding: 40, textAlign: 'center' }}>
                <div className="spinner-lg" style={{ margin: '0 auto' }} />
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="card">
              <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
                <Icon name="book" size={48} style={{ opacity: 0.15, marginBottom: 16 }} />
                <p style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>
                  Noch keine Einträge für dieses Datum
                </p>
                <p style={{ color: 'var(--text-quaternary)', fontSize: 13 }}>
                  Füge eine Strategie-Checkliste oder eine Notiz hinzu.
                </p>
              </div>
            </div>
          ) : (
            entries.map((entry, i) => (
              <EntryCard
                key={entry.id || i}
                entry={entry}
                date={date}
                onUpdate={refresh}
              />
            ))
          )}

        </div>
      </main>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// ENTRY CARD — with inline outcome buttons + full edit mode
// ═══════════════════════════════════════════════════════════════

const EntryCard = ({ entry, date, onUpdate }) => {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editData, setEditData] = useState(null);
  const isStrategy = entry.type === 'strategy';

  const startEdit = () => {
    setEditData(isStrategy ? { ...entry.data } : { text: entry.data.text || '' });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditData(null);
  };

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

  const quickSetOutcome = async (outcome) => {
    const sessionId = localStorage.getItem('wavescout_session');
    const updatedData = { ...entry.data, outcome, tradeExecuted: true };

    try {
      await fetch(`${API_URL}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({
          id: entry.id,
          date: entry.date || date,
          type: entry.type,
          checklistData: updatedData
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
        <Icon name={isStrategy ? 'checklist' : 'book'} className="ico" />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {new Date(entry.created_at).toLocaleTimeString('de-DE')}
        </span>
        {isStrategy && (
          <span className="badge badge-tag" style={{ marginLeft: 8 }}>STRATEGIE</span>
        )}
        <div className="actions" style={{ marginLeft: 'auto' }}>
          {editing ? (
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={saveEdit}
                disabled={saving}
              >
                {saving ? <div className="spinner-sm" /> : <Icon name="save" size={13} />}
                Speichern
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                <Icon name="x" size={13} />
                Abbrechen
              </button>
            </>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={startEdit}>
              <Icon name="edit" size={13} />
              Bearbeiten
            </button>
          )}
        </div>
      </div>

      <div className="card-body">
        {/* Read-only summary (always visible) */}
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

        {/* Edit form (inline) */}
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

// ═══════════════════════════════════════════════════════════════
// STRATEGY CHECKLIST DISPLAY (read-only with outcome buttons)
// ═══════════════════════════════════════════════════════════════

const StrategyChecklistDisplay = ({ data, currentOutcome, onQuickOutcome }) => {
  const outcomeMap = [
    { key: 'WIN',  label: 'WIN',  cls: 'active-win' },
    { key: 'LOSS', label: 'LOSS', cls: 'active-loss' },
    { key: 'BE',   label: 'B/E',  cls: 'active-be' },
    { key: 'OPEN', label: 'OPEN', cls: 'active-open' },
  ];

  const checks = [
    data.ema200Checked, data.keyZonesMarked,
    data.inKeyZone, data.higherLowLowerHigh, data.noChop,
    data.clearTrendCandle, data.breakoutConfirmed,
    data.rsiFilter, data.rsiNotExtreme,
    data.slPlaced, data.tradeWorthIt,
    data.matchesBias, data.canExplain, data.clearMinded
  ].filter(Boolean).length;
  const total = 14;

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        {data.biasSet && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Bias</span>
            <span className={`badge badge-${data.biasSet.toLowerCase() === 'long' ? 'win' : data.biasSet.toLowerCase() === 'short' ? 'loss' : 'wait'}`}>
              {data.biasSet}
            </span>
          </div>
        )}
        {data.tpRatio && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>R:R</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{data.tpRatio}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Checks</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: checks >= total * 0.7 ? 'var(--win)' : 'var(--wait)' }}>
            {checks}/{total}
          </span>
        </div>
      </div>

      {/* Quick outcome selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: data.notes ? 14 : 0 }}>
        <span style={{ color: 'var(--text-quaternary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
          Ergebnis
        </span>
        <div className="outcome-bar">
          {outcomeMap.map(({ key, label, cls }) => (
            <button
              key={key}
              className={`outcome-btn ${currentOutcome === key ? cls : ''}`}
              onClick={() => onQuickOutcome(key)}
              title={`Ergebnis auf ${label} setzen`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {data.notes && (
        <div style={{
          marginTop: 14,
          padding: '12px 14px',
          background: 'var(--bg-0)',
          borderRadius: 8,
          lineHeight: 1.7,
          color: 'var(--text-secondary)',
          borderLeft: '3px solid var(--border)',
          whiteSpace: 'pre-wrap'
        }}>
          {data.notes}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// STRATEGY CHECKLIST FORM (used for new + edit)
// ═══════════════════════════════════════════════════════════════

const StrategyChecklistForm = ({
  checklist, setChecklist,
  completedChecks, totalChecks,
  onSave, onCancel,
  embedded = false
}) => {
  const pct = Math.round((completedChecks / totalChecks) * 100);
  const progressColor = pct >= 70 ? 'var(--win)' : pct >= 40 ? 'var(--wait)' : 'var(--loss)';

  const row = (label, key) => (
    <label className="check-row" key={key}>
      <input
        type="checkbox"
        checked={!!checklist[key]}
        onChange={(e) => setChecklist({ ...checklist, [key]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  );

  const body = (
    <>
      {/* Progress bar */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Fortschritt</span>
          <span style={{ fontWeight: 700, color: progressColor, fontFamily: 'var(--font-mono)' }}>
            {completedChecks}/{totalChecks} ({pct}%)
          </span>
        </div>
        <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: progressColor, borderRadius: 4, transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {/* Schritt 1 */}
      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 1 · Morgen-Routine (4H / 1H)</div>
        {row('EMA 200 auf 4H geprüft', 'ema200Checked')}
        <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Bias:</span>
          <select
            value={checklist.biasSet}
            onChange={(e) => setChecklist({ ...checklist, biasSet: e.target.value })}
            className="input"
            style={{ width: 'auto', minWidth: 200 }}
          >
            <option value="">-- wählen --</option>
            <option value="LONG">LONG (Preis über EMA 200)</option>
            <option value="SHORT">SHORT (Preis unter EMA 200)</option>
            <option value="KEIN_TRADE">KEIN TRADE (EMA flach)</option>
          </select>
        </div>
        {row('1-2 Key-Zonen auf 15min markiert', 'keyZonesMarked')}
      </div>

      {/* Schritt 2 */}
      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 2 · Zonenanalyse (15min)</div>
        {row('Preis in markierter Key-Zone', 'inKeyZone')}
        {row('Higher Low (Long) / Lower High (Short) sichtbar', 'higherLowLowerHigh')}
        {row('Kein Chop, kein Seitwärtsmarkt', 'noChop')}
      </div>

      {/* Schritt 3 */}
      <div className="checklist-group">
        <div className="checklist-group-title">Schritt 3 · Entry (5-10min)</div>
        {row('Klare Trendkerze (starker Body, wenig Docht)', 'clearTrendCandle')}
        {row('Bruch von lokalem High (Long) / Low (Short)', 'breakoutConfirmed')}
        {row('RSI >40 steigend (Long) / RSI <60 fallend (Short)', 'rsiFilter')}
        {row('RSI nicht extrem (<70 und >30)', 'rsiNotExtreme')}
      </div>

      {/* Risk Management */}
      <div className="checklist-group">
        <div className="checklist-group-title">Risk Management</div>
        {row('SL logisch unter/über Struktur platziert', 'slPlaced')}
        <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>TP Ratio:</span>
          <input
            type="text"
            value={checklist.tpRatio}
            onChange={(e) => setChecklist({ ...checklist, tpRatio: e.target.value })}
            placeholder="z.B. 1:2"
            className="input"
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-quaternary)', whiteSpace: 'nowrap' }}>Mindestens 1:1.5</span>
        </div>
        {row('Trade lohnt sich wirklich?', 'tradeWorthIt')}
      </div>

      {/* Final Check */}
      <div className="checklist-group">
        <div className="checklist-group-title">Final Check</div>
        {row('Passt der Trade zum Tages-Bias?', 'matchesBias')}
        {row('Könnte ich diesen Trade jemandem erklären?', 'canExplain')}
        {row('Ruhig und klar im Kopf?', 'clearMinded')}
      </div>

      {/* Trade Ergebnis */}
      <div className="checklist-group">
        <div className="checklist-group-title">Trade Ergebnis</div>
        {row('Trade ausgeführt', 'tradeExecuted')}
        {checklist.tradeExecuted && (
          <div style={{ margin: '8px 0 8px 26px' }}>
            <div className="outcome-bar">
              {[
                { key: 'WIN',  label: 'WIN',  cls: 'active-win' },
                { key: 'LOSS', label: 'LOSS', cls: 'active-loss' },
                { key: 'BE',   label: 'B/E',  cls: 'active-be' },
                { key: 'OPEN', label: 'OPEN', cls: 'active-open' },
              ].map(({ key, label, cls }) => (
                <button
                  key={key}
                  className={`outcome-btn ${checklist.outcome === key ? cls : ''}`}
                  onClick={() => setChecklist({ ...checklist, outcome: key })}
                >
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
            <Icon name="save" size={14} />
            Checkliste speichern
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="checklist" className="ico" />
        <h3>Top-Down Strategie — Checkliste</h3>
        <div className="actions">
          <span style={{ fontSize: 12, color: 'var(--text-quaternary)', fontFamily: 'var(--font-mono)', marginRight: 8 }}>
            {completedChecks}/{totalChecks}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            <Icon name="x" size={13} />
            Schließen
          </button>
        </div>
      </div>
      <div className="card-body">{body}</div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// NOTE MODAL
// ═══════════════════════════════════════════════════════════════

const NoteModal = ({ onSave, onCancel }) => {
  const [noteText, setNoteText] = useState('');

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="book" className="ico" />
        <h3>Neue Notiz</h3>
        <div className="actions">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            <Icon name="x" size={13} />
            Schließen
          </button>
        </div>
      </div>
      <div className="card-body">
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Was hast du heute gelernt? Welche Trades liefen gut? Was würdest du anders machen?"
          className="input"
          rows={8}
          style={{ width: '100%', resize: 'vertical' }}
          autoFocus
        />
        <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
          <button
            className="btn btn-primary"
            onClick={() => onSave(noteText)}
            disabled={!noteText.trim()}
          >
            <Icon name="save" size={14} />
            Speichern
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<JournalPage />);
