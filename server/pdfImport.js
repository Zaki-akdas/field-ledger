/**
 * Server-side parser for CO-SHIP dispatch-sheet PDFs — the "Collection Report
 * (Bill Wise)" print-out a distributor hands over each day.
 *
 * Text extraction (unpdf / pdf.js) returns each printed line in order, so a
 * record reads like:
 *
 *   12 IN-16437264-0138 01/09/26 gourav kirana store FO_CSFL_671304720 Wasim
 *   Khan
 *   Anand Nagar
 *   TIT
 *   ₹ 3,227 ₹ 3,227 ₹ 4,283
 *
 * Rows are anchored on their invoice number + date; the party name runs from
 * there up to the FO_… party id, and the amount triple (Invoice Amt, Net Amt,
 * Total Outs.) follows the party id. Net Amt is what the salesman is expected
 * to collect, so it becomes the bill's amount.
 *
 * Dates are NOT taken from the sheet: the printed Bill Date is the dispatch
 * date, while the app books bills for the business day the uploader chose
 * (the route passes bill_date, defaulting to today). That keeps this identical
 * to how a CSV without a date column is handled.
 */
import { readFile } from 'node:fs/promises';
import { extractText } from 'unpdf';
import { commitBillRows } from './import.js';

const BAD_PDF = () => {
  const err = new Error("That PDF couldn't be read as a CO-SHIP dispatch sheet. Upload the print-out of a Collection Report (Bill Wise) and try again.");
  err.status = 400;
  return err;
};

const NO_BILLS = () => {
  const err = new Error("No bills found in that PDF. It should list one IN-… invoice per row — upload a CO-SHIP Collection Report (Bill Wise) print-out instead.");
  err.status = 400;
  return err;
};

// One sheet record: "12 IN-16437264-0138 01/09/26 …" — serial number, an
// invoice like IN-16437264-0138, then a dd/mm/yy date.
const ROW_START = /(?:^|\n)\s*(\d{1,3})[ \t]+(IN(?:-|_)[A-Z0-9]+(?:[-_][A-Z0-9]+)*)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
const PARTY_ID = /\bFO_[A-Z0-9_]+\b/;
const TOTAL_LINE = /^Total\b/m;

const amountOf = (token) => Number(token.replace(/,/g, ''));

export async function parseCoshipPdf(filePath, { salesmanId, billDate, file } = {}) {
  let raw;
  try {
    raw = await readFile(filePath);
  } catch {
    throw BAD_PDF();
  }

  let pages;
  try {
    const out = await extractText(new Uint8Array(raw));
    pages = Array.isArray(out.text) ? out.text : [out.text];
  } catch {
    throw BAD_PDF();
  }

  const bills = [];
  const skipped = [];
  const seen = new Set();

  for (const pageText of pages) {
    const starts = [];
    ROW_START.lastIndex = 0;
    for (let m = ROW_START.exec(pageText); m; m = ROW_START.exec(pageText)) starts.push(m);

    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const sno = s[1];
      const invoiceNo = s[2];
      const end = starts[i + 1] ? starts[i + 1].index : pageText.length;
      // Everything after this record's date up to the next record (or the end
      // of the page) is this bill's row. A trailing "Total ₹ …" line and any
      // page decorations after it never belong to a row, so cut them off.
      let body = pageText.slice(s.index + s[0].length, end).split(TOTAL_LINE)[0];

      // Party name: from the start of the row up to the FO_… party id.
      const pid = body.match(PARTY_ID);
      const shopName = (pid ? body.slice(0, pid.index) : body).replace(/\s+/g, ' ').trim();

      // Amounts: after the party id, printed as "₹ 1,330 ₹ 1,330 ₹ 1,330".
      // If an extractor drops the ₹ glyph (some fonts map it oddly), fall back
      // to bare numbers in order — the party id is already sliced off so no
      // stray digits can leak in from it.
      const tail = pid ? body.slice(pid.index + pid[0].length) : body;
      const amounts = [];
      for (const am of tail.matchAll(/₹\s*(\d[\d,]*(?:\.\d+)?)/g)) amounts.push(amountOf(am[1]));
      if (!amounts.length) {
        for (const am of tail.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?![\d.,])/g)) amounts.push(amountOf(am[1]));
      }
      // Column order is Invoice Amt, Net Amt, Total Outs. — Net Amt is index 1.
      const amount = amounts.length >= 2 ? amounts[1] : amounts[0] ?? null;

      if (!shopName) { skipped.push({ row: sno, invoice_no: invoiceNo, reason: 'No customer name for this row.' }); continue; }
      if (!Number.isFinite(amount) || amount <= 0) { skipped.push({ row: sno, invoice_no: invoiceNo, reason: 'No net amount for this bill in the PDF.' }); continue; }
      if (seen.has(invoiceNo)) { skipped.push({ row: sno, invoice_no: invoiceNo, reason: 'This invoice number appears twice in the same file.' }); continue; }
      seen.add(invoiceNo);
      bills.push({ invoiceNo, shopName, area: '', amount, date: billDate });
    }
  }

  if (!bills.length) throw NO_BILLS();

  return commitBillRows(bills, { salesmanId, file, skipped });
}
