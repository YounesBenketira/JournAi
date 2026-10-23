import { execute, select, executeBatch, executeBatchIfUnchanged, type DbStatement } from '../../lib/db';
import { getTimestamp } from '../../utils/date';
import { generateId } from '../../utils/generators';
import type { SyncCollection } from '../../types/sync';

export const SYNC_COLLECTIONS: SyncCollection[] = [
  'entries',
  'todos',
  'sticky_notes',
];

interface SyncStateRow {
  collection: SyncCollection;
  record_id: string;
  dirty: number;
  deleted: number;
  local_version: number;
  remote_version: number;
  updated_at: string;
  synced_at: string | null;
  remote_updated_at: string | null;
  payload_hash: string | null;
}

export interface LocalSyncRecord {
  collection: SyncCollection;
  recordId: string;
  version: number;
  deleted: boolean;
  updatedAt: string;
  payload: Record<string, unknown> | null;
}

function assertSyncCollection(collection: SyncCollection): void {
  if (!SYNC_COLLECTIONS.includes(collection)) {
    throw new Error(`Unsupported sync collection: ${collection}`);
  }
}

function getSelectRecordQuery(collection: SyncCollection): string {
  switch (collection) {
    case 'entries':
      return 'SELECT id, date, content, created_at, updated_at, last_content_update FROM entries WHERE id = $1';
    case 'todos':
      return 'SELECT id, date, content, scheduled_time, completed, position, created_at, updated_at FROM todos WHERE id = $1';
    case 'sticky_notes':
      return 'SELECT id, date, content, created_at, updated_at FROM sticky_notes WHERE id = $1';
    default:
      collection satisfies never;
      throw new Error('Unsupported sync collection.');
  }
}

function buildDeleteStatement(collection: SyncCollection, recordId: string): DbStatement {
  switch (collection) {
    case 'entries':
      return { query: 'DELETE FROM entries WHERE id = $1', values: [recordId] };
    case 'todos':
      return { query: 'DELETE FROM todos WHERE id = $1', values: [recordId] };
    case 'sticky_notes':
      return { query: 'DELETE FROM sticky_notes WHERE id = $1', values: [recordId] };
    default:
      collection satisfies never;
      throw new Error('Unsupported sync collection.');
  }
}

function buildUpsertStatement(collection: SyncCollection, payload: Record<string, unknown>): DbStatement {
  switch (collection) {
    case 'entries':
      return {
        query: `INSERT INTO entries (id, date, content, created_at, updated_at, last_content_update, processed_at, content_hash)
          VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
          ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            content = excluded.content,
            updated_at = excluded.updated_at,
            last_content_update = excluded.last_content_update,
            processed_at = NULL,
            content_hash = NULL`,
        values: [
          payload.id,
          payload.date,
          payload.content,
          payload.created_at,
          payload.updated_at,
          payload.last_content_update ?? null,
        ],
      };
    case 'todos':
      return {
        query: `INSERT INTO todos (id, date, content, scheduled_time, completed, position, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            content = excluded.content,
            scheduled_time = excluded.scheduled_time,
            completed = excluded.completed,
            position = excluded.position,
            updated_at = excluded.updated_at`,
        values: [
          payload.id,
          payload.date,
          payload.content,
          payload.scheduled_time ?? null,
          payload.completed,
          payload.position,
          payload.created_at,
          payload.updated_at,
        ],
      };
    case 'sticky_notes':
      return {
        query: `INSERT INTO sticky_notes (id, date, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            content = excluded.content,
            updated_at = excluded.updated_at`,
        values: [
          payload.id,
          payload.date,
          payload.content,
          payload.created_at,
          payload.updated_at,
        ],
      };
    default:
      collection satisfies never;
      throw new Error('Unsupported sync collection.');
  }
}

