/**
 * GET /api/status — deeper than /api/health, for uptime checkers that should
 * notice more than "the process is up":
 *
 *   checks.database — the DB actually answers (with round-trip latency)
 *   checks.storage  — attachment storage is reachable (Supabase round trip,
 *                     or the local uploads dir exists in disk mode)
 *   checks.backup   — a backup exists and how old the newest one is
 *
 * Public (same posture as /api/health) but the payload carries no secrets —
 * only booleans, latencies and timestamps. Responses are cached for 30 s so
 * a 1-minute poller (or a burst of monitors) never adds real load. HTTP 200
 * when the service is usable, 503 when the database or storage is down, so
 * plain HTTP-status monitors alert correctly. A stale backup does not take
 * the endpoint down — it sets checks.backup.stale for body-based monitors.
 *
 * During a sustained outage a check that just failed is short-circuited for
 * 60 s (FAIL_BACKOFF_MS): its last failure result is replayed — flagged
 * `cached: true` in the payload — instead of re-paying a full network
 * timeout on every refresh. Failures are only ever replayed, successes
 * never are, so a fresh problem is still detected live; recovery is seen
 * within ~3 cache windows (~90 s).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { pool } from './db.js';
import { storageProbe, latestRemoteBackup } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mirrors tools/backup.mjs's local destination so both agree on where zips live.
const LOCAL_BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const STALE_HOURS = 26; // daily schedule + 2h grace before we call it stale

const CACHE_TTL_MS = 30_000;
// After a check fails, retry it only this often: probes that HANG (DB
// blackholed, storage unreachable-but-accepting) each cost a full network
// timeout, so re-probing on every 30 s refresh would make the endpoint
// answer slowly every other minute for as long as the outage lasts. The
// memory ONLY covers failures — successes are never short-circuited, so a
// fresh outage is always probed and reported truthfully — and expires after
// two skipped windows, bounding recovery blindness at ~3 TTLs (~90 s).
const FAIL_BACKOFF_MS = 60_000;
let cache = { at: 0, body: null, code: 200 };
// Per-check last failure: kind -> { at, result }. The stored result is
// replayed verbatim while the backoff window is open.
const lastFailure = new Map();

/** Run a probe, timing it and turning any throw into a failed check.
 * `kind` keys the failure memory: a check that failed within FAIL_BACKOFF_MS
 * replays its last failure result instead of paying the probe cost again. */
async function timed(fn, kind) {
  const failed = kind ? lastFailure.get(kind) : null;
  if (failed && Date.now() - failed.at < FAIL_BACKOFF_MS) {
    // Short-circuit: recent failure of THIS check — answer from memory.
    return { ...failed.result, cached: true };
  }
  const started = Date.now();
  try {
    const detail = (await fn()) || {};
    if (kind) lastFailure.delete(kind); // recovered — forget the failure
    return { latency_ms: Date.now() - started, ...detail, ok: detail.ok !== false };
  } catch (err) {
    const result = { ok: false, latency_ms: Date.now() - started, error: err.message };
    if (kind) lastFailure.set(kind, { at: Date.now(), result });
    return result;
  }
}

async function dbCheck() {
  // Direct pool query on purpose: it must not open (or depend on) the
  // request transaction — /api/status answers even when no user is attached.
  await pool.query('SELECT 1');
  return {};
}

async function backupCheck() {
  // Newest zip: Storage first (where scheduled backups go), local dir as the
  // fallback for disk-mode hosts.
  let newest = await latestRemoteBackup();
  if (!newest && fs.existsSync(LOCAL_BACKUP_DIR)) {
    let best = null;
    for (const f of fs.readdirSync(LOCAL_BACKUP_DIR).filter((f) => f.endsWith('.zip'))) {
      const mtime = fs.statSync(path.join(LOCAL_BACKUP_DIR, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { name: f, mtime };
    }
    newest = best ? { name: best.name, created_at: new Date(best.mtime).toISOString() } : null;
  }
  if (!newest) return { ok: false, error: 'no backup found' };
  const age_hours = (Date.now() - Date.parse(newest.created_at)) / 3_600_000;
  return {
    age_hours: Math.round(age_hours * 10) / 10,
    last_at: newest.created_at,
    name: newest.name,
    stale: age_hours > STALE_HOURS,
  };
}

export async function statusSnapshot() {
  // Parallel: one slow probe (a storage hiccup, a DB hanging on connect)
  // must not stretch the others' reported latency — each check is timed
  // independently and the snapshot finishes at the slowest, not the sum.
  const [database, storage, backup] = await Promise.all([
    timed(dbCheck, 'database'),
    timed(storageProbe, 'storage'),
    timed(backupCheck, 'backup'),
  ]);
  const ok = database.ok && storage.ok;
  return { body: { ok, time: new Date().toISOString(), checks: { database, storage, backup } }, ok };
}

export const router = Router();
// Single-flight: while a snapshot is being taken (cold cache, or the 30 s
// TTL expiring during an outage when every probe hangs until timeout), all
// concurrent requests wait for that ONE snapshot instead of each starting
// their own — so a monitor burst during a DB outage produces one connection
// attempt per refresh, not one per request.
let inFlight = null;

async function refresh() {
  try {
    const { body, ok } = await statusSnapshot();
    cache = { at: Date.now(), body, code: ok ? 200 : 503 };
  } catch (err) {
    // statusSnapshot already guards each check; this is the belt-and-braces
    // path — never take the endpoint itself down.
    cache = { at: Date.now(), body: { ok: false, time: new Date().toISOString(), error: err.message }, code: 503 };
  } finally {
    inFlight = null;
  }
}

/** Test/drill hook: forget the cached snapshot (tools/status-drill.mjs). */
export function resetStatusCacheForTests() {
  cache = { at: 0, body: null, code: 200 };
  inFlight = null;
  lastFailure.clear();
}

router.get('/', async (_req, res) => {
  if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.status(cache.code).json(cache.body);
  }
  if (!inFlight) inFlight = refresh();
  await inFlight;
  res.status(cache.code).json(cache.body);
});
