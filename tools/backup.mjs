/**
 * Automated database backup. Dumps every table (schema-aware: columns are
 * read from information_schema, so new tables/columns are picked up without
 * touching this file) into one zip of CSVs and stores it:
 *
 *   - Supabase Storage, backups/ prefix in the attachment bucket, when
 *     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (same client as
 *     server/storage.js) — survives host restarts, works on serverless;
 *   - otherwise server/backups/ on local disk (dev, VPS).
 *
 * The zip also carries manifest.json (row counts, table list, timestamps) and
 * the restore tool refuses files whose manifest doesn't match its contents.
 *
 * Unlike pg_dump this is plain SQL reads — it runs anywhere Node runs, needs
 * no client tools, and works through the transaction-mode pooler. The price
 * is that it captures data, not schema; restore expects the target schema to
 * already exist (npm run db:init), which also keeps restores version-safe.
 *
 *   npm run backup                       (local schedule via cron/Task Scheduler)
 *   BACKUP_KEEP=14 npm run backup        (prune older backups, default 14)
 *   BACKUP_DIR=/path npm run backup      (override local-disk destination)
 *
 * Password hashes ARE included (unlike the /api/admin/backup download):
 * this file never leaves your storage/account, and restore of a wiped book
 * needs working logins. Pruned automatically: keeps the newest BACKUP_KEEP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { pool, q } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'server', 'backups');
const KEEP = Math.max(Number(process.env.BACKUP_KEEP) || 14, 1);

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  // json/jsonb come back from pg as plain objects; stringify them so the CSV
  // carries real JSON (restore parses it back — see tools/restore.mjs).
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every user table in the public schema, FK-safe dump order not required for
 * CSV (restore re-inserts with session_replication_role off), but a stable
 * order keeps diffs between consecutive backups readable. */
async function listTables() {
  const rows = await q(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

async function dumpTable(table) {
  const cols = (await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )).map((r) => r.column_name);
  const rows = await q(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}"`);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return { csv: lines.join('\r\n') + '\r\n', count: rows.length, cols };
}

async function storageClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  const started = Date.now();
  const tables = await listTables();
  const zip = new JSZip();
  const manifest = { created_at: new Date().toISOString(), tables: {}, tool: 'tools/backup.mjs', version: 1 };

  for (const table of tables) {
    const { csv, count } = await dumpTable(table);
    zip.file(`${table}.csv`, csv);
    manifest.tables[table] = count;
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `field-ledger-backup-${stamp}.zip`;
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const supabase = await storageClient();
  let where;
  // --out <path>: also/only write a local copy (restore tests, air-gapped
  // hosts, keeping one copy on a different device).
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, body);
    console.log(`[backup] local copy: ${outPath}`);
    if (!supabase) {
      console.log(`[backup] ${name} — ${tables.length} tables, ${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows`);
      await pool.end();
      return;
    }
  }
  if (supabase) {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'field-ledger';
    const { error } = await supabase.storage.from(bucket).upload(`backups/${name}`, body, {
      contentType: 'application/zip', upsert: false,
    });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    // Prune: newest KEEP backups stay in backups/, older ones removed.
    const { data: objects } = await supabase.storage.from(bucket).list('backups', {
      limit: 1000, sortBy: { column: 'created_at', order: 'desc' },
    });
    const stale = (objects || []).filter((o) => o.name.endsWith('.zip')).slice(KEEP);
    if (stale.length) {
      await supabase.storage.from(bucket).remove(stale.map((o) => `backups/${o.name}`));
    }
    where = `Supabase Storage (${bucket}/backups/${name})`;
  } else {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, name), body);
    const all = fs.readdirSync(LOCAL_DIR).filter((f) => f.endsWith('.zip')).sort().reverse();
    for (const old of all.slice(KEEP)) fs.unlinkSync(path.join(LOCAL_DIR, old));
    where = path.join(LOCAL_DIR, name);
  }

  const total = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`[backup] ${name} — ${tables.length} tables, ${total} rows, ${(body.length / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[backup] stored: ${where}`);
  console.log(`[backup] retention: newest ${KEEP} kept${supabase ? ' in Storage backups/ prefix' : ` in ${LOCAL_DIR}`}`);
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[backup] failed:', err.message); process.exit(1); });
