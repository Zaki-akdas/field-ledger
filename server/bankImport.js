import ExcelJS from 'exceljs';
import { q, q1, round2 } from './db.js';

/* ------------------------------------------------------------ parsing --- */

const FIELD_PATTERNS = [
  ['date', /date|value\s*dt|txn\s*dt/i],
  ['narration', /narration|description|remarks?|particulars|details/i],
  ['ref', /\butr\b|reference|ref\s*no|ref\s*id/i],
  ['credit', /credit|deposit/i],
  ['debit', /debit|withdrawal/i],
  ['amount', /amount/i],
  ['balance', /balance/i],
];

function columnMap(headerRow) {
  const map = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const label = String(cell.value ?? '').trim();
    if (!label) return;
    for (const [field, re] of FIELD_PATTERNS) {
      if (map[field]) continue;
      if (re.test(label)) { map[field] = col; return; }
    }
  });
  return map;
}

function cellValue(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && 'text' in v) return String(v.text).trim();
  if (v && typeof v === 'object' && 'result' in v) return v.result;
  return v == null ? null : v;
}

function toNumber(v) {
  const n = Number(String(v ?? '').toString().replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cellDate(v) {
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[0];
    const d = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (d) return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  }
  return null;
}

/**
 * UTR-shaped tokens in a narration: banks abbreviate differently, so accept
 * the common shapes — UTR/NEFT/RTGS/IMPS followed by a 6-16 digit run, or a
 * bare 12-digit run (the standard UPI/NEFT UTR length).
 */
function extractUtr(narration) {
  const s = String(narration || '');
  const explicit = s.match(/(?:UTR|NEFT|RTGS|IMPS|UPI)[/\s:=~-]*([A-Z0-9]{6,16})/i);
  if (explicit) return explicit[1].toUpperCase();
  const bare = s.match(/\b(\d{12})\b/);
  if (bare) return bare[1];
  return null;
}

/**
 * Read a statement workbook (CSV or XLSX) into normalised credit rows.
 * Accepts both single-amount layouts (amount + withdrawal/deposit flag) and
 * two-column layouts (debit + credit). Only credits are relevant — money in.
 */
export async function parseStatement(filePath) {
  const wb = new ExcelJS.Workbook();
  const lower = filePath.toLowerCase();
  const unreadable = () => {
    const err = new Error('That file couldn\'t be read as a spreadsheet. Re-save it as .csv or .xlsx and upload again.');
    err.status = 400;
    return err;
  };
  try {
    if (lower.endsWith('.csv')) await wb.csv.readFile(filePath);
    else await wb.xlsx.readFile(filePath);
  } catch {
    throw unreadable();
  }

  const ws = wb.worksheets[0];
  if (!ws) {
    const err = new Error('That file has no worksheet in it.');
    err.status = 400;
    throw err;
  }

  let map = null;
  let headerRowNumber = 0;
  ws.eachRow((row, rowNumber) => {
    if (map || rowNumber > 15) return;
    if ((row.actualCellCount || 0) < 2) return;
    const candidate = columnMap(row);
    const hasAmount = candidate.amount || candidate.credit || candidate.debit;
    if (hasAmount && (candidate.narration || candidate.ref)) {
      map = candidate;
      headerRowNumber = rowNumber;
    }
  });

  if (!map) {
    const err = new Error('Could not find the statement columns. The file needs a Narration/Description column and an Amount (or Credit/Debit) column in the top rows.');
    err.status = 400;
    throw err;
  }

  const rows = [];
  let skipped = 0;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const get = (field) => {
      const col = map[field];
      if (!col) return null;
      return cellValue(row.getCell(col));
    };
    const date = cellDate(get('date'));
    const narration = String(get('narration') ?? '').trim();
    const explicitRef = String(get('ref') ?? '').trim();
    const credit = toNumber(get('credit'));
    const debit = toNumber(get('debit'));
    const amount = credit != null ? credit : (debit != null ? -debit : toNumber(get('amount')));

    if (!narration && amount == null) return;
    // Only money-in rows matter for reconciliation; debits are expenses.
    if (amount == null || amount <= 0) { skipped += 1; return; }

    rows.push({
      date,
      narration,
      ref: (explicitRef || extractUtr(narration) || '').toUpperCase() || null,
      amount: round2(amount),
    });
  });

  if (rows.length === 0) {
    const err = new Error('No incoming (credit) rows found in this statement. Re-check the column mapping — this tool matches money received, not payments out.');
    err.status = 400;
    throw err;
  }
  return { rows, skipped };
}

