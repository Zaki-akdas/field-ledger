import { Router } from 'express';
import { billRows, billRow, reconcile, round2, q1, qx, pool } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { todayISO } from '../dates.js';
import { upload } from '../uploads.js';
import { parseBillWorkbook } from '../import.js';
import { createBill, recordCollection, cancelBill, uncancelBill, addShortItems, HttpError } from '../mutations.js';

export const router = Router();
router.use(requireAuth);

function handle(fn) {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/* ---------------------------------------------------------------- bills --- */

router.get('/bills', handle(async (req, res) => {
  const { from, to, date, status, q, salesmanId } = req.query;
  const salesman = req.user.role === 'admin' ? (salesmanId ? Number(salesmanId) : null) : req.user.id;
  let rows = await billRows({ from: date || from, to: date || to, salesmanId: salesman });
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((b) => b.invoice_no.toLowerCase().includes(needle)
      || b.shop_name.toLowerCase().includes(needle)
      || (b.shop_area || '').toLowerCase().includes(needle));
  }
  if (status && status !== 'all') rows = rows.filter((b) => b.status === status);
  res.json({ bills: rows, count: rows.length });
}));

router.get('/bills/:id', handle(async (req, res) => {
  const client = req._dbClient || pool;
  const bill = await billRow(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (req.user.role !== 'admin' && bill.salesman_id !== req.user.id) {
    return res.status(403).json({ error: 'This bill is not on your route.' });
  }
  const colRes = await client.query('SELECT * FROM collections WHERE bill_id = $1 ORDER BY id', [bill.id]);
  const collectionsList = colRes.rows;
  for (const c of collectionsList) {
    const denRes = await client.query('SELECT denom, count FROM cash_denominations WHERE collection_id = $1 ORDER BY denom DESC', [c.id]);
    c.denominations = denRes.rows;
  }
  const shortRes = await client.query('SELECT * FROM short_items WHERE bill_id = $1 ORDER BY id', [bill.id]);
  const cancelRes = await client.query('SELECT * FROM cancellations WHERE bill_id = $1', [bill.id]);
  res.json({ bill, collections: collectionsList, short_items: shortRes.rows, cancellation: cancelRes.rows[0] || null });
}));

router.post('/bills', handle(async (req, res) => {
  const out = await createBill({ payload: req.body, user: req.user });
  res.status(out.deduped ? 200 : 201).json(out);
}));

router.post('/bills/upload', upload.single('file'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an Excel file to upload.' });
  const ownerId = req.user.role === 'admin' && req.body.salesman_id ? Number(req.body.salesman_id) : req.user.id;
  const result = await parseBillWorkbook(req.file.path, {
    salesmanId: ownerId,
    billDate: req.body.bill_date || todayISO(),
    file: req.file.filename,
  });
  res.json(result);
}));

router.post('/attachments', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received. Try again.' });
  res.json({ path: req.file.filename, original: req.file.originalname });
});

/* ---------------------------------------------------------- field writes --- */

router.post('/collections', handle(async (req, res) => {
  const out = await recordCollection({ payload: req.body, user: req.user });
  res.status(out.deduped ? 200 : 201).json(out);
}));

router.post('/cancellations', handle(async (req, res) => {
  const out = await cancelBill({ payload: req.body, user: req.user });
  res.status(out.deduped ? 200 : 201).json(out);
}));

router.delete('/cancellations/:billId', handle(async (req, res) => {
  res.json(await uncancelBill({ billId: req.params.billId, user: req.user }));
}));

router.post('/short-items', handle(async (req, res) => {
  const out = await addShortItems({ payload: req.body, user: req.user });
  res.status(out.deduped ? 200 : 201).json(out);
}));

/* ------------------------------------------------------------------ day --- */

router.get('/session/today', handle(async (req, res) => {
  const date = req.query.date || todayISO();
  const rows = await billRows({ from: date, to: date, salesmanId: req.user.id });
  const session = await q1('SELECT * FROM day_sessions WHERE salesman_id = $1 AND work_date = $2', [req.user.id, date]);
  res.json({
    session: session || null,
    baseline: {
      date,
      bill_count: rows.length,
      amount: round2(rows.reduce((a, b) => a + b.amount, 0)),
      done: rows.filter((b) => b.status === 'delivered' || b.status === 'cancelled').length,
    },
  });
}));

