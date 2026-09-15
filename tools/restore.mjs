/**
 * Restore a backup produced by tools/backup.mjs. Validates the zip against
 * its manifest, truncates the live tables, and re-inserts every row inside
 * one transaction — either the whole book comes back or nothing changes.
 *
 * The target schema must already exist (npm run db:init); the backup carries
 * data, not schema, which keeps restores version-safe across app upgrades.
 *
 *   npm run restore -- server/backups/field-ledger-backup-….zip
 *   npm run restore -- path/to.zip --list          (inspect without touching)
 *
 * Safety rails:
 *   - refuses to run unless --yes is passed (or typed at the prompt)
 *   - refuses a zip whose manifest row counts don't match its contents
 *   - refuses when live tables hold data unless --replace-live is passed
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import JSZip from 'jszip';
import { pool, q, q1, tx } from '../server/db.js';

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const yes = args.includes('--yes');
const replaceLive = args.includes('--replace-live');
const zipPath = args.find((a) => !a.startsWith('--'));

if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('Usage: npm run restore -- <backup.zip> [--list] [--yes] [--replace-live]');
  process.exit(1);
}

/** Minimal RFC-4180 CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function confirm() {
  if (yes) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question('Type RESTORE to overwrite the live database: ', res));
  rl.close();
  if (answer.trim() !== 'RESTORE') {
    console.error('[restore] aborted — nothing was changed.');
    process.exit(1);
  }
}

const main = async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('manifest.json missing — not a field-ledger backup.');
  const manifest = JSON.parse(await manifestFile.async('string'));

  // Validate contents against the manifest before touching the database.
  const tables = Object.keys(manifest.tables);
  for (const t of tables) {
    if (!zip.file(`${t}.csv`)) throw new Error(`manifest lists ${t} but ${t}.csv is missing from the zip`);
  }
  let zipRows = 0;
  const parsed = {};
  for (const t of tables) {
    const rows = parseCsv(await zip.file(`${t}.csv`).async('string'));
    const [header, ...data] = rows;
    if (data.length !== manifest.tables[t]) {
      throw new Error(`${t}: zip has ${data.length} rows but manifest says ${manifest.tables[t]} — corrupted backup`);
    }
    parsed[t] = { header, data };
    zipRows += data.length;
  }
  console.log(`[restore] ${path.basename(zipPath)} — made ${manifest.created_at}, ${tables.length} tables, ${zipRows} rows`);

  if (listOnly) {
    for (const t of tables) console.log(`   ${t.padEnd(22)} ${manifest.tables[t]}`);
    await pool.end();
    return;
  }

  await confirm();

  // Live-data guard: restoring into a book with rows is destructive unless
  // explicitly acknowledged.
  const live = await q1(`SELECT
    (SELECT COUNT(*) FROM bills) + (SELECT COUNT(*) FROM collections) + (SELECT COUNT(*) FROM shops) AS n`);
  if (live.n > 0 && !replaceLive) {
    console.error(`[restore] live database holds ${live.n} rows — pass --replace-live to overwrite (a backup is taken first is NOT automatic; run npm run backup now if unsure).`);
    await pool.end();
    process.exit(1);
  }

  await tx(async (client) => {
    // FK-safe: disable triggers for the load, re-enable after. Superuser-only
    // on managed hosts, so fall back to ordered deletes when it fails.
    let suppress = false;
    try {
      await q(`SET LOCAL session_replication_role = replica`, [], client);
      suppress = true;
    } catch { /* ordered order below */ }

    const order = ['cash_denominations', 'bank_matches', 'bill_edits', 'short_items', 'cancellations',
      'collections', 'bills', 'products', 'day_sessions', 'sessions', 'shops', 'trash',
      'audit_log', 'error_reports', 'users'];
    for (const t of order) {
      if (!parsed[t]) continue;
      await q(`TRUNCATE TABLE "${t}" CASCADE`, [], client);
    }

    for (const t of tables) {
      const { header, data } = parsed[t];
      const cols = header.map((c) => c.replace(/^"|"$/g, ''));
      const colSql = cols.map((c) => `"${c}"`).join(',');
      // json/jsonb columns arrive as CSV text; hand Postgres real JSON.
      const jsonCols = new Set(
        (await q(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('json','jsonb')`,
          [t],
          client,
        )).map((r) => r.column_name),
      );
      for (let i = 0; i < data.length; i++) {
        const values = data[i].map((v, j) => {
          if (v === '') return null;
          if (jsonCols.has(cols[j])) {
            // Older backups serialized objects as the literal text
            // "[object Object]" — unrecoverable; store as a JSON string so
            // the row at least loads, and mark it clearly.
            if (/^\[object Object\]$/.test(v.trim())) return { _corrupt: 'pre-fix backup' };
            try { return JSON.parse(v); } catch { return v; }
          }
          return v;
        });
        await q(
          `INSERT INTO "${t}" (${colSql}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(',')})`,
          values,
          client,
        );
      }
      if (data.length) console.log(`   ${t.padEnd(22)} ${data.length} rows`);
    }
    void suppress;
  });

  console.log('[restore] done — every table re-inserted in one transaction.');
  await pool.end();
};

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[restore] failed:', err.message); process.exit(1); });
