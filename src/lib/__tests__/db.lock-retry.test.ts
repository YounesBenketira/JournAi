import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('Database Lock Retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('rolls back a download if its local row changed before the transaction', async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:sql|load') return Promise.resolve('sqlite:journai.db');
      if (command === 'plugin:sql|select') return Promise.resolve([{ content: 'New local edit' }]);
      return Promise.resolve({ rowsAffected: 1 });
    });
    const { executeBatchIfUnchanged } = await import('../db');
    const applied = await executeBatchIfUnchanged(
      [{ query: 'UPDATE todos SET content=$1 WHERE id=$2', values: ['Cloud edit', 'todo-1'] }],
      [{ query: 'SELECT content FROM todos WHERE id=$1', values: ['todo-1'], rows: [{ content: 'Original content' }] }]
    );
    expect(applied).toBe(false);
    const executed = mockInvoke.mock.calls.filter(call => call[0] === 'plugin:sql|execute').map(call => call[1].query);
    expect(executed).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('applies a download and commits when its local row has not changed', async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:sql|load') return Promise.resolve('sqlite:journai.db');
      if (command === 'plugin:sql|select') return Promise.resolve([{ content: 'Original content', id: 'todo-1' }]);
      return Promise.resolve({ rowsAffected: 1 });
    });
    const { executeBatchIfUnchanged } = await import('../db');
    const applied = await executeBatchIfUnchanged(
      [{ query: 'UPDATE todos SET content=$1 WHERE id=$2', values: ['Cloud edit', 'todo-1'] }],
      [{ query: 'SELECT content, id FROM todos WHERE id=$1', values: ['todo-1'], rows: [{ id: 'todo-1', content: 'Original content' }] }]
    );
    expect(applied).toBe(true);
    const executed = mockInvoke.mock.calls.filter(call => call[0] === 'plugin:sql|execute').map(call => call[1].query);
    expect(executed).toEqual(['BEGIN IMMEDIATE', 'UPDATE todos SET content=$1 WHERE id=$2', 'COMMIT']);
  });

  it('retries execute when sqlite reports a lock', async () => {
    let executeAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:sql|load') {
        return Promise.resolve('sqlite:journai.db');
      }
      if (command === 'plugin:sql|execute') {
        executeAttempts += 1;
        if (executeAttempts === 1) {
          return Promise.reject(new Error('error returned from database: (code: 5) database is locked'));
        }
        return Promise.resolve({ rowsAffected: 1 });
      }
      return Promise.resolve(undefined);
    });

    const { execute } = await import('../db');
    const result = await execute('DELETE FROM todos WHERE id = $1', ['todo-1']);

    expect(result).toEqual({ rowsAffected: 1 });
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it('retries select when sqlite reports a lock', async () => {
    let selectAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:sql|load') {
        return Promise.resolve('sqlite:journai.db');
      }
      if (command === 'plugin:sql|select') {
        selectAttempts += 1;
        if (selectAttempts === 1) {
          return Promise.reject(new Error('database is locked'));
        }
        return Promise.resolve([{ id: 'entry-1' }]);
      }
      return Promise.resolve(undefined);
    });

    const { select } = await import('../db');
    const rows = await select<{ id: string }>('SELECT id FROM entries');

    expect(rows).toEqual([{ id: 'entry-1' }]);
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it('executes a batch inside one transaction with lock retry', async () => {
    let insertAttempts = 0;
    mockInvoke.mockImplementation((command: string, payload?: { query?: string }) => {
      if (command === 'plugin:sql|load') {
        return Promise.resolve('sqlite:journai.db');
      }

      if (command === 'plugin:sql|execute') {
        if (payload?.query === 'BEGIN IMMEDIATE') {
          return Promise.resolve({ rowsAffected: 0 });
        }
        if (payload?.query?.startsWith('INSERT INTO todos')) {
          insertAttempts += 1;
          if (insertAttempts === 1) {
            return Promise.reject(new Error('database is locked'));
          }
          return Promise.resolve({ rowsAffected: 1 });
        }
        if (payload?.query === 'COMMIT') {
          return Promise.resolve({ rowsAffected: 0 });
        }
      }

      return Promise.resolve({ rowsAffected: 0 });
    });

    const { executeBatch } = await import('../db');
    await executeBatch([
      {
        query: 'INSERT INTO todos (id, date, content, scheduled_time, completed, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        values: ['todo-1', '2025-01-01', 'Task', null, 0, 0, 'ts', 'ts'],
      },
    ]);

    expect(mockInvoke).toHaveBeenCalledTimes(5);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'plugin:sql|execute', expect.objectContaining({ query: 'BEGIN IMMEDIATE' }));
    expect(mockInvoke).toHaveBeenNthCalledWith(5, 'plugin:sql|execute', expect.objectContaining({ query: 'COMMIT' }));
  });

  it('backs up and resets secure db once when load reports invalid database format', async () => {
    let loadAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:sql|load') {
        loadAttempts += 1;
        if (loadAttempts === 1) {
          return Promise.reject(new Error('error returned from database: (code: 26) file is not a database'));
        }
        return Promise.resolve('sqlite:journai.db');
      }
      if (command === 'plugin:sql|close') {
        return Promise.resolve(undefined);
      }
      if (command === 'app_lock_backup_and_reset_secure_db') {
        return Promise.resolve('/tmp/journai_demo.db.backup-123');
      }
      if (command === 'plugin:sql|select') {
        return Promise.resolve([{ id: 'entry-1' }]);
      }
      return Promise.resolve(undefined);
    });

    const { select } = await import('../db');
    const rows = await select<{ id: string }>('SELECT id FROM entries');

    expect(rows).toEqual([{ id: 'entry-1' }]);
    expect(mockInvoke).toHaveBeenCalledTimes(5);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'plugin:sql|load', { db: 'sqlite:journai.db' });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'plugin:sql|close', { db: 'sqlite:journai.db' });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, 'app_lock_backup_and_reset_secure_db');
    expect(mockInvoke).toHaveBeenNthCalledWith(4, 'plugin:sql|load', { db: 'sqlite:journai.db' });
    expect(mockInvoke).toHaveBeenNthCalledWith(5, 'plugin:sql|select', {
      db: 'sqlite:journai.db',
      query: 'SELECT id FROM entries',
      values: [],
    });
  });
});
