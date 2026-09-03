/**
 * Set up Row Level Security (RLS) on all tables.
 * Uses PostgreSQL session variables set by the app on each request:
 *   SET app.current_user_id = '<user_id>';
 *   SET app.current_user_role = '<role>';
 *
 * Run once: node tools/setup-rls.js
 */
import pg from 'pg';
const { Client } = pg;

// Credentials come from the environment — never commit connection strings.
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set SUPABASE_DB_URL (or DATABASE_URL) to the PostgreSQL connection string.');
  process.exit(1);
}
const c = new Client({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

await c.connect();
console.log('Connected to Supabase PostgreSQL\n');

// ────────────────────────────────────────────────────────────
// 1. Helper function to read current user from session vars
// ────────────────────────────────────────────────────────────
await c.query(`
  CREATE OR REPLACE FUNCTION current_user_id() RETURNS int AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::int;
  $$ LANGUAGE sql STABLE;

  CREATE OR REPLACE FUNCTION current_user_role() RETURNS text AS $$
    SELECT NULLIF(current_setting('app.current_user_role', true), '');
  $$ LANGUAGE sql STABLE;

  CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean AS $$
    SELECT current_user_role() = 'admin';
  $$ LANGUAGE sql STABLE;
`);
console.log('✓ Created helper functions: current_user_id(), current_user_role(), is_admin()');

// ────────────────────────────────────────────────────────────
// 2. Enable RLS on all tables
// ────────────────────────────────────────────────────────────
const tables = [
  'users', 'sessions', 'shops', 'products',
  'bills', 'collections', 'cash_denominations',
  'short_items', 'cancellations', 'day_sessions',
];

for (const table of tables) {
  await c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  // Allow table owners to bypass RLS (for the service role / direct DB access)
  await c.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  console.log(`✓ RLS enabled on ${table}`);
}

// ────────────────────────────────────────────────────────────
// 3. Drop existing policies (idempotent)
// ────────────────────────────────────────────────────────────
for (const table of tables) {
  const { rows } = await c.query(`
    SELECT policyname FROM pg_policies WHERE tablename = $1
  `, [table]);
  for (const r of rows) {
    await c.query(`DROP POLICY IF EXISTS "${r.policyname}" ON ${table}`);
  }
}
console.log('✓ Cleared existing policies\n');

// ────────────────────────────────────────────────────────────
// 4. Create policies
// ────────────────────────────────────────────────────────────

// ── users ──
await c.query(`
  -- Everyone can see their own profile
  CREATE POLICY "users_select_own" ON users
    FOR SELECT USING (id = current_user_id());

  -- Admins can see all users
  CREATE POLICY "users_select_admin" ON users
    FOR SELECT USING (is_admin());

  -- Admins can update any user
  CREATE POLICY "users_update_admin" ON users
    FOR UPDATE USING (is_admin());

  -- Users can update their own password
  CREATE POLICY "users_update_own" ON users
    FOR UPDATE USING (id = current_user_id());
`);
console.log('✓ users policies');

// ── sessions ──
await c.query(`
  -- Users can manage their own sessions
  CREATE POLICY "sessions_select_own" ON sessions
    FOR SELECT USING (user_id = current_user_id());

  CREATE POLICY "sessions_insert_own" ON sessions
    FOR INSERT WITH CHECK (user_id = current_user_id());

  CREATE POLICY "sessions_delete_own" ON sessions
    FOR DELETE USING (user_id = current_user_id());
`);
console.log('✓ sessions policies');

// ── shops ──
await c.query(`
  -- Admins see all shops
  CREATE POLICY "shops_select_admin" ON shops
    FOR SELECT USING (is_admin());

  -- Salesmen see their own shops
  CREATE POLICY "shops_select_own" ON shops
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert/update/delete shops
  CREATE POLICY "shops_insert_admin" ON shops
    FOR INSERT WITH CHECK (is_admin());

  CREATE POLICY "shops_update_admin" ON shops
    FOR UPDATE USING (is_admin());

  CREATE POLICY "shops_delete_admin" ON shops
    FOR DELETE USING (is_admin());
`);
console.log('✓ shops policies');

// ── products ──
await c.query(`
  -- Products are public read (lookup table)
  CREATE POLICY "products_select_all" ON products
    FOR SELECT USING (true);

  -- Only admins can modify products
  CREATE POLICY "products_insert_admin" ON products
    FOR INSERT WITH CHECK (is_admin());

  CREATE POLICY "products_update_admin" ON products
    FOR UPDATE USING (is_admin());

  CREATE POLICY "products_delete_admin" ON products
    FOR DELETE USING (is_admin());
`);
console.log('✓ products policies');

// ── bills ──
await c.query(`
  -- Admins see all bills
  CREATE POLICY "bills_select_admin" ON bills
    FOR SELECT USING (is_admin());

  -- Salesmen see their own bills
  CREATE POLICY "bills_select_own" ON bills
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert bills (batch upload)
  CREATE POLICY "bills_insert_admin" ON bills
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert bills (field upload)
  CREATE POLICY "bills_insert_own" ON bills
    FOR INSERT WITH CHECK (salesman_id = current_user_id());

  -- Admins can update any bill
  CREATE POLICY "bills_update_admin" ON bills
    FOR UPDATE USING (is_admin());

  -- Salesmen can update their own bills (mark cancelled, etc.)
  CREATE POLICY "bills_update_own" ON bills
    FOR UPDATE USING (salesman_id = current_user_id());
`);
console.log('✓ bills policies');

// ── collections ──
await c.query(`
  -- Admins see all collections
  CREATE POLICY "collections_select_admin" ON collections
    FOR SELECT USING (is_admin());

  -- Salesmen see their own collections
  CREATE POLICY "collections_select_own" ON collections
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert collections
  CREATE POLICY "collections_insert_admin" ON collections
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert collections (field collection)
  CREATE POLICY "collections_insert_own" ON collections
    FOR INSERT WITH CHECK (salesman_id = current_user_id());

  -- Admins can update/delete collections
  CREATE POLICY "collections_update_admin" ON collections
    FOR UPDATE USING (is_admin());

  CREATE POLICY "collections_delete_admin" ON collections
    FOR DELETE USING (is_admin());
`);
console.log('✓ collections policies');

// ── cash_denominations ──
await c.query(`
  -- Admins see all denominations
  CREATE POLICY "cash_denom_select_admin" ON cash_denominations
    FOR SELECT USING (is_admin());

  -- Salesmen see denominations for their own collections
  CREATE POLICY "cash_denom_select_own" ON cash_denominations
    FOR SELECT USING (
      collection_id IN (
        SELECT id FROM collections WHERE salesman_id = current_user_id()
      )
    );

  -- Admins can insert denominations
  CREATE POLICY "cash_denom_insert_admin" ON cash_denominations
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert denominations for their own collections
  CREATE POLICY "cash_denom_insert_own" ON cash_denominations
    FOR INSERT WITH CHECK (
      collection_id IN (
        SELECT id FROM collections WHERE salesman_id = current_user_id()
      )
    );
`);
console.log('✓ cash_denominations policies');

// ── short_items ──
await c.query(`
  -- Admins see all short items
  CREATE POLICY "short_items_select_admin" ON short_items
    FOR SELECT USING (is_admin());

  -- Salesmen see their own short items
  CREATE POLICY "short_items_select_own" ON short_items
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert short items
  CREATE POLICY "short_items_insert_admin" ON short_items
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert short items (field reporting)
  CREATE POLICY "short_items_insert_own" ON short_items
    FOR INSERT WITH CHECK (salesman_id = current_user_id());

  -- Admins can update/delete short items
  CREATE POLICY "short_items_update_admin" ON short_items
    FOR UPDATE USING (is_admin());

  CREATE POLICY "short_items_delete_admin" ON short_items
    FOR DELETE USING (is_admin());
`);
console.log('✓ short_items policies');

// ── cancellations ──
await c.query(`
  -- Admins see all cancellations
  CREATE POLICY "cancellations_select_admin" ON cancellations
    FOR SELECT USING (is_admin());

  -- Salesmen see their own cancellations
  CREATE POLICY "cancellations_select_own" ON cancellations
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert cancellations
  CREATE POLICY "cancellations_insert_admin" ON cancellations
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert cancellations (field cancellation)
  CREATE POLICY "cancellations_insert_own" ON cancellations
    FOR INSERT WITH CHECK (salesman_id = current_user_id());

  -- Admins can delete cancellations (undo)
  CREATE POLICY "cancellations_delete_admin" ON cancellations
    FOR DELETE USING (is_admin());

  -- Salesmen can delete their own cancellations (undo)
  CREATE POLICY "cancellations_delete_own" ON cancellations
    FOR DELETE USING (salesman_id = current_user_id());
`);
console.log('✓ cancellations policies');

// ── day_sessions ──
await c.query(`
  -- Admins see all day sessions
  CREATE POLICY "day_sessions_select_admin" ON day_sessions
    FOR SELECT USING (is_admin());

  -- Salesmen see their own day sessions
  CREATE POLICY "day_sessions_select_own" ON day_sessions
    FOR SELECT USING (salesman_id = current_user_id());

  -- Admins can insert day sessions
  CREATE POLICY "day_sessions_insert_admin" ON day_sessions
    FOR INSERT WITH CHECK (is_admin());

  -- Salesmen can insert their own day sessions
  CREATE POLICY "day_sessions_insert_own" ON day_sessions
    FOR INSERT WITH CHECK (salesman_id = current_user_id());

  -- Admins can update day sessions
  CREATE POLICY "day_sessions_update_admin" ON day_sessions
    FOR UPDATE USING (is_admin());

  -- Salesmen can update their own day sessions (end day)
  CREATE POLICY "day_sessions_update_own" ON day_sessions
    FOR UPDATE USING (salesman_id = current_user_id());
`);
console.log('✓ day_sessions policies');

// ────────────────────────────────────────────────────────────
// 5. Verify
// ────────────────────────────────────────────────────────────
console.log('\n── Verification ──');
for (const table of tables) {
  const { rows } = await c.query(`
    SELECT COUNT(*)::int AS n FROM pg_policies WHERE tablename = $1
  `, [table]);
  const rls = await c.query(`
    SELECT relrowsecurity FROM pg_class WHERE relname = $1
  `, [table]);
  const enabled = rls.rows[0]?.relrowsecurity;
  console.log(`  ${table}: ${rows[0].n} policies, RLS ${enabled ? 'ON' : 'OFF'}`);
}

await c.end();
console.log('\n✅ RLS setup complete!');
