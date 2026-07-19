import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BgpStateTag, Field, Led, Spinner, StatusTag, fmtAge, fmtBytes } from '../components/ui.jsx';

const ADMIN_KEY = 'dn42_admin_token';

const pct = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);

function MiniMeter({ value, total, tone = 'grn' }) {
  const ratio = pct(value, total);
  return (
    <div className={`mini-meter ${tone}`} aria-label={`${value} of ${total}`}>
      <span className={ratio > 0 ? 'on' : ''} style={{ width: `${ratio}%` }} />
    </div>
  );
}

function StatusMetric({ label, value, detail, tone = 'grn', total }) {
  return (
    <div className={`status-metric ${tone}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      <span className="s">{detail}</span>
      {typeof total === 'number' && <MiniMeter value={Number(value) || 0} total={total} tone={tone} />}
    </div>
  );
}

function BarChart({ rows, emptyText = 'no data' }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  if (!rows.length || max === 0) return <div className="chart-empty">{emptyText}</div>;
  return (
    <div className="bar-chart">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span className="bar-label" title={r.label}>{r.label}</span>
          <span className={`bar-track ${r.tone || ''}`}>
            <span style={{ width: `${pct(r.value, max)}%` }} />
          </span>
          <span className="bar-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function LiveOverview({ rows, liveRows, issueCount, liveOk }) {
  const activeRows = rows.filter((p) => p.status === 'active');
  const probedRows = rows.filter((p) => liveRows[p.id]);
  const bgpUp = activeRows.filter((p) => liveRows[p.id]?.bgpUp).length;
  const wgUp = activeRows.filter((p) => liveRows[p.id]?.wgUp).length;
  const rxTotal = rows.reduce((n, p) => n + (liveRows[p.id]?.wireguard?.rx_bytes || 0), 0);
  const txTotal = rows.reduce((n, p) => n + (liveRows[p.id]?.wireguard?.tx_bytes || 0), 0);

  const byNode = Object.values(rows.reduce((acc, p) => {
    const id = p.nodeId || 'unknown';
    const live = liveRows[p.id];
    if (!acc[id]) acc[id] = { label: id, value: 0, issues: 0, ok: 0 };
    acc[id].value += 1;
    if (live?.ok) acc[id].ok += 1;
    if (p.status === 'error' || live?.ok === false || live?.error) acc[id].issues += 1;
    return acc;
  }, {}))
    .map((n) => ({ ...n, tone: n.issues ? 'red' : 'grn' }))
    .sort((a, b) => b.issues - a.issues || b.value - a.value || a.label.localeCompare(b.label));

  const issueBuckets = Object.values(rows.reduce((acc, p) => {
    const live = liveRows[p.id];
    const issues = p.status === 'error' && !live?.issues?.length
      ? [{ code: 'session.error' }]
      : live?.issues || [];
    issues.forEach((issue) => {
      const key = issue.code || 'unknown';
      acc[key] = acc[key] || { label: key.replace(/\./g, ' '), value: 0, tone: 'red' };
      acc[key].value += 1;
    });
    return acc;
  }, {})).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  return (
    <div className="live-overview">
      <div className="status-metrics">
        <StatusMetric label="Live OK" value={liveOk} detail={`${rows.length} sessions`} total={rows.length} />
        <StatusMetric label="Issues" value={issueCount} detail={issueCount ? 'needs attention' : 'clear'} tone={issueCount ? 'red' : 'grn'} total={rows.length} />
        <StatusMetric label="BGP up" value={bgpUp} detail={`${activeRows.length} active`} total={activeRows.length} />
        <StatusMetric label="WG fresh" value={wgUp} detail={`${probedRows.length} probed`} total={activeRows.length} tone={wgUp === activeRows.length ? 'grn' : 'amber'} />
        <StatusMetric label="Traffic" value={fmtBytes(rxTotal + txTotal)} detail={`rx ${fmtBytes(rxTotal)} / tx ${fmtBytes(txTotal)}`} tone="amber" />
      </div>
      <div className="chart-grid">
        <div className="chart-block">
          <div className="chart-title">Node sessions</div>
          <BarChart rows={byNode} />
        </div>
        <div className="chart-block">
          <div className="chart-title">Issue mix</div>
          <BarChart rows={issueBuckets.slice(0, 6)} emptyText="no live issues" />
        </div>
      </div>
    </div>
  );
}

function LiveIssueTag({ live }) {
  if (!live || live.ok !== false) return null;
  const label = live.bgpUp === false
    ? 'BGP issue'
    : live.wgUp === false
      ? 'WG issue'
      : 'Live issue';
  return (
    <span className="tag red" title={live.summary || ''} style={{ marginTop: 6, whiteSpace: 'normal', lineHeight: 1.35 }}>
      <Led color="red" />
      {label}
    </span>
  );
}

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
  const [liveRows, setLiveRows] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');
  const [filter, setFilter] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState('');

  const load = () => api.admin.peerings(token).then(setRows).catch((e) => onError(e.message));
  const loadLive = async () => {
    setLiveBusy(true);
    try {
      const live = await api.admin.livePeerings(token);
      setLiveRows(Object.fromEntries(live.map((r) => [r.id, r.live])));
      setCheckedAt(new Date().toLocaleTimeString());
    } catch (e) {
      onError(e.message);
    }
    setLiveBusy(false);
  };
  useEffect(() => {
    load();
    loadLive();
  }, []);
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(loadLive, 30000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const act = async (id, action) => {
    setBusyId(id);
    try {
      if (action === 'delete') {
        await api.admin.remove(token, id);
      } else {
        await api.admin.action(token, id, action);
      }
      await load();
      await loadLive();
    } catch (e) {
      onError(e.message);
    }
    setBusyId(null);
  };

  const syncDiscovered = async () => {
    setSyncBusy(true);
    setSyncNote('');
    try {
      const result = await api.admin.syncDiscovered(token);
      const imported = result.results?.reduce((n, r) => n + (r.imported || 0), 0) || 0;
      const skipped = result.results?.reduce((n, r) => n + (r.skipped || 0), 0) || 0;
      setSyncNote(`synced ${imported}, skipped ${skipped}`);
      await load();
      await loadLive();
    } catch (e) {
      onError(e.message);
    }
    setSyncBusy(false);
  };

  if (!rows) return <p className="mut"><Spinner /> loading…</p>;
  const isIssue = (p) => {
    const live = liveRows[p.id];
    if (p.status === 'error') return true;
    if (p.status !== 'active') return false;
    return live ? live.ok === false || !!live.error : false;
  };
  const visibleRows = filter === 'issues' ? rows.filter(isIssue) : rows;
  const liveOk = rows.filter((p) => liveRows[p.id]?.ok).length;
  const issueCount = rows.filter(isIssue).length;
  return (
    <div className="panel screws admin-sessions-panel">
      <div className="panel-head" style={{ justifyContent: 'space-between', gap: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>live session monitor</span>
          <span className="chip">ok {liveOk}</span>
          <span className={`chip ${issueCount ? 'red' : ''}`}>issues {issueCount}</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className={`btn sm ${filter === 'all' ? '' : 'ghost'}`} onClick={() => setFilter('all')}>All</button>
          <button className={`btn sm ${filter === 'issues' ? '' : 'ghost'}`} onClick={() => setFilter('issues')}>Issues</button>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            auto 30s
          </label>
          {checkedAt && <span className="dim xs">checked {checkedAt}</span>}
          {syncNote && <span className="dim xs">{syncNote}</span>}
          <button className="btn sm" onClick={syncDiscovered} disabled={syncBusy}>{syncBusy ? <Spinner /> : 'Sync discovered'}</button>
          <button className="btn sm" onClick={loadLive} disabled={liveBusy}>{liveBusy ? <Spinner /> : 'Refresh live'}</button>
        </span>
      </div>
      <LiveOverview rows={rows} liveRows={liveRows} issueCount={issueCount} liveOk={liveOk} />
      <table className="grid">
        <thead>
          <tr>
            <th>ASN</th><th>Maintainer</th><th>Node</th><th>Source</th><th>Port</th><th>Config</th><th>BGP</th><th>WG</th><th>Routes</th><th>Transfer</th><th>Endpoint</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="13" className="dim">no peering sessions yet</td></tr>}
          {rows.length > 0 && visibleRows.length === 0 && <tr><td colSpan="13" className="dim">no sessions match this view</td></tr>}
          {visibleRows.map((p) => {
            const live = liveRows[p.id];
            const routes = live?.bgp?.routes;
            const wg = live?.wireguard;
            const wgOk = typeof wg?.ok === 'boolean'
              ? wg.ok
              : typeof wg?.handshake_recent === 'boolean'
                ? wg.handshake_recent
                : typeof wg?.latest_handshake_age === 'number' && wg.latest_handshake_age <= 180;
            return (
              <tr key={p.id}>
                <td className="amber">AS{p.asn}</td>
                <td className="mut">{p.mntner}</td>
                <td>{p.nodeId}</td>
                <td><span className={`chip ${p.source === 'manual' ? 'amber' : ''}`}>{p.source || 'auto'}</span></td>
                <td className="mut">{p.wgPort}</td>
                <td>
                  <StatusTag status={p.status} />
                  {p.status === 'active' && <LiveIssueTag live={live} />}
                  {p.lastError && <div className="xs red" title={p.lastError}>{p.lastError.slice(0, 48)}…</div>}
                </td>
                <td>
                  {live?.bgp ? (
                    <>
                      <BgpStateTag state={live.bgp.state} />
                      {live.bgp.error && <div className="xs red" title={live.bgp.error}>{live.bgp.error.slice(0, 48)}…</div>}
                    </>
                  ) : <span className="dim xs">{live?.error || live?.reason || 'not probed'}</span>}
                </td>
                <td>
                  {wg ? (
                    <span className={`tag ${wgOk ? 'grn' : 'amber'}`} title={wg.error || ''}>
                      <Led color={wgOk ? 'grn' : 'amber'} blink={!wgOk} />
                      {wg.error || fmtAge(wg.latest_handshake_age)}
                    </span>
                  ) : <span className="dim xs">{live?.error ? 'agent error' : 'not probed'}</span>}
                </td>
                <td className="xs">
                  {routes ? (
                    <span>{routes.ipv4_import}/{routes.ipv4_export} v4<br />{routes.ipv6_import}/{routes.ipv6_export} v6</span>
                  ) : <span className="dim">—</span>}
                </td>
                <td className="xs">
                  {wg ? <span>rx {fmtBytes(wg.rx_bytes)}<br />tx {fmtBytes(wg.tx_bytes)}</span> : <span className="dim">—</span>}
                </td>
                <td className="mut xs">{p.wgEndpoint || '—'}</td>
                <td className="dim xs">{p.createdAt?.slice(0, 16)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {busyId === p.id ? <Spinner /> : (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {p.status === 'pending' && <button className="btn sm solid" onClick={() => act(p.id, 'approve')}>Approve</button>}
                      {p.source !== 'manual' && ['active', 'error', 'delete_failed'].includes(p.status) && <button className="btn sm" onClick={() => act(p.id, 'redeploy')}>Redeploy</button>}
                      {p.source !== 'manual' && p.status === 'active' && <button className="btn sm ghost" onClick={() => act(p.id, 'disable')}>Disable</button>}
                      {p.source !== 'manual' && p.status === 'disabled' && <button className="btn sm" onClick={() => act(p.id, 'enable')}>Enable</button>}
                      <button className="btn sm danger" onClick={() => act(p.id, 'delete')}>{p.source === 'manual' ? 'Forget' : 'Del'}</button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
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
            {n.health?.bird && <div className="row"><span className="k">BIRD</span><span className={`v ${n.health.bird_ok === false ? 'red' : ''}`}>{n.health.bird}</span></div>}
            {n.health && <div className="row"><span className="k">WG tools</span><span className={`v ${n.health.wireguard && n.health.wg_quick ? 'grn' : 'red'}`}>{n.health.wireguard && n.health.wg_quick ? 'ready' : 'missing'}</span></div>}
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
