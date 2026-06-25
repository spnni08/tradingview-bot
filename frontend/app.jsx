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
  const ROUTES = {
    '/dashboard': 'dashboard',
    '/strategien': 'strategien',
    '/strategies': 'strategien',
    '/signals': 'backtest',
    '/backtesting': 'backtest',
    '/journal': 'journal',
    '/analytics': 'statistiken',
    '/admin': 'einstellungen',
    '/settings': 'einstellungen',
    '/profile': 'einstellungen'
  };
  const pageToPath = {
    dashboard: '/dashboard',
    strategien: '/strategien',
    backtest: '/backtesting',
    journal: '/journal',
    statistiken: '/analytics',
    einstellungen: '/settings'
  };
  const resolvePage = (path) => ROUTES[path] || 'dashboard';

  const [page, setPage] = useState(resolvePage(window.location.pathname));
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Track which pages have been visited so we only mount them once (lazy init).
  const [mounted, setMounted] = useState(() => new Set([resolvePage(window.location.pathname)]));

  useEffect(() => {
    // Validate session via the HttpOnly cookie (credentials: 'include').
    // Falls back to cached user info in localStorage for immediate UI render.
    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        const u = data.user;
        localStorage.setItem('wavescout_user', JSON.stringify(u));
        if (u.mustChangePassword) {
          window.location.href = 'change-password.html';
          return;
        }
        setUser(u);
        const initialPage = resolvePage(window.location.pathname);
        if (!ROUTES[window.location.pathname]) window.history.replaceState({}, '', '/dashboard');
        if (initialPage === 'admin' && u.role !== 'admin') {
          window.history.replaceState({}, '', '/dashboard');
          setPage('dashboard');
        } else {
          setPage(initialPage);
        }
        setReady(true);
      })
      .catch(() => {
        localStorage.removeItem('wavescout_user');
        window.location.href = 'login.html';
      });
  }, []);

  useEffect(() => {
    const onPop = () => setPage(resolvePage(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const handleLogout = async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      localStorage.removeItem('wavescout_user');
      sessionStorage.removeItem('wavescout_session');
      window.location.href = 'login.html';
    }
  };

  const navigate = (p) => {
    const target = p === 'admin' ? 'einstellungen' : p;
    const path = pageToPath[target] || '/dashboard';
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setPage(target);
    // Mark page as mounted so it stays alive for future visits.
    setMounted(prev => prev.has(target) ? prev : new Set([...prev, target]));
  };

  useEffect(() => {
    const h = (e) => setPage(e.detail === 'admin' ? 'einstellungen' : e.detail);
    window.addEventListener('wavescout-navigate', h);
    return () => window.removeEventListener('wavescout-navigate', h);
  }, []);

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

  const activePage = page;
  const props = { user, navigate };

  const PAGE_COMPONENTS = {
    dashboard:     <DashboardPage     {...props}/>,
    strategien:    <StrategienPage    {...props}/>,
    journal:       <JournalPage       {...props}/>,
    backtest:      <BacktestPage      {...props}/>,
    statistiken:   <StatistikenPage   {...props}/>,
    news:          <NewsPage          {...props}/>,
    einstellungen: <EinstellungenPage {...props}/>,
  };

  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="app-with-sidebar">
      <Sidebar
        page={activePage}
        setPage={(p) => { navigate(p); closeMobile(); }}
        user={user}
        onLogout={handleLogout}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
        mobileOpen={mobileOpen}
      />
      {mobileOpen && <div className="sidebar-overlay" onClick={closeMobile}/>}
      <div className="mobile-topbar">
        <button className="mobile-hamburger" onClick={() => setMobileOpen(o => !o)} aria-label="Menü">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>
        </svg>
        <span className="mobile-topbar-title">WAVESCOUT</span>
      </div>
      <main className={`app-main${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        {Object.entries(PAGE_COMPONENTS).map(([p, component]) =>
          mounted.has(p) && (
            <div key={p} style={{ display: activePage === p ? 'contents' : 'none' }}>
              <PageErrorBoundary>
                {component}
              </PageErrorBoundary>
            </div>
          )
        )}
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
