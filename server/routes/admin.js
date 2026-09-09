import { Router } from 'express';
import { reconcile, cashRollup, round2, q1, q } from '../db.js';
import { requireAuth, requireRole, verifyPassword } from '../auth.js';
import { todayISO, isoDaysAgo } from '../dates.js';
import { upload } from '../uploads.js';
import fs from 'node:fs';
import JSZip from 'jszip';
import { parseStatement, matchStatement, recordMatches } from '../bankImport.js';

export const router = Router();
router.use(requireAuth, requireRole('admin'));

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function rangeOf(req) {
  return {
    from: req.query.from || isoDaysAgo(6),
    to: req.query.to || todayISO(),
    salesmanId: num(req.query.salesmanId),
  };
}

async function salesmanRows({ from, to, salesmanId }) {
  const where = salesmanId ? 'AND u.id = $1' : '';
  const args = salesmanId ? [salesmanId] : [];
  const people = await q(`SELECT id, code, name, phone FROM users u WHERE u.role = 'salesman' AND u.active = 1 ${where} ORDER BY u.code`, args);
  // Per-salesman work is independent — run it in parallel against the shared
  // pool (transaction-mode pooler multiplexes these over few backends).
  return Promise.all(people.map(async (p) => {
    const [r, session, lastCol] = await Promise.all([
      reconcile({ from, to, salesmanId: p.id }),
      q1('SELECT started_at, ended_at FROM day_sessions WHERE salesman_id = $1 AND work_date = $2', [p.id, todayISO()]),
      q1('SELECT MAX(created_at) AS t FROM collections WHERE salesman_id = $1', [p.id]),
    ]);
    return {
      ...p,
      bill_count: r.bill_count,
      billed: r.billed,
      expected: r.expected,
      collected: r.actual,
      variance: r.variance,
      cancelled_count: r.cancelled_count,
      cancelled_amount: r.cancelled_amount,
      short_amount: r.short_amount,
      by_mode: r.by_mode,
      day_started: session?.started_at ? String(session.started_at).slice(11, 16) : null,
      day_ended: session?.ended_at ? String(session.ended_at).slice(11, 16) : null,
      last_activity: lastCol?.t || null,
    };
  }));
}

router.get('/reconciliation', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    const start = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    const dates = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    // Period total, per-day rows and per-salesman rows are independent — the
    // day/salesman dimensions run concurrently instead of 20+ round trips.
    const [totals, dayResults, salesmen] = await Promise.all([
      reconcile({ from, to, salesmanId }),
      Promise.all(dates.map((day) => reconcile({ from: day, to: day, salesmanId }))),
      salesmanRows({ from, to, salesmanId }),
    ]);
    const days = dayResults.map((r, i) => ({ date: dates[i], ...r }));
    res.json({
      range: { from, to },
      ...totals,
      days,
      salesmen,
    });
  } catch (err) { next(err); }
});

router.get('/salesmen', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    res.json({ range: { from, to }, salesmen: await salesmanRows({ from, to, salesmanId }) });
  } catch (err) { next(err); }
});

