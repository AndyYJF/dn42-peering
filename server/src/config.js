import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function resolveConfigFile(envVar, name) {
  if (process.env[envVar]) return process.env[envVar];
  const real = path.join(root, '..', 'config', `${name}.json`);
  const example = path.join(root, '..', 'config', `${name}.example.json`);
  if (existsSync(real)) return real;
  console.warn(`[config] ${name}.json not found, falling back to ${name}.example.json — do not use in production`);
  return example;
}

const defaults = {
  networkName: 'DN42-NET',
  ourAsn: 4242420000,
  port: 8042,
  dbPath: './data/peering.db',
  jwtSecret: '',
  adminToken: '',
  autoApprove: true,
  demo: false,
  trustProxy: false,
  registry: { localPath: '', api: 'https://explorer.burble.com/api/registry' },
  keyserver: 'keys.openpgp.org',
  smtp: { host: '', port: 587, user: '', pass: '', from: '' },
  allowedAsnRanges: [[4242420000, 4242423999]],
  challengeTtlSec: 900,
  jwtTtlSec: 86400,
  maxPeeringsPerAsn: 4,
  maxEmailCodesPerWindow: 5, // hard cap on verification e-mails per ASN and per recipient within challengeTtlSec
  // Content-Security-Policy for the served SPA. script-src/connect-src are strict
  // ('self' only) so an injected script can't run inline or exfiltrate the token;
  // Google Fonts is allowed for style/font. Set to null/'' to disable, or override.
  contentSecurityPolicy: [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self'",
    "connect-src 'self'",
  ].join('; '),
};

const fileCfg = loadJson(resolveConfigFile('PEERING_CONFIG', 'config'));
const nodesCfg = loadJson(resolveConfigFile('PEERING_NODES', 'nodes'));

export const config = {
  ...defaults,
  ...fileCfg,
  registry: { ...defaults.registry, ...(fileCfg.registry || {}) },
  smtp: { ...defaults.smtp, ...(fileCfg.smtp || {}) },
  demo: process.env.PEERING_DEMO === '1' || fileCfg.demo === true,
  port: Number(process.env.PORT || fileCfg.port || defaults.port),
};

if (!config.jwtSecret || config.jwtSecret.startsWith('CHANGE-ME')) {
  if (config.demo) {
    config.jwtSecret = 'demo-secret-do-not-use-in-production';
  } else {
    console.error('[config] jwtSecret is unset — set a long random string in config.json');
    process.exit(1);
  }
}

// DEMO MODE disables signature/admin/email checks and uses a public JWT secret.
// Never let it come up in production unless explicitly forced.
if (config.demo && process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO !== '1') {
  console.error('[config] refusing to start in DEMO MODE with NODE_ENV=production (set ALLOW_DEMO=1 only if you truly intend an open demo).');
  process.exit(1);
}

export const nodes = nodesCfg.nodes;
export const nodeById = (id) => nodes.find((n) => n.id === id);

// The agent bearer token is sent on every call; over plaintext http to a
// non-loopback host it can be sniffed (-> root RCE on the node). Warn loudly.
if (!config.demo) {
  for (const n of nodes || []) {
    const url = String(n.agentUrl || '');
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
    if (url.startsWith('http://') && !loopback) {
      console.warn(`[config] node ${n.id}: agentUrl is plaintext http:// to a non-loopback host — the agent token is exposed on the wire. Use https or a private encrypted management network.`);
    }
  }
}

/** Public view of a node — never leak agent URL/token. */
export function publicNode(n) {
  const { agentUrl, agentToken, ...pub } = n;
  return pub;
}

if (config.demo) {
  console.warn('[config] DEMO MODE — signature verification and agent calls are simulated');
}
