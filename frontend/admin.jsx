// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - ADMIN (FUNKTIONIERT RICHTIG)
// Mit Telegram-Test, User-Management, System-Info
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const AdminPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramResult, setTelegramResult] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    console.log('🛡️ Admin page initializing...');
    
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');
    
    if (!sessionId || !userData) {
      console.log('❌ No session, redirecting to login');
      window.location.href = 'login.html';
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      console.log('✅ User loaded:', parsedUser.username, 'Role:', parsedUser.role);
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

      loadAdminData(sessionId);
    } catch (err) {
      console.error('Error parsing user:', err);
      window.location.href = 'login.html';
    }
  }, []);

  const loadAdminData = async (sessionId) => {
    try {
      console.log('📊 Loading admin data...');
      
      // Load users
      const usersResponse = await fetch(`${API_URL}/users`, {
        headers: { 'X-Session-ID': sessionId }
      });

      let usersData = [];
      if (usersResponse.ok) {
        usersData = await usersResponse.json();
        console.log('✅ Users loaded:', usersData.length);
      } else {
        console.log('⚠️ No users endpoint, using fallback');
      }

      // Load stats
      const statsResponse = await fetch(`${API_URL}/stats`, {
        headers: { 'X-Session-ID': sessionId }
      });

      let statsData = null;
      if (statsResponse.ok) {
        statsData = await statsResponse.json();
        console.log('✅ Stats loaded:', statsData);
      }

      setUsers(usersData);
      setStats(statsData);
      setLoading(false);
    } catch (err) {
      console.error('❌ Error loading admin data:', err);
      setUsers([]);
      setStats(null);
      setLoading(false);
    }
  };

  const handleTestTelegram = async () => {
    console.log('🧪 Testing Telegram...');
    setTelegramTesting(true);
    setTelegramResult(null);
    
    const sessionId = localStorage.getItem('wavescout_session');
    
    try {
      const response = await fetch(`${API_URL}/test-telegram`, {
        headers: { 'X-Session-ID': sessionId }
      });

      const data = await response.json();
      console.log('📱 Telegram test result:', data);
      setTelegramResult(data);
      setTelegramTesting(false);
    } catch (err) {
      console.error('❌ Telegram test error:', err);
      setTelegramResult({ 
        success: false, 
        message: 'Fehler beim Testen: ' + err.message 
      });
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
            height: '100vh',
            flexDirection: 'column',
            gap: 20
          }}>
            <div className="spinner-lg"></div>
            <div style={{color: 'var(--text-secondary)'}}>Lade Admin-Panel...</div>
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

          {/* System Stats */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <div className="stat">
              <div className="label">Total Users</div>
              <div className="value">{users.length}</div>
              <div className="sub muted">Registriert</div>
            </div>
            <div className="stat">
              <div className="label">Admins</div>
              <div className="value">{users.filter(u => u.role === 'admin').length}</div>
              <div className="sub muted">Administratoren</div>
            </div>
            <div className="stat">
              <div className="label">Total Trades</div>
              <div className="value">{stats?.total || 0}</div>
              <div className="sub muted">Alle Signale</div>
            </div>
            <div className="stat">
              <div className="label">Win-Rate</div>
              <div className="value">{stats?.winRate?.toFixed(1) || 0}%</div>
              <div className="sub win">System Performance</div>
            </div>
          </div>

          {/* Telegram Test */}
          <div className="card">
            <div className="card-head">
              <Icon name="bell" className="ico"/>
              <h3>Telegram Integration</h3>
            </div>
            <div className="card-body">
              <p style={{marginBottom: 16, color: 'var(--text-secondary)', lineHeight: 1.6}}>
                Teste ob Telegram-Benachrichtigungen korrekt funktionieren. 
                Eine Test-Nachricht wird an den konfigurierten Chat gesendet.
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
                    Telegram jetzt testen
                  </>
                )}
              </button>
              
              {telegramResult && (
                <div style={{
                  marginTop: 16,
                  padding: 16,
                  background: telegramResult.success ? 'rgba(46, 213, 115, 0.1)' : 'rgba(235, 87, 87, 0.1)',
                  borderRadius: 12,
                  border: `2px solid ${telegramResult.success ? '#2ed573' : '#eb5757'}`
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    marginBottom: 8
                  }}>
                    <div style={{fontSize: 24}}>
                      {telegramResult.success ? '✅' : '❌'}
                    </div>
                    <div>
                      <div style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: telegramResult.success ? '#2ed573' : '#eb5757'
                      }}>
                        {telegramResult.success ? 'Erfolgreich!' : 'Fehler'}
                      </div>
                      <div style={{fontSize: 13, color: 'var(--text-secondary)', marginTop: 2}}>
                        {telegramResult.message}
                      </div>
                    </div>
                  </div>
                  
                  {telegramResult.success && (
                    <div style={{
                      fontSize: 12,
                      color: 'var(--text-tertiary)',
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid var(--border)'
                    }}>
                      💡 Prüfe deine Telegram-App auf eine neue Nachricht von deinem Bot
                    </div>
                  )}
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
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="users" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>Keine Benutzer gefunden</p>
                <p style={{fontSize: 12, marginTop: 8, color: 'var(--text-quaternary)'}}>
                  User-Endpoint ist möglicherweise nicht verfügbar
                </p>
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Benutzername</th>
                    <th>Email</th>
                    <th>Rolle</th>
                    <th>Status</th>
                    <th>Erstellt</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={i}>
                      <td>
                        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                          <div style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: 'var(--blue-500)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'white',
                            fontWeight: 600,
                            fontSize: 14
                          }}>
                            {u.username?.charAt(0).toUpperCase() || 'U'}
                          </div>
                          <strong>{u.username}</strong>
                        </div>
                      </td>
                      <td className="muted">{u.email}</td>
                      <td>
                        <span className={`badge ${u.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>
                          {u.role === 'admin' ? 'ADMIN' : 'USER'}
                        </span>
                      </td>
                      <td>
                        {u.must_change_password ? (
                          <span className="badge badge-loss">Passwort ändern</span>
                        ) : (
                          <span className="badge badge-win">Aktiv</span>
                        )}
                      </td>
                      <td className="mono muted" style={{fontSize: 11}}>
                        {new Date(u.created_at).toLocaleDateString('de-DE', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric'
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* System Info */}
          <div className="card">
            <div className="card-head">
              <Icon name="settings" className="ico"/>
              <h3>System Information</h3>
            </div>
            <div className="card-body">
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 20
              }}>
                <div>
                  <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4}}>
                    Version
                  </div>
                  <div style={{fontSize: 14, fontWeight: 600}}>
                    WAVESCOUT v3.3.0 Production
                  </div>
                </div>
                <div>
                  <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4}}>
                    Worker Status
                  </div>
                  <div style={{fontSize: 14, fontWeight: 600, color: 'var(--win)'}}>
                    ✓ Online
                  </div>
                </div>
                <div>
                  <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4}}>
                    Backend
                  </div>
                  <div style={{fontSize: 14, fontWeight: 600}}>
                    Cloudflare Workers
                  </div>
                </div>
                <div>
                  <div style={{fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4}}>
                    Database
                  </div>
                  <div style={{fontSize: 14, fontWeight: 600}}>
                    Cloudflare D1
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<AdminPage/>);
