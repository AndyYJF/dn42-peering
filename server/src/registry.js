import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * DN42 registry lookup. Two sources:
 *  - local clone of git.dn42.dev/dn42/registry (config.registry.localPath)
 *  - burble.com explorer HTTP API (fallback)
 * Objects are normalized to arrays of [attribute, value] pairs.
 */

function parseRpsl(text) {
  const pairs = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('%') || raw.startsWith('#')) continue;
    if (/^[ \t+]/.test(raw) && pairs.length) {
      pairs[pairs.length - 1][1] += ' ' + raw.replace(/^[+\s]+/, '').trim();
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    pairs.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
  }
  return pairs;
}

async function fetchObject(type, name) {
  if (config.registry.localPath) {
    const p = path.join(config.registry.localPath, 'data', type, name);
    if (!existsSync(p)) return null;
    return parseRpsl(readFileSync(p, 'utf8'));
  }
  const url = `${config.registry.api}/${type}/${encodeURIComponent(name)}?raw`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry API ${res.status}`);
  const data = await res.json();
  // burble raw format: { "<type>/<name>": [["attr","value"], ...] } — but stay tolerant of variants
  const first = Array.isArray(data) ? data : Object.values(data)[0];
  if (!Array.isArray(first)) throw new Error('unexpected registry API response shape');
  return first.map((row) => (Array.isArray(row) ? [String(row[0]), String(row[1])] : null)).filter(Boolean);
}

const attr = (obj, key) => obj.filter(([k]) => k.toLowerCase() === key).map(([, v]) => v);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function maskEmail(e) {
  const [local, domain] = e.split('@');
  const head = local.slice(0, 2);
  const tail = local.length > 5 ? local.slice(-1) : '';
  return `${head}***${tail}@${domain}`;
}

/**
 * Contact e-mails for an ASN: aut-num admin-c/tech-c -> person/role objects,
 * `e-mail:` attributes plus `contact:` lines that contain an address.
 */
export async function lookupContactEmails(aut) {
  const handles = [...new Set([...attr(aut.raw, 'admin-c'), ...attr(aut.raw, 'tech-c')])];
  const emails = [];
  for (const h of handles) {
    const person = (await fetchObject('person', h)) || (await fetchObject('role', h));
    if (!person) continue;
    for (const v of [...attr(person, 'e-mail'), ...attr(person, 'contact')]) {
      const m = v.match(EMAIL_RE);
      const found = m && m[0].toLowerCase();
      if (found && !emails.includes(found)) emails.push(found);
    }
  }
  return emails;
}

/**
 * Fetch a PGP public key from the registry's key-cert object (PGPKEY-<last 8
 * hex digits>). Returns the armored key block or null. Note: certif lines in
 * RPSL collapse blank lines; gpg tolerates the missing blank line after the
 * armor header in most builds, so we reinsert it to be safe.
 */
export async function fetchKeyCert(fingerprint) {
  const name = `PGPKEY-${fingerprint.replace(/\s/g, '').slice(-8).toUpperCase()}`;
  const obj = await fetchObject('key-cert', name);
  if (!obj) return null;
  const lines = obj.filter(([k]) => k.toLowerCase() === 'certif').map(([, v]) => v.trim());
  if (!lines.length) return null;
  const out = [];
  for (const l of lines) {
    out.push(l === '+' || l === '' ? '' : l);
    if (l.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')) out.push('');
  }
  return out.join('\n') + '\n';
}

export async function lookupAsn(asn) {
  const aut = await fetchObject('aut-num', `AS${asn}`);
  if (!aut) return null;
  const mntners = attr(aut, 'mnt-by').filter((m) => m.toUpperCase() !== 'DN42-MNT');
  return {
    asName: attr(aut, 'as-name')[0] || `AS${asn}`,
    descr: attr(aut, 'descr')[0] || '',
    mntBy: mntners,
    raw: aut,
  };
}

/**
 * Collect usable auth methods from the ASN's maintainer objects: SSH / PGP
 * keys from mntner auth lines, then registry contact e-mails (admin-c/tech-c).
 */
export async function lookupAuthMethods(asn) {
  const aut = await lookupAsn(asn);
  if (!aut) return { aut: null, methods: [] };
  const methods = [];
  for (const m of aut.mntBy) {
    const mnt = await fetchObject('mntner', m);
    if (!mnt) continue;
    for (const line of attr(mnt, 'auth')) {
      const [scheme, ...rest] = line.split(/\s+/);
      const s = scheme.toLowerCase();
      if (s.startsWith('ssh-') || s.startsWith('ecdsa-')) {
        methods.push({
          idx: methods.length, mntner: m, type: scheme,
          keyData: `${scheme} ${rest[0]}`,
          display: `${scheme} …${rest[0].slice(-12)}${rest[1] ? ` (${rest.slice(1).join(' ')})` : ''}`,
        });
      } else if (s === 'pgp-fingerprint') {
        const fpr = rest.join('').replace(/\s/g, '').toUpperCase();
        methods.push({
          idx: methods.length, mntner: m, type: 'pgp', keyData: fpr,
          display: `PGP ${fpr.replace(/(.{4})/g, '$1 ').trim()}`,
        });
      }
    }
  }
  for (const email of await lookupContactEmails(aut)) {
    methods.push({
      idx: methods.length, mntner: aut.mntBy[0] || 'registry', type: 'email',
      keyData: email,
      display: `e-mail code to ${maskEmail(email)}`,
    });
  }
  return { aut, methods };
}
