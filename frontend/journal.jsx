// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - JOURNAL MIT LIVE-DATEN
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const JournalPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [currentEntry, setCurrentEntry] = useState('');

  useEffect(() => {
    // Check auth
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

      if (response.status === 401) {
        localStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      const data = await response.json();
      
      // Filter nur Journal-Einträge
      const journalEntries = (data || [])
        .filter(item => item.type === 'journal')
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

  const saveEntry = async () => {
    if (!currentEntry.trim()) return;

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
            text: currentEntry,
            timestamp: Date.now()
          }
        })
      });

      if (response.ok) {
        setCurrentEntry('');
        setEditMode(false);
        loadEntries(sessionId, date);
      }
    } catch (err) {
      console.error('Error saving entry:', err);
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
          subtitle={`${entries.length} Einträge am ${new Date(date).toLocaleDateString('de-DE')}`}
        />
        <div className="content page-enter">
          
          {/* Date Picker */}
          <div className="card">
            <div className="card-head">
              <Icon name="calendar" className="ico"/>
              <h3>Datum wählen</h3>
            </div>
            <div className="card-body">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="input"
                style={{maxWidth: 200}}
              />
            </div>
          </div>

          {/* New Entry */}
          {editMode ? (
            <div className="card">
              <div className="card-head">
                <Icon name="plus" className="ico"/>
                <h3>Neuer Eintrag</h3>
                <div className="actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setEditMode(false);
                      setCurrentEntry('');
                    }}
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
              <div className="card-body">
                <textarea
                  value={currentEntry}
                  onChange={(e) => setCurrentEntry(e.target.value)}
                  placeholder="Was hast du heute gelernt? Welche Trades liefen gut? Was könntest du verbessern?"
                  className="input"
                  rows={8}
                  style={{width: '100%', resize: 'vertical'}}
                />
                <div style={{marginTop: 16}}>
                  <button className="btn btn-primary" onClick={saveEntry}>
                    <Icon name="check" size={14}/>
                    Speichern
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => setEditMode(true)}
              style={{width: '100%'}}
            >
              <Icon name="plus" size={16}/>
              Neuer Journal-Eintrag
            </button>
          )}

          {/* Entries List */}
          {loading ? (
            <div className="card">
              <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
                <div className="spinner-lg" style={{margin: '0 auto'}}/>
                <p style={{marginTop: 16, color: 'var(--text-secondary)'}}>Lade Einträge...</p>
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="card">
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="book" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>
                  Noch keine Einträge für dieses Datum
                </p>
                <p style={{fontSize: 12, marginTop: 8, color: 'var(--text-quaternary)'}}>
                  Klicke auf "Neuer Journal-Eintrag" um zu starten
                </p>
              </div>
            </div>
          ) : (
            entries.map((entry, i) => (
              <div key={entry.id || i} className="card">
                <div className="card-head">
                  <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <Icon name="book" className="ico"/>
                    <span style={{fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>
                      {new Date(entry.created_at).toLocaleTimeString('de-DE')}
                    </span>
                  </div>
                </div>
                <div className="card-body">
                  <div style={{lineHeight: 1.7, whiteSpace: 'pre-wrap'}}>
                    {entry.data.text}
                  </div>
                </div>
              </div>
            ))
          )}

        </div>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<JournalPage/>);
