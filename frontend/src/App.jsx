import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link } from 'react-router-dom';
import { Home } from './pages/Home.jsx';
import { Wizard } from './pages/Wizard.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Admin } from './pages/Admin.jsx';
import { api, getAuth, clearToken } from './api.js';
import { Led } from './components/ui.jsx';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">{now.toISOString().slice(11, 19)} UTC</span>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  );
  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('pd-theme', theme); } catch { /* ignore */ }
  }, [theme]);
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'light' ? 'DARK' : 'LIGHT'}
    </button>
  );
}

function TopBar({ info, auth, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Close mobile nav on escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Prevent background scroll when mobile menu is open
  useEffect(() => {
    if (menuOpen) {
      document.body.classList.add('menu-open');
    } else {
      document.body.classList.remove('menu-open');
    }
    return () => document.body.classList.remove('menu-open');
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand" onClick={closeMenu}>
          <span className="brand-mark"><Led color="amber" /></span>
          <span>
            <span className="brand-name">PEERING<b>/</b>DESK</span>
            <br />
            <span className="brand-asn">AS{info?.ourAsn || '——'} · {info?.networkName || 'DN42'}</span>
          </span>
        </Link>

        {/* Desktop navigation */}
        <nav className="nav desktop-nav">
          <NavLink to="/" end>Network</NavLink>
          <NavLink to="/peer">Peer with us</NavLink>
          <NavLink to="/dashboard">My sessions</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>

        {/* Desktop right controls */}
        <div className="topbar-right desktop-right">
          <Clock />
          <ThemeToggle />
          {auth && (
            <span className="auth-chip">
              <Led color="grn" />
              AS{auth.asn}
              <button type="button" onClick={onLogout} title="log out">✕</button>
            </span>
          )}
        </div>

        {/* Mobile controls & hamburger button */}
        <div className="mobile-controls">
          <ThemeToggle />
          <button
            type="button"
            className={`nav-toggle ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            <span className="nav-toggle-bar" />
            <span className="nav-toggle-bar" />
            <span className="nav-toggle-bar" />
          </button>
        </div>
      </div>

      {/* Mobile Drawer Overlay & Nav */}
      <div className={`mobile-nav-backdrop ${menuOpen ? 'visible' : ''}`} onClick={closeMenu} />
      <div className={`mobile-nav-drawer ${menuOpen ? 'open' : ''}`}>
        <div className="mobile-nav-links">
          <NavLink to="/" end onClick={closeMenu}>
            <span className="mobile-nav-icon">◈</span> Network
          </NavLink>
          <NavLink to="/peer" onClick={closeMenu}>
            <span className="mobile-nav-icon">⚡</span> Peer with us
          </NavLink>
          <NavLink to="/dashboard" onClick={closeMenu}>
            <span className="mobile-nav-icon">◫</span> My sessions
          </NavLink>
          <NavLink to="/admin" onClick={closeMenu}>
            <span className="mobile-nav-icon">⚙</span> Admin
          </NavLink>
        </div>

        <div className="mobile-nav-footer">
          <div className="mobile-nav-meta">
            <Clock />
            {auth && (
              <span className="auth-chip">
                <Led color="grn" />
                AS{auth.asn}
                <button
                  type="button"
                  onClick={() => {
                    onLogout();
                    closeMenu();
                  }}
                  title="log out"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer({ info }) {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <div>
          <h4>Peering/Desk</h4>
          <p style={{ margin: 0 }}>
            Self-service peering for {info?.networkName || 'this network'} (AS{info?.ourAsn}).
            Verify your DN42 identity, pick a node, and the tunnel + BGP session is provisioned automatically.
          </p>
        </div>
        <div>
          <h4>Resources</h4>
          <ul>
            <li><a href="https://dn42.dev" target="_blank" rel="noreferrer">DN42 wiki</a></li>
            <li><a href="https://explorer.burble.com" target="_blank" rel="noreferrer">Registry explorer</a></li>
            <li><a href="https://dn42.dev/howto/wireguard" target="_blank" rel="noreferrer">WireGuard how-to</a></li>
            <li><a href="https://dn42.dev/howto/Bird2" target="_blank" rel="noreferrer">BIRD2 how-to</a></li>
          </ul>
        </div>
        <div>
          <h4>Status legend</h4>
          <ul>
            <li className="legend"><Led color="grn" /> session established</li>
            <li className="legend"><Led color="amber" blink /> provisioning / pending</li>
            <li className="legend"><Led color="red" /> error — check config</li>
            <li className="legend"><Led color="off" /> disabled</li>
          </ul>
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  const [info, setInfo] = useState(null);
  const [auth, setAuth] = useState(getAuth());

  useEffect(() => {
    api.info().then(setInfo).catch(() => {});
  }, []);

  const logout = () => {
    clearToken();
    setAuth(null);
  };

  return (
    <BrowserRouter>
      <TopBar info={info} auth={auth} onLogout={logout} />
      {info?.demo && (
        <div className="wrap">
          <div className="alert warn xs" style={{ marginTop: 14 }}>
            DEMO MODE — signature checks and node agents are simulated. Type <b>demo</b> as the signature to log in.
          </div>
        </div>
      )}
      <main className="wrap">
        <Routes>
          <Route path="/" element={<Home info={info} />} />
          <Route path="/peer" element={<Wizard info={info} auth={auth} onAuthed={() => setAuth(getAuth())} />} />
          <Route path="/dashboard" element={<Dashboard auth={auth} />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
      <Footer info={info} />
    </BrowserRouter>
  );
}
