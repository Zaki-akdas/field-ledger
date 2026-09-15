/**
 * Error sink: one place where client crashes and server faults are recorded.
 * Backed by the error_reports table — append-only, lazily pruned, queryable
 * with plain SQL. No external service, no new dependencies.
 *
 *   recordError({ source, kind, message, stack, ... })   — fire and forget
 *
 * Pruning keeps the latest 500 rows, enforced on every 25th insert so the
 * table can never grow unbounded on a busy host.
 *
 * Used by:
 *   - POST /api/errors            (client ErrorBoundary / window.onerror)
 *   - server/app.js error handler (failed requests)
 *   - server/index.js             (uncaughtException, unhandledRejection)
 */
import { pool } from './db.js';

const KEEP = 500;
const PRUNE_EVERY = 25;
let insertsSincePrune = 0;

const MAX = {
  message: 2000,
  stack: 8000,
  component_stack: 8000,
  url: 500,
  user_agent: 300,
  user_code: 60,
  kind: 60,
};

function clip(value, field) {
  if (value == null) return null;
  const s = String(value);
  return s.length > MAX[field] ? s.slice(0, MAX[field] - 1) + '…' : s;
}

/**
 * Record an error report. Never throws — a failing sink must not turn one
 * failure into two. Safe to call from anywhere; uses the base pool directly,
 * not the request transaction (an error report must survive even when the
 * request's transaction rolls back).
 */
export function recordError(report) {
  try {
    const row = {
      source: report.source === 'client' ? 'client' : 'server',
      kind: clip(report.kind, 'kind') || 'error',
      message: clip(report.message, 'message') || '(no message)',
      stack: clip(report.stack, 'stack'),
      component_stack: clip(report.component_stack, 'component_stack'),
      url: clip(report.url, 'url'),
      user_agent: clip(report.user_agent, 'user_agent'),
      user_id: Number.isInteger(report.user_id) ? report.user_id : null,
      user_code: clip(report.user_code, 'user_code'),
      context: report.context && typeof report.context === 'object' ? report.context : null,
    };
    const promise = pool
      .query(
        `INSERT INTO error_reports (source, kind, message, stack, component_stack, url, user_agent, user_id, user_code, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.source, row.kind, row.message, row.stack, row.component_stack, row.url, row.user_agent, row.user_id, row.user_code, row.context ? JSON.stringify(row.context) : null],
      )
      .then(() => {
        insertsSincePrune += 1;
        if (insertsSincePrune >= PRUNE_EVERY) {
          insertsSincePrune = 0;
          return pool.query(
            `DELETE FROM error_reports
             WHERE id NOT IN (SELECT id FROM error_reports ORDER BY id DESC LIMIT $1)`,
            [KEEP],
          );
        }
        return null;
      })
      .catch((err) => {
        // The sink itself failing (e.g. table missing on an old database)
        // must stay silent — it already logged to console at the call site.
        if (process.env.NODE_ENV !== 'production') console.warn('[errors] sink write failed:', err.message);
      });
    // Keep a handle so Node doesn't treat this as the only pending work.
    if (typeof promise?.catch === 'function') promise.catch(() => {});
    return promise;
  } catch {
    return null;
  }
}

/** Normalise an Error (or anything throwable) into a report payload. */
export function errorToReport(err, { kind = 'error', source = 'server', ...rest } = {}) {
  return {
    source,
    kind,
    message: err?.message || String(err),
    stack: err?.stack,
    ...rest,
  };
}
