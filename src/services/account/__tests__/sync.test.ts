import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync as DatabaseType, SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const fixture = vi.hoisted(() => ({ db: null as unknown as DatabaseType, secrets: new Map<string, string>(), origin: '' }));
vi.mock('../../../lib/secureStorage', () => ({ secureStorage: {
  get: async (key: string) => fixture.secrets.get(key) ?? null,
  set: async (key: string, value: string) => { fixture.secrets.set(key, value); },
  delete: async (key: string) => { fixture.secrets.delete(key); },
} }));
vi.mock('../../../lib/db', () => {
  const statement = (query: string, values: unknown[] = []) => {
    const prepared = fixture.db.prepare(query);
    const bindings = Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value as SQLInputValue]));
    return { all: () => prepared.all(bindings), run: () => prepared.run(bindings) };
  };
  const batch = (items: { query: string; values?: unknown[] }[]) => {
    fixture.db.exec('BEGIN');
    try { for (const item of items) statement(item.query, item.values).run(); fixture.db.exec('COMMIT'); }
    catch (error) { fixture.db.exec('ROLLBACK'); throw error; }
  };
  return {
    select: async (query: string, values: unknown[]) => statement(query, values).all(),
    execute: async (query: string, values: unknown[]) => ({ rowsAffected: statement(query, values).run().changes }),
    executeBatch: async (items: { query: string; values?: unknown[] }[]) => batch(items),
    executeBatchIfUnchanged: async (items: { query: string; values?: unknown[] }[], guards: { query: string; values: unknown[]; rows: unknown[] }[]) => {
      for (const guard of guards) if (JSON.stringify(statement(guard.query, guard.values).all()) !== JSON.stringify(guard.rows)) return false;
      batch(items); return true;
    },
  };
});

import { signIn, apiRequest, SERVER_URL } from '../client';
import { syncAccount } from '../sync';
import { createTodo, updateTodo, getTodosByDate } from '../../todos';
import { getAccountMeta, getTodoEpoch } from '../storage';
import { getPendingConflicts, markRecordDirty, resolveConflict } from '../../sync/localRepository';

function device() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entries(id TEXT PRIMARY KEY,date TEXT,content TEXT,created_at TEXT,updated_at TEXT,last_content_update TEXT,processed_at TEXT,content_hash TEXT);
    CREATE TABLE todos(id TEXT PRIMARY KEY,date TEXT,content TEXT,completed INTEGER,position INTEGER,scheduled_time TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE sticky_notes(id TEXT PRIMARY KEY,date TEXT,content TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE sync_state(collection TEXT,record_id TEXT,dirty INTEGER,deleted INTEGER,local_version INTEGER DEFAULT 0,remote_version INTEGER DEFAULT 0,updated_at TEXT,synced_at TEXT,remote_updated_at TEXT,payload_hash TEXT,PRIMARY KEY(collection,record_id));
    CREATE TABLE sync_conflicts(id TEXT PRIMARY KEY,collection TEXT,record_id TEXT,local_payload TEXT,remote_payload TEXT,created_at TEXT,resolved INTEGER);`);
  return { db, secrets: new Map<string, string>() };
}

let server: { close: (callback: () => void) => void };
let serverDb: DatabaseType;
const nativeFetch = globalThis.fetch;
const devices: ReturnType<typeof device>[] = [];
function switchTo(value: ReturnType<typeof device>) { fixture.db = value.db; fixture.secrets = value.secrets; }
function newDevice() { const value = device(); devices.push(value); switchTo(value); return value; }

beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  const appPath = '../../../../server/src/app.js';
  const dbPath = '../../../../server/src/database.js';
  const { createApp } = require(appPath);
  const { openDatabase } = require(dbPath);
  serverDb = openDatabase(':memory:');
  const listener = createApp(serverDb, { origin: SERVER_URL }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  fixture.origin = `http://127.0.0.1:${listener.address().port}`;
  server = listener;
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => nativeFetch(url.replace(SERVER_URL, fixture.origin), { ...options, signal: undefined }));
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(resolve));
  serverDb?.close();
  for (const value of devices) value.db.close();
  vi.unstubAllGlobals();
});
beforeEach(() => newDevice());

