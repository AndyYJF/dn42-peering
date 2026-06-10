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
  registry: { localPath: '', api: 'https://explorer.burble.com/api/registry' },
  keyserver: 'keys.openpgp.org',
  smtp: { host: '', port: 587, user: '', pass: '', from: '' },
  allowedAsnRanges: [[4242420000, 4242423999]],
  challengeTtlSec: 900,
  jwtTtlSec: 86400,
  maxPeeringsPerAsn: 4,
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

export const nodes = nodesCfg.nodes;
export const nodeById = (id) => nodes.find((n) => n.id === id);

/** Public view of a node — never leak agent URL/token. */
export function publicNode(n) {
  const { agentUrl, agentToken, ...pub } = n;
  return pub;
}

if (config.demo) {
  console.warn('[config] DEMO MODE — signature verification and agent calls are simulated');
}
