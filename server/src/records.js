import { z } from 'zod';
import { transaction } from './database.js';
import { fail } from './security.js';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const common = { id, date, content: z.string().max(100000), created_at: timestamp, updated_at: timestamp };
const todo = z.object({ ...common, content: z.string().trim().min(1).max(20000), completed: z.union([z.literal(0), z.literal(1)]), position: z.number().int().min(0), scheduled_time: z.string().max(30).nullable().optional() });
const note = z.object({ ...common, content: z.string().trim().min(1).max(20000) });
const encrypted = z.object({ algorithm: z.literal('AES-256-GCM'), ivB64: z.string().max(32), ciphertextB64: z.string().max(1500000) });
export const changeSchema = z.object({
  collection: z.enum(['entries', 'todos', 'sticky_notes']), recordId: id,
  baseRevision: z.number().int().nonnegative(), deleted: z.boolean(),
  payload: z.unknown(), createdAt: timestamp, updatedAt: timestamp,
  sharingEpoch: z.number().int().nonnegative().default(0),
});

export const recordView = row => ({
  collection: row.collection, recordId: row.id, revision: row.revision,
  deleted: Boolean(row.deleted), payload: row.payload ? JSON.parse(row.payload) : null,
  createdAt: row.created_at, updatedAt: row.updated_at, sharingEpoch: row.sharing_epoch,
});

export function writeRecord(db, ownerId, input) {
  const change = changeSchema.parse(input);
  let payload = null;
  if (!change.deleted) {
    payload = (change.collection === 'entries' ? encrypted : change.collection === 'todos' ? todo : note).parse(change.payload);
    if (change.collection !== 'entries' && payload.id !== change.recordId) fail(400, 'Record ID does not match.');
  }
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM records WHERE owner_id = ? AND collection = ? AND id = ?').get(ownerId, change.collection, change.recordId);
    // A lost response can safely be retried without creating another revision.
    if (existing && existing.deleted === Number(change.deleted) && existing.payload === JSON.stringify(payload)) return { record: recordView(existing) };
    if ((existing?.revision ?? 0) !== change.baseRevision) return { conflict: existing ? recordView(existing) : null };
    const account = db.prepare('SELECT sharing_epoch FROM accounts WHERE id = ?').get(ownerId);
    const createdAt = existing?.created_at ?? change.createdAt;
    const epoch = existing?.sharing_epoch ?? Math.min(change.sharingEpoch, account.sharing_epoch);
    if (payload && change.collection !== 'entries') payload.created_at = createdAt;
    const revision = Number(db.prepare('INSERT INTO revisions DEFAULT VALUES').run().lastInsertRowid);
    db.prepare(`INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, collection, id) DO UPDATE SET revision=excluded.revision,
      deleted=excluded.deleted, payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(ownerId, change.collection, change.recordId, revision, Number(change.deleted), JSON.stringify(payload), createdAt, change.updatedAt, epoch);
    return { record: recordView(db.prepare('SELECT * FROM records WHERE owner_id = ? AND collection = ? AND id = ?').get(ownerId, change.collection, change.recordId)) };
  });
}

export function listOwned(db, ownerId, collection, { startDate, endDate, query, completed, limit = 100, offset = 0 } = {}) {
  let rows = db.prepare('SELECT * FROM records WHERE owner_id = ? AND collection = ? AND deleted = 0 ORDER BY created_at, id').all(ownerId, collection).map(recordView);
  rows = rows.filter(r => (!startDate || r.payload.date >= startDate) && (!endDate || r.payload.date <= endDate)
    && (!query || r.payload.content.toLowerCase().includes(query.toLowerCase()))
    && (completed === undefined || Boolean(r.payload.completed) === completed));
  return { records: rows.slice(offset, offset + limit), total: rows.length };
}

export function sharedTodos(db, viewerId) {
  return db.prepare(`SELECT r.*, a.email AS owner_email, s.id AS share_id
    FROM shares s JOIN accounts a ON a.id = s.owner_id JOIN records r ON r.owner_id = s.owner_id
    WHERE s.viewer_id = ? AND r.collection = 'todos' AND r.deleted = 0
      AND r.sharing_epoch >= s.epoch AND r.created_at > s.accepted_at
    ORDER BY json_extract(r.payload, '$.date'), r.created_at, r.id`).all(viewerId)
    .map(r => ({ ...recordView(r), ownerEmail: r.owner_email, shareId: r.share_id }));
}
