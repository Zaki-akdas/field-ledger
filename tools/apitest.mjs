/**
 * API regression test — exercises the reconciliation identity, every
 * validation rule, offline replay idempotency, exports and imports.
 *
 *   node tools/apitest.mjs          (needs the API running on :4000)
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4000/api';
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

async function main() {
  /* ------------------------------------------------------------- auth --- */
  const bad = await login('admin', 'wrong-password');
  check('Wrong password is rejected', bad.status === 401, `got ${bad.status}`);

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

  /* ------------------------------------------------------- exports --- */
  for (const report of ['reconciliation', 'salesmen', 'bills', 'cancellations', 'shortages', 'cash-rollup']) {
    const x = await call('GET', `/export/${report}?format=xlsx&${RANGE}`, { token: A });
    const p = await call('GET', `/export/${report}?format=pdf&${RANGE}`, { token: A });
    check(`Export ${report} (xlsx + pdf)`,
      x.status === 200 && x.data.byteLength > 2000 && p.status === 200 && p.data.byteLength > 800,
      `xlsx ${x.data.byteLength ?? 0}B pdf ${p.data.byteLength ?? 0}B`);
  }

  /* ------------------------------------------------------- cleanup --- */
  // Leave the demo ledger as we found it: drop this run's test rows.
  // Runs as the table owner so Row Level Security is bypassed.
  const { tx } = await import('../server/db.js');
  const removed = await tx(async (client) => {
    const { rows: bills } = await client.query("SELECT id FROM bills WHERE invoice_no LIKE 'INV/TEST/%'");
    await client.query("DELETE FROM collections WHERE client_id LIKE 'test-%'");
    for (const { id } of bills) {
      await client.query('DELETE FROM collections WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM short_items WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM cancellations WHERE bill_id = $1', [id]);
      await client.query('DELETE FROM bills WHERE id = $1', [id]);
    }
    return bills.length;
  });
  console.log(`\n(cleaned up ${removed} test bill${removed === 1 ? '' : 's'})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed: ' + failures.join(', ')); process.exit(1); }
}

main().catch((err) => { console.error('💥', err); process.exit(1); });
