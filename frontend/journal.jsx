// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - JOURNAL MIT STRATEGIE-CHECKLISTE
// Basierend auf "Top-Down Daytrading Strategie" PDF
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const JournalPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState([]);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  
  // Checkliste State
  const [checklist, setChecklist] = useState({
    // Schritt 1: Morgen-Routine (4H/1H)
    ema200Checked: false,
    biasSet: '',  // 'LONG', 'SHORT', 'KEIN_TRADE'
    keyZonesMarked: false,
    
    // Schritt 2: Zonenanalyse (15min)
    inKeyZone: false,
    higherLowLowerHigh: false,
    noChop: false,
    
    // Schritt 3: Entry (5-10min)
    clearTrendCandle: false,
    breakoutConfirmed: false,
    rsiFilter: false,
    rsiNotExtreme: false,
    
    // Risk Management
    slPlaced: false,
    tpRatio: '',  // z.B. "1:2"
    tradeWorthIt: false,
    
    // Final Check
    matchesBias: false,
    canExplain: false,
    clearMinded: false,
    
    // Outcome
    tradeExecuted: false,
    outcome: '',  // 'WIN', 'LOSS', 'BE', 'OPEN'
    notes: ''
  });

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
  }, [date]);

  const loadEntries = async (sessionId, selectedDate) => {
    try {
      const response = await fetch(
        `${API_URL}/checklist?date=${selectedDate}`,
        {
          headers: { 'X-Session-ID': sessionId }
        }
      );

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
          checklistData: {
            ...checklist,
            timestamp: Date.now()
          }
        })
      });

      if (response.ok) {
        setShowChecklist(false);
        setChecklist({
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
        });
        loadEntries(sessionId, date);
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
          checklistData: {
            text: noteText,
            timestamp: Date.now()
          }
        })
      });

      if (response.ok) {
        setShowNotes(false);
        loadEntries(sessionId, date);
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

  return (
    <div className="app">
      <Sidebar active="journal" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="📔 Trading Journal"
          subtitle={`${entries.length} Einträge · ${new Date(date).toLocaleDateString('de-DE', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}`}
        />
        <div className="content page-enter">
          
          {/* Date Picker & Actions */}
          <div className="card">
            <div className="card-head">
              <Icon name="calendar" className="ico"/>
              <h3>Datum & Aktionen</h3>
            </div>
            <div className="card-body">
              <div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="input"
                  style={{maxWidth: 200}}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => setShowChecklist(true)}
                >
                  <Icon name="checklist" size={14}/>
                  Strategie-Checkliste
                </button>
                <button
                  className="btn"
                  onClick={() => setShowNotes(true)}
                >
                  <Icon name="plus" size={14}/>
                  Notiz hinzufügen
                </button>
              </div>
            </div>
          </div>

          {/* Strategie Checkliste Modal */}
          {showChecklist && (
            <div className="card">
              <div className="card-head">
                <Icon name="checklist" className="ico"/>
                <h3>Top-Down Strategie - Checkliste</h3>
                <div className="actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowChecklist(false)}
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
              <div className="card-body">
                
                {/* Schritt 1: Morgen-Routine */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Schritt 1: Morgen-Routine (4H / 1H)
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.ema200Checked}
                      onChange={(e) => setChecklist({...checklist, ema200Checked: e.target.checked})}
                    />
                    <span>EMA 200 auf 4H geprüft</span>
                  </label>

                  <div style={{marginBottom: 8}}>
                    <span style={{fontSize: 13, marginRight: 8}}>Bias für heute:</span>
                    <select
                      value={checklist.biasSet}
                      onChange={(e) => setChecklist({...checklist, biasSet: e.target.value})}
                      className="input"
                      style={{display: 'inline', width: 'auto'}}
                    >
                      <option value="">-- wählen --</option>
                      <option value="LONG">LONG (Preis über EMA 200)</option>
                      <option value="SHORT">SHORT (Preis unter EMA 200)</option>
                      <option value="KEIN_TRADE">KEIN TRADE (EMA flach)</option>
                    </select>
                  </div>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.keyZonesMarked}
                      onChange={(e) => setChecklist({...checklist, keyZonesMarked: e.target.checked})}
                    />
                    <span>1-2 Key-Zonen auf 15min markiert</span>
                  </label>
                </div>

                {/* Schritt 2: Zonenanalyse */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Schritt 2: Zonenanalyse (15min)
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.inKeyZone}
                      onChange={(e) => setChecklist({...checklist, inKeyZone: e.target.checked})}
                    />
                    <span>Preis in markierter Key-Zone</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.higherLowLowerHigh}
                      onChange={(e) => setChecklist({...checklist, higherLowLowerHigh: e.target.checked})}
                    />
                    <span>Higher Low (L) / Lower High (S) sichtbar</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.noChop}
                      onChange={(e) => setChecklist({...checklist, noChop: e.target.checked})}
                    />
                    <span>Kein Chop, kein Seitwärtsmarkt</span>
                  </label>
                </div>

                {/* Schritt 3: Entry */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Schritt 3: Entry (5-10min)
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.clearTrendCandle}
                      onChange={(e) => setChecklist({...checklist, clearTrendCandle: e.target.checked})}
                    />
                    <span>Klare Trendkerze (starker Body, wenig Docht)</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.breakoutConfirmed}
                      onChange={(e) => setChecklist({...checklist, breakoutConfirmed: e.target.checked})}
                    />
                    <span>Bruch von lokalem High (L) / Low (S)</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.rsiFilter}
                      onChange={(e) => setChecklist({...checklist, rsiFilter: e.target.checked})}
                    />
                    <span>RSI &gt;40 steigend (L) / RSI &lt;60 fallend (S)</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.rsiNotExtreme}
                      onChange={(e) => setChecklist({...checklist, rsiNotExtreme: e.target.checked})}
                    />
                    <span>RSI nicht extrem (&lt;70 und &gt;30)</span>
                  </label>
                </div>

                {/* Risk Management */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Risk Management
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.slPlaced}
                      onChange={(e) => setChecklist({...checklist, slPlaced: e.target.checked})}
                    />
                    <span>SL logisch unter/über Struktur platziert</span>
                  </label>

                  <div style={{marginBottom: 8}}>
                    <span style={{fontSize: 13, marginRight: 8}}>TP Ratio:</span>
                    <input
                      type="text"
                      value={checklist.tpRatio}
                      onChange={(e) => setChecklist({...checklist, tpRatio: e.target.value})}
                      placeholder="z.B. 1:2"
                      className="input"
                      style={{display: 'inline', width: '100px'}}
                    />
                    <span style={{fontSize: 12, marginLeft: 8, color: 'var(--text-tertiary)'}}>
                      (Mindestens 1:1.5)
                    </span>
                  </div>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.tradeWorthIt}
                      onChange={(e) => setChecklist({...checklist, tradeWorthIt: e.target.checked})}
                    />
                    <span>Trade lohnt sich wirklich?</span>
                  </label>
                </div>

                {/* Final Check */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Final Check
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.matchesBias}
                      onChange={(e) => setChecklist({...checklist, matchesBias: e.target.checked})}
                    />
                    <span>Passt der Trade zum Tages-Bias?</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.canExplain}
                      onChange={(e) => setChecklist({...checklist, canExplain: e.target.checked})}
                    />
                    <span>Könnte ich diesen Trade jemandem erklären?</span>
                  </label>

                  <label style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.clearMinded}
                      onChange={(e) => setChecklist({...checklist, clearMinded: e.target.checked})}
                    />
                    <span>Ruhig und klar im Kopf?</span>
                  </label>
                </div>

                {/* Outcome */}
                <div style={{marginBottom: 24}}>
                  <h4 style={{marginBottom: 12, color: 'var(--blue-500)'}}>
                    Trade Ergebnis
                  </h4>
                  
                  <label style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
                    <input
                      type="checkbox"
                      checked={checklist.tradeExecuted}
                      onChange={(e) => setChecklist({...checklist, tradeExecuted: e.target.checked})}
                    />
                    <span>Trade ausgeführt</span>
                  </label>

                  {checklist.tradeExecuted && (
                    <div style={{marginBottom: 8}}>
                      <span style={{fontSize: 13, marginRight: 8}}>Ergebnis:</span>
                      <select
                        value={checklist.outcome}
                        onChange={(e) => setChecklist({...checklist, outcome: e.target.value})}
                        className="input"
                        style={{display: 'inline', width: 'auto'}}
                      >
                        <option value="">-- wählen --</option>
                        <option value="WIN">WIN (Gewonnen)</option>
                        <option value="LOSS">LOSS (Verloren)</option>
                        <option value="BE">BE (Break Even)</option>
                        <option value="OPEN">OPEN (Noch offen)</option>
                      </select>
                    </div>
                  )}

                  <textarea
                    value={checklist.notes}
                    onChange={(e) => setChecklist({...checklist, notes: e.target.value})}
                    placeholder="Notizen zum Trade..."
                    className="input"
                    rows={4}
                    style={{width: '100%', marginTop: 8}}
                  />
                </div>

                <div style={{display: 'flex', gap: 10}}>
                  <button className="btn btn-primary" onClick={saveStrategyChecklist}>
                    <Icon name="check" size={14}/>
                    Checkliste speichern
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setShowChecklist(false)}
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Notiz Modal */}
          {showNotes && (
            <NoteModal
              onSave={saveNotes}
              onCancel={() => setShowNotes(false)}
            />
          )}

          {/* Entries List */}
          {loading ? (
            <div className="card">
              <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
                <div className="spinner-lg" style={{margin: '0 auto'}}/>
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="card">
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="book" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>
                  Noch keine Einträge für dieses Datum
                </p>
              </div>
            </div>
          ) : (
            entries.map((entry, i) => (
              <EntryCard key={entry.id || i} entry={entry} />
            ))
          )}

        </div>
      </main>
    </div>
  );
};

