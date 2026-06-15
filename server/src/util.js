import { isIP } from 'node:net';
import { config } from './config.js';

/** Validation + small helpers shared by routes. */

export const isValidAsn = (asn) =>
  Number.isInteger(asn) && config.allowedAsnRanges.some(([lo, hi]) => asn >= lo && asn <= hi);

export const isWgKey = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(s.trim());

function hextets(addr) {
  if (typeof addr !== 'string' || isIP(addr) !== 6 || addr.includes('.')) return null;
  const [left, right = ''] = addr.toLowerCase().split('::');
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const missing = 8 - l.length - r.length;
  if (missing < 0) return null;
  const parts = [...l, ...Array(missing).fill('0'), ...r];
  if (parts.length !== 8) return null;
  return parts.map((p) => parseInt(p || '0', 16));
}

export const isLinkLocal = (s) => {
  const h = hextets(String(s || '').trim());
  return !!h && h[0] === 0xfe80 && h[1] === 0 && h[2] === 0 && h[3] === 0;
};

export function isDn42V4(s) {
  if (typeof s !== 'string') return false;
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const inCidr = (base, bits) => (ip >>> (32 - bits)) === (base >>> (32 - bits));
  return inCidr(0x0a000000, 8) || inCidr(0xac140000, 14) || inCidr(0xac1f0000, 16); // 10.0.0.0/8, 172.20.0.0/14, 172.31.0.0/16
}

export const isDn42V6 = (s) => {
  const h = hextets(String(s || '').trim());
  return !!h && (h[0] & 0xff00) === 0xfd00;
};

// host:port — DNS name, IPv4, or [IPv6]
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

// host:port - DNS name, IPv4, or [IPv6]
export function isEndpoint(s) {
  if (typeof s !== 'string' || /[\r\n\t\0]/.test(s)) return false;
  const value = s.trim();
  let host, port;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0 || value[end + 1] !== ':') return false;
    host = value.slice(1, end);
    port = value.slice(end + 2);
    if (isIP(host) !== 6) return false;
  } else {
    const parts = value.split(':');
    if (parts.length !== 2) return false;
    [host, port] = parts;
    if (!(isIP(host) === 4 || HOST_RE.test(host))) return false;
  }
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export const ifaceName = (asn) => `dn42-${String(asn).slice(-4)}`;

/** Preferred dn42 convention: 2xxxx where xxxx = last 4 digits of the peer ASN. */
export function assignPort(asn, takenPorts) {
  const taken = new Set(takenPorts);
  const preferred = 20000 + Number(String(asn).slice(-4));
  if (!taken.has(preferred)) return preferred;
  for (let p = 21000; p < 30000; p++) if (!taken.has(p)) return p;
  throw new Error('no free WireGuard port on this node');
}

/** Simple fixed-window per-IP rate limiter for sensitive endpoints. */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) { // bound memory: drop expired buckets at most once per window
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      lastSweep = now;
    }
    const key = req.ip || req.socket.remoteAddress || '?';
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      return next();
    }
    if (++entry.n > max) return res.status(429).json({ error: 'rate limited, slow down' });
    next();
  };
}