export async function markRecordDirty(collection: SyncCollection, recordId: string, updatedAt: string = getTimestamp()): Promise<void> {
  assertSyncCollection(collection);
  await execute(
    `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, updated_at)
      VALUES ($1, $2, 1, 0, 1, $3)
      ON CONFLICT(collection, record_id) DO UPDATE SET
        dirty = 1,
        deleted = 0,
        local_version = sync_state.local_version + 1,
        updated_at = excluded.updated_at`,
    [collection, recordId, updatedAt]
  );
  await clearSyncConflictsForRecord(collection, recordId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:dirty-record', { detail: { collection, recordId } }));
  }
}

export async function markRecordDeleted(collection: SyncCollection, recordId: string, updatedAt: string = getTimestamp()): Promise<void> {
  assertSyncCollection(collection);
  await execute(
    `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, updated_at)
      VALUES ($1, $2, 1, 1, 1, $3)
      ON CONFLICT(collection, record_id) DO UPDATE SET
        dirty = 1,
        deleted = 1,
        local_version = sync_state.local_version + 1,
        updated_at = excluded.updated_at`,
    [collection, recordId, updatedAt]
  );
  await clearSyncConflictsForRecord(collection, recordId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:dirty-record', { detail: { collection, recordId } }));
  }
}

export async function markRecordPendingUpload(
  collection: SyncCollection,
  recordId: string,
  updatedAt: string
): Promise<void> {
  assertSyncCollection(collection);
  const result = await execute(
    `UPDATE sync_state SET
        dirty = 1,
        local_version = local_version + 1,
        updated_at = $3
      WHERE collection = $1 AND record_id = $2`,
    [collection, recordId, updatedAt]
  );
  if (result.rowsAffected === 0) {
    return;
  }
  await clearSyncConflictsForRecord(collection, recordId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:dirty-record', { detail: { collection, recordId } }));
  }
}

export async function getSyncState(collection: SyncCollection, recordId: string): Promise<SyncStateRow | null> {
  const rows = await select<SyncStateRow>(
    `SELECT collection, record_id, dirty, deleted, local_version, remote_version, updated_at, synced_at, remote_updated_at, payload_hash
     FROM sync_state WHERE collection = $1 AND record_id = $2`,
    [collection, recordId]
  );
  return rows[0] ?? null;
}

export async function getLocalPayload(collection: SyncCollection, recordId: string): Promise<Record<string, unknown> | null> {
  const rows = await select<Record<string, unknown>>(getSelectRecordQuery(collection), [recordId]);
  return rows[0] ?? null;
}

export async function getDirtyRecords(): Promise<LocalSyncRecord[]> {
  const states = await select<SyncStateRow>(
    `SELECT s.collection, s.record_id, s.dirty, s.deleted, s.local_version, s.remote_version, s.updated_at, s.synced_at, s.remote_updated_at, s.payload_hash
     FROM sync_state s
     WHERE s.dirty = 1
     ORDER BY s.updated_at ASC`
  );
  const records: LocalSyncRecord[] = [];

  for (const state of states) {
    const deleted = state.deleted === 1;
    records.push({
      collection: state.collection,
      recordId: state.record_id,
      version: state.local_version,
      deleted,
      updatedAt: state.updated_at,
      payload: deleted ? null : await getLocalPayload(state.collection, state.record_id),
    });
  }

  return records;
}

export async function markRecordSynced(
  collection: SyncCollection,
  recordId: string,
  version: number,
  syncedAt: string,
  payloadHash: string,
  deleted = false
): Promise<void> {
  await execute(
    `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, remote_version, updated_at, synced_at, remote_updated_at, payload_hash)
      VALUES ($1, $2, 0, $6, $3, $3, $4, $4, $4, $5)
      ON CONFLICT(collection, record_id) DO UPDATE SET
        dirty = CASE
          WHEN sync_state.local_version = $3 THEN 0
          ELSE sync_state.dirty
        END,
        deleted = CASE
          WHEN sync_state.local_version = $3 THEN $6
          ELSE sync_state.deleted
        END,
        remote_version = MAX(sync_state.remote_version, $3),
        synced_at = $4,
        remote_updated_at = $4,
        payload_hash = $5`,
    [collection, recordId, version, syncedAt, payloadHash, deleted ? 1 : 0]
  );
  await clearSyncConflictsForRecord(collection, recordId);
}

