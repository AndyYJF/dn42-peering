import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dbPath = path.resolve(process.cwd(), config.dbPath);
mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS peerings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asn         INTEGER NOT NULL,
  mntner      TEXT    NOT NULL,
  node_id     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  wg_pubkey   TEXT    NOT NULL,
  wg_endpoint TEXT,
  peer_ll     TEXT    NOT NULL,
  peer_v4     TEXT,
  peer_v6     TEXT,
  mp_bgp      INTEGER NOT NULL DEFAULT 1,
  enh         INTEGER NOT NULL DEFAULT 1,
  wg_port     INTEGER NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'auto',
  iface       TEXT,
  bgp_proto   TEXT,
  last_error  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asn, node_id)
);

CREATE TABLE IF NOT EXISTS challenges (
  id         TEXT PRIMARY KEY,
  asn        INTEGER NOT NULL,
  mntner     TEXT    NOT NULL,
  method     TEXT    NOT NULL,
  key_data   TEXT    NOT NULL,
  challenge  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL DEFAULT (datetime('now')),
  asn    INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
`);

export function logEvent(asn, action, detail = '') {
  db.prepare('INSERT INTO events (asn, action, detail) VALUES (?, ?, ?)').run(asn, action, String(detail).slice(0, 500));
}

// migration for databases created before the email-code login existed
try { db.exec('ALTER TABLE challenges ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE peerings ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'"); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN iface TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN bgp_proto TEXT'); } catch { /* already there */ }
try { db.exec("ALTER TABLE peerings ADD COLUMN operational_state TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already there */ }
try { db.exec("ALTER TABLE peerings ADD COLUMN bgp_state TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already there */ }
try { db.exec("ALTER TABLE peerings ADD COLUMN wg_state TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN last_handshake_at INTEGER'); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN last_established_at TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN operational_error TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE peerings ADD COLUMN last_checked_at TEXT'); } catch { /* already there */ }

export const q = {
  peeringsByAsn: db.prepare('SELECT * FROM peerings WHERE asn = ? ORDER BY created_at'),
  peeringById: db.prepare('SELECT * FROM peerings WHERE id = ?'),
  peeringByAsnNode: db.prepare('SELECT * FROM peerings WHERE asn = ? AND node_id = ?'),
  allPeerings: db.prepare('SELECT * FROM peerings ORDER BY created_at DESC'),
  countByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM peerings GROUP BY status'),
  countByNode: db.prepare("SELECT node_id, COUNT(*) AS n FROM peerings WHERE status = 'active' GROUP BY node_id"),
  portsOnNode: db.prepare('SELECT wg_port FROM peerings WHERE node_id = ?'),
  insertPeering: db.prepare(`INSERT INTO peerings
    (asn, mntner, node_id, status, wg_pubkey, wg_endpoint, peer_ll, peer_v4, peer_v6, mp_bgp, enh, wg_port)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updatePeering: db.prepare(`UPDATE peerings SET
    wg_pubkey = ?, wg_endpoint = ?, peer_ll = ?, peer_v4 = ?, peer_v6 = ?, mp_bgp = ?, enh = ?,
    updated_at = datetime('now') WHERE id = ?`),
  upsertDiscoveredPeering: db.prepare(`INSERT INTO peerings
    (asn, mntner, node_id, status, wg_pubkey, wg_endpoint, peer_ll, peer_v4, peer_v6, mp_bgp, enh, wg_port, source, iface, bgp_proto, last_error)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, NULL)
    ON CONFLICT(asn, node_id) DO UPDATE SET
      wg_pubkey = excluded.wg_pubkey,
      wg_endpoint = excluded.wg_endpoint,
      peer_ll = excluded.peer_ll,
      peer_v4 = excluded.peer_v4,
      peer_v6 = excluded.peer_v6,
      mp_bgp = excluded.mp_bgp,
      enh = excluded.enh,
      wg_port = excluded.wg_port,
      iface = excluded.iface,
      bgp_proto = excluded.bgp_proto,
      status = CASE WHEN peerings.source = 'manual' THEN 'active' ELSE peerings.status END,
      last_error = CASE WHEN peerings.source = 'manual' THEN NULL ELSE peerings.last_error END,
      updated_at = datetime('now')
    WHERE peerings.source = 'manual'`),
  setStatus: db.prepare("UPDATE peerings SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?"),
  setOperationalState: db.prepare(`UPDATE peerings SET
    operational_state = ?, bgp_state = ?, wg_state = ?,
    last_handshake_at = COALESCE(?, last_handshake_at),
    last_established_at = COALESCE(?, last_established_at),
    operational_error = ?, last_checked_at = ?
    WHERE id = ?`),
  clearOperationalState: db.prepare(`UPDATE peerings SET
    operational_state = 'unknown', bgp_state = 'unknown', wg_state = 'unknown',
    operational_error = NULL, last_checked_at = NULL WHERE id = ?`),
  markNotProvisioned: db.prepare(`UPDATE peerings SET
    operational_state = 'not-provisioned', bgp_state = 'not-provisioned', wg_state = 'not-provisioned',
    operational_error = NULL, last_checked_at = datetime('now') WHERE id = ?`),
  deletePeering: db.prepare('DELETE FROM peerings WHERE id = ?'),
  insertChallenge: db.prepare('INSERT INTO challenges (id, asn, mntner, method, key_data, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getChallenge: db.prepare('SELECT * FROM challenges WHERE id = ?'),
  useChallenge: db.prepare('UPDATE challenges SET used = 1 WHERE id = ?'),
  bumpAttempts: db.prepare('UPDATE challenges SET attempts = attempts + 1 WHERE id = ?'),
  recentEmailChallenges: db.prepare("SELECT COUNT(*) AS n FROM challenges WHERE asn = ? AND method = 'email' AND used = 0 AND attempts < 5 AND expires_at > ?"),
  // counts ALL email codes issued in the last challengeTtlSec (expires_at = created + ttl), regardless of used/attempts
  emailCodesForAsnWindow: db.prepare("SELECT COUNT(*) AS n FROM challenges WHERE asn = ? AND method = 'email' AND expires_at > ?"),
  emailCodesForRecipientWindow: db.prepare("SELECT COUNT(*) AS n FROM challenges WHERE key_data = ? AND method = 'email' AND expires_at > ?"),
  recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
};

export function recordOperationalState(id, live) {
  q.setOperationalState.run(
    live.operationalState,
    live.bgpState,
    live.wgState,
    live.lastHandshakeAt,
    live.lastEstablishedAt,
    live.ok ? null : live.summary,
    live.checkedAt,
    id,
  );
}
