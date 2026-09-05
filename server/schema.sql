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
  amount NUMERIC(12,2) NOT NULL,
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
  amount NUMERIC(12,2) NOT NULL,
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
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  short_date TEXT NOT NULL,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE TABLE IF NOT EXISTS cancellations (
  id SERIAL PRIMARY KEY,
  bill_id INTEGER NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
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

-- ── Pre-auth lookups (SECURITY DEFINER) ────────────────────────────────────
-- Login and token→user resolution run before a JWT actor exists, so RLS
-- (which keys on request.jwt.claims) would return nothing for a non-owner
-- DATABASE_URL role. These helpers execute as the table owner and return
-- exactly the columns the app needs. EXECUTE is revoked from PUBLIC and
-- granted to the platform 'authenticated' role; custom roles need their own
-- GRANT (see README). Kept in sync with tools/setup-rls.js.
CREATE OR REPLACE FUNCTION app_find_user_by_code(p_code text)
RETURNS TABLE (id integer, code text, name text, role text, phone text, password_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, code, name, role, phone, password_hash
  FROM users
  WHERE lower(code) = lower(p_code) AND active = 1
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app_session_user(p_token text)
RETURNS TABLE (id integer, code text, name text, role text, phone text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT u.id, u.code, u.name, u.role, u.phone
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND u.active = 1
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app_create_session(p_token text, p_user_id integer)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO sessions (token, user_id) VALUES (p_token, p_user_id);
$$;

CREATE OR REPLACE FUNCTION app_destroy_session(p_token text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM sessions WHERE token = p_token;
$$;

REVOKE ALL ON FUNCTION app_find_user_by_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_session_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_create_session(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_destroy_session(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION app_find_user_by_code(text) TO authenticated;
    GRANT EXECUTE ON FUNCTION app_session_user(text) TO authenticated;
    GRANT EXECUTE ON FUNCTION app_create_session(text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION app_destroy_session(text) TO authenticated;
  END IF;
END
$$;

-- ── Shop payment pattern (SECURITY INVOKER) ────────────────────────────
-- How a shop usually pays, from its settled history: shares of cash vs
-- online vs cheque in collected money, how many bills it has settled, and
-- whether it leans on credit notes. Pass p_salesman_id to scope a salesman
-- to his own route's history (NULL sees everything — admins). Kept as SQL
-- so it runs identically under RLS and owner connections.
CREATE OR REPLACE FUNCTION app_shop_payment_pattern(p_shop_id integer, p_salesman_id integer DEFAULT NULL)
RETURNS TABLE (
  bills_settled bigint,
  cash numeric,
  online numeric,
  cheque numeric,
  credit_note numeric,
  total numeric,
  last_collection_date text
)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT
    COUNT(DISTINCT co.bill_id)::bigint,
    COALESCE(SUM(co.amount) FILTER (WHERE co.mode = 'cash'), 0),
    COALESCE(SUM(co.amount) FILTER (WHERE co.mode = 'online'), 0),
    COALESCE(SUM(co.amount) FILTER (WHERE co.mode = 'cheque'), 0),
    COALESCE(SUM(co.amount) FILTER (WHERE co.mode = 'credit_note'), 0),
    COALESCE(SUM(co.amount), 0),
    MAX(co.collection_date)::text
  FROM collections co
  JOIN bills b ON b.id = co.bill_id
  WHERE b.shop_id = p_shop_id
    AND ($2::int IS NULL OR b.salesman_id = $2)
    AND NOT EXISTS (
      SELECT 1 FROM cancellations x
      WHERE x.bill_id = co.bill_id AND x.amount >= b.amount
    )
  GROUP BY b.shop_id;
$$;
