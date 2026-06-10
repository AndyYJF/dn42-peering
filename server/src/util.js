import { config } from './config.js';

/** Validation + small helpers shared by routes. */

export const isValidAsn = (asn) =>
  Number.isInteger(asn) && config.allowedAsnRanges.some(([lo, hi]) => asn >= lo && asn <= hi);

export const isWgKey = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(s.trim());

export const isLinkLocal = (s) => typeof s === 'string' && /^fe80:(:[0-9a-f]{0,4}){1,4}$/i.test(s.trim());

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

export const isDn42V6 = (s) => typeof s === 'string' && /^fd[0-9a-f]{0,2}:[0-9a-f:]+$/i.test(s.trim());

// host:port — DNS name, IPv4, or [IPv6]
export const isEndpoint = (s) =>
  typeof s === 'string' &&
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{1,5}$/i.test(s.trim());

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
  return (req, res, next) => {
    const now = Date.now();
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
