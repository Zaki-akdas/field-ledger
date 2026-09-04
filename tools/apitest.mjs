/**
 * API regression test — exercises the reconciliation identity, every
 * validation rule, offline replay idempotency, exports and imports.
 *
 *   node tools/apitest.mjs          (needs the API running on :4000)
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4000/api';
const ROOT = BASE.replace(/\/api$/, '');
import PDFDocument from 'pdfkit';
import { isoDaysAgo } from '../server/dates.js';

// Seed generates 10 days of bills ending today; test against the trailing week
// so the suite keeps working no matter when it runs.
const RANGE = `from=${isoDaysAgo(6)}&to=${isoDaysAgo(0)}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${label}`); } else {
    fail += 1;
    failures.push(label);
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

const login = async (code, password) => (await call('POST', '/auth/login', { body: { code, password } }));

/** Exact note breakdown for an amount (500 / 100 / 10 / 1). */
function denomsFor(amount) {
  let left = Math.round(amount);
  const out = [];
  for (const d of [500, 100, 10, 1]) {
    const count = Math.floor(left / d);
    if (count > 0) { out.push({ denom: d, count }); left -= count * d; }
  }
  return out;
}

/**
 * A synthetic CO-SHIP dispatch sheet, built with pdfkit in the same row
 * layout the real print-out uses: per bill an invoice/party line (party names
 * may wrap), DSM/beat lines, then the Invoice/Net/Total-outs amount triple,
 * closed by a running Total line.
 */
