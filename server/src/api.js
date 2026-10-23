import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { accountView, authenticate, credentialsSchema, digest, emailSchema, fail, issueSession, passwordHash, requireSession, token } from './security.js';
import { transaction } from './database.js';
import { recordView, sharedTodos, writeRecord } from './records.js';

export function apiRouter(db) {
  const api = Router();
  const authLimit = rateLimit({ windowMs: 900000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  api.post('/register', authLimit, async (req, res) => {
    const { email, credential } = credentialsSchema.parse(req.body);
    const hash = await passwordHash(credential);
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO accounts(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id, email, hash, new Date().toISOString());
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE')) fail(409, 'An account with this email already exists. Sign in instead.');
      throw error;
    }
    res.status(201).json({ account: { id, email, sharingEpoch: 0 }, token: issueSession(db, id) });
  });
  api.post('/login', authLimit, async (req, res) => {
    const account = await authenticate(db, req.body);
    res.json({ account: accountView(account), token: issueSession(db, account.id) });
  });
  api.use(requireSession(db, 'app', 'journai'));
  api.get('/me', (req, res) => res.json(accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.session.account_id))));
  api.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.session.token_hash);
    res.sendStatus(204);
  });
  api.get('/changes', (req, res) => {
    const after = z.coerce.number().int().nonnegative().default(0).parse(req.query.after);
    const rows = db.prepare('SELECT * FROM records WHERE owner_id = ? AND revision > ? ORDER BY revision LIMIT 100').all(req.session.account_id, after);
    res.json({ records: rows.map(recordView), cursor: rows.at(-1)?.revision ?? after, hasMore: rows.length === 100 });
  });
  api.post('/changes', (req, res) => {
    const result = writeRecord(db, req.session.account_id, req.body);
    res.status('conflict' in result ? 409 : 200).json(result);
  });
  api.get('/sharing', (req, res) => {
    const accountId = req.session.account_id;
    const rows = db.prepare(`SELECT s.id, s.accepted_at AS acceptedAt, s.owner_id AS ownerId,
      a.email AS ownerEmail, b.email AS viewerEmail FROM shares s
      JOIN accounts a ON a.id=s.owner_id JOIN accounts b ON b.id=s.viewer_id
      WHERE s.owner_id=? OR s.viewer_id=?`).all(accountId, accountId);
    const invitations = db.prepare('SELECT email, expires_at AS expiresAt FROM invitations WHERE owner_id=? AND expires_at>?').all(accountId, Date.now());
    res.json({ shares: rows, invitations });
  });
  api.post('/sharing/invite', (req, res) => {
    const email = emailSchema.parse(req.body.email);
    const owner = db.prepare('SELECT email FROM accounts WHERE id=?').get(req.session.account_id);
    if (owner.email === email) fail(400, 'Invite someone with a different account.');
    const code = token();
    const expiresAt = Date.now() + 86400000;
    transaction(db, () => {
      db.prepare('DELETE FROM invitations WHERE owner_id=? AND email=?').run(req.session.account_id, email);
      db.prepare('INSERT INTO invitations VALUES(?,?,?,?)').run(digest(code), req.session.account_id, email, expiresAt);
    });
    res.status(201).json({ code, expiresAt });
  });
  api.post('/sharing/accept', (req, res) => {
    const code = z.string().min(30).max(100).parse(req.body.code);
    const viewer = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.session.account_id);
    const share = transaction(db, () => {
      const invite = db.prepare('SELECT * FROM invitations WHERE token_hash=? AND expires_at>?').get(digest(code), Date.now());
      if (!invite || invite.email !== viewer.email) fail(400, 'This invitation is invalid, expired, or for another account.');
      const existing = db.prepare('SELECT id FROM shares WHERE owner_id=? AND viewer_id=?').get(invite.owner_id, viewer.id);
      if (existing) fail(409, 'You are already connected.');
      const owner = db.prepare('UPDATE accounts SET sharing_epoch=sharing_epoch+1 WHERE id=? RETURNING sharing_epoch').get(invite.owner_id);
      const id = randomUUID();
      const acceptedAt = new Date().toISOString();
      db.prepare('INSERT INTO shares VALUES(?,?,?,?,?)').run(id, invite.owner_id, viewer.id, acceptedAt, owner.sharing_epoch);
      db.prepare('DELETE FROM invitations WHERE token_hash=?').run(digest(code));
      return { id, acceptedAt };
    });
    res.status(201).json(share);
  });
  api.delete('/sharing/invite', (req, res) => {
    const email = emailSchema.parse(req.body.email);
    db.prepare('DELETE FROM invitations WHERE owner_id=? AND email=?').run(req.session.account_id, email);
    res.sendStatus(204);
  });
  api.delete('/sharing/:id', (req, res) => {
    db.prepare('DELETE FROM shares WHERE id=? AND (owner_id=? OR viewer_id=?)').run(req.params.id, req.session.account_id, req.session.account_id);
    res.sendStatus(204);
  });
  api.get('/shared-todos', (req, res) => res.json({ records: sharedTodos(db, req.session.account_id) }));
  api.post('/connections/revoke', (req, res) => {
    db.prepare('DELETE FROM oauth_device_requests WHERE account_id=?').run(req.session.account_id);
    db.prepare("DELETE FROM sessions WHERE account_id=? AND kind IN ('mcp','refresh')").run(req.session.account_id);
    res.sendStatus(204);
  });
  return api;
}
