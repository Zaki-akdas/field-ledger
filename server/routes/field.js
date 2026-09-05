import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { billRows, billRow, reconcile, round2, q1, qx, q } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { todayISO } from '../dates.js';
import { upload, photoUpload } from '../uploads.js';
import { saveFile, signedUploadUrl } from '../storage.js';
import { parseBillWorkbook } from '../import.js';
import { parseCoshipPdf } from '../pdfImport.js';
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
  const bill = await billRow(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (req.user.role !== 'admin' && bill.salesman_id !== req.user.id) {
    return res.status(403).json({ error: 'This bill is not on your route.' });
  }
  const collectionsList = await q('SELECT * FROM collections WHERE bill_id = $1 ORDER BY id', [bill.id]);
  for (const c of collectionsList) {
    c.denominations = await q('SELECT denom, count FROM cash_denominations WHERE collection_id = $1 ORDER BY denom DESC', [c.id]);
  }
  const shortItems = await q('SELECT * FROM short_items WHERE bill_id = $1 ORDER BY id', [bill.id]);
  const cancellation = (await q('SELECT * FROM cancellations WHERE bill_id = $1', [bill.id]))[0] || null;
  res.json({ bill, collections: collectionsList, short_items: shortItems, cancellation });
}));

router.post('/bills', handle(async (req, res) => {
  const out = await createBill({ payload: req.body, user: req.user });
  res.status(out.deduped ? 200 : 201).json(out);
}));

router.post('/bills/upload', upload.single('file'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an Excel, CSV or PDF file to upload.' });
  const ownerId = req.user.role === 'admin' && req.body.salesman_id ? Number(req.body.salesman_id) : req.user.id;
  const opts = {
    salesmanId: ownerId,
    billDate: req.body.bill_date || todayISO(),
    file: req.file.filename,
  };
  try {
    // A CO-SHIP dispatch sheet arrives as a PDF print-out; everything else is
    // parsed as a spreadsheet (xlsx/xls/csv).
    const isPdf = /\.pdf$/i.test(req.file.originalname || req.file.filename || '');
    const result = isPdf
      ? await parseCoshipPdf(req.file.path, opts)
      : await parseBillWorkbook(req.file.path, opts);
    res.json(result);
  } finally {
    // The file is parsed and no longer needed — never leave temp files.
    fs.unlink(req.file.path, () => {});
  }
}));

router.post('/attachments', photoUpload.single('file'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received. Try again.' });
  const name = await saveFile({
    data: req.file.buffer,
    contentType: req.file.mimetype || 'application/octet-stream',
    ext: path.extname(req.file.originalname || ''),
  });
  if (!name) return res.status(500).json({ error: 'Could not store that photo right now. Try again.' });
  res.json({ path: name, original: req.file.originalname });
}));

/**
 * Mint short-lived, signed /uploads URLs for a set of stored files.
 * Logged-in only (the router above applies requireAuth); the URLs are
 * per-file, expire after an hour, and are the only way to fetch bytes —
 * attachment names in the database are not enough to download a file.
 */
