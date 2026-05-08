// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - ADMIN
// ═══════════════════════════════════════════════════════════════

const AdminPage = ({ user }) => {
  const [loading, setLoading]           = useState(true);
  const [users, setUsers]               = useState([]);
  const [stats, setStats]               = useState(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramResult, setTelegramResult]   = useState(null);
  const [showCreateUser, setShowCreateUser]   = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [onlineUsers, setOnlineUsers]   = useState(new Set());

  useEffect(() => {
    if (user?.role !== 'admin') { window.location.href = 'index.html'; return; }
    const sessionId = localStorage.getItem('wavescout_session');
    loadAdminData(sessionId);
    const interval = setInterval(() => loadAdminData(sessionId), 30000);
    return () => clearInterval(interval);
  }, []);

  const loadAdminData = async (sessionId) => {
    try {
      const [usersRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/users`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`${API_URL}/stats`, { headers: { 'X-Session-ID': sessionId } })
      ]);
      if (usersRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const usersData = usersRes.ok ? await usersRes.json() : [];
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      setOnlineUsers(new Set(usersData.filter(u => u.last_seen && u.last_seen > fiveMinAgo).map(u => u.id)));
      setUsers(usersData);
      setStats(statsRes.ok ? await statsRes.json() : null);
    } catch (err) {
      console.error('Admin load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTestTelegram = async () => {
    setTelegramTesting(true);
    setTelegramResult(null);
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      const res = await fetch(`${API_URL}/test-telegram`, { headers: { 'X-Session-ID': sessionId } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTelegramResult(await res.json());
    } catch (err) {
      setTelegramResult({ success: false, message: err.message });
    } finally {
      setTelegramTesting(false);
    }
  };

  const handleCreateUser = async (userData) => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      const res = await fetch(`${API_URL}/admin/create-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify(userData)
      });
      if (res.ok) {
        setShowCreateUser(false);
        loadAdminData(sessionId);
      } else {
        const err = await res.json();
        window.alert('Fehler: ' + (err.message || 'Unbekannter Fehler'));
      }
    } catch (err) {
      window.alert('Fehler: ' + err.message);
    }
  };

  const handleBlockUser = async (userId, block) => {
    if (!window.confirm(`User wirklich ${block ? 'sperren' : 'entsperren'}?`)) return;
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/admin/block-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ userId, blocked: block })
      });
      loadAdminData(sessionId);
    } catch (err) {
      console.error('Block user error:', err);
    }
  };

  const handleLogoutUser = async (userId) => {
    if (!window.confirm('User wirklich ausloggen?')) return;
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      await fetch(`${API_URL}/admin/logout-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ userId })
      });
      loadAdminData(sessionId);
    } catch (err) {
      console.error('Logout user error:', err);
    }
  };

  const handleChangePassword = async (userId, newPassword) => {
    const sessionId = localStorage.getItem('wavescout_session');
    try {
      const res = await fetch(`${API_URL}/admin/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ userId, newPassword })
      });
      if (res.ok) { setShowChangePassword(false); setSelectedUser(null); }
      else window.alert('Fehler beim Ändern des Passworts');
    } catch (err) {
      console.error('Change password error:', err);
    }
  };

  if (loading) return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 52px)' }}>
      <div className="spinner-lg"/>
    </div>
  );

  const onlineCount = users.filter(u => onlineUsers.has(u.id)).length;

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Administration</h2>
        <p className="subtitle">{users.length} Benutzer · {onlineCount} online</p>
      </div>

      {/* System Stats */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <StatCard label="Total Users" value={users.length.toString()} sub="Registriert"/>
        <StatCard label="Online" value={onlineCount.toString()} sub="Aktiv jetzt" subTone="win"/>
        <StatCard label="Admins" value={users.filter(u => u.role === 'admin').length.toString()} sub="Administratoren"/>
        <StatCard label="Gesperrt" value={users.filter(u => u.blocked).length.toString()} sub="Blockiert" subTone="loss"/>
      </div>

      {/* Telegram */}
      <div className="card">
        <div className="card-head">
          <Icon name="bell" className="ico"/>
          <h3>Telegram Integration</h3>
        </div>
        <div className="card-body">
          <p style={{ marginBottom: 14, color: 'var(--text-secondary)', fontSize: 14 }}>
            Teste ob Telegram-Benachrichtigungen korrekt konfiguriert sind.
          </p>
          <button className="btn btn-primary" onClick={handleTestTelegram} disabled={telegramTesting}>
            {telegramTesting ? <><div className="spinner-sm"/> Sende...</> : <><Icon name="bell" size={14}/> Telegram testen</>}
          </button>
          {telegramResult && (
            <div style={{
              marginTop: 14, padding: '12px 16px', borderRadius: 10,
              background: telegramResult.success ? 'var(--bg-success)' : 'var(--bg-error)',
              border: `1px solid ${telegramResult.success ? 'var(--win)' : 'var(--loss)'}`,
              display: 'flex', alignItems: 'center', gap: 12
            }}>
              <span style={{ fontSize: 20 }}>{telegramResult.success ? '✅' : '❌'}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: telegramResult.success ? 'var(--win)' : 'var(--loss)' }}>
                  {telegramResult.success ? 'Erfolgreich!' : 'Fehler'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{telegramResult.message}</div>
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
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreateUser(true)}>
              <Icon name="plus" size={12}/> Neuer User
            </button>
          </div>
        </div>
        {users.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>Keine Benutzer</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Status</th><th>Benutzer</th><th>Rolle</th><th>Erstellt</th><th>Aktionen</th></tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={i} style={{ opacity: u.blocked ? 0.55 : 1 }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: onlineUsers.has(u.id) ? 'var(--win)' : 'var(--text-quaternary)' }}/>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {onlineUsers.has(u.id) ? 'ONLINE' : 'OFFLINE'}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: u.blocked ? 'var(--text-quaternary)' : 'var(--blue-500)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                          {(u.username || 'U').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{u.username}</div>
                          {u.email && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{u.email}</div>}
                        </div>
                        {u.blocked && <span className="badge badge-loss" style={{ marginLeft: 6 }}>GESPERRT</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'badge-win' : 'badge-wait'}`}>
                        {u.role === 'admin' ? 'ADMIN' : 'USER'}
                      </span>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>
                      {new Date(u.created_at).toLocaleDateString('de-DE')}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" title="Passwort ändern" onClick={() => { setSelectedUser(u); setShowChangePassword(true); }}>
                          <Icon name="key" size={13}/>
                        </button>
                        {onlineUsers.has(u.id) && (
                          <button className="btn btn-ghost btn-sm" title="Ausloggen" onClick={() => handleLogoutUser(u.id)}>
                            <Icon name="logout" size={13}/>
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-sm"
                          title={u.blocked ? 'Entsperren' : 'Sperren'}
                          onClick={() => handleBlockUser(u.id, !u.blocked)}
                          style={{ color: u.blocked ? 'var(--win)' : 'var(--loss)' }}
                        >
                          {u.blocked ? <Icon name="check" size={13}/> : <Icon name="x" size={13}/>}
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
        <div className="card-head"><Icon name="settings" className="ico"/><h3>System</h3></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            {[
              ['Version', 'WAVESCOUT v3.4.0 Production'],
              ['Backend', 'Cloudflare Workers'],
              ['Datenbank', 'Cloudflare D1'],
              ['Trades', `${stats?.total || 0} total · ${stats?.winRate?.toFixed(1) || 0}% Win-Rate`],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateUser && (
        <CreateUserModal onClose={() => setShowCreateUser(false)} onCreate={handleCreateUser}/>
      )}
      {showChangePassword && selectedUser && (
        <ChangePasswordModal
          user={selectedUser}
          onClose={() => { setShowChangePassword(false); setSelectedUser(null); }}
          onSave={handleChangePassword}
        />
      )}
    </div>
  );
};

// ─── Create User Modal ───────────────────────────────────────

const CreateUserModal = ({ onClose, onCreate }) => {
  const [formData, setFormData] = useState({ username: '', email: '', password: '', role: 'user' });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.username || !formData.email || !formData.password) {
      window.alert('Bitte alle Felder ausfüllen');
      return;
    }
    onCreate(formData);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 440, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: 20 }}>Neuen User anlegen</h2>
        <form onSubmit={handleSubmit}>
          {[
            { label: 'Benutzername', key: 'username', type: 'text', placeholder: 'z.B. peter' },
            { label: 'Email', key: 'email', type: 'email', placeholder: 'peter@example.com' },
            { label: 'Passwort', key: 'password', type: 'password', placeholder: 'Mindestens 8 Zeichen' },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key} style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>{label}</label>
              <input type={type} value={formData[key]} onChange={e => setFormData({ ...formData, [key]: e.target.value })} placeholder={placeholder} className="input" style={{ width: '100%' }}/>
            </div>
          ))}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Rolle</label>
            <select value={formData.role} onChange={e => setFormData({ ...formData, role: e.target.value })} className="input" style={{ width: '100%' }}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Erstellen</button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ─── Change Password Modal ───────────────────────────────────

const ChangePasswordModal = ({ user, onClose, onSave }) => {
  const [pw, setPw] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-1)', borderRadius: 14, padding: 28, maxWidth: 400, width: '90%', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: 6 }}>Passwort ändern</h2>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 20 }}>Für: <strong>{user.username}</strong></p>
        <form onSubmit={e => { e.preventDefault(); if (pw.length < 8) { window.alert('Mindestens 8 Zeichen'); return; } onSave(user.id, pw); }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Neues Passwort</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Mindestens 8 Zeichen" className="input" style={{ width: '100%' }} autoFocus/>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Ändern</button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  );
};

window.AdminPage = AdminPage;
