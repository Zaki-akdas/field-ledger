import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool, getRequestClient, releaseClient } from './db.js';
import { attachUser, resolveUser } from './auth.js';
import { router as authRouter } from './routes/auth.js';
import { router as fieldRouter } from './routes/field.js';
import { router as adminRouter } from './routes/admin.js';
import { router as syncRouter } from './routes/sync.js';
import { router as exportRouter } from './routes/exports.js';
import { router as realtimeRouter } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === 'production';

const app = express();

// ── Security headers ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,       // Vite manages CSP for the SPA
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ───────────────────────────────────────────────────────────────
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

// ── Static files ───────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

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

// ── Database check ─────────────────────────────────────────────────────
const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bills');
if (rows[0].n === 0) {
  console.log('Empty database — run seed: node server/seed.js --force');
}

// ── Start server ───────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Field Ledger API listening on http://0.0.0.0:${PORT} [${isProduction ? 'production' : 'development'}]`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully…`);

  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await pool.end();
      console.log('Database pool closed.');
    } catch (err) {
      console.error('[shutdown] Error closing pool:', err.message);
    }
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Unhandled errors ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('uncaughtException');
});
