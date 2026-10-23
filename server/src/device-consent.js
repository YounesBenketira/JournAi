import { z } from 'zod';
import { digest, fail, requireSession, token } from './security.js';
import { transaction } from './database.js';

export function browserRequest(db, req, origin) {
  const input = z.object({ requestId: z.string().max(100), csrf: z.string().max(100) }).parse(req.body);
  const request = db.prepare('SELECT * FROM oauth_requests WHERE id=? AND expires_at>?').get(input.requestId, Date.now());
  const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('journai_oauth='))?.slice(14);
  const correctOrigin = req.headers.origin === origin;
  const correctCookie = cookie === input.csrf;
  const correctCsrf = request?.csrf_hash === digest(input.csrf);
  if (!correctOrigin || !correctCookie || !correctCsrf) fail(403, 'Authorization expired. Start the connection again.');
  return request;
}

export function finishConsent(db, request, accountId, origin) {
  const params = JSON.parse(request.params);
  const code = token();
  transaction(db, () => {
    const consumed = db.prepare('DELETE FROM oauth_requests WHERE id=? AND expires_at>?').run(request.id, Date.now());
    if (!consumed.changes) fail(400, 'Authorization expired or already used.');
    db.prepare('DELETE FROM oauth_device_requests WHERE request_id=?').run(request.id);
    db.prepare('INSERT INTO oauth_codes VALUES(?,?,?,?,?,?,?,?)').run(digest(code), accountId, params.client_id,
      params.redirect_uri, params.code_challenge, params.resource, params.scope, Date.now() + 120000);
  });
  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('iss', origin);
  if (params.state) redirect.searchParams.set('state', params.state);
  return { redirect: redirect.toString() };
}

function findDeviceRequest(db, input) {
  const { code } = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(input);
  const row = db.prepare(`SELECT d.*, r.params, c.name FROM oauth_device_requests d
    JOIN oauth_requests r ON r.id=d.request_id JOIN oauth_clients c ON c.id=json_extract(r.params,'$.client_id')
    WHERE d.code_hash=? AND d.expires_at>? AND r.expires_at>?`).get(digest(code), Date.now(), Date.now());
  if (!row) fail(400, 'This connection code is invalid or expired. Start again in ChatGPT.');
  return row;
}

export function mountDeviceConsent(router, db, origin, limit) {
  router.post('/oauth/device/start', limit, (req, res) => {
    const request = browserRequest(db, req, origin);
    const code = token();
    transaction(db, () => {
      db.prepare('DELETE FROM oauth_device_requests WHERE request_id=?').run(request.id);
      db.prepare('INSERT INTO oauth_device_requests VALUES(?,?,?,?,?)').run(digest(code), request.id, null, request.expires_at, Date.now());
    });
    res.json({ code, expiresAt: request.expires_at });
  });
  router.post('/oauth/device/status', (req, res) => {
    const request = browserRequest(db, req, origin);
    const device = db.prepare('SELECT account_id FROM oauth_device_requests WHERE request_id=? AND expires_at>?').get(request.id, Date.now());
    if (!device?.account_id) return res.json({ pending: true });
    res.json(finishConsent(db, request, device.account_id, origin));
  });
  const appSession = requireSession(db, 'app', 'journai');
  router.post('/api/connections/preview', limit, appSession, (req, res) => {
    const device = findDeviceRequest(db, req.body);
    const params = JSON.parse(device.params);
    res.json({ clientName: device.name, scopes: params.scope.split(' '), expiresAt: device.expires_at });
  });
  router.post('/api/connections/approve', limit, appSession, (req, res) => {
    const device = findDeviceRequest(db, req.body);
    const approved = db.prepare('UPDATE oauth_device_requests SET account_id=? WHERE code_hash=? AND account_id IS NULL AND expires_at>?')
      .run(req.session.account_id, device.code_hash, Date.now());
    if (!approved.changes) fail(409, 'This connection has already been approved or expired.');
    res.sendStatus(204);
  });
}