router.get('/salesmen/:id', async (req, res, next) => {
  try {
    const { from, to } = rangeOf(req);
    const id = Number(req.params.id);
    const person = await q1('SELECT id, code, name, phone FROM users WHERE id = $1', [id]);
    if (!person) return res.status(404).json({ error: 'Salesman not found.' });

    const r = await reconcile({ from, to, salesmanId: id });
    const bills = await q(`
      SELECT b.*, s.name AS shop_name, s.area AS shop_area,
        COALESCE((SELECT SUM(amount::numeric) FROM collections c WHERE c.bill_id = b.id),0)::float8 AS collected_amount,
        COALESCE((SELECT SUM(amount::numeric) FROM short_items si WHERE si.bill_id = b.id),0)::float8 AS short_amount,
        CASE WHEN b.cancelled_at IS NOT NULL THEN 'cancelled'
             WHEN COALESCE((SELECT SUM(amount::numeric) FROM collections c WHERE c.bill_id = b.id),0) <= 0 THEN 'pending'
             ELSE 'partial' END AS status
      FROM bills b JOIN shops s ON s.id = b.shop_id
      WHERE b.salesman_id = $1 AND b.bill_date BETWEEN $2 AND $3
      ORDER BY b.bill_date DESC, b.id DESC`, [id, from, to]);

    const collections = await q(`
      SELECT c.*, b.invoice_no, s.name AS shop_name
      FROM collections c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE c.salesman_id = $1 AND c.collection_date BETWEEN $2 AND $3
      ORDER BY c.id DESC`, [id, from, to]);

    const cancellations = await q(`
      SELECT c.*, s.name AS shop_name FROM cancellations c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE c.salesman_id = $1 AND c.cancel_date BETWEEN $2 AND $3 ORDER BY c.id DESC`, [id, from, to]);

    const shortages = await q(`
      SELECT si.*, b.invoice_no, s.name AS shop_name FROM short_items si
      JOIN bills b ON b.id = si.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE si.salesman_id = $1 AND si.short_date BETWEEN $2 AND $3 ORDER BY si.id DESC`, [id, from, to]);

    const sessions = await q('SELECT * FROM day_sessions WHERE salesman_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date DESC', [id, from, to]);

    res.json({
      range: { from, to },
      salesman: person,
      reconciliation: r,
      bills: bills.map((b) => ({ ...b, expected_amount: b.cancelled_at ? 0 : round2(b.amount - b.short_amount), balance: round2((b.cancelled_at ? 0 : b.amount - b.short_amount) - b.collected_amount) })),
      collections,
      cancellations,
      shortages,
      sessions,
    });
  } catch (err) { next(err); }
});

router.get('/cancellations', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND c.salesman_id = $3' : '';
    const rows = await q(`
      SELECT c.id, c.invoice_no, c.amount, c.reason, c.cancel_date, c.salesman_id,
             u.name AS salesman_name, u.code AS salesman_code, s.name AS shop_name, s.area AS shop_area
      FROM cancellations c
      JOIN bills b ON b.id = c.bill_id
      JOIN shops s ON s.id = b.shop_id
      JOIN users u ON u.id = c.salesman_id
      WHERE c.cancel_date BETWEEN $1 AND $2 ${where}
      ORDER BY c.cancel_date DESC, c.id DESC`, params);
    res.json({ range: { from, to }, cancellations: rows, total: round2(rows.reduce((a, r) => a + r.amount, 0)) });
  } catch (err) { next(err); }
});

router.get('/shortages', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND si.salesman_id = $3' : '';
    const rows = await q(`
      SELECT si.id, si.product, si.qty, si.rate, si.amount, si.reason, si.short_date,
             b.invoice_no, s.name AS shop_name, u.name AS salesman_name, u.code AS salesman_code
      FROM short_items si
      JOIN bills b ON b.id = si.bill_id
      JOIN shops s ON s.id = b.shop_id
      JOIN users u ON u.id = si.salesman_id
      WHERE si.short_date BETWEEN $1 AND $2 ${where}
      ORDER BY si.short_date DESC, si.id DESC`, params);
    res.json({ range: { from, to }, shortages: rows, total: round2(rows.reduce((a, r) => a + r.amount, 0)) });
  } catch (err) { next(err); }
});

router.get('/cash-rollup', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    res.json({ range: { from, to }, ...(await cashRollup({ from, to, salesmanId })) });
  } catch (err) { next(err); }
});

/* --------------------------------------------------- bank reconciliation --- */

function handle(fn) {
  return (req, res, next) => { fn(req, res, next).catch(next); };
}

