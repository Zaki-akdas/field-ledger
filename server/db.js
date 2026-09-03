/**
 * PostgreSQL database layer — replaces the SQLite better-sqlite3 API.
 * Exports the same helpers (billRows, billRow, reconcile, cashRollup, round2)
 * but every function is now async.
 */
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL environment variable is not set.');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  // DATABASE_URL points at Supabase's transaction-mode pooler (port 6543),
  // which multiplexes many client connections over a few backends — no
  // per-session cap and no backend pinned while a client idles. Each request
  // now rides one transaction (RLS context + consistent reads) held for the
  // duration of that request, so the pool must fit the concurrent requests
  // themselves rather than just individual queries. PGPOOL_MAX overrides;
  // Vercel stays small because it can still serve modest concurrency.
  max: Math.min(25, Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 3 : 20))),
  idleTimeoutMillis: 30000,
  // Generous so a burst of concurrent requests queues on the pool instead of
  // failing while an earlier request's transaction is still finishing.
  connectionTimeoutMillis: 20000,
  query_timeout: 15000,
  statement_timeout: 15000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected pool error:', err);
});

/* ---------------------------------------------------------------- request scope --- */

/**
 * Per-request database scope. The request middleware (app.js) runs each
 * request inside this store with { user }. The first q/q1/qx/tx call opens
 * one transaction for the whole request and sets the RLS session variables
 * transaction-locally; every later query — read or write — reuses that same
 * client, so Row Level Security sees the same actor for the entire request
 * and never leaks context to another request on the same pooled backend.
 * The middleware commits (or rolls back) when the response finishes.
 */
export const requestStore = new AsyncLocalStorage();

async function setRlsContext(client, user) {
  if (!user) return;
  await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(user.id)]);
  await client.query(`SELECT set_config('app.current_user_role', $1, true)`, [user.role || '']);
}

/**
 * Resolve the client this request's queries should run on, opening the
 * request transaction lazily on first database access. Returns null when
 * there is no request scope or no actor (pre-auth work, boot scripts).
 */
async function ensureRequestClient(user = null) {
  const ctx = requestStore.getStore();
  if (!ctx) return null;
  if (ctx.client) return ctx.client;
  const actor = user || ctx.user || null;
  if (!actor) return null;
  if (!ctx.begin) {
    ctx.begin = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await setRlsContext(client, actor);
      } catch (err) {
        client.release();
        ctx.begin = null;
        throw err;
      }
      ctx.client = client;
    })();
  }
  await ctx.begin;
  return ctx.client;
}

/**
 * Finish the request transaction. Called by the request middleware when the
 * response finishes (commit) or is aborted / errored (rollback). Standalone
 * transactions (outside a request scope) are unaffected.
 */
