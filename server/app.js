import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getRequestClient, releaseClient } from './db.js';
import { readFile } from './storage.js';
import { attachUser, resolveUser } from './auth.js';
import { router as authRouter } from './routes/auth.js';
import { router as fieldRouter } from './routes/field.js';
import { router as adminRouter } from './routes/admin.js';
import { router as syncRouter } from './routes/sync.js';
import { router as exportRouter } from './routes/exports.js';
import { router as realtimeRouter } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// ── Security headers ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,       // Vite manages CSP for the SPA
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ───────────────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
if (isProduction && ALLOWED_ORIGINS.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// ── Rate limiting ──────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});

// ── Body parsing ───────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use(resolveUser);

// ── RLS context — each request gets its own PostgreSQL client ──────────
app.use(async (req, res, next) => {
  if (req.user) {
    try {
      req._dbClient = await getRequestClient(req.user);
    } catch (err) {
      console.error('[rls] Failed to set up request client:', err.message);
    }
  }
  res.on('finish', () => releaseClient(req._dbClient));
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/realtime', realtimeRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api', apiLimiter, fieldRouter);
app.use('/api/admin', apiLimiter, adminRouter);
app.use('/api/sync', apiLimiter, syncRouter);
app.use('/api/export', apiLimiter, exportRouter);

// ── Attachments — streamed from storage (Supabase Storage or local disk) ──
// One route for every host: names stay opaque, bytes never live on the
// server's own disk in serverless mode.
app.get('/uploads/:file', async (req, res) => {
  try {
    const file = await readFile(req.params.file);
    if (!file) return res.status(404).type('text/plain').send('Attachment not found.');
    res.set('Content-Type', file.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.end(file.data);
  } catch (err) {
    console.error('[uploads] read failed:', err.message);
    res.status(500).type('text/plain').send('Could not read that attachment.');
  }
});

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: isProduction ? '1h' : 0 }));
  app.get(/^(?!\/api|\/uploads).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('html').send('<p>Field Ledger API is running. Start Vite (<code>npm run dev</code>) for the app.</p>'));
}

// ── 404 catch-all for API ──────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: `No endpoint for ${req.method} ${req.originalUrl}.` }));

// ── Global error handler ───────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is larger than 12 MB. Compress it and upload again.' });
  }
  if (err?.message && /Unsupported file type/.test(err.message)) {
    return res.status(415).json({ error: err.message });
  }
  if (err.status && err.status < 500) console.warn('[rejected]', err.message);
  else console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server.' });
});

export default app;
