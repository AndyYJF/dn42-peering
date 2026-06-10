import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Led, Spinner, StatusTag } from '../components/ui.jsx';

const ADMIN_KEY = 'dn42_admin_token';

function TokenGate({ onToken }) {
  const [token, setToken] = useState('');
  return (
    <div className="panel screws panel-body" style={{ maxWidth: 480 }}>
      <Field label="Admin token" hint="from config.json">
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && onToken(token)}
          placeholder="••••••••"
        />
      </Field>
      <button className="btn solid" disabled={!token} onClick={() => onToken(token)}>Unlock console →</button>
    </div>
  );
}

function PeeringsTable({ token, onError }) {
  const [rows, setRows] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => api.admin.peerings(token).then(setRows).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    setBusyId(id);
    try {
      if (action === 'delete') {
        await api.admin.remove(token, id);
      } else {
        await api.admin.action(token, id, action);
      }
      await load();
    } catch (e) {
      onError(e.message);
    }
    setBusyId(null);
  };

  if (!rows) return <p className="mut"><Spinner /> loading…</p>;
  return (
    <div className="panel screws" style={{ overflowX: 'auto' }}>
      <table className="grid">
        <thead>
          <tr>
            <th>ASN</th><th>Maintainer</th><th>Node</th><th>Port</th><th>Status</th><th>Endpoint</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="8" className="dim">no peering sessions yet</td></tr>}
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="amber">AS{p.asn}</td>
              <td className="mut">{p.mntner}</td>
              <td>{p.nodeId}</td>
              <td className="mut">{p.wgPort}</td>
              <td>
                <StatusTag status={p.status} />
                {p.lastError && <div className="xs red" title={p.lastError}>{p.lastError.slice(0, 48)}…</div>}
              </td>
              <td className="mut xs">{p.wgEndpoint || '—'}</td>
              <td className="dim xs">{p.createdAt?.slice(0, 16)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {busyId === p.id ? <Spinner /> : (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    {p.status === 'pending' && <button className="btn sm solid" onClick={() => act(p.id, 'approve')}>Approve</button>}
                    {(p.status === 'active' || p.status === 'error') && <button className="btn sm" onClick={() => act(p.id, 'redeploy')}>Redeploy</button>}
                    {p.status === 'active' && <button className="btn sm ghost" onClick={() => act(p.id, 'disable')}>Disable</button>}
                    {p.status === 'disabled' && <button className="btn sm" onClick={() => act(p.id, 'enable')}>Enable</button>}
                    <button className="btn sm danger" onClick={() => act(p.id, 'delete')}>Del</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodesHealth({ token, onError }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.admin.nodesHealth(token).then(setRows).catch((e) => onError(e.message));
  }, []);
  if (!rows) return <p className="mut"><Spinner /> probing agents…</p>;
  return (
    <div className="node-grid">
      {rows.map((n) => (
        <div key={n.id} className="panel screws node-card">
          <div className="head">
            <Led color={n.reachable ? 'grn' : 'red'} />
            <span className="id">{n.id}</span>
            <span className="chip cc">{n.cc}</span>
          </div>
          <div className="rows">
            <div className="row"><span className="k">Agent</span><span className={`v ${n.reachable ? 'grn' : 'red'}`}>{n.reachable ? 'reachable' : 'unreachable'}</span></div>
            {n.health?.bird && <div className="row"><span className="k">BIRD</span><span className="v">{n.health.bird}</span></div>}
            {n.health && <div className="row"><span className="k">Peers</span><span className="v">{n.health.peers ?? '—'}</span></div>}
            {n.health?.dry_run && <div className="row"><span className="k">Mode</span><span className="v amber">dry run</span></div>}
            {n.error && <div className="row"><span className="k">Error</span><span className="v red xs">{n.error}</span></div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventLog({ token, onError }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.admin.events(token).then(setRows).catch((e) => onError(e.message));
  }, []);
  if (!rows) return <p className="mut"><Spinner /> loading…</p>;
  return (
    <div className="panel screws" style={{ overflowX: 'auto' }}>
      <table className="grid">
        <thead><tr><th>Time (UTC)</th><th>ASN</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="4" className="dim">no events</td></tr>}
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="dim xs">{e.ts}</td>
              <td className="amber">{e.asn ? `AS${e.asn}` : '—'}</td>
              <td>{e.action}</td>
              <td className="mut xs">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Admin() {
  const [token, setTokenState] = useState(sessionStorage.getItem(ADMIN_KEY) || '');
  const [tab, setTab] = useState('sessions');
  const [error, setError] = useState('');

  const setToken = (t) => {
    sessionStorage.setItem(ADMIN_KEY, t);
    setTokenState(t);
    setError('');
  };

  const onError = (msg) => {
    setError(msg);
    if (/token/i.test(msg)) {
      sessionStorage.removeItem(ADMIN_KEY);
      setTokenState('');
    }
  };

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'end', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <div className="sec-label">Operator console</div>
          <h1 className="sec-title" style={{ marginBottom: 0 }}>Admin</h1>
        </div>
        {token && (
          <div style={{ marginLeft: 'auto', marginBottom: 6, display: 'flex', gap: 8 }}>
            {['sessions', 'nodes', 'log'].map((t) => (
              <button key={t} className={`btn sm ${tab === t ? '' : 'ghost'}`} onClick={() => { setTab(t); setError(''); }}>
                {t}
              </button>
            ))}
            <button className="btn sm danger" onClick={() => { sessionStorage.removeItem(ADMIN_KEY); setTokenState(''); }}>Lock</button>
          </div>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      {!token ? (
        <TokenGate onToken={setToken} />
      ) : tab === 'sessions' ? (
        <PeeringsTable key={`s${token}`} token={token} onError={onError} />
      ) : tab === 'nodes' ? (
        <NodesHealth key={`n${token}`} token={token} onError={onError} />
      ) : (
        <EventLog key={`l${token}`} token={token} onError={onError} />
      )}
    </div>
  );
}
