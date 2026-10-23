import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const scrypt = promisify(scryptCallback);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const credentialsSchema = z.object({ email: emailSchema, credential: z.string().regex(/^[a-f0-9]{64}$/) });
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const accountView = (row) => ({ id: row.id, email: row.email, sharingEpoch: row.sharing_epoch });

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export async function passwordHash(credential) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(credential, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

export async function authenticate(db, input) {
  const { email, credential } = credentialsSchema.parse(input);
  const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  const [salt, expected] = (account?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const key = await scrypt(credential, salt, 64);
  if (!timingSafeEqual(key, Buffer.from(expected, 'hex')) || !account) fail(401, 'Email or password is incorrect.');
  return account;
}

export function issueSession(db, accountId, { kind = 'app', clientId = null, scope = 'account', resource = 'journai', seconds = 2592000 } = {}) {
  const raw = token();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(digest(raw), accountId, Date.now() + seconds * 1000, kind, clientId, scope, resource);
  return raw;
}

export function requireSession(db, kind, resource) {
  return (req, res, next) => {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    const session = bearer && db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(digest(bearer), Date.now());
    if (!session || session.kind !== kind || session.resource !== resource) {
      if (kind === 'mcp') res.set('WWW-Authenticate', `Bearer resource_metadata="${resource.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    req.session = session;
    next();
  };
}
