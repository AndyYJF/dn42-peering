import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { BgpStateTag, CopyBlock, Field, Spinner, StatusTag, fmtAge, fmtBytes } from '../components/ui.jsx';
import './Dashboard.css';

const NODE_FLAGS = {
  fra: ['blk', 'red', 'gold'],
  tyo: ['white', 'jp', 'white'],
  hkt: ['red', 'red', 'red'],
  lax: ['navy', 'white', 'red'],
};

function daysAgo(iso) {
  if (!iso) return 'unknown';
  const days = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function nodeTitle(peering) {
  const node = peering.node || {};
  const name = node.name || peering.nodeId || 'Node';
  const suffix = node.publicV4 ? ` (${node.publicV4.split('.').at(-1)})` : '';
  return `${name}${suffix}`;
}

function NodeFlag({ nodeId }) {
  const colors = NODE_FLAGS[nodeId] || ['muted', 'muted', 'muted'];
  return (
    <span className={`manage-flag ${nodeId || 'unknown'}`} aria-hidden="true">
      {colors.map((c, i) => <span key={`${c}-${i}`} className={c} />)}
    </span>
  );
}

function IconButton({ label, tone = '', children, ...props }) {
  return (
    <button type="button" className={`manage-icon-btn ${tone}`} title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}

function Connectivity({ peering, status }) {
  const bgpOk = status?.bgp?.state === 'Established' || peering.status === 'active';
  const wgAge = status?.wireguard?.latest_handshake_age;
  const wgOk = typeof wgAge === 'number' ? wgAge <= 180 : peering.status === 'active';
  return (
    <div className="manage-connectivity">
      <span className={bgpOk ? 'ok' : 'warn'}>BGP {bgpOk ? 'OK' : 'WAIT'}</span>
      <span className={wgOk ? 'ok' : 'warn'}>WG {wgOk ? 'OK' : 'STALE'}</span>
    </div>
  );
}

function EditForm({ peering, onSaved, onCancel }) {
  const [form, setForm] = useState({
    wgPubkey: peering.wgPubkey,
    wgEndpoint: peering.wgEndpoint || '',
    peerLl: peering.peerLl,
    peerV4: peering.peerV4 || '',
    peerV6: peering.peerV6 || '',
    mpBgp: peering.mpBgp,
    enh: peering.enh,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      onSaved(await api.updatePeering(peering.id, {
        ...form,
        wgEndpoint: form.wgEndpoint || null,
        peerV4: form.peerV4 || null,
        peerV6: form.peerV6 || null,
      }));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="manage-edit-form">
      <div className="manage-form-grid">
        <Field label="WG public key"><input type="text" value={form.wgPubkey} onChange={set('wgPubkey')} /></Field>
        <Field label="Endpoint" hint="empty = behind NAT"><input type="text" value={form.wgEndpoint} onChange={set('wgEndpoint')} /></Field>
        <Field label="Link-local"><input type="text" value={form.peerLl} onChange={set('peerLl')} /></Field>
        <Field label="DN42 v4" hint="optional"><input type="text" value={form.peerV4} onChange={set('peerV4')} /></Field>
        <Field label="DN42 v6" hint="optional"><input type="text" value={form.peerV6} onChange={set('peerV6')} /></Field>
      </div>
      <div className="manage-checks">
        <label className="check"><input type="checkbox" checked={form.mpBgp} onChange={set('mpBgp')} /> MP-BGP</label>
        <label className="check"><input type="checkbox" checked={form.enh} onChange={set('enh')} /> extended next hop</label>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="manage-edit-actions">
        <button className="btn sm solid" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save & redeploy'}</button>
        <button className="btn sm ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function SessionDetail({ peering, status, error, view, onSaved, onCancelEdit }) {
  const o = peering.ourSide;
  if (view === 'edit') {
    return <EditForm peering={peering} onSaved={onSaved} onCancel={onCancelEdit} />;
  }

  if (view === 'ourside' && o) {
    return (
      <div className="manage-detail-grid">
        <section className="manage-detail-card wide">
          <div className="manage-card-title">Network information</div>
          <dl className="manage-kv">
            <div><dt>Endpoint</dt><dd>{o.endpoint}</dd></div>
            <div><dt>WireGuard public key</dt><dd>{o.wgPubkey}</dd></div>
            <div><dt>IPv6 link-local</dt><dd>{o.linkLocal}</dd></div>
            {o.tunnelV4 && <div><dt>DN42 IPv4</dt><dd>{o.tunnelV4}</dd></div>}
            {o.dn42V6 && <div><dt>DN42 IPv6</dt><dd>{o.dn42V6}</dd></div>}
          </dl>
        </section>
        <section className="manage-detail-card">
          <div className="manage-card-title">Copy block</div>
          <CopyBlock
            label={`our side - ${peering.nodeId}`}
            text={[
              `ASN:        AS${o.asn}`,
              `Endpoint:   ${o.endpoint}`,
              `Public key: ${o.wgPubkey}`,
              `Link-local: ${o.linkLocal}`,
              o.tunnelV4 ? `DN42 v4:    ${o.tunnelV4}` : null,
              o.dn42V6 ? `DN42 v6:    ${o.dn42V6}` : null,
            ].filter(Boolean).join('\n')}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="manage-detail-grid">
      <section className="manage-detail-card">
        <div className="manage-card-title">Live status</div>
        {error && <div className="alert" style={{ margin: 0 }}>{error}</div>}
        {status?.bgp ? (
          <div className="manage-live-metrics">
            <div><span>BGP state</span><b><BgpStateTag state={status.bgp.state} /></b></div>
            <div><span>Since</span><b>{status.bgp.since || 'unknown'}</b></div>
            <div><span>Handshake</span><b>{fmtAge(status.wireguard?.latest_handshake_age)}</b></div>
            <div><span>Transfer</span><b>{fmtBytes(status.wireguard?.rx_bytes)} / {fmtBytes(status.wireguard?.tx_bytes)}</b></div>
          </div>
        ) : (
          <p className="mut small" style={{ margin: 0 }}>{status ? `session is ${status.status} - no live data` : 'Probe this session to load live BGP and WireGuard status.'}</p>
        )}
      </section>
      <section className="manage-detail-card">
        <div className="manage-card-title">BGP indicators</div>
        <div className="manage-stat-pair">
          <div><strong>{status?.bgp?.routes?.ipv4_import ?? '-'}</strong><span>IPv4 imported</span></div>
          <div><strong>{status?.bgp?.routes?.ipv4_export ?? '-'}</strong><span>IPv4 exported</span></div>
          <div><strong>{status?.bgp?.routes?.ipv6_import ?? '-'}</strong><span>IPv6 imported</span></div>
          <div><strong>{status?.bgp?.routes?.ipv6_export ?? '-'}</strong><span>IPv6 exported</span></div>
        </div>
      </section>
    </div>
  );
}

function Session({ peering, onChanged, onDeleted }) {
  const [view, setView] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState('');

  const probe = async () => {
    setBusy(true);
    setError('');
    setView('status');
    try {
      setStatus(await api.peeringStatus(peering.id));
    } catch (e) {
      setError(e.message);
      setStatus(null);
    }
    setBusy(false);
  };

  const del = async () => {
    if (!confirmDel) return setConfirmDel(true);
    setBusy(true);
    try {
      await api.deletePeering(peering.id);
      onDeleted(peering.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const o = peering.ourSide;
  const open = view !== null;
  return (
    <>
      <tr className={open ? 'expanded' : ''}>
        <td>
          <div className="manage-node-cell">
            <NodeFlag nodeId={peering.nodeId} />
            <span>
              <b>{nodeTitle(peering)}</b>
              <small>{peering.nodeId?.toUpperCase()} - {o?.iface || peering.iface || 'wireguard'}</small>
            </span>
          </div>
        </td>
        <td><b>WireGuard</b></td>
        <td>
          <div className="manage-ip-stack">
            <span><em>LL</em>{peering.peerLl}</span>
            {peering.peerV4 && <span><em>V4</em>{peering.peerV4}</span>}
            {peering.peerV6 && <span><em>V6</em>{peering.peerV6}</span>}
          </div>
        </td>
        <td>{daysAgo(peering.createdAt)}</td>
        <td>
          <div className="manage-status-stack">
            <StatusTag status={peering.status} />
            {peering.source === 'manual' && <span className="chip amber">manual</span>}
          </div>
        </td>
        <td><Connectivity peering={peering} status={status} /></td>
        <td>
          <div className="manage-actions">
            <IconButton label="Probe session" tone="primary" onClick={probe} disabled={busy}>{busy && view === 'status' ? <Spinner /> : '⌕'}</IconButton>
            <IconButton label="Our side" onClick={() => setView(view === 'ourside' ? null : 'ourside')}>⇄</IconButton>
            {peering.source !== 'manual' && <IconButton label="Edit" onClick={() => setView(view === 'edit' ? null : 'edit')}>✎</IconButton>}
            {peering.source !== 'manual' && (
              <IconButton label={confirmDel ? 'Click again to delete' : 'Delete'} tone="danger" onClick={del} disabled={busy} onBlur={() => setConfirmDel(false)}>
                {confirmDel ? '!' : '⌫'}
              </IconButton>
            )}
          </div>
        </td>
      </tr>
      {peering.status === 'error' && peering.lastError && (
        <tr className="manage-row-alert">
          <td colSpan="7"><div className="alert" style={{ margin: 0 }}>{peering.lastError}</div></td>
        </tr>
      )}
      {open && (
        <tr className="manage-row-detail">
          <td colSpan="7">
            <SessionDetail
              peering={peering}
              status={status}
              error={error}
              view={view}
              onSaved={(updated) => { onChanged(updated); setView(null); }}
              onCancelEdit={() => setView(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export function Dashboard({ auth }) {
  const [peerings, setPeerings] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!auth) return;
    api.myPeerings().then(setPeerings).catch((e) => setError(e.message));
  }, [auth]);

  const refresh = () => {
    setError('');
    setPeerings(null);
    api.myPeerings().then(setPeerings).catch((e) => setError(e.message));
  };

  const filteredPeerings = peerings?.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [p.nodeId, p.node?.name, p.peerLl, p.peerV4, p.peerV6, p.wgEndpoint, p.status]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  if (!auth) {
    return (
      <div className="page user-manage">
        <div className="page-head manage-guest-head">
          <div className="sec-label">Dashboard</div>
          <h1 className="sec-title">My sessions</h1>
        </div>
        <div className="panel screws panel-body manage-guest-card">
          <p className="mut" style={{ marginTop: 0 }}>You are not authenticated. Verify your ASN to manage your sessions.</p>
          <Link to="/peer" className="btn solid">Verify my ASN →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page user-manage">
      <aside className="manage-sidebar" aria-label="Dashboard sections">
        <a className="active" href="#sessions"><span>→</span> My sessions</a>
        <a href="#account"><span>♙</span> My account</a>
      </aside>

      <section className="manage-content" id="sessions">
        <div className="manage-heading">
          <div>
            <div className="sec-label">Dashboard · AS{auth.asn}</div>
            <h1>My sessions</h1>
          </div>
          <div className="manage-summary">
            <span>{peerings?.length ?? 0}<small>Total</small></span>
            <span>{peerings?.filter((p) => p.status === 'active').length ?? 0}<small>Active</small></span>
          </div>
        </div>

        <div className="manage-toolbar">
          <Link to="/peer" className="manage-btn primary">→ New peering session</Link>
          <a className="manage-btn" href="https://map.dn42.dev" target="_blank" rel="noreferrer">◎ Show in Map.dn42</a>
          <button className="manage-btn" type="button" onClick={refresh}>⟳ Refresh</button>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ASN, node, IP or status..."
            className="manage-search"
          />
        </div>

        {error && <div className="alert">{error}</div>}
        {peerings === null && !error && <p className="mut"><Spinner /> loading…</p>}
        {peerings?.length === 0 && (
          <div className="manage-empty">
            <p>No sessions yet.</p>
            <Link to="/peer">Set up your first one →</Link>
          </div>
        )}
        {filteredPeerings && filteredPeerings.length > 0 && (
          <div className="manage-table-shell">
            <table className="manage-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Interface type</th>
                  <th>IP</th>
                  <th>Created at</th>
                  <th>Status</th>
                  <th>Connectivity</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPeerings.map((p) => (
                  <Session
                    key={p.id}
                    peering={p}
                    onChanged={(updated) => setPeerings(peerings.map((x) => (x.id === updated.id ? updated : x)))}
                    onDeleted={(id) => setPeerings(peerings.filter((x) => x.id !== id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {peerings && peerings.length > 0 && filteredPeerings?.length === 0 && (
          <div className="manage-empty">
            <p>No sessions match this search.</p>
            <button type="button" onClick={() => setQuery('')}>Clear search</button>
          </div>
        )}
      </section>
    </div>
  );
}