router.post('/attachments/sign', handle(async (req, res) => {
  const asked = Array.isArray(req.body?.names)
    ? req.body.names
    : req.body?.name ? [req.body.name] : [];
  const names = [...new Set(asked.map((n) => String(n)).filter(Boolean))].slice(0, 50);
  if (names.length === 0) return res.status(400).json({ error: 'Send attachment name(s) to sign.' });
  const urls = {};
  for (const n of names) {
    const u = signedUploadUrl(n);
    if (u) urls[n] = u;
  }
  res.json({
    urls,
    // Seconds after which every URL in this response expires; the client
    // re-signs when it needs fresh links (refresh or re-open).
    expiresIn: Number(process.env.UPLOAD_SIGN_TTL || 3600),
  });
}));

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

  // Auto-email the day's collection report (PDF + Excel) to the office.
  // Runs only when SMTP is configured; failures never break the day end.
  let report_email = 'unconfigured';
  if (!process.env.OFFICE_EMAIL) {
    report_email = 'unconfigured';
  } else {
    try {
      const mail = await import('../mail.js');
      if (mail.isMailConfigured()) {
        const ex = await import('../exports.js');
        const summary = await ex.collectionSummary({ from: date, to: date, salesmanId: req.user.id });
        if (summary.count > 0) {
          const [pdf, xlsx] = await Promise.all([
            ex.buildPdf({ report: 'collection', from: date, to: date, salesmanId: req.user.id }),
            ex.buildWorkbook({ report: 'collection', from: date, to: date, salesmanId: req.user.id }),
          ]);
          const send = mail.sendDayReportEmail({
            to: process.env.OFFICE_EMAIL,
            salesman: req.user,
            date,
            summary,
            attachments: [
              { filename: pdf.filename, content: Buffer.from(pdf.buffer), contentType: 'application/pdf' },
              { filename: xlsx.filename, content: Buffer.from(xlsx.buffer), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            ],
          });
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP send timed out')), 8000));
          report_email = (await Promise.race([send, timeout])).ok ? 'sent' : 'failed';
        } else {
          report_email = 'no-bills';
        }
      }
    } catch (err) {
      report_email = 'failed';
      console.error('day-end report email failed:', err.message);
    }
  }
  res.json({ session, report_email });
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
  const deposit = await q1(
    "SELECT COALESCE(SUM(amount::numeric),0)::float8 AS cash_today FROM collections WHERE salesman_id = $1 AND mode = 'cash' AND collection_date = $2",
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
    cash_in_hand: round2(deposit?.cash_today || 0),
    pending_list: pending.slice(0, 60),
  });
}));

/* -------------------------------------------------------------- lookups --- */

router.get('/shops', handle(async (req, res) => {
  const needle = String(req.query.q || '').trim();
  const salesmanId = req.user.role === 'admin' ? null : req.user.id;
  const rows = await q(`
    SELECT id, name, area, owner_name FROM shops
    WHERE ($1::int IS NULL OR salesman_id = $1)
      AND ($2 = '' OR lower(name) LIKE '%' || lower($2) || '%' OR lower(COALESCE(area,'')) LIKE '%' || lower($2) || '%')
    ORDER BY name LIMIT 40`, [salesmanId, needle]);
  res.json({ shops: rows });
}));

router.get('/products', handle(async (req, res) => {
  const rows = await q('SELECT id, name, default_rate FROM products ORDER BY name');
  res.json({ products: rows });
}));

router.get('/salesmen', requireRole('admin'), handle(async (req, res) => {
  const rows = await q("SELECT id, code, name, phone FROM users WHERE role = 'salesman' AND active = 1 ORDER BY code");
  res.json({ salesmen: rows });
}));

/* ------------------------------------------------- shop payment pattern --- */

// How this shop usually pays (cash/online/cheque/credit-note shares over its
// settled history). Powers the Collect screen's "usual split" suggestion.
// Salesmen are scoped to their own route's history inside the SQL itself
// (correct under RLS and owner connections alike); admins see every shop.
// Shops with no settled bills return a null pattern.
router.get('/shops/:id/payment-pattern', handle(async (req, res) => {
  const scope = req.user.role === 'admin' ? null : req.user.id;
  const rows = await qx('SELECT * FROM app_shop_payment_pattern($1, $2)', [Number(req.params.id), scope]);
  const r = rows.rows[0] || null;
  res.json({ pattern: r ? {
    bills_settled: Number(r.bills_settled),
    cash: Number(r.cash),
    online: Number(r.online),
    cheque: Number(r.cheque),
    credit_note: Number(r.credit_note),
    total: Number(r.total),
    last_collection_date: r.last_collection_date,
  } : null });
}));

/* ------------------------------------------------------------------ UPI --- */

// Payee config for the Collect screen's scannable UPI QR. Deliberately
// env-driven: nothing is hardcoded, and the endpoint reports `enabled: false`
// until the office sets UPI_VPA, so the app never shows a guessed account.
router.get('/upi', handle(async (req, res) => {
  const vpa = (process.env.UPI_VPA || '').trim();
  if (!vpa) return res.json({ enabled: false });
  res.json({ enabled: true, vpa, name: (process.env.UPI_PAYEE_NAME || '').trim() });
}));

export { HttpError };
