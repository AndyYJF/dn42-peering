const CHECKED_AT = () => new Date().toISOString();

function bgpIsUp(bgp) {
  if (!bgp) return false;
  return typeof bgp.ok === 'boolean' ? bgp.ok : bgp.state === 'Established';
}

function wgIsUp(wg) {
  if (!wg) return false;
  if (typeof wg.ok === 'boolean') return wg.ok;
  if (typeof wg.handshake_recent === 'boolean') return wg.handshake_recent;
  return typeof wg.latest_handshake_age === 'number' && wg.latest_handshake_age <= 180;
}

/** Convert one live agent response into a stable operational-state record. */
export function operationalSnapshot(status, checkedAt = CHECKED_AT()) {
  const bgp = status?.bgp || null;
  const wg = status?.wireguard || null;
  const bgpUp = bgpIsUp(bgp);
  const wgUp = wgIsUp(wg);
  const bgpState = bgp?.state || 'unknown';
  const wgState = !wg
    ? 'unknown'
    : wgUp
      ? 'fresh'
      : wg.latest_handshake_at
        ? 'stale'
        : 'never';
  const issues = [];

  if (!bgp) {
    issues.push({ code: 'bgp.no-data', message: 'BGP status is missing' });
  } else {
    if (bgp.error) issues.push({ code: 'bgp.error', message: bgp.error });
    if (!bgpUp) issues.push({ code: 'bgp.down', message: `BGP is ${bgpState}` });
  }

  if (!wg) {
    issues.push({ code: 'wg.no-data', message: 'WireGuard status is missing' });
  } else {
    if (wg.error) issues.push({ code: 'wg.error', message: wg.error });
    if (!wgUp) {
      const age = wg.latest_handshake_age;
      const detail = age == null ? 'no handshake seen' : `last handshake ${age}s ago`;
      issues.push({ code: 'wg.stale', message: `WireGuard is stale: ${detail}` });
    }
  }

  let operationalState = 'down';
  if (!bgp && !wg) operationalState = 'unknown';
  else if (bgpUp && wgUp) operationalState = 'up';
  else if (bgpUp || wgUp) operationalState = 'degraded';

  return {
    ok: operationalState === 'up',
    operationalState,
    severity: operationalState === 'up' ? 'ok' : operationalState === 'unknown' ? 'info' : 'critical',
    summary: issues.length ? issues.map((i) => i.message).join('; ') : 'BGP established and WireGuard handshake is fresh',
    issues,
    bgpUp,
    wgUp,
    bgpState,
    wgState,
    lastHandshakeAt: wg?.latest_handshake_at != null && Number.isFinite(Number(wg.latest_handshake_at))
      ? Number(wg.latest_handshake_at)
      : null,
    lastEstablishedAt: bgpUp ? (bgp.since || checkedAt) : null,
    bgp,
    wireguard: wg,
    checkedAt,
  };
}

export function operationalFailure(message, checkedAt = CHECKED_AT()) {
  const detail = String(message || 'agent unreachable');
  return {
    ok: false,
    operationalState: 'unknown',
    severity: 'critical',
    summary: `agent unreachable: ${detail}`,
    issues: [{ code: 'agent.unreachable', message: detail }],
    bgpUp: false,
    wgUp: false,
    bgpState: 'unknown',
    wgState: 'unknown',
    lastHandshakeAt: null,
    lastEstablishedAt: null,
    bgp: null,
    wireguard: null,
    error: detail,
    checkedAt,
  };
}
