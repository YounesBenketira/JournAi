import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listOwned, recordView, sharedTodos, writeRecord } from './records.js';
import { fail, requireSession } from './security.js';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filters = { startDate: date.optional(), endDate: date.optional(), query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0) };

function createTools(db, session) {
  const server = new McpServer({ name: 'journai', version: '1.0.0' });
  const scopes = session.scope.split(' ');
  const ownerId = session.account_id;
  function register(name, description, schema, scope, readOnly, handler) {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: name.startsWith('update_'), idempotentHint: readOnly, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } }, async args => {
      if (!scopes.includes(scope)) return { isError: true, content: [{ type: 'text', text: `Requires ${scope} permission. Reconnect JournAi.` }] };
      try { return result(handler(args)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.status ? error.message : 'Invalid request. Refresh the record and try again.' }] }; }
    });
  }
  register('list_todos', 'Read your own JournAi todos. Filter by date, text, or completion; results are paginated.', { ...filters, completed: z.boolean().optional() }, 'todos:read', true,
    args => listOwned(db, ownerId, 'todos', args));
  register('list_sticky_notes', 'Read your own JournAi sticky notes, with date and text filters and pagination.', filters, 'notes:read', true,
    args => listOwned(db, ownerId, 'sticky_notes', args));
  register('list_shared_todos', 'Read future todos shared with you by another JournAi account. These are view-only.', {}, 'todos:read', true,
    () => ({ records: sharedTodos(db, ownerId) }));
  for (const [collection, singular, scope] of [['todos', 'todo', 'todos:write'], ['sticky_notes', 'sticky_note', 'notes:write']]) {
    register(`create_${singular}`, `Create a ${singular.replace('_', ' ')} in your own JournAi account. Supply a date explicitly. Reuse requestId when retrying.`,
      { date, content: z.string().trim().min(1).max(20000), requestId: z.string().uuid() }, scope, false, args => {
        const recordId = `mcp-${args.requestId}`;
        const existing = db.prepare('SELECT * FROM records WHERE owner_id=? AND collection=? AND id=?').get(ownerId, collection, recordId);
        if (existing) return { record: recordView(existing) };
        const now = new Date().toISOString();
        const account = db.prepare('SELECT sharing_epoch FROM accounts WHERE id=?').get(ownerId);
        const payload = { id: recordId, date: args.date, content: args.content, created_at: now, updated_at: now };
        if (collection === 'todos') Object.assign(payload, { completed: 0, position: Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE owner_id=? AND collection='todos'").get(ownerId).n) });
        return writeRecord(db, ownerId, { collection, recordId, baseRevision: 0, deleted: false, payload, createdAt: now, updatedAt: now, sharingEpoch: account.sharing_epoch });
      });
    register(`update_${singular}`, `Update your own ${singular.replace('_', ' ')} using the revision from a fresh list. Cannot change someone else's todo.`,
      { id: z.string().max(100), revision: z.number().int().positive(), content: z.string().trim().min(1).max(20000).optional(),
        ...(collection === 'todos' ? { completed: z.boolean().optional() } : {}) }, scope, false, args => {
        const existing = db.prepare('SELECT * FROM records WHERE owner_id=? AND collection=? AND id=? AND deleted=0').get(ownerId, collection, args.id);
        if (!existing) fail(404, 'Record not found in your account.');
        const payload = JSON.parse(existing.payload);
        if (args.content !== undefined) payload.content = args.content;
        if (args.completed !== undefined) payload.completed = Number(args.completed);
        const now = new Date().toISOString();
        payload.updated_at = now;
        return writeRecord(db, ownerId, { collection, recordId: args.id, baseRevision: args.revision, deleted: false,
          payload, createdAt: existing.created_at, updatedAt: now, sharingEpoch: existing.sharing_epoch });
      });
  }
  return server;
}

export function mountMcp(app, db, origin) {
  app.all('/mcp', requireSession(db, 'mcp', `${origin}/mcp`), async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const server = createTools(db, req.session);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}
