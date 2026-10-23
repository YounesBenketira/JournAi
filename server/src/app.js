import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { apiRouter } from './api.js';
import { oauthRouter } from './oauth.js';
import { mountMcp } from './mcp.js';

export function createApp(db, { origin, allowedOrigins = [], trustProxy = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const source = req.headers.origin;
    if (source) {
      if (![origin, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...allowedOrigins].includes(source)) return res.status(403).json({ error: 'Origin not allowed.' });
      res.set('Access-Control-Allow-Origin', source).vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.get('/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.get('/credential.js', (_req, res) => res.sendFile(fileURLToPath(new URL('./credential.js', import.meta.url))));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use(oauthRouter(db, origin));
  app.use('/api', apiRouter(db));
  mountMcp(app, db, origin);
  app.use((error, _req, res, _next) => {
    const status = error instanceof ZodError ? 400 : error.status ?? 500;
    res.status(status).json({ error: status === 500 ? 'Server error. Please try again.' : error instanceof ZodError ? 'Invalid request.' : error.message });
  });
  return app;
}
