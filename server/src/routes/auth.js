import { Router } from 'express';
import { config } from '../config.js';
import { q, logEvent } from '../db.js';
import { lookupAuthMethods } from '../registry.js';
import { verifySignature, SSH_NAMESPACE } from '../authverify.js';
import { sign, verify, randomId, randomChallenge } from '../jwt.js';
import { isValidAsn, rateLimit } from '../util.js';

export const authRouter = Router();
authRouter.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 40 }));

function parseAsn(input) {
  const asn = Number(String(input ?? '').trim().replace(/^AS/i, ''));
  return Number.isInteger(asn) ? asn : NaN;
}

// Step 1 — who are you? Pull mntner auth methods from the registry.
authRouter.post('/lookup', async (req, res) => {
  const asn = parseAsn(req.body.asn);
  if (!isValidAsn(asn)) return res.status(400).json({ error: 'ASN outside the accepted DN42 ranges' });
  try {
    const { aut, methods } = await lookupAuthMethods(asn);
    if (!aut) return res.status(404).json({ error: `AS${asn} not found in the DN42 registry` });
    res.json({
      asn,
      asName: aut.asName,
      mntBy: aut.mntBy,
      methods: methods.map(({ idx, mntner, type, display }) => ({ idx, mntner, type, display })),
    });
  } catch (e) {
    res.status(502).json({ error: `registry lookup failed: ${e.message}` });
  }
});

// Step 2 — issue a challenge bound to one registry auth key.
authRouter.post('/challenge', async (req, res) => {
  const asn = parseAsn(req.body.asn);
  const methodIndex = Number(req.body.methodIndex);
  if (!isValidAsn(asn)) return res.status(400).json({ error: 'invalid ASN' });
  try {
    const { methods } = await lookupAuthMethods(asn);
    const method = methods[methodIndex];
    if (!method) return res.status(400).json({ error: 'unknown auth method index' });

    const id = randomId();
    const challenge = randomChallenge();
    q.insertChallenge.run(id, asn, method.mntner, method.type, method.keyData,
      challenge, Date.now() + config.challengeTtlSec * 1000);

    const command = method.type === 'pgp'
      ? `echo "${challenge}" | gpg --clearsign`
      : `echo -n "${challenge}" | ssh-keygen -Y sign -n ${SSH_NAMESPACE} -f ~/.ssh/<your-registry-key>`;
    res.json({ challengeId: id, challenge, method: method.type, mntner: method.mntner, command, ttlSec: config.challengeTtlSec });
  } catch (e) {
    res.status(502).json({ error: `registry lookup failed: ${e.message}` });
  }
});

// Step 3 — verify the signature, mint a session token.
authRouter.post('/verify', async (req, res) => {
  const { challengeId, signature, publicKey } = req.body;
  if (!challengeId || !signature) return res.status(400).json({ error: 'challengeId and signature required' });
  const ch = q.getChallenge.get(String(challengeId));
  if (!ch || ch.used) return res.status(400).json({ error: 'challenge not found or already used' });
  if (ch.expires_at < Date.now()) return res.status(400).json({ error: 'challenge expired, request a new one' });

  const result = await verifySignature(
    ch.method === 'pgp' ? 'pgp' : 'ssh', ch.key_data, ch.challenge, String(signature),
    publicKey ? String(publicKey) : undefined,
  );
  if (!result.ok) return res.status(401).json({ error: `verification failed: ${result.error}` });

  q.useChallenge.run(ch.id);
  logEvent(ch.asn, 'auth.verified', `${ch.mntner} via ${ch.method}`);
  const token = sign({ asn: ch.asn, mntner: ch.mntner }, config.jwtSecret, config.jwtTtlSec);
  res.json({ token, asn: ch.asn, mntner: ch.mntner, expiresIn: config.jwtTtlSec });
});

/** Express middleware: require a valid peer JWT. */
export function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verify(token, config.jwtSecret);
  if (!payload) return res.status(401).json({ error: 'authentication required' });
  req.auth = payload;
  next();
}
