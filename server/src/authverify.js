import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { fetchKeyCert } from './registry.js';

export const SSH_NAMESPACE = 'dn42-peering';

/**
 * Verify an SSH signature (`ssh-keygen -Y sign -n dn42-peering`) against a registry pubkey.
 * Shells out to ssh-keygen, which must be on PATH (OpenSSH >= 8.0).
 */
export function verifySsh(pubkeyLine, challenge, signature) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dn42sig-'));
  try {
    const signers = path.join(dir, 'allowed_signers');
    const sigFile = path.join(dir, 'challenge.sig');
    writeFileSync(signers, `dn42 ${pubkeyLine}\n`);
    writeFileSync(sigFile, signature.trim() + '\n');
    const res = spawnSync('ssh-keygen', [
      '-Y', 'verify', '-f', signers, '-I', 'dn42', '-n', SSH_NAMESPACE, '-s', sigFile,
    ], { input: challenge, encoding: 'utf8', timeout: 10000 });
    if (res.error) return { ok: false, error: `ssh-keygen unavailable: ${res.error.message}` };
    if (res.status === 0) return { ok: true };
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 300);
    if (detail) console.warn('[authverify] ssh-keygen verify failed:', detail); // log server-side, don't leak to client
    return { ok: false, error: 'signature did not verify against your registry key' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gpg(env, args, input) {
  return spawnSync('gpg', ['--batch', ...args], { env, encoding: 'utf8', timeout: 25000, input });
}

/** True if a key with this exact fingerprint is now in the keyring. */
function keyInRing(env, fingerprint) {
  const res = gpg(env, ['--with-colons', '--fingerprint']);
  return res.status === 0 && (res.stdout || '').includes(`fpr:::::::::${fingerprint.toUpperCase()}:`);
}

/**
 * Get the public key for `fingerprint` into the throwaway keyring. Sources, in
 * order: armored key pasted by the user, configured + fallback keyservers,
 * DN42 registry key-cert object. The fingerprint pin is what provides trust —
 * where the key bytes come from doesn't matter.
 */
async function importKey(env, fingerprint, pastedKey) {
  const tried = [];
  if (pastedKey && pastedKey.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    gpg(env, ['--import'], pastedKey);
    if (keyInRing(env, fingerprint)) return { ok: true };
    tried.push('pasted key (fingerprint mismatch)');
  }
  for (const ks of [config.keyserver, 'keyserver.ubuntu.com']) {
    if (!ks || tried.includes(ks)) continue;
    gpg(env, ['--keyserver', ks, '--recv-keys', fingerprint]);
    if (keyInRing(env, fingerprint)) return { ok: true };
    tried.push(ks);
  }
  try {
    const cert = await fetchKeyCert(fingerprint);
    if (cert) {
      gpg(env, ['--import'], cert);
      if (keyInRing(env, fingerprint)) return { ok: true };
    }
    tried.push('registry key-cert');
  } catch {
    tried.push('registry key-cert (unreachable)');
  }
  return {
    ok: false,
    error: `public key ${fingerprint} not found (tried: ${tried.join(', ')}). ` +
      'Paste your armored public key (gpg --armor --export <fpr>) in the form, ' +
      'or upload it to a keyserver / add a key-cert to the registry.',
  };
}

/**
 * Verify a PGP clearsigned challenge against a registry-pinned fingerprint.
 */
export async function verifyPgp(fingerprint, clearsigned, challenge, pastedKey) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dn42gpg-'));
  const env = { ...process.env, GNUPGHOME: dir };
  try {
    const probe = gpg(env, ['--version']);
    if (probe.error) return { ok: false, error: `gpg unavailable: ${probe.error.message}` };

    const got = await importKey(env, fingerprint, pastedKey);
    if (!got.ok) return got;

    const msgFile = path.join(dir, 'msg.asc');
    writeFileSync(msgFile, clearsigned.trim() + '\n');
    const ver = gpg(env, ['--status-fd', '2', '--decrypt', msgFile]);
    const status = ver.stderr || '';
    const valid = status.split('\n').find((l) => l.includes('[GNUPG:] VALIDSIG'));
    if (!valid) return { ok: false, error: 'no valid signature found' };
    const fields = valid.trim().split(/\s+/);
    const sigFpr = (fields[2] || '').toUpperCase();           // fingerprint of the signing (sub)key
    const primaryFpr = (fields[fields.length - 1] || '').toUpperCase(); // primary key fingerprint
    const want = fingerprint.toUpperCase().replace(/[^0-9A-F]/g, '');
    if (want.length !== 40 && want.length !== 64) {
      return { ok: false, error: 'registry PGP fingerprint must be a full 40- or 64-hex fingerprint' };
    }
    // exact match against the signing key or its primary key — no suffix matching
    if (want !== sigFpr && want !== primaryFpr) return { ok: false, error: 'signature made by a different key' };
    if (!(ver.stdout || '').includes(challenge)) return { ok: false, error: 'signed text does not contain the challenge' };
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifySignature(method, keyData, challenge, signature, pastedKey) {
  if (config.demo && signature.trim() === 'demo') return { ok: true };
  if (method === 'pgp') return verifyPgp(keyData, signature, challenge, pastedKey);
  return verifySsh(keyData, challenge, signature);
}
