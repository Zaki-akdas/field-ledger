/**
 * Migrate SQLite ledger → Supabase PostgreSQL (batched).
 * Usage: node tools/migrate-to-supabase.js
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Credentials come from the environment — never commit connection strings.
const SUPABASE_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!SUPABASE_URL) {
  console.error('Set SUPABASE_DB_URL (or DATABASE_URL) to the destination PostgreSQL connection string.');
  process.exit(1);
}
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, 'server', 'data', 'ledger.db');

const { Client } = pg;
const pgClient = new Client({
  connectionString: SUPABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const sqlLite = new Database(SQLITE_PATH);

// The destination schema now lives in server/schema.sql — read it so the two
// stay in sync. Migration wipes the destination tables first, then replays data.
const DROPS = `
DROP TABLE IF EXISTS cash_denominations CASCADE;
DROP TABLE IF EXISTS short_items CASCADE;
DROP TABLE IF EXISTS collections CASCADE;
DROP TABLE IF EXISTS cancellations CASCADE;
DROP TABLE IF EXISTS day_sessions CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS bills CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS shops CASCADE;
DROP TABLE IF EXISTS users CASCADE;
`;
const SCHEMA = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');

function v(val) {
  if (val === null || val === undefined) return null;
  return val;
}

async function batchInsert(table, cols, rows, batchSize = 200) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const placeholders = [];
    const params = [];
    let idx = 1;
    for (const row of batch) {
      const rowPH = cols.map(() => `$${idx++}`);
      placeholders.push(`(${rowPH.join(',')})`);
      for (const c of cols) params.push(v(row[c]));
    }
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`;
    await pgClient.query(sql, params);
  }
  console.log(`  ✓ ${rows.length} rows into ${table}`);
}

async function migrate() {
  console.log('Connecting to Supabase...');
  await pgClient.connect();

  console.log('Creating schema...');
  await pgClient.query(DROPS);
  await pgClient.query(SCHEMA);
  await pgClient.query('SET session_replication_role = replica;');
  console.log('Schema created.');

  // Users
  const users = sqlLite.prepare('SELECT * FROM users ORDER BY id').all();
  console.log(`Users (${users.length})...`);
  await batchInsert('users',
    ['id', 'code', 'name', 'role', 'phone', 'password_hash', 'active', 'created_at'],
    users
  );
  const maxUserId = Math.max(...users.map(u => u.id));
  await pgClient.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), $1)`, [maxUserId]);

  // Shops
  const shops = sqlLite.prepare('SELECT * FROM shops ORDER BY id').all();
  console.log(`Shops (${shops.length})...`);
  await batchInsert('shops',
    ['id', 'name', 'owner_name', 'area', 'phone', 'salesman_id'],
    shops
  );
  const maxShopId = Math.max(...shops.map(s => s.id));
  await pgClient.query(`SELECT setval(pg_get_serial_sequence('shops', 'id'), $1)`, [maxShopId]);

  // Products
  const products = sqlLite.prepare('SELECT * FROM products ORDER BY id').all();
  console.log(`Products (${products.length})...`);
  await batchInsert('products',
    ['id', 'name', 'default_rate'],
    products
  );
  const maxProductId = Math.max(...products.map(p => p.id));
  await pgClient.query(`SELECT setval(pg_get_serial_sequence('products', 'id'), $1)`, [maxProductId]);

  // Bills
  const bills = sqlLite.prepare('SELECT * FROM bills ORDER BY id').all();
  console.log(`Bills (${bills.length})...`);
  await batchInsert('bills',
    ['id', 'invoice_no', 'shop_id', 'salesman_id', 'amount', 'bill_date', 'source', 'attachment', 'client_id', 'cancelled_at', 'created_at'],
    bills
  );
  const maxBillId = Math.max(...bills.map(b => b.id));
  await pgClient.query(`SELECT setval(pg_get_serial_sequence('bills', 'id'), $1)`, [maxBillId]);

  // Collections
  const collections = sqlLite.prepare('SELECT * FROM collections ORDER BY id').all();
  console.log(`Collections (${collections.length})...`);
  await batchInsert('collections',
    ['id', 'bill_id', 'salesman_id', 'mode', 'amount', 'ref_no', 'bank', 'cheque_date', 'note', 'attachment', 'collection_date', 'client_id', 'created_at'],
    collections
  );
  const maxColId = Math.max(...collections.map(c => c.id));
  await pgClient.query(`SELECT setval(pg_get_serial_sequence('collections', 'id'), $1)`, [maxColId]);

  // Cash denominations
  const denoms = sqlLite.prepare('SELECT * FROM cash_denominations ORDER BY id').all();
  console.log(`Cash denominations (${denoms.length})...`);
  await batchInsert('cash_denominations',
    ['id', 'collection_id', 'denom', 'count'],
    denoms
  );
  if (denoms.length) {
    const maxId = Math.max(...denoms.map(d => d.id));
    await pgClient.query(`SELECT setval(pg_get_serial_sequence('cash_denominations', 'id'), $1)`, [maxId]);
  }

  // Short items
  const shorts = sqlLite.prepare('SELECT * FROM short_items ORDER BY id').all();
  console.log(`Short items (${shorts.length})...`);
  await batchInsert('short_items',
    ['id', 'bill_id', 'salesman_id', 'product', 'qty', 'rate', 'amount', 'reason', 'short_date', 'client_id', 'created_at'],
    shorts
  );
  if (shorts.length) {
    const maxId = Math.max(...shorts.map(s => s.id));
    await pgClient.query(`SELECT setval(pg_get_serial_sequence('short_items', 'id'), $1)`, [maxId]);
  }

  // Cancellations
  const cancellations = sqlLite.prepare('SELECT * FROM cancellations ORDER BY id').all();
  console.log(`Cancellations (${cancellations.length})...`);
  await batchInsert('cancellations',
    ['id', 'bill_id', 'invoice_no', 'amount', 'reason', 'salesman_id', 'cancel_date', 'client_id', 'created_at'],
    cancellations
  );
  if (cancellations.length) {
    const maxId = Math.max(...cancellations.map(c => c.id));
    await pgClient.query(`SELECT setval(pg_get_serial_sequence('cancellations', 'id'), $1)`, [maxId]);
  }

  // Day sessions
  const daySessions = sqlLite.prepare('SELECT * FROM day_sessions ORDER BY id').all();
  console.log(`Day sessions (${daySessions.length})...`);
  await batchInsert('day_sessions',
    ['id', 'salesman_id', 'work_date', 'started_at', 'ended_at', 'opening_note', 'closing_note'],
    daySessions
  );
  if (daySessions.length) {
    const maxId = Math.max(...daySessions.map(ds => ds.id));
    await pgClient.query(`SELECT setval(pg_get_serial_sequence('day_sessions', 'id'), $1)`, [maxId]);
  }

  await pgClient.query('SET session_replication_role = DEFAULT;');

  // Verify
  console.log('\nVerification:');
  const tables = ['users', 'shops', 'products', 'bills', 'collections', 'cash_denominations', 'short_items', 'cancellations', 'day_sessions'];
  for (const t of tables) {
    const res = await pgClient.query(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t}: ${res.rows[0].n} rows`);
  }

  await pgClient.end();
  console.log('\n✅ Migration complete!');
}

migrate().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
