/**
 * Migration: money amount columns REAL → NUMERIC(12,2).
 *
 * Sums over float4 columns drifted by whole rupees once the book grew past a
 * couple of hundred rows (Postgres accumulates SUM(real) in float4), which
 * broke the reconciliation identity. Storing money as numeric keeps every
 * aggregation exact — this is the durable fix (query-side ::numeric casts
 * were only a band-aid).
 *
 * Idempotent: safe to run any number of times, against a fresh schema or a
 * populated database. Fresh databases get the right types straight from
 * server/schema.sql; this only rewrites columns that are still real.
 *
 *   npm run db:migrate        (reads .env when present)
 */
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('[migrate-amounts-numeric] Set SUPABASE_DB_URL (or DATABASE_URL) to the PostgreSQL connection string.');
  process.exit(1);
}

/** Money columns that must never drift in float4. */
const MONEY_COLUMNS = [
  ['bills', 'amount'],
  ['collections', 'amount'],
  ['short_items', 'amount'],
  ['cancellations', 'amount'],
];

/** Rewrite any still-real money column to NUMERIC(12,2). Returns rows changed. */
export async function migrateAmountColumns(client) {
  const changed = [];
  for (const [table, column] of MONEY_COLUMNS) {
    const { rows } = await client.query(
      `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    const col = rows[0];
    if (!col) {
      console.log(`  ${table}.${column}: column not found — skipping`);
      continue;
    }
    if (col.data_type === 'real' || col.data_type === 'double precision') {
      await client.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE NUMERIC(12,2) USING ${column}::numeric(12,2)`,
      );
      changed.push(`${table}.${column}`);
      console.log(`  ${table}.${column}: REAL → NUMERIC(12,2) ✓`);
    } else if (col.data_type === 'numeric' && col.numeric_precision === 12 && col.numeric_scale === 2) {
      console.log(`  ${table}.${column}: already NUMERIC(12,2) — nothing to do`);
    } else {
      console.log(`  ${table}.${column}: ${col.data_type}(${col.numeric_precision},${col.numeric_scale}) — leaving untouched`);
    }
  }
  return changed;
}

// Run directly: `node tools/migrate-amounts-numeric.mjs`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[migrate-amounts-numeric] Connected — rewriting money columns:');
  const changed = await migrateAmountColumns(client);
  await client.end();
  console.log(changed.length ? `\nDone — ${changed.length} column(s) converted to NUMERIC(12,2).` : '\nDone — nothing to convert.');
}
