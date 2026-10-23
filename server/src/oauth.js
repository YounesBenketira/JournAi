import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, digest, fail, issueSession, token } from './security.js';
import { transaction } from './database.js';

const scopes = ['todos:read', 'todos:write', 'notes:read', 'notes:write'];
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function redirectAllowed(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.hash && !url.username && !url.password
      && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

function consentPage(name, requestId, csrf) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect JournAi</title><link rel="stylesheet" href="/auth.css"></head><body><main>
    <h1>Connect JournAi</h1><p>${escapeHtml(name)} wants access to your todos and sticky notes.</p>
    <p>This connection can read and create or update your todos and notes, within the permissions requested. Your journal entries are never available.</p>
    <form id="consent" data-request="${escapeHtml(requestId)}" data-csrf="${escapeHtml(csrf)}">
    <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
    <p id="error" role="alert"></p><button type="submit">Sign in and allow access</button>
    <p>Close this page to cancel. You can revoke access in JournAi settings.</p></form>
    </main><script type="module" src="/consent.js"></script></body></html>`;
}

export function oauthRouter(db, origin) {
  const router = Router();
  const resource = `${origin}/mcp`;
  const limit = rateLimit({ windowMs: 900000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
  const metadata = { resource, authorization_servers: [origin], scopes_supported: scopes, bearer_methods_supported: ['header'] };
  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(metadata));
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scopes, authorization_response_iss_parameter_supported: true,
  }));
  router.post('/oauth/register', limit, (req, res) => {
    const body = z.object({ redirect_uris: z.array(z.string().url().refine(redirectAllowed)).min(1).max(5),
      client_name: z.string().max(100).default('ChatGPT'), token_endpoint_auth_method: z.literal('none').optional() }).parse(req.body);
    const id = randomUUID();
    db.prepare('INSERT INTO oauth_clients VALUES(?,?,?)').run(id, JSON.stringify(body.redirect_uris), body.client_name);
    res.status(201).json({ client_id: id, client_name: body.client_name, redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  });
  router.get('/oauth/authorize', limit, (req, res) => {
    const params = z.object({ client_id: z.string(), redirect_uri: z.string().url(), response_type: z.literal('code'),
      code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
      state: z.string().max(2000).optional(), resource: z.literal(resource), scope: z.string().default(scopes.join(' ')) }).parse(req.query);
    const client = db.prepare('SELECT * FROM oauth_clients WHERE id=?').get(params.client_id);
    if (!client || !JSON.parse(client.redirects).includes(params.redirect_uri)) fail(400, 'Invalid OAuth client or redirect.');
    if (!params.scope || params.scope.split(' ').some(s => !scopes.includes(s))) fail(400, 'Invalid scope.');
    const requestId = token();
    const csrf = token();
    db.prepare('INSERT INTO oauth_requests VALUES(?,?,?,?)').run(requestId, JSON.stringify(params), digest(csrf), Date.now() + 600000);
    res.cookie('journai_oauth', csrf, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/oauth' });
    res.type('html').send(consentPage(client.name, requestId, csrf));
  });
  router.post('/oauth/authorize', limit, async (req, res) => {
    const input = z.object({ requestId: z.string().max(100), csrf: z.string().max(100), email: z.string(), credential: z.string() }).parse(req.body);
    const request = db.prepare('SELECT * FROM oauth_requests WHERE id=? AND expires_at>?').get(input.requestId, Date.now());
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('journai_oauth='))?.slice(14);
    if (req.headers.origin !== origin || !request || cookie !== input.csrf || digest(input.csrf) !== request.csrf_hash) fail(403, 'Authorization expired. Start the connection again.');
    const account = await authenticate(db, input);
    const params = JSON.parse(request.params);
    const code = token();
    transaction(db, () => {
      if (!db.prepare('DELETE FROM oauth_requests WHERE id=?').run(input.requestId).changes) fail(400, 'Authorization already used.');
      db.prepare('INSERT INTO oauth_codes VALUES(?,?,?,?,?,?,?,?)').run(digest(code), account.id, params.client_id, params.redirect_uri, params.code_challenge, resource, params.scope, Date.now() + 120000);
    });
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', origin);
    if (params.state) redirect.searchParams.set('state', params.state);
    res.json({ redirect: redirect.toString() });
  });
  router.post('/oauth/token', limit, (req, res) => {
    const input = z.object({ grant_type: z.enum(['authorization_code', 'refresh_token']), client_id: z.string(), resource: z.literal(resource),
      code: z.string().optional(), redirect_uri: z.string().optional(), code_verifier: z.string().min(43).max(128).optional(), refresh_token: z.string().optional() }).parse(req.body);
    const result = transaction(db, () => {
      let grant;
      if (input.grant_type === 'authorization_code') {
        grant = db.prepare('SELECT * FROM oauth_codes WHERE code_hash=? AND expires_at>?').get(digest(input.code ?? ''), Date.now());
        const challenge = createHash('sha256').update(input.code_verifier ?? '').digest('base64url');
        if (!grant || grant.client_id !== input.client_id || grant.redirect_uri !== input.redirect_uri || grant.challenge !== challenge) fail(400, 'Invalid authorization code.');
        db.prepare('DELETE FROM oauth_codes WHERE code_hash=?').run(grant.code_hash);
      } else {
        grant = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND kind='refresh' AND expires_at>?").get(digest(input.refresh_token ?? ''), Date.now());
        if (!grant || grant.client_id !== input.client_id || grant.resource !== resource) fail(400, 'Invalid refresh token.');
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(grant.token_hash);
      }
      const options = { clientId: input.client_id, scope: grant.scope, resource };
      return { access_token: issueSession(db, grant.account_id, { ...options, kind: 'mcp', seconds: 3600 }),
        refresh_token: issueSession(db, grant.account_id, { ...options, kind: 'refresh', seconds: 2592000 }),
        token_type: 'Bearer', expires_in: 3600, scope: grant.scope };
    });
    res.json(result);
  });
  router.post('/oauth/revoke', limit, (req, res) => {
    const input = z.object({ token: z.string().max(200), client_id: z.string() }).parse(req.body);
    db.prepare("DELETE FROM sessions WHERE token_hash=? AND client_id=? AND kind IN ('mcp','refresh')").run(digest(input.token), input.client_id);
    res.sendStatus(200);
  });
  return router;
}
