import { execute, executeBatch, select } from '../../lib/db';

export async function initializeAccountStorage(): Promise<void> {
  await executeBatch([
    { query: 'CREATE TABLE IF NOT EXISTS account_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', values: [] },
    { query: 'CREATE TABLE IF NOT EXISTS account_sync_revisions (collection TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(collection, record_id))', values: [] },
    { query: 'CREATE TABLE IF NOT EXISTS todo_sharing_origin (record_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL)', values: [] },
  ]);
}

export async function getAccountMeta(key: string): Promise<string | null> {
  const rows = await select<{ value: string }>('SELECT value FROM account_sync_meta WHERE key=$1', [key]);
  return rows[0]?.value ?? null;
}

export async function setAccountMeta(key: string, value: string): Promise<void> {
  await execute('INSERT INTO account_sync_meta VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
}

export async function getRevision(collection: string, recordId: string): Promise<number> {
  const rows = await select<{ revision: number }>('SELECT revision FROM account_sync_revisions WHERE collection=$1 AND record_id=$2', [collection, recordId]);
  return rows[0]?.revision ?? 0;
}

export async function setRevision(collection: string, recordId: string, revision: number): Promise<void> {
  await execute('INSERT INTO account_sync_revisions VALUES($1,$2,$3) ON CONFLICT(collection,record_id) DO UPDATE SET revision=excluded.revision', [collection, recordId, revision]);
}

export async function getTodoEpoch(recordId: string): Promise<number> {
  const rows = await select<{ epoch: number }>('SELECT epoch FROM todo_sharing_origin WHERE record_id=$1', [recordId]);
  return rows[0]?.epoch ?? 0;
}
