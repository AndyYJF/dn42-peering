import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { BgpStateTag, CopyBlock, Field, Spinner, StatusTag, fmtAge, fmtBytes } from '../components/ui.jsx';

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
    <div className="detail">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 18px' }}>
        <Field label="WG public key"><input type="text" value={form.wgPubkey} onChange={set('wgPubkey')} /></Field>
        <Field label="Endpoint" hint="empty = behind NAT"><input type="text" value={form.wgEndpoint} onChange={set('wgEndpoint')} /></Field>
        <Field label="Link-local"><input type="text" value={form.peerLl} onChange={set('peerLl')} /></Field>
        <Field label="DN42 v4" hint="optional"><input type="text" value={form.peerV4} onChange={set('peerV4')} /></Field>
        <Field label="DN42 v6" hint="optional"><input type="text" value={form.peerV6} onChange={set('peerV6')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 18, margin: '4px 0 16px' }}>
        <label className="check"><input type="checkbox" checked={form.mpBgp} onChange={set('mpBgp')} /> MP-BGP</label>
        <label className="check"><input type="checkbox" checked={form.enh} onChange={set('enh')} /> extended next hop</label>
      </div>
      {error && <div className="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn sm solid" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save & redeploy'}</button>
        <button className="btn sm ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function Session({ peering, onChanged, onDeleted }) {
  const [view, setView] = useState(null); // null | 'status' | 'edit' | 'ourside'
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
  return (
    <div className="panel screws sess">
      <div className="head">
        <span className="node-id">{peering.nodeId}</span>
        <span className="iface">{o?.iface} · port {peering.wgPort}</span>
        <StatusTag status={peering.status} />
        {peering.source === 'manual' && <span className="chip amber">manual read-only</span>}
        <div className="right">
          <button className="btn sm" onClick={probe} disabled={busy}>{busy && view === 'status' ? <Spinner /> : 'Probe'}</button>
          <button className="btn sm ghost" onClick={() => setView(view === 'ourside' ? null : 'ourside')}>Our side</button>
          {peering.source !== 'manual' && <button className="btn sm ghost" onClick={() => setView(view === 'edit' ? null : 'edit')}>Edit</button>}
          {peering.source !== 'manual' && (
            <button className="btn sm danger" onClick={del} disabled={busy} onBlur={() => setConfirmDel(false)}>
              {confirmDel ? 'Sure? click again' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      <div className="body">
        <div className="cell"><div className="k">Your pubkey</div><div className="v mono-cut" title={peering.wgPubkey}>{peering.wgPubkey}</div></div>
        <div className="cell"><div className="k">Your endpoint</div><div className="v">{peering.wgEndpoint || <span className="dim">behind NAT</span>}</div></div>
        <div className="cell"><div className="k">Link-local</div><div className="v">{peering.peerLl}</div></div>
        <div className="cell"><div className="k">Options</div><div className="v xs">{[peering.mpBgp && 'MP-BGP', peering.enh && 'ENH'].filter(Boolean).join(' · ') || '—'}</div></div>
      </div>

      {peering.status === 'error' && peering.lastError && (
        <div className="detail"><div className="alert" style={{ margin: 0 }}>{peering.lastError}</div></div>
      )}

      {view === 'status' && (status || error) && (
        <div className="detail">
          {error && <div className="alert" style={{ margin: 0 }}>{error}</div>}
          {status?.bgp && (
            <div className="body" style={{ padding: 0 }}>
              <div className="cell"><div className="k">BGP</div><div className="v"><BgpStateTag state={status.bgp.state} /></div></div>
              <div className="cell"><div className="k">Since</div><div className="v xs">{status.bgp.since || '—'}</div></div>
              <div className="cell"><div className="k">Routes in</div><div className="v">{status.bgp.routes ? `${status.bgp.routes.ipv4_import} v4 / ${status.bgp.routes.ipv6_import} v6` : '—'}</div></div>
              <div className="cell"><div className="k">Routes out</div><div className="v">{status.bgp.routes ? `${status.bgp.routes.ipv4_export} v4 / ${status.bgp.routes.ipv6_export} v6` : '—'}</div></div>
              <div className="cell"><div className="k">Handshake</div><div className="v">{fmtAge(status.wireguard?.latest_handshake_age)}</div></div>
              <div className="cell"><div className="k">Transfer</div><div className="v xs">↓ {fmtBytes(status.wireguard?.rx_bytes)} · ↑ {fmtBytes(status.wireguard?.tx_bytes)}</div></div>
            </div>
          )}
          {status && !status.bgp && <p className="mut small" style={{ margin: 0 }}>session is {status.status} — no live data</p>}
        </div>
      )}

      {view === 'ourside' && o && (
        <div className="detail">
          <CopyBlock
            label={`our side · ${peering.nodeId}`}
            text={[
              `ASN:        AS${o.asn}`,
              `Endpoint:   ${o.endpoint}`,
              `Public key: ${o.wgPubkey}`,
              `Link-local: ${o.linkLocal}`,
              o.tunnelV4 ? `DN42 v4:    ${o.tunnelV4}` : null,
              o.dn42V6 ? `DN42 v6:    ${o.dn42V6}` : null,
            ].filter(Boolean).join('\n')}
          />
        </div>
      )}

      {view === 'edit' && (
        <EditForm
          peering={peering}
          onSaved={(updated) => { onChanged(updated); setView(null); }}
          onCancel={() => setView(null)}
        />
      )}
    </div>
  );
}

export function Dashboard({ auth }) {
  const [peerings, setPeerings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!auth) return;
    api.myPeerings().then(setPeerings).catch((e) => setError(e.message));
  }, [auth]);

  if (!auth) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="sec-label">Dashboard</div>
          <h1 className="sec-title">My sessions</h1>
        </div>
        <div className="panel screws panel-body" style={{ maxWidth: 560 }}>
          <p className="mut" style={{ marginTop: 0 }}>You are not authenticated. Verify your ASN to manage your sessions.</p>
          <Link to="/peer" className="btn solid">Verify my ASN →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'end', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <div className="sec-label">Dashboard · AS{auth.asn}</div>
          <h1 className="sec-title" style={{ marginBottom: 0 }}>My sessions</h1>
        </div>
        <Link to="/peer" className="btn" style={{ marginLeft: 'auto', marginBottom: 6 }}>+ New session</Link>
      </div>

      {error && <div className="alert">{error}</div>}
      {peerings === null && !error && <p className="mut"><Spinner /> loading…</p>}
      {peerings?.length === 0 && (
        <div className="panel screws panel-body">
          <p className="mut" style={{ margin: 0 }}>
            No sessions yet. <Link to="/peer">Set up your first one →</Link>
          </p>
        </div>
      )}
      <div className="sess-list" style={{ marginTop: 18 }}>
        {peerings?.map((p) => (
          <Session
            key={p.id}
            peering={p}
            onChanged={(updated) => setPeerings(peerings.map((x) => (x.id === updated.id ? updated : x)))}
            onDeleted={(id) => setPeerings(peerings.filter((x) => x.id !== id))}
          />
        ))}
      </div>
    </div>
  );
}
