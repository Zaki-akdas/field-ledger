import { pool } from './db.js';
import app from './app.js';

/**
 * Port resolution. `.env` (loaded by --env-file) sets PORT=4000, but Node's
 * --env-file never overrides variables that already exist in the environment
 * — and some shells/sandboxes inject PORT=0, which made the API listen on an
 * OS-assigned port and broke every script that expected :4000 (smoke, apitest,
 * trash-e2e). So: ignore non-positive PORT values and fall back to .env or
 * 4000. Real deployments that set a meaningful PORT are unaffected.
 */
const RAW_PORT = Number(process.env.PORT);
const PORT = Number.isFinite(RAW_PORT) && RAW_PORT > 0 ? RAW_PORT : 4000;
const isProduction = process.env.NODE_ENV === 'production';

// ── Database check ─────────────────────────────────────────────────────
const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bills');
if (rows[0].n === 0) {
  console.log('Empty database — provision accounts with: node tools/provision-accounts.mjs');
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
