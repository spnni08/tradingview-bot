// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - SPA ROUTER
// Single-page app: no full-page reloads on navigation
// ═══════════════════════════════════════════════════════════════

class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '60px 40px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8, color: 'var(--loss)' }}>
            Fehler beim Laden der Seite
          </div>
          <pre style={{
            fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-2)',
            padding: '12px 16px', borderRadius: 8, textAlign: 'left',
            maxWidth: 640, margin: '0 auto 20px', overflow: 'auto',
            fontFamily: 'var(--font-mono)', lineHeight: 1.5,
            border: '1px solid var(--border)'
          }}>
            {this.state.error.toString()}
            {this.state.error.stack ? '\n\n' + this.state.error.stack : ''}
          </pre>
          <button
            className="btn btn-ghost"
            onClick={() => this.setState({ error: null })}
          >
            Erneut versuchen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  const [page, setPage] = useState('dashboard');
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    <div className="app-with-sidebar">
      <Sidebar
        page={page}
        setPage={setPage}
        user={user}
        onLogout={handleLogout}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
      />
      <main className={`app-main${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <PageErrorBoundary key={page}>
          {renderPage()}
        </PageErrorBoundary>
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