describe('account sync with real HTTP and local SQLite on two devices', () => {
  it('syncs both directions, preserves stale edits as conflicts, and resolves the chosen copy', async () => {
    const first = { db: fixture.db, secrets: fixture.secrets };
    await signIn('devices@example.com', 'a long private test password', true);
    const todo = await createTodo('2026-10-23', 'From first device');
    await syncAccount();
    const second = newDevice();
    await signIn('devices@example.com', 'a long private test password', false);
    await syncAccount();
    expect((await getTodosByDate('2026-10-23'))[0].content).toBe('From first device');
    await updateTodo(todo.id, { content: 'Second device edit' });
    await syncAccount();
    switchTo(first);
    await updateTodo(todo.id, { content: 'First device offline edit' });
    const result = await syncAccount();
    expect(result.conflicts).toBe(1);
    expect((await getTodosByDate('2026-10-23'))[0].content).toBe('First device offline edit');
    const conflicts = await getPendingConflicts();
    expect(JSON.parse(conflicts[0].remote_payload!).content).toBe('Second device edit');
    await resolveConflict(conflicts[0].id, 'remote');
    await syncAccount();
    expect((await getTodosByDate('2026-10-23'))[0].content).toBe('Second device edit');
    switchTo(second);
    expect((await getPendingConflicts()).length).toBe(0);
  });

  it('records sharing at creation and never upgrades an older todo on later sync', async () => {
    const owner = { db: fixture.db, secrets: fixture.secrets };
    await signIn('sharing-owner@example.com', 'a long private test password', true);
    const before = await createTodo('2026-10-23', 'Offline before invitation');
    const invite = await apiRequest<{ code: string }>('/sharing/invite', { method: 'POST', body: JSON.stringify({ email: 'sharing-wife@example.com' }) });
    const wife = newDevice();
    await signIn('sharing-wife@example.com', 'another private test password', true);
    await apiRequest('/sharing/accept', { method: 'POST', body: JSON.stringify(invite) });
    switchTo(owner);
    await syncAccount();
    expect(await getAccountMeta('sharingEpoch')).toBe('1');
    expect(await getTodoEpoch(before.id)).toBe(0);
    const after = await createTodo('2026-10-23', 'New shared todo');
    expect(await getTodoEpoch(after.id)).toBe(1);
    await updateTodo(before.id, { content: 'Old but edited after invitation' });
    await syncAccount();
    switchTo(wife);
    const shared = await apiRequest<{ records: { recordId: string }[] }>('/shared-todos');
    expect(shared.records.map(row => row.recordId)).toEqual([after.id]);
    expect((await getTodosByDate('2026-10-23')).length).toBe(0);
  });

  it('binds the local database to one account before any other account can upload it', async () => {
    await signIn('binding@example.com', 'a long private test password', true);
    await expect(signIn('another@example.com', 'a long private test password', true)).rejects.toThrow('belongs to another account');
  });

  it('encrypts journal content and recovers a lost upload response without duplicating or conflicting', async () => {
    const first = { db: fixture.db, secrets: fixture.secrets };
    await signIn('journal@example.com', 'a long private test password', true);
    const now = new Date().toISOString();
    fixture.db.prepare('INSERT INTO entries(id,date,content,created_at,updated_at,last_content_update) VALUES(?,?,?,?,?,?)')
      .run('private-entry', '2026-10-23', 'Only my devices can decrypt this journal', now, now, now);
    await markRecordDirty('entries', 'private-entry');
    let lost = false;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      const response = await nativeFetch(url.replace(SERVER_URL, fixture.origin), { ...options, signal: undefined });
      if (url.endsWith('/changes') && options.method === 'POST' && !lost) {
        lost = true; throw new Error('Connection dropped after upload');
      }
      return response;
    });
    await expect(syncAccount()).rejects.toThrow('Connection dropped');
    const recovered = await syncAccount();
    expect(recovered.conflicts).toBe(0);
    const stored = serverDb.prepare("SELECT payload FROM records WHERE collection='entries' AND id='private-entry'").get();
    expect(String(stored?.payload)).not.toContain('Only my devices');
    expect(String(stored?.payload)).toContain('ciphertextB64');
    newDevice();
    await signIn('journal@example.com', 'a long private test password', false);
    await syncAccount();
    const entry = fixture.db.prepare('SELECT content FROM entries WHERE id=?').get('private-entry');
    expect(entry?.content).toBe('Only my devices can decrypt this journal');
    switchTo(first);
  });
});
