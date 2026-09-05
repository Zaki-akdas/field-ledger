import { pool } from './db.js';
import app from './app.js';

const PORT = Number(process.env.PORT || 4000);
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
