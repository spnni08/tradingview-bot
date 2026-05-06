// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - ADMIN MIT TELEGRAM TEST
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const AdminPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramResult, setTelegramResult] = useState(null);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      window.location.href = 'login.html';
      return;
    }

    const parsedUser = JSON.parse(userData);
    setUser(parsedUser);

    if (parsedUser.role !== 'admin') {
      alert('Nur für Administratoren!');
      window.location.href = 'index.html';
      return;
    }

    if (parsedUser.mustChangePassword) {
      window.location.href = 'change-password.html';
      return;
    }

    loadUsers(sessionId);
  }, []);

  const loadUsers = async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/users`, {
        headers: { 'X-Session-ID': sessionId }
      });

      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      }
      setLoading(false);
    } catch (err) {
      console.error('Error loading users:', err);
      setLoading(false);
    }
  };

  const handleTestTelegram = async () => {
    setTelegramTesting(true);
    setTelegramResult(null);
    
    const sessionId = localStorage.getItem('wavescout_session');
    
    try {
      const response = await fetch(`${API_URL}/test-telegram`, {
        headers: { 'X-Session-ID': sessionId }
      });

      const data = await response.json();
      setTelegramResult(data);
      setTelegramTesting(false);
    } catch (err) {
      console.error('Telegram test error:', err);
      setTelegramResult({ success: false, message: 'Fehler beim Testen' });
      setTelegramTesting(false);
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

  if (loading) {
    return (
      <div className="app">
        <Sidebar active="admin" user={user} onLogout={handleLogout} />
        <main className="main">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh'
          }}>
            <div className="spinner-lg"></div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar active="admin" user={user} onLogout={handleLogout} />
      <main className="main">
        <Topbar
          title="🛡️ Administration"
          subtitle={`${users.length} Benutzer · System Management`}
        />
        <div className="content page-enter">

          {/* Telegram Test */}
          <div className="card">
            <div className="card-head">
              <Icon name="bell" className="ico"/>
              <h3>Telegram Integration</h3>
            </div>
            <div className="card-body">
              <p style={{marginBottom: 16, color: 'var(--text-secondary)'}}>
                Teste ob Telegram-Benachrichtigungen funktionieren
              </p>
              <button 
                className="btn btn-primary" 
                onClick={handleTestTelegram}
                disabled={telegramTesting}
              >
                {telegramTesting ? (
                  <>
                    <div className="spinner-sm" style={{marginRight: 8}}></div>
                    Sende Test-Nachricht...
                  </>
                ) : (
                  <>
                    <Icon name="bell" size={14}/>
                    Telegram testen
                  </>
                )}
              </button>
              
              {telegramResult && (
                <div style={{
                  marginTop: 16,
                  padding: 12,
                  background: telegramResult.success ? 'var(--bg-success)' : 'var(--bg-error)',
                  borderRadius: 8,
                  border: `1px solid ${telegramResult.success ? 'var(--win)' : 'var(--loss)'}`
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: telegramResult.success ? 'var(--win)' : 'var(--loss)'
                  }}>
                    {telegramResult.success ? '✅' : '❌'}
                    <strong>{telegramResult.message}</strong>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* User Management */}
          <div className="card">
            <div className="card-head">
              <Icon name="users" className="ico"/>
              <h3>Benutzer-Verwaltung</h3>
            </div>
            {users.length === 0 ? (
              <div className="card-body" style={{padding: 40, textAlign: 'center'}}>
                <p>Keine Benutzer gefunden</p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Benutzername</th>
                    <th>Email</th>
                    <th>Rolle</th>
                    <th>Passwort ändern</th>
                    <th>Erstellt</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={i}>
                      <td><strong>{u.username}</strong></td>
                      <td className="muted">{u.email}</td>
                      <td>
                        <span className={`badge ${u.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>
                          {u.role === 'admin' ? 'ADMIN' : 'USER'}
                        </span>
                      </td>
                      <td>
                        {u.must_change_password ? (
                          <span className="badge badge-loss">Erforderlich</span>
                        ) : (
                          <span className="badge badge-win">✓</span>
                        )}
                      </td>
                      <td className="mono muted" style={{fontSize: 11}}>
                        {new Date(u.created_at).toLocaleDateString('de-DE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* System Info */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(3, 1fr)'}}>
            <div className="stat">
              <div className="label">Worker Version</div>
              <div className="value">3.3.0</div>
              <div className="sub muted">Production</div>
            </div>
            <div className="stat">
              <div className="label">Total Users</div>
              <div className="value">{users.length}</div>
              <div className="sub muted">Registriert</div>
            </div>
            <div className="stat">
              <div className="label">Admin Users</div>
              <div className="value">{users.filter(u => u.role === 'admin').length}</div>
              <div className="sub muted">Administratoren</div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<AdminPage/>);
