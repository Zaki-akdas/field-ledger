/**
 * PostgreSQL database layer — replaces the SQLite better-sqlite3 API.
 * Exports the same helpers (billRows, billRow, reconcile, cashRollup, round2)
 * but every function is now async.
 */
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL environment variable is not set.');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  // DATABASE_URL points at Supabase's transaction-mode pooler (port 6543),
  // which multiplexes many client connections over a few backends. There is
  // no per-session cap and no backend is pinned while a client idles, so a
  // shared pool can serve any number of concurrent requests. Each instance
  // still keeps its pool modest; PGPOOL_MAX overrides, Vercel stays tiny.
  max: Math.min(25, Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 3 : 12))),
  idleTimeoutMillis: 30000,
  // Fail fast when the database is unreachable instead of hanging until the
  // platform kills the request.
  connectionTimeoutMillis: 8000,
  query_timeout: 15000,
  statement_timeout: 15000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected pool error:', err);
});

/* ---------------------------------------------------------------- helpers --- */

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Convenience: run a query and return rows. */
export async function q(sql, params = [], client = null) {
  const target = client || pool;
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
  const target = client || pool;
  return target.query(sql, params);
}

/**
 * Run a set of queries inside one PostgreSQL transaction with RLS context.
 *
 * This is the only place RLS session variables are set, and they are set
 * transaction-locally (set_config is_local). That is deliberate: through the
 * transaction-mode pooler a backend can be reassigned to another client the
 * moment COMMIT runs, so context cannot outlive the transaction — which is
 * exactly what makes this safe under heavy concurrency.
 *
 * Usage: await tx(async (client) => { ... }, req.user)
 */
export async function tx(fn, user = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (user) {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(user.id)]);
      await client.query(`SELECT set_config('app.current_user_role', $1, true)`, [user.role || '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
