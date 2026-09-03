import { Router } from 'express';
import { reconcile, cashRollup, round2, pool } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { todayISO, isoDaysAgo } from '../dates.js';

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

async function salesmanRows({ from, to, salesmanId, client }) {
  const c = client || pool;
  const where = salesmanId ? 'AND u.id = $1' : '';
  const args = salesmanId ? [salesmanId] : [];
  const { rows: people } = await c.query(`SELECT id, code, name, phone FROM users u WHERE u.role = 'salesman' AND u.active = 1 ${where} ORDER BY u.code`, args);
  // Per-salesman work is independent — run it in parallel. Over a remote
  // database this takes the reconciliation screen from ~6s to well under 1s.
  return Promise.all(people.map(async (p) => {
    const [r, session, lastCol] = await Promise.all([
      reconcile({ from, to, salesmanId: p.id }),
      c.query('SELECT started_at, ended_at FROM day_sessions WHERE salesman_id = $1 AND work_date = $2', [p.id, todayISO()]),
      c.query('SELECT MAX(created_at) AS t FROM collections WHERE salesman_id = $1', [p.id]),
    ]);
    const sess = session.rows[0];
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
      day_started: sess?.started_at ? String(sess.started_at).slice(11, 16) : null,
      day_ended: sess?.ended_at ? String(sess.ended_at).slice(11, 16) : null,
      last_activity: lastCol.rows[0]?.t || null,
    };
  }));
}

router.get('/reconciliation', async (req, res, next) => {
  try {
    const client = req._dbClient || pool;
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
      salesmanRows({ from, to, salesmanId, client }),
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
    const client = req._dbClient || pool;
    const { from, to, salesmanId } = rangeOf(req);
    res.json({ range: { from, to }, salesmen: await salesmanRows({ from, to, salesmanId, client }) });
  } catch (err) { next(err); }
});

router.get('/salesmen/:id', async (req, res, next) => {
  try {
    const client = req._dbClient || pool;
    const { from, to } = rangeOf(req);
    const id = Number(req.params.id);
    const person = await client.query('SELECT id, code, name, phone FROM users WHERE id = $1', [id]);
    if (!person.rows.length) return res.status(404).json({ error: 'Salesman not found.' });

    const r = await reconcile({ from, to, salesmanId: id });
    const bills = await client.query(`
      SELECT b.*, s.name AS shop_name, s.area AS shop_area,
        COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) AS collected_amount,
        COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id),0) AS short_amount,
        CASE WHEN b.cancelled_at IS NOT NULL THEN 'cancelled'
             WHEN COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) <= 0 THEN 'pending'
             ELSE 'partial' END AS status
      FROM bills b JOIN shops s ON s.id = b.shop_id
      WHERE b.salesman_id = $1 AND b.bill_date BETWEEN $2 AND $3
      ORDER BY b.bill_date DESC, b.id DESC`, [id, from, to]);

    const collections = await client.query(`
      SELECT c.*, b.invoice_no, s.name AS shop_name
      FROM collections c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE c.salesman_id = $1 AND c.collection_date BETWEEN $2 AND $3
      ORDER BY c.id DESC`, [id, from, to]);

    const cancellations = await client.query(`
      SELECT c.*, s.name AS shop_name FROM cancellations c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE c.salesman_id = $1 AND c.cancel_date BETWEEN $2 AND $3 ORDER BY c.id DESC`, [id, from, to]);

    const shortages = await client.query(`
      SELECT si.*, b.invoice_no, s.name AS shop_name FROM short_items si
      JOIN bills b ON b.id = si.bill_id JOIN shops s ON s.id = b.shop_id
      WHERE si.salesman_id = $1 AND si.short_date BETWEEN $2 AND $3 ORDER BY si.id DESC`, [id, from, to]);

    const sessions = await client.query('SELECT * FROM day_sessions WHERE salesman_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date DESC', [id, from, to]);

    res.json({
      range: { from, to },
      salesman: person.rows[0],
      reconciliation: r,
      bills: bills.rows.map((b) => ({ ...b, expected_amount: b.cancelled_at ? 0 : round2(b.amount - b.short_amount), balance: round2((b.cancelled_at ? 0 : b.amount - b.short_amount) - b.collected_amount) })),
      collections: collections.rows,
      cancellations: cancellations.rows,
      shortages: shortages.rows,
      sessions: sessions.rows,
    });
  } catch (err) { next(err); }
});

router.get('/cancellations', async (req, res, next) => {
  try {
    const client = req._dbClient || pool;
    const { from, to, salesmanId } = rangeOf(req);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND c.salesman_id = $3' : '';
    const { rows } = await client.query(`
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
    const client = req._dbClient || pool;
    const { from, to, salesmanId } = rangeOf(req);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND si.salesman_id = $3' : '';
    const { rows } = await client.query(`
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

router.get('/bills', async (req, res, next) => {
  try {
    const client = req._dbClient || pool;
    const { from, to, salesmanId } = rangeOf(req);
    const status = req.query.status;
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND b.salesman_id = $3' : '';
    const { rows } = await client.query(`
      SELECT b.*, s.name AS shop_name, s.area AS shop_area, u.name AS salesman_name, u.code AS salesman_code,
        COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) AS collected_amount,
        COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id),0) AS short_amount,
        CASE WHEN b.cancelled_at IS NOT NULL THEN 'cancelled'
             WHEN COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) <= 0 THEN 'pending'
             WHEN COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) >= b.amount
                  - COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id),0) - 0.5 THEN 'delivered'
             ELSE 'partial' END AS status
      FROM bills b JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = b.salesman_id
      WHERE b.bill_date BETWEEN $1 AND $2 ${where}
      ORDER BY b.bill_date DESC, b.id DESC`, params);
    const filtered = status && status !== 'all' ? rows.filter((b) => b.status === status) : rows;
    res.json({ range: { from, to }, bills: filtered });
  } catch (err) { next(err); }
});
