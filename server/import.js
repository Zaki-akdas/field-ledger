import ExcelJS from 'exceljs';
import { q1, round2, billRow } from './db.js';
import { createBill } from './mutations.js';

const FIELDS = [
  ['invoice_no', /invoice|inv\s*\.?\s*no|bill\s*no|doc(ument)?\s*no|voucher/i],
  ['amount', /amount|value|net|total/i],
  ['bill_date', /date|dt/i],
  ['area', /area|route|beat|location|sector/i],
  ['shop_name', /customer|shop|party|outlet|client|name/i],
];

function columnMap(headerRow) {
  const map = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const label = String(cell.value ?? '').trim();
    if (!label) return;
    for (const [field, re] of FIELDS) {
      if (map[field]) continue;
      if (re.test(label)) { map[field] = col; return; }
    }
  });
  return map;
}

function cellDate(v) {
  if (v instanceof Date) {
    // ExcelJS hands date cells back as local-midnight Dates; toISOString()
    // would shift them a day back in any non-UTC timezone, so read the
    // calendar components as written in the cell.
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

export async function parseBillWorkbook(filePath, { salesmanId, billDate, file } = {}) {
  const wb = new ExcelJS.Workbook();
  const lower = filePath.toLowerCase();
  const unreadable = () => {
    const err = new Error('That file couldn\'t be read as a spreadsheet. Re-save it as .xlsx or .csv and upload again.');
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
    if (map || rowNumber > 12) return;
    const filled = row.cellCount ? row.actualCellCount : 0;
    if (filled < 2) return;
    const candidate = columnMap(row);
    if (candidate.invoice_no && candidate.amount) {
      map = candidate;
      headerRowNumber = rowNumber;
    }
  });

  if (!map) {
    const err = new Error('Could not find an "Invoice No" and an "Amount" column in this file. Put those two headers in the top rows and upload again.');
    err.status = 400;
    throw err;
  }

  const seen = new Set();
  const skipped = [];
  const bills = [];
  let created = 0;

  const user = await q1('SELECT id, code, name, role FROM users WHERE id = $1', [salesmanId]);
  if (!user) {
    const err = new Error('Salesman not found for this upload.');
    err.status = 400;
    throw err;
  }

  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const get = (field) => {
      const col = map[field];
      if (!col) return null;
      const cell = row.getCell(col);
      const v = cell.value;
      if (v && typeof v === 'object' && 'text' in v) return String(v.text).trim();
      if (v && typeof v === 'object' && 'result' in v) return v.result;
      return v == null ? null : v;
    };

    const invoiceNo = String(get('invoice_no') ?? '').trim();
    const rawAmount = Number(String(get('amount') ?? '').toString().replace(/[^0-9.-]/g, ''));
    const shopName = String(get('shop_name') ?? '').trim();
    const area = get('area') ? String(get('area')).trim() : '';
    const date = cellDate(get('bill_date')) || billDate;

    if (!invoiceNo && !rawAmount && !shopName) return;

    if (!invoiceNo) { skipped.push({ row: rowNumber, reason: 'No invoice number in this row.' }); return; }
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) { skipped.push({ row: rowNumber, invoice_no: invoiceNo, reason: 'Amount is missing or zero.' }); return; }
    if (seen.has(invoiceNo)) { skipped.push({ row: rowNumber, invoice_no: invoiceNo, reason: 'This invoice number appears twice in the same file.' }); return; }
    seen.add(invoiceNo);

    // Check for duplicate in DB — this is sync but acceptable for upload
    // We'll let createBill handle the dupe check
    try {
      // Note: createBill is async, but we're inside a sync eachRow callback.
      // We collect the bills to create and process them after.
      bills.push({ invoiceNo, shopName, area, amount: rawAmount, date });
    } catch (err) {
      skipped.push({ row: rowNumber, invoice_no: invoiceNo, reason: err.message });
    }
  });

  // Process bills async — use a separate array to avoid mutating bills during iteration
  const createdBills = [];
  for (const b of bills) {
    try {
      const out = await createBill({
        payload: {
          invoice_no: b.invoiceNo,
          shop_name: b.shopName || `Unnamed customer ${b.invoiceNo}`,
          area: b.area,
          amount: b.amount,
          bill_date: b.date,
          salesman_id: user.id,
        },
        user,
      });
      if (!out.deduped) created += 1;
      const row = await billRow(out.bill.id);
      if (row) createdBills.push(row);
    } catch (err) {
      skipped.push({ row: 0, invoice_no: b.invoiceNo, reason: err.message });
    }
  }

  return {
    created,
    skipped,
    bills: createdBills,
    total_amount: round2(createdBills.reduce((a, b) => a + b.amount, 0)),
    file: file || null,
  };
}
