// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - SPA ROUTER
// Single-page app: no full-page reloads on navigation
// ═══════════════════════════════════════════════════════════════

const App = () => {
  const [page, setPage] = useState('dashboard');
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sessionId = localStorage.getItem('wavescout_session');
    const userData = localStorage.getItem('wavescout_user');

    if (!sessionId || !userData) {
      window.location.href = 'login.html';
      return;
    }

    try {
      const u = JSON.parse(userData);
      if (u.mustChangePassword) {
        window.location.href = 'change-password.html';
        return;
      }
      setUser(u);
      setReady(true);
    } catch {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  }, []);

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

  const navigate = (p) => setPage(p);

  if (!ready) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', flexDirection: 'column', gap: 16
      }}>
        <div className="spinner-lg"/>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>WAVESCOUT wird geladen...</div>
      </div>
    );
  }

  const renderPage = () => {
    const props = { user, navigate };
    switch (page) {
      case 'dashboard':     return <DashboardPage     key="dashboard"     {...props}/>;
      case 'journal':       return <JournalPage       key="journal"       {...props}/>;
      case 'backtest':      return <BacktestPage      key="backtest"      {...props}/>;
      case 'statistiken':   return <StatistikenPage   key="statistiken"   {...props}/>;
      case 'einstellungen': return <EinstellungenPage key="einstellungen" {...props}/>;
      case 'admin':
        return user?.role === 'admin'
          ? <AdminPage key="admin" {...props}/>
          : <DashboardPage key="dashboard" {...props}/>;
      default:              return <DashboardPage     key="dashboard"     {...props}/>;
    }
  };

  return (
    <div className="app">
      <Navbar page={page} setPage={setPage} user={user} onLogout={handleLogout}/>
      <main className="main">
        {renderPage()}
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