// Entry Card Component
const EntryCard = ({ entry }) => {
  const isStrategy = entry.type === 'strategy';
  
  return (
    <div className="card">
      <div className="card-head">
        <Icon name={isStrategy ? 'checklist' : 'book'} className="ico"/>
        <span style={{fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
          {new Date(entry.created_at).toLocaleTimeString('de-DE')}
        </span>
        {isStrategy && (
          <span className="badge badge-tag" style={{marginLeft: 8}}>STRATEGIE</span>
        )}
      </div>
      <div className="card-body">
        {isStrategy ? (
          <StrategyChecklistDisplay data={entry.data} />
        ) : (
          <div style={{lineHeight: 1.7, whiteSpace: 'pre-wrap'}}>
            {entry.data.text}
          </div>
        )}
      </div>
    </div>
  );
};

// Display Strategie Checkliste
const StrategyChecklistDisplay = ({ data }) => (
  <div style={{fontSize: 13}}>
    <div style={{marginBottom: 12}}>
      <strong>Bias:</strong> <span className={`badge badge-${data.biasSet?.toLowerCase() || 'wait'}`}>{data.biasSet || 'N/A'}</span>
    </div>
    
    {data.tradeExecuted && (
      <div style={{marginBottom: 12}}>
        <strong>Ergebnis:</strong> <span className={`badge badge-${
          data.outcome === 'WIN' ? 'win' :
          data.outcome === 'LOSS' ? 'loss' :
          'wait'
        }`}>{data.outcome}</span>
      </div>
    )}

    {data.tpRatio && (
      <div style={{marginBottom: 12}}>
        <strong>R:R:</strong> {data.tpRatio}
      </div>
    )}

    {data.notes && (
      <div style={{
        marginTop: 16,
        padding: 12,
        background: 'var(--bg-1)',
        borderRadius: 8,
        lineHeight: 1.6
      }}>
        {data.notes}
      </div>
    )}
  </div>
);

// Note Modal
const NoteModal = ({ onSave, onCancel }) => {
  const [noteText, setNoteText] = useState('');

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="plus" className="ico"/>
        <h3>Neue Notiz</h3>
      </div>
      <div className="card-body">
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Was hast du heute gelernt? Welche Trades liefen gut?"
          className="input"
          rows={8}
          style={{width: '100%'}}
          autoFocus
        />
        <div style={{marginTop: 16, display: 'flex', gap: 10}}>
          <button
            className="btn btn-primary"
            onClick={() => onSave(noteText)}
            disabled={!noteText.trim()}
          >
            <Icon name="check" size={14}/>
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

const StatCard = ({ label, value, sub, subTone = 'muted', icon }) => (
  <div className="stat" data-tip={sub}>
    <div className="label" style={{display: 'flex', alignItems: 'center', gap: 6}}>
      {icon && <Icon name={icon} size={11}/>}
      {label}
    </div>
    <div className="value">{value}</div>
    {sub && <div className={`sub ${subTone}`}>{sub}</div>}
  </div>
);

ReactDOM.createRoot(document.getElementById('root')).render(<JournalPage/>);
