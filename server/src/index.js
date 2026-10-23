import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from './database.js';
import { createApp } from './app.js';

const origin = process.env.JOURNAI_ORIGIN;
if (!origin || new URL(origin).origin !== origin) throw new Error('Set JOURNAI_ORIGIN to the public HTTPS origin, without a trailing slash.');
if (!origin.startsWith('https://') && !origin.startsWith('http://127.0.0.1:')) throw new Error('HTTPS is required outside local development.');
const path = process.env.JOURNAI_DATABASE ?? './data/journai.db';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = openDatabase(path);
const app = createApp(db, { origin, trustProxy: process.env.JOURNAI_TRUST_PROXY === '1' ? 'loopback' : false,
  allowedOrigins: (process.env.JOURNAI_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) });
const listener = app.listen(Number(process.env.PORT ?? 4391), '127.0.0.1', () => console.log('JournAi server ready.'));
const cleanup = setInterval(() => {
  for (const table of ['sessions', 'invitations', 'oauth_codes', 'oauth_requests', 'oauth_device_requests']) db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(Date.now());
}, 3600000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup);
  listener.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
