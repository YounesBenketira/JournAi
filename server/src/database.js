import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, sharing_epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL, kind TEXT NOT NULL, client_id TEXT, scope TEXT NOT NULL,
      resource TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      owner_id TEXT NOT NULL REFERENCES accounts(id), collection TEXT NOT NULL,
      id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL,
      payload TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      sharing_epoch INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner_id, collection, id)
    );
    CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE INDEX IF NOT EXISTS records_revision ON records(owner_id, revision);
    CREATE TABLE IF NOT EXISTS invitations (
      token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
      email TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
      viewer_id TEXT NOT NULL REFERENCES accounts(id), accepted_at TEXT NOT NULL,
      epoch INTEGER NOT NULL, UNIQUE(owner_id, viewer_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY, redirects TEXT NOT NULL, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_requests (
      id TEXT PRIMARY KEY, params TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_device_requests (
      code_hash TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
      account_id TEXT REFERENCES accounts(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
      resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
