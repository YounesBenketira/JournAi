import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';

test('local device approval preserves browser binding, scopes and single use', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db, { origin: 'http://127.0.0.1' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = 'http://127.0.0.1';
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, data };
  };
  try {
    const account = await request('/api/register', { email: 'device-test@example.com', credential: 'a'.repeat(64) });
    assert.equal(account.status, 201);
    const appHeaders = { Authorization: `Bearer ${account.data.token}` };
    const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const client = await request('/oauth/register', { redirect_uris: [callback], client_name: 'Local test client' });
    const verifier = 'local-test-verifier-'.repeat(4);
    const params = { client_id: client.data.client_id, redirect_uri: callback, response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      resource: `${origin}/mcp`, scope: 'todos:read notes:read', state: 'local-state' };
    const consent = await request('/oauth/authorize?' + new URLSearchParams(params));
    const requestId = consent.data.match(/data-request="([^"]+)"/)[1];
    const csrf = consent.data.match(/data-csrf="([^"]+)"/)[1];
    const proof = { requestId, csrf };
    const browserHeaders = { Origin: origin, Cookie: `journai_oauth=${csrf}` };
    assert.equal((await request('/oauth/device/start', proof)).status, 403);
    const start = await request('/oauth/device/start', proof, browserHeaders);
    assert.equal(start.status, 200);
    const codeBody = { code: start.data.code };
    assert.equal((await request('/api/connections/approve', codeBody)).status, 401);
    const preview = await request('/api/connections/preview', codeBody, appHeaders);
    assert.deepEqual(preview.data.scopes, ['todos:read', 'notes:read']);
    assert.deepEqual((await request('/oauth/device/status', proof, browserHeaders)).data, { pending: true });
    assert.equal((await request('/api/connections/approve', { code: 'x'.repeat(43) }, appHeaders)).status, 400);
    assert.equal((await request('/api/connections/approve', codeBody, appHeaders)).status, 204);
    assert.equal((await request('/api/connections/approve', codeBody, appHeaders)).status, 409);
    assert.equal((await request('/oauth/device/status', proof)).status, 403);
    const approved = await request('/oauth/device/status', proof, browserHeaders);
    assert.equal(approved.status, 200);
    const redirect = new URL(approved.data.redirect);
    assert.equal(redirect.searchParams.get('state'), 'local-state');
    assert.equal(redirect.searchParams.get('iss'), origin);
    assert.equal((await request('/oauth/device/status', proof, browserHeaders)).status, 403);
    assert.equal((await request('/api/connections/preview', codeBody, appHeaders)).status, 400);
    const exchange = { grant_type: 'authorization_code', client_id: params.client_id, redirect_uri: callback,
      code_verifier: verifier, resource: params.resource, code: redirect.searchParams.get('code') };
    const grant = await request('/oauth/token', exchange);
    assert.equal(grant.status, 200);
    assert.equal(grant.data.scope, 'todos:read notes:read');
    assert.equal((await request('/oauth/token', exchange)).status, 400);
    const grantedAccount = db.prepare("SELECT account_id FROM sessions WHERE kind='mcp' AND client_id=?").get(params.client_id);
    assert.equal(grantedAccount.account_id, account.data.account.id);
    const nextConsent = await request('/oauth/authorize?' + new URLSearchParams(params));
    const nextProof = { requestId: nextConsent.data.match(/data-request="([^"]+)"/)[1], csrf: nextConsent.data.match(/data-csrf="([^"]+)"/)[1] };
    const nextHeaders = { Origin: origin, Cookie: `journai_oauth=${nextProof.csrf}` };
    const oldCode = await request('/oauth/device/start', nextProof, nextHeaders);
    const newCode = await request('/oauth/device/start', nextProof, nextHeaders);
    assert.equal((await request('/api/connections/approve', { code: oldCode.data.code }, appHeaders)).status, 400);
    assert.equal((await request('/api/connections/approve', { code: newCode.data.code }, appHeaders)).status, 204);
    await request('/api/connections/revoke', {}, appHeaders);
    assert.deepEqual((await request('/oauth/device/status', nextProof, nextHeaders)).data, { pending: true });
    const expiring = await request('/oauth/device/start', nextProof, nextHeaders);
    db.prepare('UPDATE oauth_requests SET expires_at=0 WHERE id=?').run(nextProof.requestId);
    assert.equal((await request('/api/connections/approve', { code: expiring.data.code }, appHeaders)).status, 400);
    assert.equal((await request('/oauth/device/status', nextProof, nextHeaders)).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
