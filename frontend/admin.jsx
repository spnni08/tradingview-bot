// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - ADMIN (COMPLETE)
// User Management · Telegram · Online Status · Create/Block Users
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

const AdminPage = () => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  
  // Telegram
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramResult, setTelegramResult] = useState(null);
  
  // Modals
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  
  // Online tracking
  const [onlineUsers, setOnlineUsers] = useState(new Set());

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
      
      // Refresh data every 30 seconds
      const interval = setInterval(() => loadAdminData(sessionId), 30000);
      return () => clearInterval(interval);
    } catch (err) {
      console.error('Error parsing user:', err);
      window.location.href = 'login.html';
    }
  }, []);

  const loadAdminData = async (sessionId) => {
    try {
      console.log('📊 Loading admin data...');
      
      const [usersResponse, statsResponse] = await Promise.all([
        fetch(`${API_URL}/users`, {
          headers: { 'X-Session-ID': sessionId }
        }),
        fetch(`${API_URL}/stats`, {
          headers: { 'X-Session-ID': sessionId }
        })
      ]);

      let usersData = [];
      if (usersResponse.ok) {
        usersData = await usersResponse.json();
        console.log('✅ Users loaded:', usersData.length);
        
        // Check which users are online (updated in last 5 minutes)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const online = new Set(
          usersData
            .filter(u => u.last_seen && u.last_seen > fiveMinutesAgo)
            .map(u => u.id)
        );
        setOnlineUsers(online);
      }

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

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log('📱 Telegram test result:', data);
      setTelegramResult(data);
    } catch (err) {
      console.error('❌ Telegram test error:', err);
      setTelegramResult({ 
        success: false, 
        message: 'Fehler: ' + err.message 
      });
    } finally {
      setTelegramTesting(false);
    }
  };

  const handleCreateUser = async (userData) => {
    const sessionId = localStorage.getItem('wavescout_session');
    
    try {
      const response = await fetch(`${API_URL}/admin/create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify(userData)
      });

      if (response.ok) {
        alert('User erfolgreich erstellt!');
        setShowCreateUser(false);
        loadAdminData(sessionId);
      } else {
        const error = await response.json();
        alert('Fehler: ' + (error.message || 'User konnte nicht erstellt werden'));
      }
    } catch (err) {
      alert('Fehler beim Erstellen: ' + err.message);
    }
  };

  const handleBlockUser = async (userId, block) => {
    const sessionId = localStorage.getItem('wavescout_session');
    
    if (!confirm(`User wirklich ${block ? 'sperren' : 'entsperren'}?`)) return;
    
    try {
      const response = await fetch(`${API_URL}/admin/block-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({ userId, blocked: block })
      });

      if (response.ok) {
        alert(`User ${block ? 'gesperrt' : 'entsperrt'}!`);
        loadAdminData(sessionId);
      } else {
        alert('Fehler beim Aktualisieren');
      }
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  };

  const handleLogoutUser = async (userId) => {
    const sessionId = localStorage.getItem('wavescout_session');
    
    if (!confirm('User wirklich ausloggen?')) return;
    
    try {
      const response = await fetch(`${API_URL}/admin/logout-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({ userId })
      });

      if (response.ok) {
        alert('User ausgeloggt!');
        loadAdminData(sessionId);
      } else {
        alert('Fehler beim Ausloggen');
      }
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  };

  const handleChangePassword = async (userId, newPassword) => {
    const sessionId = localStorage.getItem('wavescout_session');
    
    try {
      const response = await fetch(`${API_URL}/admin/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({ userId, newPassword })
      });

      if (response.ok) {
        alert('Passwort erfolgreich geändert!');
        setShowChangePassword(false);
        setSelectedUser(null);
      } else {
        alert('Fehler beim Ändern des Passworts');
      }
    } catch (err) {
      alert('Fehler: ' + err.message);
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
          subtitle={`${users.length} Benutzer · ${users.filter(u => onlineUsers.has(u.id)).length} online`}
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
              <div className="label">Online</div>
              <div className="value win">{users.filter(u => onlineUsers.has(u.id)).length}</div>
              <div className="sub muted">Aktiv jetzt</div>
            </div>
            <div className="stat">
              <div className="label">Admins</div>
              <div className="value">{users.filter(u => u.role === 'admin').length}</div>
              <div className="sub muted">Administratoren</div>
            </div>
            <div className="stat">
              <div className="label">Gesperrt</div>
              <div className="value loss">{users.filter(u => u.blocked).length}</div>
              <div className="sub muted">Blockiert</div>
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
                  background: telegramResult.success ? 'var(--bg-success)' : 'var(--bg-error)',
                  borderRadius: 12,
                  border: `2px solid ${telegramResult.success ? 'var(--win)' : 'var(--loss)'}`
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12
                  }}>
                    <div style={{fontSize: 24}}>
                      {telegramResult.success ? '✅' : '❌'}
                    </div>
                    <div>
                      <div style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: telegramResult.success ? 'var(--win)' : 'var(--loss)'
                      }}>
                        {telegramResult.success ? 'Erfolgreich!' : 'Fehler'}
                      </div>
                      <div style={{fontSize: 13, color: 'var(--text-secondary)', marginTop: 2}}>
                        {telegramResult.message}
                      </div>
                    </div>
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
              <div className="actions">
                <button 
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowCreateUser(true)}
                >
                  <Icon name="plus" size={12}/>
                  Neuer User
                </button>
              </div>
            </div>
            {users.length === 0 ? (
              <div className="card-body" style={{padding: 60, textAlign: 'center'}}>
                <Icon name="users" size={48} style={{opacity: 0.2, marginBottom: 16}}/>
                <p style={{color: 'var(--text-tertiary)'}}>Keine Benutzer gefunden</p>
              </div>
            ) : (
              <div style={{overflowX: 'auto'}}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Benutzer</th>
                      <th>Email</th>
                      <th>Rolle</th>
                      <th>Erstellt</th>
                      <th>Aktionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u, i) => (
                      <tr key={i} style={{opacity: u.blocked ? 0.5 : 1}}>
                        <td>
                          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                            <div style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: onlineUsers.has(u.id) ? 'var(--win)' : 'var(--text-quaternary)'
                            }}/>
                            <span style={{fontSize: 11, color: 'var(--text-tertiary)'}}>
                              {onlineUsers.has(u.id) ? 'ONLINE' : 'OFFLINE'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                            <div style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              background: u.blocked ? 'var(--text-quaternary)' : 'var(--blue-500)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: 'white',
                              fontWeight: 600,
                              fontSize: 14
                            }}>
                              {u.username?.charAt(0).toUpperCase() || 'U'}
                            </div>
                            <div>
                              <div style={{fontWeight: 600}}>
                                {u.username}
                                {u.blocked && (
                                  <span className="badge badge-loss" style={{marginLeft: 8}}>
                                    GESPERRT
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="muted">{u.email}</td>
                        <td>
                          <span className={`badge ${u.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>
                            {u.role === 'admin' ? 'ADMIN' : 'USER'}
                          </span>
                        </td>
                        <td className="mono muted" style={{fontSize: 11}}>
                          {new Date(u.created_at).toLocaleDateString('de-DE', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric'
                          })}
                        </td>
                        <td>
                          <div style={{display: 'flex', gap: 6}}>
                            <button 
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setSelectedUser(u);
                                setShowChangePassword(true);
                              }}
                              title="Passwort ändern"
                            >
                              🔑
                            </button>
                            {onlineUsers.has(u.id) && (
                              <button 
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleLogoutUser(u.id)}
                                title="Ausloggen"
                              >
                                🚪
                              </button>
                            )}
                            <button 
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleBlockUser(u.id, !u.blocked)}
                              title={u.blocked ? 'Entsperren' : 'Sperren'}
                              style={{
                                color: u.blocked ? 'var(--win)' : 'var(--loss)'
                              }}
                            >
                              {u.blocked ? '✓' : '🚫'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                    Total Trades
                  </div>
                  <div style={{fontSize: 14, fontWeight: 600}}>
                    {stats?.total || 0} ({stats?.winRate?.toFixed(1) || 0}% Win-Rate)
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

      {/* Create User Modal */}
      {showCreateUser && (
        <CreateUserModal
          onClose={() => setShowCreateUser(false)}
          onCreate={handleCreateUser}
        />
      )}

      {/* Change Password Modal */}
      {showChangePassword && selectedUser && (
        <ChangePasswordModal
          user={selectedUser}
          onClose={() => {
            setShowChangePassword(false);
            setSelectedUser(null);
          }}
          onSave={handleChangePassword}
        />
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// CREATE USER MODAL
// ═══════════════════════════════════════════════════════════════

const CreateUserModal = ({ onClose, onCreate }) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    role: 'user'
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.username || !formData.email || !formData.password) {
      alert('Bitte alle Felder ausfüllen!');
      return;
    }

    onCreate(formData);
  };

  return (
    <div 
      className="modal-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={onClose}
    >
      <div 
        className="modal-content"
        style={{
          background: 'var(--bg-1)',
          borderRadius: 16,
          padding: 32,
          maxWidth: 500,
          width: '90%',
          border: '1px solid var(--border)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{marginBottom: 24}}>Neuen User anlegen</h2>
        
        <form onSubmit={handleSubmit}>
          <div style={{marginBottom: 16}}>
            <label style={{display: 'block', marginBottom: 8}}>Benutzername</label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({...formData, username: e.target.value})}
              className="input"
              placeholder="z.B. peter"
            />
          </div>

          <div style={{marginBottom: 16}}>
            <label style={{display: 'block', marginBottom: 8}}>Email</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({...formData, email: e.target.value})}
              className="input"
              placeholder="z.B. peter@example.com"
            />
          </div>

          <div style={{marginBottom: 16}}>
            <label style={{display: 'block', marginBottom: 8}}>Passwort</label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({...formData, password: e.target.value})}
              className="input"
              placeholder="Mindestens 8 Zeichen"
            />
          </div>

          <div style={{marginBottom: 24}}>
            <label style={{display: 'block', marginBottom: 8}}>Rolle</label>
            <select
              value={formData.role}
              onChange={(e) => setFormData({...formData, role: e.target.value})}
              className="input"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div style={{display: 'flex', gap: 12}}>
            <button type="submit" className="btn btn-primary" style={{flex: 1}}>
              User erstellen
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Abbrechen
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// CHANGE PASSWORD MODAL
// ═══════════════════════════════════════════════════════════════

const ChangePasswordModal = ({ user, onClose, onSave }) => {
  const [newPassword, setNewPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!newPassword || newPassword.length < 8) {
      alert('Passwort muss mindestens 8 Zeichen lang sein!');
      return;
    }

    onSave(user.id, newPassword);
  };

  return (
    <div 
      className="modal-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={onClose}
    >
      <div 
        className="modal-content"
        style={{
          background: 'var(--bg-1)',
          borderRadius: 16,
          padding: 32,
          maxWidth: 500,
          width: '90%',
          border: '1px solid var(--border)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{marginBottom: 8}}>Passwort ändern</h2>
        <p style={{color: 'var(--text-secondary)', marginBottom: 24}}>
          Für User: <strong>{user.username}</strong>
        </p>
        
        <form onSubmit={handleSubmit}>
          <div style={{marginBottom: 24}}>
            <label style={{display: 'block', marginBottom: 8}}>Neues Passwort</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input"
              placeholder="Mindestens 8 Zeichen"
              autoFocus
            />
          </div>

          <div style={{display: 'flex', gap: 12}}>
            <button type="submit" className="btn btn-primary" style={{flex: 1}}>
              Passwort ändern
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Abbrechen
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<AdminPage/>);
