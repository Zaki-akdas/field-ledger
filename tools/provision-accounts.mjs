/**
 * Idempotent account + reference-data provisioner. Creates the login accounts
 * (admin, ops, SLM-01..SLM-06) and the product catalog the shortage form uses.
 * No demo bills, collections, or shops — the book starts empty and fills only
 * with real uploads. Safe to run repeatedly.
 *
 *   node --env-file-if-exists=.env tools/provision-accounts.mjs
 */
import { pool, q1 } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

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

let created = 0;
let existing = 0;

async function upsertUser(code, name, role, phone, password) {
  const found = await q1('SELECT id FROM users WHERE code = $1', [code]);
  if (found) {
    existing += 1;
    return found.id;
  }
  const { rows: [row] } = await pool.query(
    'INSERT INTO users (code, name, role, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [code, name, role, phone, hashPassword(password)],
  );
  created += 1;
  return row.id;
}

for (const [code, name, role, phone, pw] of ADMIN) await upsertUser(code, name, role, phone, pw);
for (const [code, name, phone] of SALESMEN) await upsertUser(code, name, 'salesman', phone, 'field123');

let productCreates = 0;
for (const [name, rate] of PRODUCTS) {
  const found = await q1('SELECT id FROM products WHERE name = $1', [name]);
  if (!found) {
    await pool.query('INSERT INTO products (name, default_rate) VALUES ($1, $2)', [name, rate]);
    productCreates += 1;
  }
}

console.log(`[provision] users: ${created} created, ${existing} existing · products: ${productCreates} created`);
await pool.end();
