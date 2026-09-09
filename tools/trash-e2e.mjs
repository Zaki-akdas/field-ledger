/**
 * E2E: hard-delete (purge) → trash → restore flow.
 * Defaults to a local API on :4000 (same convention as tools/apitest.mjs);
 * set LIVE_URL to aim it at a deployment instead. Self-cleaning: scratch
 * data is purged/erased on the way out, so it's safe to re-run.
 *
 *   node --env-file=.env tools/trash-e2e.mjs
 *   LIVE_URL=https://field-ledger-theta.vercel.app node tools/trash-e2e.mjs
 */
const BASE = process.env.LIVE_URL
  || (process.env.BASE || 'http://127.0.0.1:4000/api').replace(/\/api$/, '');
const CODE = process.env.LOGIN_CODE || 'admin';
const PASSWORD = process.env.LOGIN_PASSWORD || 'admin123';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${extra}`}`);
  ok ? passed++ : failed++;
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, data };
};

/* ── 1. Sign in ── */
const login = await call('POST', '/auth/login', { body: { code: CODE, password: PASSWORD } });
check('Admin signs in', login.status === 200 && login.data?.user?.role === 'admin', `status ${login.status}`);
if (login.status !== 200) process.exit(1);
const A = login.data.token;
const adminPassword = PASSWORD; // purge requires re-entering the admin's own password

/* ── 2. Create a scratch bill (unique invoice so reruns never collide) ── */
const invoice = `TRASH-E2E/${Date.now()}`;
const made = await call('POST', '/bills', {
  token: A,
  body: {
    invoice_no: invoice,
    shop_name: `E2E Trash Shop ${Date.now()}`,
    shop_area: 'TEST-AREA',
    amount: 1234.5,
    bill_date: new Date().toISOString().slice(0, 10),
  },
});
check('Scratch bill created', made.status === 200 || made.status === 201, JSON.stringify(made.data).slice(0, 120));
const billId = made.data?.bill?.id;
if (!billId) process.exit(1);

/* ── 3. Purge it — wrong password must be refused first ── */
const wrongPw = await call('POST', `/admin/bills/${billId}/purge`, { token: A, body: { password: 'definitely-wrong' } });
check('Purge refuses wrong password (401)', wrongPw.status === 401, `got ${wrongPw.status}`);

const noPw = await call('POST', `/admin/bills/${billId}/purge`, { token: A, body: {} });
check('Purge refuses missing password (400)', noPw.status === 400, `got ${noPw.status}`);

const purged = await call('POST', `/admin/bills/${billId}/purge`, { token: A, body: { password: adminPassword } });
check('Purge succeeds with correct password', purged.status === 200 && purged.data?.purged === true, JSON.stringify(purged.data).slice(0, 120));
const trashId = purged.data?.trash_id;
check('Purge returns a trash id + expiry', !!trashId && !!purged.data?.restorable_until, JSON.stringify(purged.data?.restorable_until));

/* ── 4. Bill is really gone from the ledger ── */
const gone = await call('GET', `/bills/${billId}`, { token: A });
check('Purged bill is gone from the ledger (404)', gone.status === 404, `got ${gone.status}`);

/* ── 5. Bill is in the bin, exactly once, with our invoice ── */
const bin = await call('GET', '/admin/trash', { token: A });
const mine = (bin.data?.entries || []).filter((e) => e.entity === 'bill' && e.entity_id === billId);
check('Trash lists the purged bill', mine.length === 1, `found ${mine.length}`);

/* ── 6. Restore it — the bill comes back with the same id ── */
const restored = await call('POST', `/admin/trash/${trashId}/restore`, { token: A, body: {} });
check('Restore succeeds', restored.status === 200 && restored.data?.restored === true, JSON.stringify(restored.data).slice(0, 120));

const back = await call('GET', `/bills/${billId}`, { token: A });
check('Restored bill is back with the SAME id', back.status === 200 && back.data?.bill?.id === billId && back.data?.bill?.invoice_no === invoice,
  `status ${back.status}, invoice ${back.data?.bill?.invoice_no}`);
check('Restored bill keeps amount intact', Number(back.data?.bill?.amount) === 1234.5, `amount ${back.data?.bill?.amount}`);

const binAfterRestore = await call('GET', '/admin/trash', { token: A });
const mineAfter = (binAfterRestore.data?.entries || []).filter((e) => e.entity === 'bill' && e.entity_id === billId);
check('Trash entry cleared after restore', mineAfter.length === 0, `found ${mineAfter.length}`);

/* ── 7. Purge again + erase forever (cleanup + covers the other path) ── */
const purge2 = await call('POST', `/admin/bills/${billId}/purge`, { token: A, body: { password: adminPassword } });
check('Second purge succeeds', purge2.status === 200, `status ${purge2.status}`);
const trashId2 = purge2.data?.trash_id;

const wipe = await call('POST', `/admin/trash/${trashId2}/purge`, { token: A, body: {} });
check('Erase-forever succeeds', wipe.status === 200 && wipe.data?.purged === true, JSON.stringify(wipe.data).slice(0, 120));

const stillGone = await call('GET', `/bills/${billId}`, { token: A });
check('Erased bill is gone for good (404)', stillGone.status === 404, `got ${stillGone.status}`);

const binFinal = await call('GET', '/admin/trash', { token: A });
check('Erased entry no longer in bin', !(binFinal.data?.entries || []).some((e) => e.id === trashId2));

/* ── 8. Restore the shop the scratch bill created (leave DB as found) ── */
const binShop = (binFinal.data?.entries || []).filter((e) => e.label?.includes('E2E Trash Shop'));
if (binShop.length > 0) {
  const shopWipe = await call('POST', `/admin/trash/${binShop[0].id}/purge`, { token: A, body: {} });
  check('Scratch shop cleaned from bin', shopWipe.status === 200 || shopWipe.status === 404, `got ${shopWipe.status}`);
} else {
  check('No scratch shop left in bin (shop row survived purge)', true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