export async function applyRemoteRecord(
  collection: SyncCollection,
  recordId: string,
  version: number,
  updatedAt: string,
  payloadHash: string,
  deleted: boolean,
  payload: Record<string, unknown> | null,
  syncedAt: string = getTimestamp(),
  expected?: { localVersion: number | null; payload: Record<string, unknown> | null }
): Promise<boolean> {
  const statements: DbStatement[] = [];

  if (deleted) {
    statements.push(buildDeleteStatement(collection, recordId));
  } else if (payload) {
    statements.push(buildUpsertStatement(collection, payload));
  }

  statements.push({
    query: `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, remote_version, updated_at, synced_at, remote_updated_at, payload_hash)
      VALUES ($1, $2, 0, $3, $4, $4, $5, $7, $5, $6)
      ON CONFLICT(collection, record_id) DO UPDATE SET
        dirty = 0,
        deleted = excluded.deleted,
        local_version = MAX(sync_state.local_version, $4),
        remote_version = MAX(sync_state.remote_version, $4),
        updated_at = excluded.updated_at,
        synced_at = excluded.synced_at,
        remote_updated_at = excluded.remote_updated_at,
        payload_hash = excluded.payload_hash`,
    values: [collection, recordId, deleted ? 1 : 0, version, updatedAt, payloadHash, syncedAt],
  });

  if (expected) {
    const applied = await executeBatchIfUnchanged(statements, [
      { query: 'SELECT local_version, dirty FROM sync_state WHERE collection=$1 AND record_id=$2', values: [collection, recordId],
        rows: expected.localVersion === null ? [] : [{ local_version: expected.localVersion, dirty: 0 }] },
      { query: getSelectRecordQuery(collection), values: [recordId], rows: expected.payload ? [expected.payload] : [] },
    ]);
    if (!applied) return false;
  } else {
    await executeBatch(statements);
  }
  await clearSyncConflictsForRecord(collection, recordId);
  return true;
}

export async function updateSyncedAt(
  collection: SyncCollection,
  recordId: string,
  syncedAt: string = getTimestamp()
): Promise<void> {
  await execute(
    `UPDATE sync_state SET synced_at = $1 WHERE collection = $2 AND record_id = $3`,
    [syncedAt, collection, recordId]
  );
}

export async function clearSyncConflictsForRecord(
  collection: SyncCollection,
  recordId: string
): Promise<void> {
  assertSyncCollection(collection);
  const result = await execute(
    `UPDATE sync_conflicts
     SET resolved = 1
     WHERE collection = $1 AND record_id = $2 AND resolved = 0`,
    [collection, recordId]
  );
  if (result.rowsAffected > 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:conflicts-changed'));
  }
}

export async function saveSyncConflict(
  collection: SyncCollection,
  recordId: string,
  localPayload: Record<string, unknown> | null,
  remotePayload: Record<string, unknown> | null
): Promise<void> {
  const existing = await select<{ id: string }>(
    `SELECT id FROM sync_conflicts
     WHERE collection = $1 AND record_id = $2 AND resolved = 0
     LIMIT 1`,
    [collection, recordId]
  );
  if (existing.length > 0) {
    await execute('UPDATE sync_conflicts SET remote_payload=$1 WHERE id=$2', [remotePayload ? JSON.stringify(remotePayload) : null, existing[0].id]);
    return;
  }

  await execute(
    `INSERT INTO sync_conflicts (id, collection, record_id, local_payload, remote_payload, created_at, resolved)
      VALUES ($1, $2, $3, $4, $5, $6, 0)`,
    [
      generateId(),
      collection,
      recordId,
      localPayload ? JSON.stringify(localPayload) : null,
      remotePayload ? JSON.stringify(remotePayload) : null,
      getTimestamp(),
    ]
  );
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:conflicts-changed'));
  }
}

