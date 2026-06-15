import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import { q, logEvent } from '../db.js';
import { lookupAuthMethods, maskEmail } from '../registry.js';
import { verifySignature, SSH_NAMESPACE } from '../authverify.js';
import { sign, verify, randomId, randomChallenge } from '../jwt.js';
import { isValidAsn, rateLimit } from '../util.js';
import { mailEnabled, sendCode } from '../mailer.js';

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
    const usable = methods.filter((m) => m.type !== 'email' || mailEnabled() || config.demo);
    res.json({
      asn,
      asName: aut.asName,
      mntBy: aut.mntBy,
      methods: usable.map(({ idx, mntner, type, display }) => ({ idx, mntner, type, display })),
    });
  } catch (e) {
    res.status(502).json({ error: `registry lookup failed: ${e.message}` });
  }
});

// Step 2 — issue a challenge bound to one registry auth method.
authRouter.post('/challenge', async (req, res) => {
  const asn = parseAsn(req.body.asn);
  const methodIndex = Number(req.body.methodIndex);
  if (!isValidAsn(asn)) return res.status(400).json({ error: 'invalid ASN' });
  try {
    const { methods } = await lookupAuthMethods(asn);
    const method = methods[methodIndex];
    if (!method) return res.status(400).json({ error: 'unknown auth method index' });

    const id = randomId();

    if (method.type === 'email') {
      if (!mailEnabled() && !config.demo) return res.status(503).json({ error: 'e-mail login is not configured on this portal' });
      // cap outstanding codes per ASN to limit mail abuse
      if (q.recentEmailChallenges.get(asn, Date.now()).n >= 3) {
        return res.status(429).json({ error: 'too many codes requested — wait for the previous ones to expire' });
      }
      // hard ceiling on total sends per rolling window (per ASN and per recipient),
      // independent of used/attempts — stops "burn attempts then re-request" mail-bombing
      const cap = config.maxEmailCodesPerWindow;
      if (q.emailCodesForAsnWindow.get(asn, Date.now()).n >= cap ||
          q.emailCodesForRecipientWindow.get(method.keyData, Date.now()).n >= cap) {
        return res.status(429).json({ error: 'too many verification e-mails recently — try again later' });
      }
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      q.insertChallenge.run(id, asn, method.mntner, 'email', method.keyData,
        code, Date.now() + config.challengeTtlSec * 1000);
      try {
        await sendCode(method.keyData, code, asn);
      } catch (e) {
        return res.status(502).json({ error: `could not send mail: ${e.message}` });
      }
      logEvent(asn, 'auth.email-code', maskEmail(method.keyData));
      return res.json({
        challengeId: id, method: 'email', mntner: method.mntner,
        sentTo: maskEmail(method.keyData), ttlSec: config.challengeTtlSec,
      });
    }

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

const codeEqual = (a, b) => {
  const x = String(a).trim(), y = String(b).trim();
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
};

// Step 3 — verify the signature / e-mail code, mint a session token.
authRouter.post('/verify', async (req, res) => {
  const { challengeId, signature, publicKey } = req.body;
  if (!challengeId || !signature) return res.status(400).json({ error: 'challengeId and signature required' });
  const ch = q.getChallenge.get(String(challengeId));
  if (!ch || ch.used) return res.status(400).json({ error: 'challenge not found or already used' });
  if (ch.expires_at < Date.now()) return res.status(400).json({ error: 'challenge expired, request a new one' });

  let result;
  if (ch.method === 'email') {
    if (ch.attempts >= 5) return res.status(429).json({ error: 'too many wrong codes — request a new one' });
    q.bumpAttempts.run(ch.id);
    const ok = (config.demo && String(signature).trim() === 'demo') || codeEqual(signature, ch.challenge);
    result = ok ? { ok: true } : { ok: false, error: 'wrong code' };
  } else {
    result = await verifySignature(
      ch.method === 'pgp' ? 'pgp' : 'ssh', ch.key_data, ch.challenge, String(signature),
      publicKey ? String(publicKey) : undefined,
    );
  }
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
