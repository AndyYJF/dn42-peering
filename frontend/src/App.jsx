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

function TopBar({ info, auth, onLogout }) {
  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand">
          <span className="brand-mark"><Led color="amber" /></span>
          <span>
            <span className="brand-name">PEERING<b>/</b>DESK</span>
            <br />
            <span className="brand-asn">AS{info?.ourAsn || '——'} · {info?.networkName || 'DN42'}</span>
          </span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end>Network</NavLink>
          <NavLink to="/peer">Peer with us</NavLink>
          <NavLink to="/dashboard">My sessions</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
        <div className="topbar-right">
          <Clock />
          {auth && (
            <span className="auth-chip">
              <Led color="grn" />
              AS{auth.asn}
              <button type="button" onClick={onLogout} title="log out">✕</button>
            </span>
          )}
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
