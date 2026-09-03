/**
 * Bootstrap the database schema for a fresh PostgreSQL instance (CI, new
 * environments). Safe to run against an existing database — every statement
 * in server/schema.sql is IF NOT EXISTS.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/db DATABASE_SSL=false node tools/init-db.mjs
 *   npm run db:init          (reads .env when present)
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', 'server', 'schema.sql');

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('[init-db] Set SUPABASE_DB_URL (or DATABASE_URL) to the PostgreSQL connection string.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

await client.connect();
console.log('[init-db] Connected — applying ' + path.relative(path.join(__dirname, '..'), schemaPath));
await client.query(fs.readFileSync(schemaPath, 'utf8'));

const tables = ['users', 'shops', 'products', 'bills', 'collections', 'cash_denominations', 'short_items', 'cancellations', 'day_sessions'];
for (const t of tables) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  console.log(`  ${t}: ${rows[0].n} rows`);
}

await client.end();
console.log('[init-db] Schema ready. Seed with: node server/seed.js --force');