router.post('/session/start', handle(async (req, res) => {
  const date = req.body?.work_date || todayISO();
  const existing = await q1('SELECT * FROM day_sessions WHERE salesman_id = $1 AND work_date = $2', [req.user.id, date]);
  if (existing) return res.json({ session: existing });
  const r = await qx(
    "INSERT INTO day_sessions (salesman_id, work_date, started_at) VALUES ($1, $2, (NOW() AT TIME ZONE 'utc')::text) RETURNING id",
    [req.user.id, date],
  );
  const session = await q1('SELECT * FROM day_sessions WHERE id = $1', [r.rows[0].id]);
  res.status(201).json({ session });
}));

router.post('/session/end', handle(async (req, res) => {
  const date = req.body?.work_date || todayISO();
  await qx(
    `INSERT INTO day_sessions (salesman_id, work_date, ended_at, closing_note)
     VALUES ($1, $2, (NOW() AT TIME ZONE 'utc')::text, $3)
     ON CONFLICT (salesman_id, work_date)
     DO UPDATE SET ended_at = (NOW() AT TIME ZONE 'utc')::text, closing_note = EXCLUDED.closing_note`,
    [req.user.id, date, req.body?.note || null],
  );
  const session = await q1('SELECT * FROM day_sessions WHERE salesman_id = $1 AND work_date = $2', [req.user.id, date]);
  res.json({ session });
}));

/* ------------------------------------------------------------ dashboard --- */

router.get('/me/dashboard', handle(async (req, res) => {
  const { from, to } = req.query;
  const salesmanId = req.user.role === 'admin' && req.query.salesmanId ? Number(req.query.salesmanId) : req.user.id;
  const r = await reconcile({ from, to, salesmanId });
  const bills = await billRows({ from, to, salesmanId });
  const byStatus = { delivered: 0, partial: 0, pending: 0, cancelled: 0 };
  const pending = [];
  let pendingAmount = 0;
  for (const b of bills) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    if (b.status === 'pending' || b.status === 'partial') {
      pending.push(b);
      pendingAmount += b.balance;
    }
  }
  const client = req._dbClient || pool;
  const deposit = await client.query(
    "SELECT COALESCE(SUM(amount),0) AS cash_today FROM collections WHERE salesman_id = $1 AND mode = 'cash' AND collection_date = $2",
    [salesmanId, todayISO()],
  );
  res.json({
    range: { from: from || null, to: to || null },
    expected: r.expected,
    collected: r.actual,
    variance: r.variance,
    by_mode: r.by_mode,
    bills: byStatus,
    bill_count: bills.length,
    cancelled: { count: r.cancelled_count, amount: r.cancelled_amount },
    short: { amount: r.short_amount, count: bills.reduce((a, b) => a + (b.short_count || 0), 0) },
    pending: { count: pending.length, amount: round2(pendingAmount) },
    cash_in_hand: round2(deposit.rows[0].cash_today),
    pending_list: pending.slice(0, 60),
  });
}));

/* -------------------------------------------------------------- lookups --- */

router.get('/shops', handle(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const salesmanId = req.user.role === 'admin' ? null : req.user.id;
  const client = req._dbClient || pool;
  const rows = await client.query(`
    SELECT id, name, area, owner_name FROM shops
    WHERE ($1::int IS NULL OR salesman_id = $1)
      AND ($2 = '' OR lower(name) LIKE '%' || lower($2) || '%' OR lower(COALESCE(area,'')) LIKE '%' || lower($2) || '%')
    ORDER BY name LIMIT 40`, [salesmanId, q]);
  res.json({ shops: rows.rows });
}));

router.get('/products', handle(async (req, res) => {
  const client = req._dbClient || pool;
  const rows = await client.query('SELECT id, name, default_rate FROM products ORDER BY name');
  res.json({ products: rows.rows });
}));

router.get('/salesmen', requireRole('admin'), handle(async (req, res) => {
  const client = req._dbClient || pool;
  const rows = await client.query("SELECT id, code, name, phone FROM users WHERE role = 'salesman' AND active = 1 ORDER BY code");
  res.json({ salesmen: rows.rows });
}));

export { HttpError };
