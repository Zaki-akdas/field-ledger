/**
 * Idempotent account + reference-data provisioner. Creates the login accounts
 * (admin, ops, SLM-01..SLM-06) and the product catalog the shortage form uses.
 * No demo bills, collections, or shops — the book starts empty and fills only
 * with real uploads. Safe to run repeatedly.
 *
 * Password policy: every provisioned account is created with a strong random
 * password and the must_change_password flag set, so the first sign-in is
 * forced through rotation before anything else works. The passwords are
 * printed ONCE here and nowhere else — never logged, never stored in plaintext.
 *
 * Local development/demo convenience (NOT for production):
 *   PROVIDE_SEEDED_PASSWORDS=1 npm run provision
 * RESETS the seeded accounts to the well-known passwords (admin123 / ops123 /
 * field123) and clears their rotation flag, which is what the test suite
 * (smoke, apitest, trash-e2e) expects. Never run this against production —
 * it deliberately re-installs credentials that are public in the README.
 *
 *   node --env-file-if-exists=.env tools/provision-accounts.mjs
 */
import { randomBytes } from 'node:crypto';
import { pool, q1 } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const SEEDED = process.env.PROVIDE_SEEDED_PASSWORDS === '1';

// Kept only so PROVIDE_SEEDED_PASSWORDS=1 can restore them in dev/test DBs.
const SEEDED_PW = { admin: 'admin123', ops: 'ops123', salesman: 'field123' };

const ADMIN = [
  ['admin', 'Neha Kulkarni', 'admin', '98260 00001', 'admin123'],
  ['ops', 'Back Office', 'admin', '98260 00002', 'ops123'],
];

const SALESMEN = [
  ['SLM-01', 'Ramesh Yadav', '98260 11234'],
  ['SLM-02', 'Suresh Patil', '98260 22345'],
  ['SLM-03', 'Anil Sharma', '98260 33456'],
  ['SLM-04', 'Vikram Chouhan', '98260 44567'],
  ['SLM-05', 'Imran Qureshi', '98260 55678'],
  ['SLM-06', 'Deepak Verma', '98260 66789'],
];

const PRODUCTS = [
  ['Chips 52g', 10],
  ['Kurkure 60g', 10],
  ['Lays 30g', 5],
  ['Biscuits 75g', 10],
  ['Cake 65g', 15],
  ['Namkeen 100g', 20],
  ['Cold drink 200ml', 20],
  ['Cold drink 600ml', 35],
  ['Milk 500ml', 25],
  ['Bread 400g', 20],
];

// Human-friendly but strong: 4 groups of 5 base32-ish chars — 20 chars of
// ~100 bits, readable aloud over a phone call to a salesman.
function strongPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += alphabet[raw[i] % alphabet.length];
  return s.match(/.{5}/g).join('-');
}

let created = 0;
let existing = 0;
const issued = []; // printed once at the end, only for newly created accounts

async function upsertUser(code, name, role, phone, password) {
  const found = await q1('SELECT id FROM users WHERE code = $1', [code]);
  if (found) {
    existing += 1;
    return { id: found.id, password: null };
  }
  const pw = SEEDED ? password : strongPassword();
  const { rows: [row] } = await pool.query(
    `INSERT INTO users (code, name, role, phone, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
    [code, name, role, phone, hashPassword(pw)],
  );
  created += 1;
  return { id: row.id, password: pw };
}

for (const [code, name, role, phone, pw] of ADMIN) {
  const r = await upsertUser(code, name, role, phone, pw);
  if (r.password) issued.push([code, r.password]);
}
for (const [code, name, phone] of SALESMEN) {
  const r = await upsertUser(code, name, 'salesman', phone, 'field123');
  if (r.password) issued.push([code, r.password]);
}

// Dev/test mode: put the seeded accounts back on their well-known passwords
// with no rotation flag, so smoke/apitest/trash-e2e/overflow can drive them.
if (SEEDED) {
  const { hashPassword: hash } = await import('../server/auth.js');
  for (const [code, , , , pw] of ADMIN) {
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = 0 WHERE code = $2', [hash(pw), code]);
  }
  for (const [code] of SALESMEN) {
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = 0 WHERE code = $2', [hash(SEEDED_PW.salesman), code]);
  }
  console.log('[provision] PROVIDE_SEEDED_PASSWORDS=1 — seeded accounts RESET to well-known passwords, rotation flag cleared (dev/test only!).');
}

let productCreates = 0;
for (const [name, rate] of PRODUCTS) {
  const found = await q1('SELECT id FROM products WHERE name = $1', [name]);
  if (!found) {
    await pool.query('INSERT INTO products (name, default_rate) VALUES ($1, $2)', [name, rate]);
    productCreates += 1;
  }
}

console.log(`[provision] users: ${created} created, ${existing} existing · products: ${productCreates} created`);
if (issued.length > 0 && !SEEDED) {
  console.log('\n── New account passwords (shown ONCE — hand out securely, never re-print) ──');
  for (const [code, pw] of issued) console.log(`  ${code.padEnd(8)} ${pw}`);
  console.log('\nEvery new account must change its password at first sign-in before the app opens.');
}
await pool.end();