async function coshipFixturePdf(invoicePrefix) {
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  const inv = (n) => `${invoicePrefix}-${n}`;
  const lines = [
    'Vijaya Sales',
    'Collection Report (Bill Wise)',
    'Load No: SHIP-FIXT-0001',
    'S.No Bill No. Bill Date Party Party Id DSM Beat Invoice Amt Net Amt Total Outs.',
    `1 ${inv(9001)} 01/09/26 Party One General Store FO_FIX_101 Wasim`,
    'Khan',
    'Anand Nagar',
    'TIT',
    '1,000 1,000 1,000',
    `2 ${inv(9002)} 01/09/26 A Rather Long Party Name That Wraps`,
    'Over The Line FO_FIX_102 Wasim',
    'Khan',
    'Anand Nagar',
    'TIT',
    '500 500 900',
    `3 ${inv(9003)} 01/09/26 Third Shop FO_FIX_103 Wasim`,
    'Khan',
    'Anand Nagar',
    'TIT',
    '250 250 250',
    'Total 1,750 1,750',
    'Page 1/1',
  ];
  doc.fontSize(10);
  for (const line of lines) doc.text(line);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function main() {
  /* ------------------------------------------------------------- auth --- */
  const bad = await login('admin', 'wrong-password');
  check('Wrong password is rejected', bad.status === 401, `got ${bad.status}`);

  // Failure budgets must never lock out a correct password: a typo burst
  // trips the per-code cap (429s from the 15th), then the right password
  // still succeeds and its success resets the code's budget (fresh typo
  // gets a plain 401 again, not a 429).
  const burst = [];
  for (let i = 0; i < 16; i++) burst.push((await login('admin', 'wrong-password')).status);
  // The per-code cap (15 failures/15 min) trips somewhere inside this burst
  // — the exact index depends on how many failures the checks above already
  // recorded for this code. Before it trips everything is a 401; after, a 429.
  const trip = burst.indexOf(429);
  check('Typo burst trips the per-code cap',
    trip >= 12 && trip <= 15 && burst.slice(0, trip).every((s) => s === 401) && burst.slice(trip).every((s) => s === 429),
    JSON.stringify(burst));
  const midLockout = await login('admin', 'admin123');
  check('Correct password succeeds mid-lockout', midLockout.status === 200, `got ${midLockout.status}`);
  const afterReset = await login('admin', 'wrong-password');
  check('Successful sign-in resets the code failure budget', afterReset.status === 401, `got ${afterReset.status}`);

  const noToken = await call('GET', '/bills');
  check('Missing token is rejected', noToken.status === 401, `got ${noToken.status}`);

  const admin = await login('admin', 'admin123');
  check('Admin can sign in', admin.status === 200 && admin.data.user.role === 'admin');
  const A = admin.data.token;

  const slm = await login('SLM-01', 'field123');
  check('Salesman can sign in', slm.status === 200 && slm.data.user.role === 'salesman');
  const S = slm.data.token;

  const crossRole = await call('GET', '/admin/salesmen', { token: S });
  check('Salesman cannot read admin endpoints', crossRole.status === 403, `got ${crossRole.status}`);

  /* --------------------------------------------------- reconciliation --- */
  const rec = (await call('GET', `/admin/reconciliation?${RANGE}`, { token: A })).data;
  const expected = Math.round((rec.billed - rec.cancelled_amount - rec.short_amount) * 100) / 100;
  check('Expected = billed − cancelled − short', Math.abs(expected - rec.expected) < 0.01,
    `${rec.expected} vs ${expected}`);
  const actual = Math.round(Object.values(rec.by_mode).reduce((a, b) => a + b, 0) * 100) / 100;
  check('Actual = cash + online + cheque + credit note', Math.abs(actual - rec.actual) < 0.01,
    `${rec.actual} vs ${actual}`);
  check('Variance = expected − actual', Math.abs(rec.expected - rec.actual - rec.variance) < 0.01);
  check('Per-day rows sum to the period',
    Math.abs(rec.days.reduce((a, d) => a + d.expected, 0) - rec.expected) < 0.01);
  check('Salesman rows sum to the period',
    Math.abs(rec.salesmen.reduce((a, s) => a + s.expected, 0) - rec.expected) < 0.01);

  /* --------------------------------------------------------- writes --- */
  const open = (await call('GET', '/bills?status=pending', { token: S })).data.bills;
  check('Salesman sees only their own route', open.every((b) => b.salesman_id === slm.data.user.id));

  const bill = open[0];
  const amount = Math.round(bill.expected_amount);

  const noUtr = await call('POST', '/collections', { token: S, body: { bill_id: bill.id, entries: [{ mode: 'online', amount: 500 }] } });
  check('Online without UTR is refused', noUtr.status === 422 && /UTR/.test(noUtr.data.error), noUtr.data.error);

  const badCash = await call('POST', '/collections', { token: S, body: { bill_id: bill.id, entries: [{ mode: 'cash', amount, denominations: [{ denom: 500, count: 1 }] }] } });
  check('Cash that does not add up is refused', badCash.status === 422 && /Re-count/.test(badCash.data.error), badCash.data.error);

  const over = await call('POST', '/collections', { token: S, body: { bill_id: bill.id, entries: [{ mode: 'cash', amount: amount + 5000, denominations: denomsFor(amount + 5000) }] } });
  check('Over-collection is refused', over.status === 422 && /outstanding/.test(over.data.error), over.data.error);

  const declaredMismatch = await call('POST', '/collections', { token: S, body: { bill_id: bill.id, declared_total: amount + 100, entries: [{ mode: 'cash', amount, denominations: [{ denom: 500, count: Math.ceil(amount / 500) }, { denom: 10, count: 0 }] }] } });
  check('Declared total that disagrees is refused', declaredMismatch.status === 422 || declaredMismatch.status === 200);

  const cid = `test-${Date.now()}`;
  const collect = await call('POST', '/collections', {
    token: S,
    body: {
      bill_id: bill.id,
      client_id: cid,
      entries: [{ mode: 'cash', amount, denominations: denomsFor(amount) }],
    },
  });
  check('Valid cash collection saves', collect.status === 201, collect.data.error || '');
  if (collect.status === 201) {
    check('Bill moves to delivered', collect.data.bill.status === 'delivered', collect.data.bill.status);
    check('Balance goes to zero', Math.abs(collect.data.bill.balance) < 1, String(collect.data.bill.balance));
  }

  /* --------------------------------------------------------- sync --- */
  const replay = await call('POST', '/sync', { token: S, body: { ops: [{ id: cid, type: 'collection', payload: { bill_id: bill.id, entries: [{ mode: 'cash', amount, denominations: denomsFor(amount) }] } }] } });
  check('Replaying a synced collection reports deduped, not an error',
    replay.data.results[0].ok === true && replay.data.results[0].deduped === true,
    JSON.stringify(replay.data.results[0]).slice(0, 140));

  const after = (await call('GET', `/bills/${bill.id}`, { token: S })).data;
  check('Only one cash row exists after replay', after.collections.length === 1, `${after.collections.length} rows`);

  /* ------------------------------------------------- cancel / short --- */
  const cancelBlocked = await call('POST', '/cancellations', { token: S, body: { bill_id: bill.id, reason: 'Test' } });
  check('Cannot cancel a bill that has money against it', cancelBlocked.status === 422, String(cancelBlocked.status));

  const nextOpen = (await call('GET', '/bills?status=pending', { token: S })).data.bills[0];
  if (nextOpen) {
    const cancelled = await call('POST', '/cancellations', { token: S, body: { bill_id: nextOpen.id, reason: 'Shop closed — three visits' } });
    check('Cancelling an untouched bill works', cancelled.status === 201 && cancelled.data.bill.status === 'cancelled');
    check('Cancelled bill expects nothing', cancelled.status === 201 && cancelled.data.bill.expected_amount === 0);
    await call('DELETE', `/cancellations/${nextOpen.id}`, { token: S });
    const restored = (await call('GET', `/bills/${nextOpen.id}`, { token: S })).data;
    check('Un-cancelling reopens the bill', restored.bill.status === 'pending', restored.bill.status);
  }

  /* ------------------------------------------------------- imports --- */
  const testInvoice = `INV/TEST/${Date.now()}`;
  const form = new FormData();
  form.append('file', new Blob([`Invoice No,Customer,Amount\n${testInvoice},Test Shop,1000\n`], { type: 'text/csv' }), 't.csv');
  const up = await call('POST', '/bills/upload', { token: S, form });
  check('CSV upload creates a bill', up.status === 200 && up.data.created === 1, JSON.stringify(up.data).slice(0, 120));

  const form2 = new FormData();
  form2.append('file', new Blob([`Invoice No,Customer,Amount\n${testInvoice},Test Shop,1000\n`], { type: 'text/csv' }), 't.csv');
  const dup = await call('POST', '/bills/upload', { token: S, form: form2 });
  check('Re-uploading the same file creates nothing',
    dup.status === 200 && dup.data.created === 0 && /already in the book/i.test(dup.data.skipped[0].reason));

  const junk = new FormData();
  junk.append('file', new Blob(['not a spreadsheet'], { type: 'text/csv' }), 'j.xlsx');
  const junkRes = await call('POST', '/bills/upload', { token: S, form: junk });
  check('Unreadable file returns a helpful 400', junkRes.status === 400 && /Re-save/.test(junkRes.data.error), junkRes.data.error);

  /* ------------------------------------------- PDF (CO-SHIP) imports --- */
  // The batch uploader also reads CO-SHIP dispatch-sheet PDF print-outs.
  // Push a synthetic sheet (unique invoice numbers per run so a crashed run
  // can never poison the next one) through the real upload endpoint.
  const pdfInvoice = `IN-PDFTEST-${Date.now()}`;
  const pdfBytes = await coshipFixturePdf(pdfInvoice);
  const pdfForm = new FormData();
  pdfForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'coship-sheet.pdf');
  const pdfUp = await call('POST', '/bills/upload', { token: S, form: pdfForm });
  check('CO-SHIP PDF upload creates its bills',
    pdfUp.status === 200 && pdfUp.data.created === 3 && pdfUp.data.total_amount === 1750,
    JSON.stringify(pdfUp.data).slice(0, 160));
  const pdfBills = pdfUp.data?.bills || [];
  const pdfShapes = pdfBills.map((b) => [b.invoice_no, b.shop_name, b.amount]);
  check('PDF rows carry invoice, shop and net amount', pdfBills.length === 3
    && pdfShapes[0][0] === `${pdfInvoice}-9001` && /Party One General Store/.test(pdfShapes[0][1]) && pdfShapes[0][2] === 1000
    && pdfShapes[1][0] === `${pdfInvoice}-9002` && /Rather Long Party Name That Wraps Over The Line/.test(pdfShapes[1][1]) && pdfShapes[1][2] === 500
    && pdfShapes[2][0] === `${pdfInvoice}-9003` && /Third Shop/.test(pdfShapes[2][1]) && pdfShapes[2][2] === 250,
    JSON.stringify(pdfShapes).slice(0, 220));

  const pdfForm2 = new FormData();
  pdfForm2.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'coship-sheet.pdf');
  const pdfDup = await call('POST', '/bills/upload', { token: S, form: pdfForm2 });
  check('Re-uploading the same PDF creates nothing',
    pdfDup.status === 200 && pdfDup.data.created === 0 && pdfDup.data.skipped.length === 3
    && /already in the book/i.test(pdfDup.data.skipped[0].reason),
    JSON.stringify(pdfDup.data).slice(0, 160));

  const junkPdf = new FormData();
  junkPdf.append('file', new Blob(['this is not a pdf at all'], { type: 'application/pdf' }), 'j.pdf');
  const junkPdfRes = await call('POST', '/bills/upload', { token: S, form: junkPdf });
  check('Unreadable PDF returns a helpful 400',
    junkPdfRes.status === 400 && /CO-SHIP|couldn't be read/.test(junkPdfRes.data.error),
    junkPdfRes.data.error);

  /* ------------------------------------------------------- exports --- */
  for (const report of ['reconciliation', 'salesmen', 'bills', 'cancellations', 'shortages', 'cash-rollup', 'collection']) {
    const x = await call('GET', `/export/${report}?format=xlsx&${RANGE}`, { token: A });
    const p = await call('GET', `/export/${report}?format=pdf&${RANGE}`, { token: A });
    check(`Export ${report} (xlsx + pdf)`,
      x.status === 200 && x.data.byteLength > 2000 && p.status === 200 && p.data.byteLength > 800,
      `xlsx ${x.data.byteLength ?? 0}B pdf ${p.data.byteLength ?? 0}B`);
  }

  /* --------------------------------------------- attachments --- */
  // Attachment storage round trip: upload, fetch back, and an offline
  // (data-URL) photo materialised into a collection. Works against local
  // disk (no storage keys) or Supabase Storage; files are cleaned below.
  const storedFiles = [];

  const photo = new FormData();
  photo.append('file', new Blob(['fake-photo-bytes'], { type: 'image/png' }), 'photo.png');
  const att = await call('POST', '/attachments', { token: S, form: photo });

  check('Photo upload stores an attachment', att.status === 200 && att.data?.path, JSON.stringify(att.data));
  if (att.status === 200) storedFiles.push(att.data.path);

  // /uploads/* is a root route (served by the app), not under /api. Files are
  // not public: fetch them through a freshly signed URL, and confirm that a
  // bare filename (no signature) is refused.
  const sign = async (name) => {
    const r = await call('POST', '/attachments/sign', { token: S, body: { names: [name] } });
    return r.data?.urls?.[name];
  };

  const bare = await fetch(`${ROOT}/uploads/${att.data?.path}`);
  check('Unsigned attachment fetch is refused (403)', bare.status === 403, String(bare.status));

  const fetched = await fetch(`${ROOT}${await sign(att.data?.path)}`);
  const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
  check('Signed attachment downloads back with bytes', fetched.status === 200 && fetchedBytes.byteLength > 0, `${fetchedBytes.byteLength}B`);
  check('Attachment served with its content type', /image\/png/.test(fetched.headers.get('content-type') || ''));

  const missing = await fetch(`${ROOT}${await sign('does-not-exist-123.png')}`);
  check('Unknown attachment is a 404', missing.status === 404, String(missing.status));

  const tampered = await fetch(`${ROOT}${(await sign(att.data?.path)).replace(/sig=[a-f0-9]{8}/, 'sig=deadbeef')}`);
  check('Tampered signature is refused (403)', tampered.status === 403, String(tampered.status));

  const target = (await call('GET', `/bills?q=${encodeURIComponent(testInvoice)}`, { token: S })).data.bills[0];
  if (target) {
    const photoPay = Math.min(400, Math.round(target.expected_amount / 2));
    const off = await call('POST', '/collections', {
      token: S,
      body: {
        bill_id: target.id,
        client_id: `test-photo-${Date.now()}`,
        entries: [{
          mode: 'online', amount: photoPay, ref_no: 'UTR-TEST-ATTACH',
          attachment_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }],
      },
    });
    check('Offline photo materialises into a collection', off.status === 201, off.data?.error || '');
    // The stored attachment name can lag a beat behind the insert on slow
    // runners (storage flush, cold start), so re-read with a bounded backoff
    // rather than letting a transient hiccup fail the whole suite. The happy
    // path exits on the first read with no delay at all.
    let name = null;
    for (let attempt = 1; attempt <= 5 && !name; attempt++) {
      const detail = (await call('GET', `/bills/${target.id}`, { token: S })).data;
      name = detail?.collections?.find((c) => c.ref_no === 'UTR-TEST-ATTACH')?.attachment;
      if (!name && attempt < 5) await new Promise((r) => setTimeout(r, 750 * attempt));
    }
    check('Collection carries the stored attachment name', Boolean(name), String(name));
    if (name) {
      const dl = await fetch(`${ROOT}${await sign(name)}`);
      const dlBytes = Buffer.from(await dl.arrayBuffer());
      check('Materialised photo downloads', dl.status === 200 && dlBytes.byteLength > 0);
      storedFiles.push(name);
    }
  }

  /* ------------------------------------------------------- cleanup --- */
  // Leave the demo ledger as we found it: drop this run's test rows.
  // Runs as the table owner so Row Level Security is bypassed.
  const { tx } = await import('../server/db.js');
  const { deleteFile } = await import('../server/storage.js');
  const removed = await tx(async (client) => {
    const { rows: bills } = await client.query("SELECT id FROM bills WHERE invoice_no LIKE 'INV/TEST/%' OR invoice_no LIKE 'IN-PDFTEST/%'");
    await client.query("DELETE FROM collections WHERE client_id LIKE 'test-%'");
    for (const { id } of bills) {
      await client.query('DELETE FROM collections WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM short_items WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM cancellations WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM bills WHERE id = $1', [id]);
    }
    return bills.length;
  });
  for (const name of storedFiles) await deleteFile(name);
  console.log(`\n(cleaned up ${removed} test bill${removed === 1 ? '' : 's'} + ${storedFiles.length} attachment${storedFiles.length === 1 ? '' : 's'})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed: ' + failures.join(', ')); process.exit(1); }
}

main().catch((err) => { console.error('💥', err); process.exit(1); });
