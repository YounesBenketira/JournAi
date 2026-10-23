import type { SyncCollection, SyncProgress, SyncSummary } from '../../types/sync';
import { AccountApiError, apiRequest, getSession, refreshAccount, type AccountSession } from './client';
import { getAccountMeta, getRevision, getTodoEpoch, initializeAccountStorage, setAccountMeta, setRevision } from './storage';
import { applyRemoteRecord, getDirtyRecords, getLocalPayload, getPendingConflicts, getSyncState, initializeSyncStates, markRecordSynced, saveSyncConflict, type LocalSyncRecord } from '../sync/localRepository';
import { decryptJsonPayload, encryptJsonPayload, hashJsonPayload } from '../sync/crypto';

interface RemoteRecord {
  collection: SyncCollection; recordId: string; revision: number; deleted: boolean;
  payload: Record<string, unknown> | null; createdAt: string; updatedAt: string; sharingEpoch: number;
}
interface Changes { records: RemoteRecord[]; cursor: number; hasMore: boolean }
type Progress = (value: SyncProgress) => void;
let running: Promise<SyncSummary> | null = null;

async function decode(record: RemoteRecord, session: AccountSession): Promise<Record<string, unknown> | null> {
  if (record.deleted || !record.payload) return null;
  if (record.collection !== 'entries') return record.payload;
  const iv = String(record.payload.ivB64);
  const ciphertext = String(record.payload.ciphertextB64);
  return decryptJsonPayload(session.journalKey, iv, ciphertext);
}

async function saveConflict(record: RemoteRecord, session: AccountSession): Promise<void> {
  const local = await getLocalPayload(record.collection, record.recordId);
  const remote = await decode(record, session);
  await saveSyncConflict(record.collection, record.recordId, local, remote);
  await setRevision(record.collection, record.recordId, record.revision);
}

async function acknowledge(record: LocalSyncRecord, remote: RemoteRecord): Promise<void> {
  await setRevision(record.collection, record.recordId, remote.revision);
  const hash = await hashJsonPayload(record.payload);
  await markRecordSynced(record.collection, record.recordId, record.version, new Date().toISOString(), hash, record.deleted);
}

function comparable(payload: Record<string, unknown> | null): string {
  if (!payload) return 'null';
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
}

async function recoverUpload(error: unknown, record: LocalSyncRecord, session: AccountSession): Promise<boolean> {
  if (!(error instanceof AccountApiError)) throw error;
  if (error.status !== 409 || !error.body.conflict) throw error;
  const remote = error.body.conflict as RemoteRecord;
  const payload = await decode(remote, session);
  const sameContent = comparable(payload) === comparable(record.payload);
  const sameDeletion = remote.deleted === record.deleted;
  if (sameContent && sameDeletion) {
    await acknowledge(record, remote);
    return true;
  }
  await saveConflict(remote, session);
  return false;
}

async function pushRecord(record: LocalSyncRecord, session: AccountSession): Promise<boolean> {
  let payload: Record<string, unknown> | null = record.payload;
  if (payload && record.collection === 'entries') {
    const encrypted = await encryptJsonPayload(session.journalKey, payload);
    payload = { algorithm: 'AES-256-GCM', ivB64: encrypted.ivB64, ciphertextB64: encrypted.ciphertextB64 };
  }
  const change = { collection: record.collection, recordId: record.recordId, deleted: record.deleted, payload,
    baseRevision: await getRevision(record.collection, record.recordId), createdAt: record.payload?.created_at ?? record.updatedAt,
    updatedAt: record.updatedAt, sharingEpoch: record.collection === 'todos' ? await getTodoEpoch(record.recordId) : 0 };
  try {
    const result = await apiRequest<{ record: RemoteRecord }>('/changes', { method: 'POST', body: JSON.stringify(change) }, session);
    await acknowledge(record, result.record);
    return true;
  } catch (error) {
    return recoverUpload(error, record, session);
  }
}

async function pushChanges(session: AccountSession, onProgress?: Progress): Promise<number> {
  const pending = await getPendingConflicts();
  const blocked = new Set(pending.map(c => c.collection + '/' + c.record_id));
  const dirty = await getDirtyRecords();
  let pushed = 0;
  for (const record of dirty) {
    if (blocked.has(record.collection + '/' + record.recordId)) continue;
    onProgress?.({ phase: 'uploading', message: 'Saving your changes...', current: pushed, total: dirty.length });
    if (await pushRecord(record, session)) pushed++;
  }
  return pushed;
}

async function pullRecord(record: RemoteRecord, session: AccountSession): Promise<boolean> {
  const revision = await getRevision(record.collection, record.recordId);
  if (record.revision <= revision) return false;
  const state = await getSyncState(record.collection, record.recordId);
  if (state?.dirty === 1) {
    await saveConflict(record, session);
    return false;
  }
  const localPayload = await getLocalPayload(record.collection, record.recordId);
  const payload = await decode(record, session);
  const hash = await hashJsonPayload(payload);
  const expected = { localVersion: state?.local_version ?? null, payload: localPayload };
  const applied = await applyRemoteRecord(record.collection, record.recordId, record.revision,
    record.updatedAt, hash, record.deleted, payload, new Date().toISOString(), expected);
  if (applied) await setRevision(record.collection, record.recordId, record.revision);
  else await saveConflict(record, session);
  return applied;
}

async function pullChanges(session: AccountSession, onProgress?: Progress): Promise<{ pulled: number; entriesChanged: boolean }> {
  let cursor = Number(await getAccountMeta('cursor') ?? 0);
  let hasMore = true;
  let pulled = 0;
  let entriesChanged = false;
  while (hasMore) {
    onProgress?.({ phase: 'downloading', message: 'Checking your other devices...', current: pulled, total: 0 });
    const page = await apiRequest<Changes>('/changes?after=' + cursor, {}, session);
    for (const record of page.records) {
      if (await pullRecord(record, session)) {
        pulled++;
        if (record.collection === 'entries') entriesChanged = true;
      }
    }
    cursor = page.cursor;
    hasMore = page.hasMore;
    await setAccountMeta('cursor', String(cursor));
  }
  return { pulled, entriesChanged };
}

async function performSync(onProgress?: Progress): Promise<SyncSummary> {
  await initializeAccountStorage();
  const session = await getSession();
  if (!session) throw new Error('Sign in to sync your devices.');
  await refreshAccount(session);
  await initializeSyncStates();
  const pushed = await pushChanges(session, onProgress);
  const { pulled, entriesChanged } = await pullChanges(session, onProgress);
  const lastSyncedAt = new Date().toISOString();
  await setAccountMeta('lastSyncedAt', lastSyncedAt);
  window.dispatchEvent(new CustomEvent('account:synced'));
  if (entriesChanged) window.dispatchEvent(new CustomEvent('account:entries-changed'));
  return { status: 'success', message: null, pushed, pulled, conflicts: (await getPendingConflicts()).length, lastSyncedAt };
}

export function syncAccount(onProgress?: Progress): Promise<SyncSummary> {
  if (!running) running = performSync(onProgress).finally(() => { running = null; });
  return running;
}
