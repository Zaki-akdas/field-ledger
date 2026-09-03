import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile, verifySignedUpload } from './storage.js';
import { attachUser, resolveUser } from './auth.js';
import { router as authRouter } from './routes/auth.js';
import { router as fieldRouter } from './routes/field.js';
import { router as adminRouter } from './routes/admin.js';
import { router as syncRouter } from './routes/sync.js';
import { router as exportRouter } from './routes/exports.js';
import { router as realtimeRouter } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// Behind a reverse proxy (Vercel, Fly, nginx) the socket IP is the proxy's;
// trust one hop so rate limiting keys on the real client IP.
app.set('trust proxy', 1);

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

// No per-request database session. Requests share the pool (db.js), which
// connects through the transaction-mode pooler; RLS context is applied
// per-transaction inside tx() for writes, and reads are authorized at the
// route layer. This is what keeps concurrent requests from pinning
// sessions and exhausting Supabase's connection budget.

// ── Routes ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/realtime', realtimeRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api', apiLimiter, fieldRouter);
app.use('/api/admin', apiLimiter, adminRouter);
app.use('/api/sync', apiLimiter, syncRouter);
app.use('/api/export', apiLimiter, exportRouter);

// ── Attachments — streamed from storage (Supabase Storage or local disk) ──
// One route for every host: names stay opaque and bytes never live on the
// server's own disk in serverless mode. Files are only served with a valid
// short-lived signature (minted by POST /api/attachments/sign for a logged-in
// user) — knowing the file name alone is not enough.
app.get('/uploads/:file', async (req, res) => {
  const name = verifySignedUpload(req.params.file, req.query.expires, req.query.sig);
  if (!name) return res.status(403).type('text/plain').send('That link has expired or is not valid. Open the page again to get a fresh link.');
  try {
    const file = await readFile(name);
    if (!file) return res.status(404).type('text/plain').send('Attachment not found.');
    res.set('Content-Type', file.contentType);
    res.set('Cache-Control', 'private, no-store');
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
