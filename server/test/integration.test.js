import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { deriveCredentials } from '../src/credential.js';

let db, server, base;
const origin = 'https://journai.example.com';
before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db, { origin }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

async function request(path, { token, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function register(name) {
  const email = `${name}-${randomUUID()}@example.com`;
  const credentials = await deriveCredentials(email, 'a long private test password');
  const response = await request('/api/register', { body: { email, credential: credentials.credential } });
  assert.equal(response.status, 201);
  return { ...response.data, credential: credentials.credential };
}
function todo(id, createdAt, epoch = 0) {
  return { collection: 'todos', recordId: id, baseRevision: 0, deleted: false, sharingEpoch: epoch, createdAt, updatedAt: createdAt,
    payload: { id, date: '2026-10-23', content: `Todo ${id}`, completed: 0, position: 0, created_at: createdAt, updated_at: createdAt } };
}

test('accounts isolate records; sharing excludes historical, edited and delayed offline todos; revocation is immediate', async () => {
  const owner = await register('owner'); const wife = await register('wife'); const stranger = await register('stranger');
  const old = todo('historical', '2020-01-01T00:00:00.000Z');
  const saved = await request('/api/changes', { token: owner.token, body: old });
  assert.equal(saved.status, 200);
  const invite = await request('/api/sharing/invite', { token: owner.token, body: { email: wife.account.email } });
  assert.equal((await request('/api/sharing/accept', { token: stranger.token, body: { code: invite.data.code } })).status, 400);
  const accepted = await request('/api/sharing/accept', { token: wife.token, body: { code: invite.data.code } });
  assert.equal(accepted.status, 201);
  assert.equal((await request('/api/sharing/accept', { token: wife.token, body: { code: invite.data.code } })).status, 400);
  const epoch = (await request('/api/me', { token: owner.token })).data.sharingEpoch;
  const future = new Date(Date.now() + 1000).toISOString();
  assert.equal((await request('/api/changes', { token: owner.token, body: todo('new', future, epoch) })).status, 200);
  assert.equal((await request('/api/changes', { token: owner.token, body: todo('offline-old', '2020-01-01T00:00:00.000Z', 0) })).status, 200);
  assert.equal((await request('/api/changes', { token: owner.token, body: todo('old-clock-ahead', future, 0) })).status, 200);
  const edited = { ...old, baseRevision: saved.data.record.revision, createdAt: future, sharingEpoch: epoch, updatedAt: future, payload: { ...old.payload, content: 'Edited after pairing', created_at: future } };
  assert.equal((await request('/api/changes', { token: owner.token, body: edited })).status, 200);
  const shared = (await request('/api/shared-todos', { token: wife.token })).data.records;
  assert.deepEqual(shared.map(r => r.recordId), ['new']);
  assert.equal((await request('/api/shared-todos', { token: stranger.token })).data.records.length, 0);
  assert.equal((await request('/api/changes', { token: wife.token })).data.records.length, 0);
  const attempt = await request('/api/changes', { token: wife.token, body: { ...todo('new', future, epoch), baseRevision: shared[0].revision } });
  assert.equal(attempt.status, 409);
  await request(`/api/sharing/${accepted.data.id}`, { token: stranger.token, method: 'DELETE' });
  assert.equal((await request('/api/shared-todos', { token: wife.token })).data.records.length, 1);
  await request(`/api/sharing/${accepted.data.id}`, { token: owner.token, method: 'DELETE' });
  assert.equal((await request('/api/shared-todos', { token: wife.token })).data.records.length, 0);
  const reinvite = await request('/api/sharing/invite', { token: owner.token, body: { email: wife.account.email } });
  await request('/api/sharing/accept', { token: wife.token, body: { code: reinvite.data.code } });
  assert.equal((await request('/api/shared-todos', { token: wife.token })).data.records.length, 0);
});

test('sync uses revisions, preserves both sides of stale edits, supports tombstones and rejects plaintext journals', async () => {
  const user = await register('sync');
  const change = todo('collision', new Date().toISOString());
  const first = await request('/api/changes', { token: user.token, body: change });
  const retry = await request('/api/changes', { token: user.token, body: change });
  assert.equal(first.data.record.revision, retry.data.record.revision);
  const stale = await request('/api/changes', { token: user.token, body: { ...change, payload: { ...change.payload, content: 'stale edit' } } });
  assert.equal(stale.status, 409); assert.equal(stale.data.conflict.payload.content, change.payload.content);
  const deleted = await request('/api/changes', { token: user.token, body: { ...change, baseRevision: first.data.record.revision, deleted: true, payload: null } });
  assert.equal(deleted.status, 200);
  const changes = await request(`/api/changes?after=${first.data.record.revision}`, { token: user.token });
  assert.equal(changes.data.records[0].deleted, true);
  const journal = { ...change, collection: 'entries' };
  assert.equal((await request('/api/changes', { token: user.token, body: journal })).status, 400);
  assert.equal((await request('/api/changes')).status, 401);
  assert.equal((await request('/api/me', { token: user.token, headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('OAuth binds consent, PKCE, resource and client; MCP tools work and revoked grants stop working', async () => {
  const user = await register('oauth');
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const client = await request('/oauth/register', { body: { redirect_uris: [callback], client_name: 'ChatGPT' } });
  assert.equal(client.status, 201);
  assert.equal((await request('/oauth/register', { body: { redirect_uris: ['https://evil.example/callback'] } })).status, 400);
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: client.data.client_id, redirect_uri: callback, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'test-state', resource: `${origin}/mcp`, scope: 'todos:read todos:write notes:read notes:write' };
  const consent = await request(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(consent.status, 200);
  const requestId = consent.data.match(/data-request="([^"]+)"/)[1];
  const csrf = consent.data.match(/data-csrf="([^"]+)"/)[1];
  const consentBody = { requestId, csrf, email: user.account.email, credential: user.credential };
  assert.equal((await request('/oauth/authorize', { body: consentBody })).status, 403);
  const allowed = await request('/oauth/authorize', { body: consentBody, headers: { Origin: origin, Cookie: `journai_oauth=${csrf}` } });
  assert.equal(allowed.status, 200);
  const redirect = new URL(allowed.data.redirect);
  assert.equal(redirect.searchParams.get('iss'), origin);
  assert.equal(redirect.searchParams.get('state'), 'test-state');
  const exchange = { grant_type: 'authorization_code', client_id: params.client_id, code: redirect.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier, resource: params.resource };
  assert.equal((await request('/oauth/token', { body: { ...exchange, code_verifier: 'b'.repeat(64) } })).status, 400);
  const grant = await request('/oauth/token', { body: exchange });
  assert.equal(grant.status, 200);
  assert.equal((await request('/oauth/token', { body: exchange })).status, 400);
  const mcp = (method, args, access = grant.data.access_token) => request('/mcp', { token: access, headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method, params: args } });
  const list = await mcp('tools/list', {});
  assert.equal(list.status, 200);
  assert.equal(list.data.result.tools.some(t => t.name.includes('entries')), false);
  const requestIdCreate = randomUUID();
  const created = await mcp('tools/call', { name: 'create_todo', arguments: { date: '2026-10-23', content: 'From ChatGPT', requestId: requestIdCreate } });
  assert.equal(created.data.result.isError, undefined);
  const again = await mcp('tools/call', { name: 'create_todo', arguments: { date: '2026-10-23', content: 'From ChatGPT', requestId: requestIdCreate } });
  assert.deepEqual(again.data.result, created.data.result);
  assert.equal((await request('/api/changes', { token: user.token })).data.records.length, 1);
  assert.equal((await request('/api/me', { token: grant.data.access_token })).status, 401);
  const refresh = await request('/oauth/token', { body: { grant_type: 'refresh_token', client_id: params.client_id, resource: params.resource, refresh_token: grant.data.refresh_token } });
  assert.equal(refresh.status, 200);
  await request('/api/connections/revoke', { token: user.token, body: {} });
  assert.equal((await mcp('tools/list', {}, refresh.data.access_token)).status, 401);
  assert.equal((await request('/oauth/token', { body: { grant_type: 'refresh_token', client_id: params.client_id, resource: params.resource, refresh_token: refresh.data.refresh_token } })).status, 400);
});
