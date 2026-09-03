-- Canonical PostgreSQL schema for Field Ledger.
-- Applied by: tools/init-db.mjs (fresh databases), tools/migrate-to-supabase.js
-- (which drops tables first via its own DROP statements before running this file).
-- Safe to run against an existing database: every object is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('salesman','admin')),
  phone TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_name TEXT,
  area TEXT,
  phone TEXT,
  salesman_id INTEGER REFERENCES users(id),
  UNIQUE (name, area)
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bills (
  id SERIAL PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  bill_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  attachment TEXT,
  client_id TEXT UNIQUE,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS collections (
  id SERIAL PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('cash','online','cheque','credit_note')),
  amount REAL NOT NULL,
  ref_no TEXT,
  bank TEXT,
  cheque_date TEXT,
  note TEXT,
  attachment TEXT,
  collection_date TEXT NOT NULL,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS cash_denominations (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  denom INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS short_items (
  id SERIAL PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  product TEXT NOT NULL,
  qty REAL NOT NULL,
  rate REAL NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  short_date TEXT NOT NULL,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS cancellations (
  id SERIAL PRIMARY KEY,
  bill_id INTEGER NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  cancel_date TEXT NOT NULL,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS day_sessions (
  id SERIAL PRIMARY KEY,
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  opening_note TEXT,
  closing_note TEXT,
  UNIQUE (salesman_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(bill_date);
CREATE INDEX IF NOT EXISTS idx_bills_salesman ON bills(salesman_id);
CREATE INDEX IF NOT EXISTS idx_col_bill ON collections(bill_id);
CREATE INDEX IF NOT EXISTS idx_col_date ON collections(collection_date);
CREATE INDEX IF NOT EXISTS idx_col_salesman ON collections(salesman_id);