/* ------------------------------------------------------------ matching --- */

/**
 * Match statement rows against recorded online/cheque collections by UTR.
 * Three tiers, first match wins, each collection claimed at most once:
 *   exact    — the statement ref equals the recorded ref_no
 *   contains — the recorded ref appears inside the narration (banks truncate
 *              or prefix refs) or the statement ref appears in the collection
 *   amount   — same amount, same day, UTR unknown on either side → surfaced
 *              as `likely` but never auto-confirmed; the office decides.
 */
export async function matchStatement(rows) {
  const collections = await q(`
    SELECT c.id, c.amount::float8 AS amount, c.ref_no, c.collection_date, c.mode,
           b.invoice_no, s.name AS shop_name, u.name AS salesman_name
    FROM collections c
    JOIN bills b ON b.id = c.bill_id
    JOIN shops s ON s.id = b.shop_id
    JOIN users u ON u.id = c.salesman_id
    WHERE c.mode IN ('online', 'cheque') AND c.ref_no IS NOT NULL AND c.ref_no <> ''
  `);
  const taken = new Set();
  const out = [];
  for (const r of rows) {
    let match = { tier: null, collection: null };
    if (r.ref) {
      let hit = collections.find((c) => !taken.has(c.id) && c.ref_no.toUpperCase() === r.ref);
      if (hit) match = { tier: 'exact', collection: hit };
      if (!match.tier) {
        hit = collections.find((c) => !taken.has(c.id)
          && (r.narration.toUpperCase().includes(c.ref_no.toUpperCase())
              || c.ref_no.toUpperCase().includes(r.ref)));
        if (hit) match = { tier: 'contains', collection: hit };
      }
    }
    if (!match.tier && r.date) {
      const hit = collections.find((c) => !taken.has(c.id)
        && c.collection_date === r.date && Math.abs(c.amount - r.amount) < 0.01);
      if (hit) match = { tier: 'likely', collection: hit };
    }
    if (match.collection) taken.add(match.collection.id);
    out.push({
      ...r,
      matched: Boolean(match.tier),
      tier: match.tier,
      collection: match.collection ? {
        id: match.collection.id,
        amount: match.collection.amount,
        ref_no: match.collection.ref_no,
        collection_date: match.collection.collection_date,
        mode: match.collection.mode,
        invoice_no: match.collection.invoice_no,
        shop_name: match.collection.shop_name,
        salesman_name: match.collection.salesman_name,
      } : null,
      amount_ok: match.collection ? Math.abs(match.collection.amount - r.amount) < 0.01 : null,
    });
  }
  return out;
}

/** Persist confirmed matches: one row per collection, idempotent per statement. */
export async function recordMatches(matches, { fileName, user }) {
  const confirmed = matches.filter((m) => m.confirmed && m.collection);
  let recorded = 0;
  const already = [];
  for (const m of confirmed) {
    const dup = await q1(
      'SELECT id FROM bank_matches WHERE collection_id = $1 AND statement_file = $2',
      [m.collection.id, fileName],
    );
    if (dup) { already.push(m.collection.id); continue; }
    await q(
      `INSERT INTO bank_matches (collection_id, statement_file, stmt_amount, stmt_date, stmt_ref, matched_tier, matched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.collection.id, fileName, m.amount, m.date, m.ref, m.tier, user.id],
    );
    recorded += 1;
  }
  return { recorded, already, total_confirmed: confirmed.length };
}

/** True when a collection already has a bank match from any statement. */
export async function matchedCollectionIds() {
  const rows = await q('SELECT DISTINCT collection_id FROM bank_matches');
  return new Set(rows.map((r) => r.collection_id));
}
