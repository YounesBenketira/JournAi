import type { Todo, TodoRow } from '../types/todo';
import { getTimestamp } from '../utils/date';
import { generateId } from '../utils/generators';
import { select, execute, executeBatch } from '../lib/db';
import { initializeAccountStorage } from './account/storage';
import { markRecordDeleted, markRecordDirty } from './sync/localRepository';

function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    date: row.date,
    content: row.content,
    completed: row.completed === 1,
    position: row.position,
  };
}

export async function getTodosByDate(date: string): Promise<Todo[]> {
  const rows = await select<TodoRow>(
    'SELECT * FROM todos WHERE date = $1 ORDER BY position ASC',
    [date]
  );
  return rows.map(rowToTodo);
}

export async function getTodosByDateRange(startDate: string, endDate: string): Promise<Todo[]> {
  const rows = await select<TodoRow>(
    'SELECT * FROM todos WHERE date >= $1 AND date <= $2 ORDER BY date ASC, position ASC',
    [startDate, endDate]
  );
  return rows.map(rowToTodo);
}

export async function createTodo(date: string, content: string): Promise<Todo> {
  const id = generateId();
  const timestamp = getTimestamp();

  const maxPositionRows = await select<{ max_pos: number | null }>(
    'SELECT MAX(position) as max_pos FROM todos WHERE date = $1',
    [date]
  );
  const position = (maxPositionRows[0]?.max_pos ?? -1) + 1;

  await initializeAccountStorage();
  await executeBatch([
    { query: 'INSERT INTO todos (id, date, content, completed, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      values: [id, date, content, 0, position, timestamp, timestamp] },
    { query: "INSERT INTO todo_sharing_origin(record_id, epoch) VALUES($1, COALESCE((SELECT CAST(value AS INTEGER) FROM account_sync_meta WHERE key='sharingEpoch'), 0))",
      values: [id] },
  ]);
  await markRecordDirty('todos', id, timestamp);

  return { id, date, content, completed: false, position };
}

export async function updateTodo(
  id: string,
  updates: { content?: string; completed?: boolean }
): Promise<Todo | null> {
  const timestamp = getTimestamp();
  const setClauses: string[] = ['updated_at = $1'];
  const values: unknown[] = [timestamp];
  let paramIndex = 2;

  if (updates.content !== undefined) {
    setClauses.push(`content = $${paramIndex}`);
    values.push(updates.content);
    paramIndex++;
  }
  if (updates.completed !== undefined) {
    setClauses.push(`completed = $${paramIndex}`);
    values.push(updates.completed ? 1 : 0);
    paramIndex++;
  }

  values.push(id);
  await execute(
    `UPDATE todos SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  const rows = await select<TodoRow>('SELECT * FROM todos WHERE id = $1', [id]);
  if (rows.length === 0) {
    return null;
  }

  await markRecordDirty('todos', id, timestamp);
  return rowToTodo(rows[0]);
}

export async function deleteTodo(id: string): Promise<boolean> {
  const result = await execute('DELETE FROM todos WHERE id = $1', [id]);
  const deleted = result.rowsAffected > 0;
  if (deleted) {
    await markRecordDeleted('todos', id);
  }
  return deleted;
}

export async function getTodosCountByDate(startDate: string, endDate: string): Promise<Map<string, { total: number; completed: number }>> {
  const rows = await select<{ date: string; total: number; completed: number }>(
    `SELECT date, COUNT(*) as total, SUM(completed) as completed
     FROM todos WHERE date >= $1 AND date <= $2
     GROUP BY date`,
    [startDate, endDate]
  );

  const map = new Map<string, { total: number; completed: number }>();
  rows.forEach(row => map.set(row.date, { total: row.total, completed: row.completed }));
  return map;
}

export async function reorderTodos(todoIds: string[]): Promise<void> {
  const timestamp = getTimestamp();
  for (let i = 0; i < todoIds.length; i++) {
    await execute(
      'UPDATE todos SET position = $1, updated_at = $2 WHERE id = $3',
      [i, timestamp, todoIds[i]]
    );
    await markRecordDirty('todos', todoIds[i], timestamp);
  }
}
