import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelect = vi.fn();
const mockExecute = vi.fn();
const mockExecuteBatch = vi.fn();

vi.mock('../../../lib/db', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  executeBatch: (...args: unknown[]) => mockExecuteBatch(...args),
}));

import { getDirtyRecords, markRecordDirty, markRecordSynced, saveSyncConflict } from '../localRepository';

describe('sync local repository integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects dirty records even when stale unresolved conflicts exist', async () => {
    mockSelect.mockImplementation((query: string) => {
      if (query.includes('FROM sync_state s')) {
        return Promise.resolve([
          {
            collection: 'entries',
            record_id: 'entry-1',
            dirty: 1,
            deleted: 0,
            local_version: 3,
            remote_version: 2,
            updated_at: '2026-05-19T10:00:00.000Z',
            synced_at: null,
            remote_updated_at: null,
            payload_hash: null,
          },
          {
            collection: 'todos',
            record_id: 'todo-1',
            dirty: 1,
            deleted: 1,
            local_version: 4,
            remote_version: 3,
            updated_at: '2026-05-19T11:00:00.000Z',
            synced_at: null,
            remote_updated_at: null,
            payload_hash: null,
          },
        ]);
      }

      if (query.includes('FROM entries')) {
        return Promise.resolve([
          {
            id: 'entry-1',
            date: '2026-05-19',
            content: 'Local edit',
            created_at: '2026-05-19T09:00:00.000Z',
            updated_at: '2026-05-19T10:00:00.000Z',
            last_content_update: null,
          },
        ]);
      }

      return Promise.resolve([]);
    });

    const records = await getDirtyRecords();
    const dirtyQuery = mockSelect.mock.calls[0][0] as string;

    expect(dirtyQuery).not.toContain('NOT EXISTS');
    expect(dirtyQuery).not.toContain('FROM sync_conflicts c');
    expect(records).toEqual([
      {
        collection: 'entries',
        recordId: 'entry-1',
        version: 3,
        deleted: false,
        updatedAt: '2026-05-19T10:00:00.000Z',
        payload: {
          id: 'entry-1',
          date: '2026-05-19',
          content: 'Local edit',
          created_at: '2026-05-19T09:00:00.000Z',
          updated_at: '2026-05-19T10:00:00.000Z',
          last_content_update: null,
        },
      },
      {
        collection: 'todos',
        recordId: 'todo-1',
        version: 4,
        deleted: true,
        updatedAt: '2026-05-19T11:00:00.000Z',
        payload: null,
      },
    ]);
  });

  it('clears dirty only when the uploaded version is still current', async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 1 });

    await markRecordSynced(
      'entries',
      'entry-1',
      3,
      '2026-05-19T12:00:00.000Z',
      'payload-hash'
    );

    const [query, values] = mockExecute.mock.calls[0] as [string, unknown[]];
    const updateClause = query.slice(query.indexOf('DO UPDATE SET'));

    expect(query).toContain('dirty = CASE');
    expect(query).toContain('WHEN sync_state.local_version = $3 THEN 0');
    expect(query).toContain('ELSE sync_state.dirty');
    expect(query).toContain('deleted = CASE');
    expect(query).toContain('WHEN sync_state.local_version = $3 THEN $6');
    expect(updateClause).not.toMatch(/\n\s*updated_at\s*=/);
    expect(values).toEqual([
      'entries',
      'entry-1',
      3,
      '2026-05-19T12:00:00.000Z',
      'payload-hash',
      0,
    ]);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sync_conflicts'),
      ['entries', 'entry-1']
    );
  });

  it('marks stale conflict rows resolved when a record is edited locally', async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 1 });

    await markRecordDirty('sticky_notes', 'note-1', '2026-05-19T12:00:00.000Z');

    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sync_state'),
      ['sticky_notes', 'note-1', '2026-05-19T12:00:00.000Z']
    );
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sync_conflicts'),
      ['sticky_notes', 'note-1']
    );
  });

  it('does not create duplicate unresolved conflicts for the same record', async () => {
    mockSelect.mockResolvedValue([{ id: 'conflict-1' }]);

    await saveSyncConflict(
      'entries',
      'entry-1',
      { id: 'entry-1', content: 'Local' },
      { id: 'entry-1', content: 'Remote' }
    );

    expect(mockSelect).toHaveBeenCalledWith(
      expect.stringContaining('FROM sync_conflicts'),
      ['entries', 'entry-1']
    );
    expect(mockExecute).toHaveBeenCalledWith(
      'UPDATE sync_conflicts SET remote_payload=$1 WHERE id=$2',
      [JSON.stringify({ id: 'entry-1', content: 'Remote' }), 'conflict-1']
    );
  });
});