// Preview: parse + match a statement, nothing recorded yet. Returns every
// credit row with its match tier and the collection it landed on.
router.post('/bank/preview', upload.single('file'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a statement file (.csv or .xlsx) to upload.' });
  try {
    const { rows, skipped } = await parseStatement(req.file.path);
    const matched = await matchStatement(rows);
    res.json({
      file: req.file.originalname,
      rows: matched,
      summary: {
        credits: matched.length,
        skipped_debits: skipped,
        exact: matched.filter((m) => m.tier === 'exact').length,
        contains: matched.filter((m) => m.tier === 'contains').length,
        likely: matched.filter((m) => m.tier === 'likely').length,
        unmatched: matched.filter((m) => !m.tier).length,
        credit_total: round2(matched.reduce((a, m) => a + m.amount, 0)),
      },
    });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// Confirm: record the office's ticked rows. Idempotent per (collection, file).
router.post('/bank/confirm', handle(async (req, res) => {
  const matches = Array.isArray(req.body?.matches) ? req.body.matches : [];
  const fileName = String(req.body?.file || 'statement').slice(0, 200);
  const cleaned = matches
    .filter((m) => m && typeof m === 'object' && m.collection && m.collection.id)
    .map((m) => ({
      confirmed: m.confirmed !== false,
      collection: { id: Number(m.collection.id) },
      amount: Number(m.amount) || 0,
      date: m.date || null,
      ref: m.ref || null,
      tier: ['exact', 'contains', 'likely'].includes(m.tier) ? m.tier : 'likely',
    }));
  if (cleaned.length === 0) return res.status(400).json({ error: 'No matched rows to record.' });
  res.json(await recordMatches(cleaned, { fileName, user: req.user }));
}));

// Which collections already have money verified against a statement.
router.get('/bank/matches', handle(async (_req, res) => {
  const rows = await q(`
    SELECT m.id, m.collection_id, m.statement_file, m.stmt_amount::float8 AS stmt_amount,
           m.stmt_date, m.stmt_ref, m.matched_tier, m.created_at,
           c.amount::float8 AS collection_amount, c.ref_no, c.collection_date, c.mode,
           b.invoice_no, s.name AS shop_name
    FROM bank_matches m
    JOIN collections c ON c.id = m.collection_id
    JOIN bills b ON b.id = c.bill_id
    JOIN shops s ON s.id = b.shop_id
    ORDER BY m.id DESC LIMIT 500`);
  res.json({ matches: rows });
}));

router.get('/bills', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    const status = req.query.status;
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND b.salesman_id = $3' : '';
    const rows = await q(`
      SELECT b.*, s.name AS shop_name, s.area AS shop_area, u.name AS salesman_name, u.code AS salesman_code,
        COALESCE((SELECT SUM(amount::numeric) FROM collections c WHERE c.bill_id = b.id),0)::float8 AS collected_amount,
        COALESCE((SELECT SUM(amount::numeric) FROM short_items si WHERE si.bill_id = b.id),0)::float8 AS short_amount,
        CASE WHEN b.cancelled_at IS NOT NULL THEN 'cancelled'
             WHEN COALESCE((SELECT SUM(amount::numeric) FROM collections c WHERE c.bill_id = b.id),0) <= 0 THEN 'pending'
             WHEN COALESCE((SELECT SUM(amount::numeric) FROM collections c WHERE c.bill_id = b.id),0) >= b.amount
                  - COALESCE((SELECT SUM(amount::numeric) FROM short_items si WHERE si.bill_id = b.id),0) - 0.5 THEN 'delivered'
             ELSE 'partial' END AS status
      FROM bills b JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = b.salesman_id
      WHERE b.bill_date BETWEEN $1 AND $2 ${where}
      ORDER BY b.bill_date DESC, b.id DESC`, params);
    const filtered = status && status !== 'all' ? rows.filter((b) => b.status === status) : rows;
    res.json({ range: { from, to }, bills: filtered });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ delete --- */

router.delete('/bills/:id', async (req, res, next) => {
  try {
    const { deleteBill } = await import('../mutations.js');
    res.json(await deleteBill({ billId: req.params.id, user: req.user }));
  } catch (err) { next(err); }
});

router.post('/bills/delete', async (req, res, next) => {
  try {
    const { deleteBills } = await import('../mutations.js');
    res.json(await deleteBills({ ids: req.body.ids, user: req.user }));
  } catch (err) { next(err); }
});

router.delete('/salesmen/:id', async (req, res, next) => {
  try {
    const { deleteSalesman } = await import('../mutations.js');
    res.json(await deleteSalesman({ salesmanId: req.params.id, user: req.user }));
  } catch (err) { next(err); }
});

router.post('/salesmen/delete', async (req, res, next) => {
  try {
    const { deleteSalesmen } = await import('../mutations.js');
    res.json(await deleteSalesmen({ ids: req.body.ids, user: req.user }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ shops --- */

router.get('/shops', async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT s.*, u.code AS salesman_code, u.name AS salesman_name,
        (SELECT COUNT(*)::int FROM bills b WHERE b.shop_id = s.id) AS bill_count,
        (SELECT COALESCE(SUM(b.amount::numeric),0)::float8 FROM bills b WHERE b.shop_id = s.id) AS billed
      FROM shops s
      LEFT JOIN users u ON u.id = s.salesman_id
      ORDER BY s.name`);
    res.json({ shops: rows });
  } catch (err) { next(err); }
});

/** Open bills across the current period, one row per salesman. Used by the
 * sidebar indicator so an admin can see at a glance how much is still open
 * and which salesmen are carrying the balance.
 */
router.get('/bills/pending-summary', async (req, res, next) => {
  try {
    const { from, to, salesmanId } = rangeOf(req);
    const whereSalesman = salesmanId ? 'AND u.id = $1' : '';
    const whereDate = 'b.bill_date BETWEEN $2 AND $3';
    const params = salesmanId ? [salesmanId, from, to] : [from, to];
    const rows = await q(`
      SELECT u.id, u.code, u.name,
        COUNT(*)::int AS bill_count,
        COALESCE(SUM(b.amount::numeric),0)::float8 AS bill_amount,
        COALESCE(SUM(CASE WHEN b.cancelled_at IS NOT NULL THEN b.amount::numeric ELSE 0 END),0)::float8 AS cancelled_amount,
        COALESCE(SUM(COALESCE(si.amount::numeric,0)),0)::float8 AS short_amount,
        COALESCE(SUM(COALESCE(c.amount::numeric,0)),0)::float8 AS collected_amount,
        COALESCE(SUM(CASE WHEN b.cancelled_at IS NULL THEN b.amount::numeric - COALESCE(si.amount::numeric,0) - COALESCE(c.amount::numeric,0) ELSE 0 END),0)::float8 AS outstanding
      FROM bills b
      JOIN users u ON u.id = b.salesman_id
      LEFT JOIN short_items si ON si.bill_id = b.id
      LEFT JOIN collections c ON c.bill_id = b.id
      WHERE ${whereDate} ${whereSalesman}
      GROUP BY u.id, u.code, u.name
      ORDER BY u.code`, params);

    const totalOutstanding = round2(rows.reduce((a, r) => a + (Number(r.outstanding) || 0), 0));
    const totalOpen = rows.reduce((a, r) => a + Number(r.bill_count), 0);

    res.json({
      range: { from, to },
      salesmen: rows,
      total: { outstanding: totalOutstanding, open: totalOpen },
    });
  } catch (err) { next(err); }
});

router.delete('/shops/:id', async (req, res, next) => {
  try {
    const { deleteShop } = await import('../mutations.js');
    res.json(await deleteShop({ shopId: req.params.id, user: req.user }));
  } catch (err) { next(err); }
});

router.post('/shops/delete', async (req, res, next) => {
  try {
    const { deleteShops } = await import('../mutations.js');
    res.json(await deleteShops({ ids: req.body.ids, user: req.user }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------- hard delete (purge) ---
 * Irreversible removal that ignores the usual safety checks. Every purge
 * requires the admin's password in the body — a stolen session alone can't
 * wipe records (same guard as factory reset).
 */
const purge = (fn, pick) => async (req, res, next) => {
  try {
    const mod = await import('../mutations.js');
    res.json(await mod[fn]({ ...pick(req), user: req.user, password: req.body?.password }));
  } catch (err) { next(err); }
};

router.post('/bills/:id/purge', purge('purgeBill', (req) => ({ billId: req.params.id })));
router.post('/shops/:id/purge', purge('purgeShop', (req) => ({ shopId: req.params.id })));
router.post('/salesmen/:id/purge', purge('purgeSalesman', (req) => ({ salesmanId: req.params.id })));

/* ------------------------------------------------------------ audit log ---
 * Who deleted / restored / purged what, and when. Read-only here.
 */
router.get('/audit', async (req, res, next) => {
  try {
    const { listAudit } = await import('../audit.js');
    // Pagination: limit/offset with a filtered total so the UI can size the
    // pager. Page is 1-based convenience; offset still wins if sent directly.
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = req.query.offset != null ? Number(req.query.offset) : (page - 1) * limit;
    const { rows, total } = await listAudit({
      action: req.query.action || undefined,
      entity: req.query.entity || undefined,
      actorId: num(req.query.actorId),
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      limit,
      offset,
    });
    res.json({
      entries: rows,
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- trash bin ---
 * Hard deletes land here as restorable snapshots for 30 days.
 */

/** Everything currently in the bin, newest first. Also sweeps expired rows. */
router.get('/trash', async (req, res, next) => {
  try {
    const { sweepExpiredTrash, listTrash } = await import('../trash.js');
    const swept = await sweepExpiredTrash(req.user);
    const entries = await listTrash();
    res.json({ entries, swept });
  } catch (err) { next(err); }
});

/** Put a purged record back into the live ledger. */
router.post('/trash/:id/restore', async (req, res, next) => {
  try {
    const { restoreTrash } = await import('../trash.js');
    res.json(await restoreTrash({ trashId: req.params.id, user: req.user }));
  } catch (err) { next(err); }
});

/** Wipe one bin entry for good — after this, restore is impossible. */
router.post('/trash/:id/purge', async (req, res, next) => {
  try {
    const { purgeTrash } = await import('../trash.js');
    res.json(await purgeTrash({ trashId: req.params.id, user: req.user }));
  } catch (err) { next(err); }
});

/** CSV field escaping: quote when needed, double embedded quotes. */
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Full-book backup: one CSV per table zipped together. Downloaded from the
 * factory-reset sheet so there is always a restorable snapshot before the
 * wipe. Password hashes are stripped from the users table for safety.
 */
const BACKUP_TABLES = [
  'users', 'shops', 'products', 'bills', 'collections', 'cash_denominations',
  'bank_matches', 'short_items', 'cancellations', 'bill_edits', 'day_sessions',
];

router.get('/backup', async (req, res, next) => {
  try {
    const zip = new JSZip();
    for (const table of BACKUP_TABLES) {
      const colRows = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      const cols = colRows.map((r) => r.column_name).filter((c) => !(table === 'users' && c === 'password_hash'));
      const rows = await q(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table}`);
      const lines = [cols.map(csvCell).join(',')];
      for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
      zip.file(`${table}.csv`, lines.join('\r\n') + '\r\n');
    }
    const date = new Date().toISOString().slice(0, 10);
    const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="field-ledger-backup-${date}.zip"`);
    res.send(body);
  } catch (err) { next(err); }
});

/** Factory reset — wipe every ledger table but keep admin accounts. */
router.post('/factory-reset', async (req, res, next) => {
  try {
    // Require the magic word AND the admin's password — a stolen session
    // alone must not be enough to wipe the entire database.
    const { confirm, password } = req.body || {};
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm factory reset.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Enter your password to confirm the factory reset.' });
    }
    const admin = await q1('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!admin || !verifyPassword(String(password), admin.password_hash)) {
      return res.status(400).json({ error: 'Wrong password. Factory reset was not performed.' });
    }

    // Truncate in FK-safe order; keep users table intact (admins survive)
    const tables = [
      'cash_denominations',
      'bank_matches',
      'bill_edits',
      'short_items',
      'cancellations',
      'collections',
      'bills',
      'shops',
      'products',
      'day_sessions',
      'sessions',
    ];
    for (const t of tables) {
      await q(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
    }
    // Delete salesman accounts (keep admins)
    await q(`DELETE FROM users WHERE role = 'salesman'`);
    // Reset sequences so IDs start from 1 again
    await q(`ALTER SEQUENCE users_id_seq RESTART WITH 1`);

    const { recordAudit } = await import('../audit.js');
    await recordAudit({
      action: 'factory_reset', entity: 'system',
      label: 'All ledger data wiped; admin accounts preserved',
      actor: req.user,
    });

    res.json({ ok: true, message: 'All data wiped. Admin accounts preserved.' });
  } catch (err) { next(err); }
});