export async function finalizeRequest(forceRollback = false) {
  const ctx = requestStore.getStore();
  if (!ctx || ctx.done) return;
  ctx.done = true;
  const client = ctx.client;
  ctx.client = null;
  if (!client) return;
  try {
    await client.query(forceRollback || ctx.rollback ? 'ROLLBACK' : 'COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------- helpers --- */

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Convenience: run a query and return rows. Runs on the request transaction. */
export async function q(sql, params = [], client = null) {
  const target = client || (await ensureRequestClient()) || pool;
  const { rows } = await target.query(sql, params);
  return rows;
}

/** Convenience: run a query and return the first row (or null). */
export async function q1(sql, params = [], client = null) {
  const rows = await q(sql, params, client);
  return rows[0] || null;
}

/** Convenience: run an INSERT/UPDATE/DELETE and return the result. */
export async function qx(sql, params = [], client = null) {
  const target = client || (await ensureRequestClient()) || pool;
  return target.query(sql, params);
}

/**
 * Run fn inside one PostgreSQL transaction with RLS context, set with
 * set_config(…, is_local) so it can never leak to another client through the
 * transaction-mode pooler.
 *
 * Inside a request scope this joins the request's own transaction — the RLS
 * context set once at first access is reused and the work commits or rolls
 * back as one unit when the response finishes. Outside a request scope
 * (scripts, tools, tests) it opens, commits and releases its own client.
 *
 * Usage: await tx(async (client) => { ... }, req.user)
 */
async function standaloneTx(fn, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, user);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function tx(fn, user = null) {
  const ctx = requestStore.getStore();
  if (ctx && (ctx.user || user)) {
    const client = await ensureRequestClient(user);
    if (client) return fn(client);
  }
  return standaloneTx(fn, user);
}

/* --------------------------------------------------------------- queries --- */

/** Upload directory for file attachments. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Bills with derived totals. `from`/`to` filter on bill_date.
 */
export async function billRows({ from, to, salesmanId } = {}) {
  const where = [];
  const params = [];
  let idx = 1;
  if (from) { where.push(`b.bill_date >= $${idx++}`); params.push(from); }
  if (to) { where.push(`b.bill_date <= $${idx++}`); params.push(to); }
  if (salesmanId) { where.push(`b.salesman_id = $${idx}`); params.push(salesmanId); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT b.*,
      s.name AS shop_name, s.area AS shop_area, s.owner_name AS shop_owner,
      u.name AS salesman_name, u.code AS salesman_code,
      COALESCE((SELECT SUM(amount) FROM cancellations c WHERE c.bill_id = b.id), 0) AS cancelled_amount,
      COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id), 0) AS short_amount,
      COALESCE((SELECT SUM(amount) FROM collections co WHERE co.bill_id = b.id), 0) AS collected_amount,
      (SELECT COUNT(*)::int FROM short_items si WHERE si.bill_id = b.id) AS short_count,
      CASE WHEN b.cancelled_at IS NOT NULL THEN 'cancelled'
           WHEN COALESCE((SELECT SUM(amount) FROM collections co WHERE co.bill_id = b.id),0) <= 0 THEN 'pending'
           WHEN COALESCE((SELECT SUM(amount) FROM collections co WHERE co.bill_id = b.id),0)
                >= b.amount
                - COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id),0)
                - 0.5 THEN 'delivered'
           ELSE 'partial' END AS status
    FROM bills b
    JOIN shops s ON s.id = b.shop_id
    JOIN users u ON u.id = b.salesman_id
    ${w}
    ORDER BY b.bill_date DESC, b.id DESC`;
  const rows = await q(sql, params);
  return rows.map(mapBill);
}

export async function billRow(id) {
  const row = await q1(`
    SELECT b.*,
      s.name AS shop_name, s.area AS shop_area, s.owner_name AS shop_owner, s.phone AS shop_phone,
      u.name AS salesman_name, u.code AS salesman_code,
      COALESCE((SELECT SUM(amount) FROM cancellations c WHERE c.bill_id = b.id), 0) AS cancelled_amount,
      COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id), 0) AS short_amount,
      COALESCE((SELECT SUM(amount) FROM collections co WHERE co.bill_id = b.id), 0) AS collected_amount
    FROM bills b
    JOIN shops s ON s.id = b.shop_id
    JOIN users u ON u.id = b.salesman_id
    WHERE b.id = $1`, [id]);
  return row ? mapBill(row) : null;
}

function mapBill(r) {
  const expected = r.cancelled_at
    ? 0
    : round2(r.amount - r.short_amount);
  const collected = round2(r.collected_amount);
  return {
    ...r,
    expected_amount: expected,
    collected_amount: collected,
    balance: round2(expected - collected),
    status: r.status || derivedStatus(r),
  };
}

function derivedStatus(r) {
  if (r.cancelled_at) return 'cancelled';
  const expected = r.amount - r.short_amount;
  if (r.collected_amount <= 0) return 'pending';
  return r.collected_amount >= expected - 0.5 ? 'delivered' : 'partial';
}

/**
 * Core reconciliation identity:
 *   Expected = Σ(Bill Amounts) − Σ(Cancelled) − Σ(Short Items)
 *   Actual   = Σ(Cash) + Σ(Online) + Σ(Cheque) + Σ(Credit Notes)
 *   Variance = Expected − Actual
 */
export async function reconcile({ from, to, salesmanId } = {}) {
  const params = [];
  const billWhere = [];
  let idx = 1;
  if (from) { billWhere.push(`b.bill_date >= $${idx++}`); params.push(from); }
  if (to) { billWhere.push(`b.bill_date <= $${idx++}`); params.push(to); }
  if (salesmanId) { billWhere.push(`b.salesman_id = $${idx}`); params.push(salesmanId); }
  const bw = billWhere.length ? 'WHERE ' + billWhere.join(' AND ') : '';

  const totals = await q1(`
    SELECT
      COUNT(*)::int AS bill_count,
      COALESCE(SUM(b.amount), 0) AS billed,
      COALESCE((SELECT SUM(c.amount) FROM cancellations c JOIN bills b2 ON b2.id = c.bill_id
                ${billWhere.length ? 'WHERE ' + billWhere.map(w => w.replace(/\bb\./g, 'b2.')).join(' AND ') : ''}), 0) AS cancelled_amount,
      COALESCE((SELECT SUM(s.amount) FROM short_items s JOIN bills b3 ON b3.id = s.bill_id
                ${billWhere.length ? 'WHERE ' + billWhere.map(w => w.replace(/\bb\./g, 'b3.')).join(' AND ') : ''}), 0) AS short_amount,
      COALESCE((SELECT COUNT(*)::int FROM cancellations c JOIN bills b4 ON b4.id = c.bill_id
                ${billWhere.length ? 'WHERE ' + billWhere.map(w => w.replace(/\bb\./g, 'b4.')).join(' AND ') : ''}), 0) AS cancelled_count
    FROM bills b ${bw}`, params);

  const modes = await q(`
    SELECT co.mode, COALESCE(SUM(co.amount),0) AS amount, COUNT(*)::int AS entries
    FROM collections co JOIN bills b5 ON b5.id = co.bill_id
    ${billWhere.length ? 'WHERE ' + billWhere.map(w => w.replace(/\bb\./g, 'b5.')).join(' AND ') : ''}
    GROUP BY co.mode`, params);

  const byMode = { cash: 0, online: 0, cheque: 0, credit_note: 0 };
  for (const m of modes) byMode[m.mode] = round2(m.amount);

  const expected = round2(totals.billed - totals.cancelled_amount - totals.short_amount);
  const actual = round2(byMode.cash + byMode.online + byMode.cheque + byMode.credit_note);
  return {
    bill_count: totals.bill_count,
    cancelled_count: totals.cancelled_count,
    billed: round2(totals.billed),
    cancelled_amount: round2(totals.cancelled_amount),
    short_amount: round2(totals.short_amount),
    expected,
    actual,
    variance: round2(expected - actual),
    by_mode: byMode,
    mode_entries: modes,
  };
}

/** Cash denomination roll-up, filtered by collection date (bank-deposit view). */
export async function cashRollup({ from, to, salesmanId } = {}) {
  const where = [];
  const params = [];
  let idx = 1;
  if (from) { where.push(`co.collection_date >= $${idx++}`); params.push(from); }
  if (to) { where.push(`co.collection_date <= $${idx++}`); params.push(to); }
  if (salesmanId) { where.push(`co.salesman_id = $${idx}`); params.push(salesmanId); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await q(`
    SELECT cd.denom AS denom, SUM(cd.count)::int AS count
    FROM cash_denominations cd
    JOIN collections co ON co.id = cd.collection_id
    ${w} GROUP BY cd.denom ORDER BY cd.denom DESC`, params);
  const total = rows.reduce((a, r) => a + r.denom * r.count, 0);
  return { rows: rows.map(r => ({ denom: r.denom, count: r.count, amount: r.denom * r.count })), total };
}