export interface SyncConflictRow {
  id: string;
  collection: SyncCollection;
  record_id: string;
  local_payload: string | null;
  remote_payload: string | null;
  created_at: string;
  resolved: number;
}

export async function getPendingConflicts(): Promise<SyncConflictRow[]> {
  return select<SyncConflictRow>(
    `SELECT id, collection, record_id, local_payload, remote_payload, created_at, resolved
     FROM sync_conflicts WHERE resolved = 0 ORDER BY created_at ASC`
  );
}

export async function resolveConflict(
  conflictId: string,
  resolution: 'local' | 'remote'
): Promise<void> {
  const conflicts = await select<SyncConflictRow>(
    'SELECT collection, record_id, remote_payload FROM sync_conflicts WHERE id = $1',
    [conflictId]
  );
  const conflict = conflicts[0];
  if (!conflict) {
    throw new Error('Conflict not found.');
  }

  const statements: DbStatement[] = [];

  if (resolution === 'remote') {
    const remotePayload = conflict.remote_payload
      ? JSON.parse(conflict.remote_payload) as Record<string, unknown>
      : null;

    if (remotePayload) {
      statements.push(buildUpsertStatement(conflict.collection, remotePayload));
      const remoteUpdatedAt = (remotePayload.updated_at as string | undefined) ?? getTimestamp();
      statements.push({
        query: `UPDATE sync_state SET
          dirty = 0,
          deleted = 0,
          updated_at = $1,
          synced_at = $2
          WHERE collection = $3 AND record_id = $4`,
        values: [remoteUpdatedAt, getTimestamp(), conflict.collection, conflict.record_id],
      });
    } else {
      statements.push(buildDeleteStatement(conflict.collection, conflict.record_id));
      statements.push({
        query: `UPDATE sync_state SET
          dirty = 0,
          deleted = 1,
          updated_at = $1,
          synced_at = $1
          WHERE collection = $2 AND record_id = $3`,
        values: [getTimestamp(), conflict.collection, conflict.record_id],
      });
    }
  } else {
    // Keep local version, force update local version to re-upload on next sync
    statements.push({
      query: `UPDATE sync_state SET
        dirty = 1,
        local_version = local_version + 1,
        updated_at = $1
        WHERE collection = $2 AND record_id = $3`,
      values: [getTimestamp(), conflict.collection, conflict.record_id],
    });
  }

  // Mark conflict as resolved
  statements.push({
    query: 'UPDATE sync_conflicts SET resolved = 1 WHERE id = $1',
    values: [conflictId],
  });

  await executeBatch(statements);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:conflicts-changed'));
  }
}

export async function resetAllSyncStates(): Promise<void> {
  await execute('UPDATE sync_state SET dirty = 1, synced_at = NULL, remote_version = 0, payload_hash = NULL');
}

export async function initializeSyncStates(): Promise<void> {
  await executeBatch([
    {
      query: `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, updated_at)
        SELECT 'entries', id, 1, 0, 1, updated_at
        FROM entries
        WHERE id NOT IN (SELECT record_id FROM sync_state WHERE collection = 'entries')`,
      values: [],
    },
    {
      query: `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, updated_at)
        SELECT 'todos', id, 1, 0, 1, updated_at
        FROM todos
        WHERE id NOT IN (SELECT record_id FROM sync_state WHERE collection = 'todos')`,
      values: [],
    },
    {
      query: `INSERT INTO sync_state (collection, record_id, dirty, deleted, local_version, updated_at)
        SELECT 'sticky_notes', id, 1, 0, 1, updated_at
        FROM sticky_notes
        WHERE id NOT IN (SELECT record_id FROM sync_state WHERE collection = 'sticky_notes')`,
      values: [],
    },
  ]);
}
