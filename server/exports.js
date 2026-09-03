import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { q, reconcile, cashRollup, round2 } from './db.js';
import { todayISO, isoDaysAgo } from './dates.js';

const MONEY_FMT = '₹#,##,##0.00';

export function range(req) {
  return {
    from: req.query.from || isoDaysAgo(6),
    to: req.query.to || todayISO(),
    salesmanId: req.query.salesmanId ? Number(req.query.salesmanId) : undefined,
  };
}

async function billsFor({ from, to, salesmanId }) {
  const params = salesmanId ? [from, to, salesmanId] : [from, to];
  const where = salesmanId ? 'AND b.salesman_id = $3' : '';
  return q(`
    SELECT b.invoice_no, b.bill_date, b.amount, s.name AS shop_name, s.area AS shop_area,
           u.name AS salesman_name, u.code AS salesman_code,
           COALESCE((SELECT SUM(amount) FROM collections c WHERE c.bill_id = b.id),0) AS collected_amount,
           COALESCE((SELECT SUM(amount) FROM short_items si WHERE si.bill_id = b.id),0) AS short_amount,
           b.cancelled_at
    FROM bills b JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = b.salesman_id
    WHERE b.bill_date BETWEEN $1 AND $2 ${where}
    ORDER BY b.bill_date, b.invoice_no`, params);
}

async function people({ salesmanId }) {
  const params = salesmanId ? [salesmanId] : [];
  const where = salesmanId ? 'AND id = $1' : '';
  return q(`SELECT id, code, name FROM users WHERE role = 'salesman' AND active = 1 ${where} ORDER BY code`, params);
}

/* ------------------------------------------------------------- workbook --- */

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF182233' } };
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function autosize(sheet, widths) {
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}

export async function buildWorkbook({ report, from, to, salesmanId }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Field Ledger';
  wb.created = new Date();

  const moneyCells = (sheet, cols) => {
    sheet.eachRow((row) => cols.forEach((c) => { row.getCell(c).numFmt = MONEY_FMT; }));
  };

  if (report === 'reconciliation' || report === 'salesmen') {
    const r = await reconcile({ from, to, salesmanId });
    const sum = wb.addWorksheet('Reconciliation');
    sum.addRow(['Field Ledger — Reconciliation']);
    sum.getCell('A1').font = { size: 14, bold: true };
    sum.addRow([`Period: ${from} to ${to}`]);
    sum.addRow([]);
    sum.addRow(['Billed', r.billed]);
    sum.addRow(['Less: Cancellations', -r.cancelled_amount]);
    sum.addRow(['Less: Short items', -r.short_amount]);
    sum.addRow(['Expected', r.expected]);
    sum.addRow(['Cash', r.by_mode.cash]);
    sum.addRow(['Online', r.by_mode.online]);
    sum.addRow(['Cheque', r.by_mode.cheque]);
    sum.addRow(['Credit notes', r.by_mode.credit_note]);
    sum.addRow(['Collected', r.actual]);
    sum.addRow(['Variance (Expected − Collected)', r.variance]);
    sum.getRow(4).font = { bold: true };
    sum.getRow(12).font = { bold: true };
    sum.getRow(13).font = { bold: true };
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].forEach((n) => { sum.getRow(n).getCell(2).numFmt = MONEY_FMT; });
    autosize(sum, [34, 20]);

    const peopleRows = await people({ salesmanId });
    const ps = wb.addWorksheet('Salesman-wise');
    ps.addRow(['Code', 'Salesman', 'Bills', 'Billed', 'Cancelled', 'Short', 'Expected', 'Cash', 'Online', 'Cheque', 'Credit note', 'Collected', 'Variance']);
    for (const p of peopleRows) {
      const pr = await reconcile({ from, to, salesmanId: p.id });
      ps.addRow([p.code, p.name, pr.bill_count, pr.billed, pr.cancelled_amount, pr.short_amount, pr.expected,
        pr.by_mode.cash, pr.by_mode.online, pr.by_mode.cheque, pr.by_mode.credit_note, pr.actual, pr.variance]);
    }
    styleHeader(ps);
    moneyCells(ps, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    autosize(ps, [10, 22, 8, 15, 13, 12, 15, 15, 14, 14, 14, 15, 14]);
  }

  if (report === 'reconciliation' || report === 'bills') {
    const sheet = wb.addWorksheet('Bills');
    sheet.addRow(['Invoice No', 'Date', 'Shop', 'Area', 'Salesman', 'Bill Amount', 'Short', 'Cancelled', 'Expected', 'Collected', 'Balance', 'Status']);
    for (const b of await billsFor({ from, to, salesmanId })) {
      const cancelled = b.cancelled_at ? b.amount : 0;
      const expected = b.cancelled_at ? 0 : round2(b.amount - b.short_amount);
      const collected = round2(b.collected_amount);
      const status = b.cancelled_at ? 'Cancelled' : collected <= 0 ? 'Pending' : collected >= expected - 0.5 ? 'Delivered' : 'Part collected';
      sheet.addRow([b.invoice_no, b.bill_date, b.shop_name, b.shop_area, `${b.salesman_code} · ${b.salesman_name}`,
        b.amount, b.short_amount, cancelled, expected, collected, round2(expected - collected), status]);
    }
    styleHeader(sheet);
    moneyCells(sheet, [6, 7, 8, 9, 10, 11]);
    autosize(sheet, [18, 12, 30, 16, 22, 14, 10, 12, 14, 14, 14, 15]);
  }

  if (report === 'reconciliation' || report === 'cancellations') {
    const sheet = wb.addWorksheet('Cancellations');
    sheet.addRow(['Date', 'Invoice No', 'Shop', 'Salesman', 'Amount', 'Reason']);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND c.salesman_id = $3' : '';
    const rows = await q(`
      SELECT c.cancel_date, c.invoice_no, c.amount, c.reason, s.name AS shop_name, u.name AS salesman_name, u.code AS salesman_code
      FROM cancellations c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = c.salesman_id
      WHERE c.cancel_date BETWEEN $1 AND $2 ${where}
      ORDER BY c.cancel_date, c.invoice_no`, params);
    for (const c of rows) sheet.addRow([c.cancel_date, c.invoice_no, c.shop_name, `${c.salesman_code} · ${c.salesman_name}`, c.amount, c.reason]);
    styleHeader(sheet);
    moneyCells(sheet, [5]);
    autosize(sheet, [12, 18, 30, 22, 14, 34]);
  }

  if (report === 'reconciliation' || report === 'shortages') {
    const sheet = wb.addWorksheet('Shortages');
    sheet.addRow(['Date', 'Invoice No', 'Shop', 'Salesman', 'Product', 'Qty', 'Rate', 'Amount', 'Reason']);
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND si.salesman_id = $3' : '';
    const rows = await q(`
      SELECT si.short_date, si.product, si.qty, si.rate, si.amount, si.reason, b.invoice_no, s.name AS shop_name,
             u.name AS salesman_name, u.code AS salesman_code
      FROM short_items si JOIN bills b ON b.id = si.bill_id JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = si.salesman_id
      WHERE si.short_date BETWEEN $1 AND $2 ${where}
      ORDER BY si.short_date, b.invoice_no`, params);
    for (const r of rows) {
      sheet.addRow([r.short_date, r.invoice_no, r.shop_name, `${r.salesman_code} · ${r.salesman_name}`, r.product, r.qty, r.rate, r.amount, r.reason]);
    }
    styleHeader(sheet);
    moneyCells(sheet, [7, 8]);
    autosize(sheet, [12, 18, 28, 22, 28, 8, 10, 12, 32]);
  }

  if (report === 'reconciliation' || report === 'cash-rollup') {
    const { rows, total } = await cashRollup({ from, to, salesmanId });
    const sheet = wb.addWorksheet('Cash Denominations');
    sheet.addRow(['Denomination', 'Count', 'Amount']);
    for (const r of rows) sheet.addRow([r.denom, r.count, r.amount]);
    sheet.addRow(['Total', rows.reduce((a, r) => a + r.count, 0), total]);
    sheet.getRow(sheet.rowCount).font = { bold: true };
    styleHeader(sheet);
    moneyCells(sheet, [3]);
    autosize(sheet, [16, 12, 18]);
    sheet.addRow([]);
    sheet.addRow([`Cash collected between ${from} and ${to}`]);
    sheet.addRow(['Bundles for bank deposit']);
  }

  /* Collection report — per-day invoice-wise register in the CO-SHIP layout:
   * S.No, invoice no, party and amount, one line per invoice, with a subtotal
   * under each day and a grand total. Cancelled bills are excluded. */
  if (report === 'collection') {
    const sheet = wb.addWorksheet('Collection Report');
    sheet.addRow(['Date', 'S.No', 'Invoice No', 'Party', 'Amount']);
    const rows = (await billsFor({ from, to, salesmanId })).filter((b) => !b.cancelled_at);
    let sno = 0;
    let grand = 0;
    let dayDate = null;
    let dayTotal = 0;
    let dayN = 0;
    const endDay = () => {
      if (dayDate === null) return;
      sheet.addRow(['', '', 'Day total', `${dayN} ${dayN === 1 ? 'bill' : 'bills'}`, dayTotal]);
      const r = sheet.getRow(sheet.rowCount);
      r.font = { bold: true };
      r.getCell(5).numFmt = MONEY_FMT;
      dayDate = null;
    };
    for (const b of rows) {
      if (b.bill_date !== dayDate) { endDay(); dayDate = b.bill_date; dayTotal = 0; dayN = 0; }
      sno += 1;
      dayTotal += Number(b.amount || 0);
      dayN += 1;
      grand += Number(b.amount || 0);
      sheet.addRow([b.bill_date, sno, b.invoice_no, b.shop_name, b.amount]);
    }
    endDay();
    sheet.addRow(['', '', 'Grand total', `${sno} ${sno === 1 ? 'bill' : 'bills'}`, grand]);
    const gt = sheet.getRow(sheet.rowCount);
    gt.font = { bold: true, size: 12 };
    gt.getCell(5).numFmt = MONEY_FMT;
    styleHeader(sheet);
    moneyCells(sheet, [5]);
    autosize(sheet, [13, 8, 22, 36, 16]);
    sheet.addRow([]);
    sheet.addRow([`Period: ${from} to ${to} · cancelled bills excluded`]);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, filename: `field-ledger-${report}-${from}_to_${to}.xlsx` };
}

/* ------------------------------------------------------------------ pdf --- */

const rs = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

function pdfTable(doc, headers, rows, colWidths) {
  const startX = doc.x;
  let y = doc.y;
  const drawRow = (cells, bold = false) => {
    let x = startX;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    cells.forEach((cell, i) => {
      doc.text(String(cell), x, y, { width: colWidths[i] - 6, align: i > 1 && /^-?[\d,.]*$/.test(String(cell)) ? 'right' : 'left' });
      x += colWidths[i];
    });
    y += 14;
    doc.moveTo(startX, y - 3).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 3)
      .strokeColor('#DADFE3').lineWidth(0.5).stroke();
  };
  drawRow(headers, true);
  for (const row of rows) {
    if (y > doc.page.height - 90) { doc.addPage(); y = doc.y; drawRow(headers, true); }
    drawRow(row);
  }
  doc.y = y + 6;
}

export async function buildPdf({ report, from, to, salesmanId }) {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  doc.rect(0, 0, doc.page.width, 46).fill('#182233');
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14).text('Field Ledger', 36, 16);
  doc.font('Helvetica').fontSize(9).fillColor('#DADFE3')
    .text(`${report.replace('-', ' ')} report · ${from} to ${to}`, 36, 30);
  doc.fillColor('#182233');
  doc.moveDown(2);
  doc.y = 66;

  if (report === 'reconciliation' || report === 'salesmen') {
    const r = await reconcile({ from, to, salesmanId });
    doc.font('Helvetica-Bold').fontSize(11).text('Reconciliation');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9.5);
    const lines = [
      ['Billed', r.billed],
      ['Less: cancellations', -r.cancelled_amount],
      ['Less: short items', -r.short_amount],
      ['Expected', r.expected],
      ['Cash', r.by_mode.cash],
      ['Online', r.by_mode.online],
      ['Cheque', r.by_mode.cheque],
      ['Credit notes', r.by_mode.credit_note],
      ['Collected', r.actual],
      ['Variance', r.variance],
    ];
    for (const [label, value] of lines) {
      const bold = label === 'Expected' || label === 'Collected' || label === 'Variance';
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      doc.text(label, 36, doc.y, { width: 260, continued: true })
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(rs(value), { width: 180, align: 'right' });
    }
    doc.moveDown(1);

    if (report === 'reconciliation') {
      doc.addPage();
    }
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#182233').text('Salesman-wise');
    doc.moveDown(0.4);
    const rows = (await people({ salesmanId })).map((p) => {
      return reconcile({ from, to, salesmanId: p.id }).then((pr) => [p.code, p.name, pr.bill_count, rs(pr.expected), rs(pr.actual), rs(pr.variance)]);
    });
    const resolved = await Promise.all(rows);
    pdfTable(doc, ['Code', 'Salesman', 'Bills', 'Expected', 'Collected', 'Variance'], resolved, [70, 130, 45, 90, 90, 90]);
  }

  if (report === 'bills') {
    const rows = (await billsFor({ from, to, salesmanId })).map((b) => {
      const expected = b.cancelled_at ? 0 : round2(b.amount - b.short_amount);
      const collected = round2(b.collected_amount);
      return [b.invoice_no, b.bill_date, b.shop_name.slice(0, 26), rs(b.amount), rs(collected), rs(expected - collected)];
    });
    pdfTable(doc, ['Invoice', 'Date', 'Shop', 'Amount', 'Collected', 'Balance'], rows, [95, 60, 140, 70, 70, 70]);
  }

  if (report === 'cancellations') {
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND c.salesman_id = $3' : '';
    const rows = await q(`
      SELECT c.cancel_date, c.invoice_no, c.amount, c.reason, s.name AS shop_name, u.code AS salesman_code
      FROM cancellations c JOIN bills b ON b.id = c.bill_id JOIN shops s ON s.id = b.shop_id JOIN users u ON u.id = c.salesman_id
      WHERE c.cancel_date BETWEEN $1 AND $2 ${where}
      ORDER BY c.cancel_date, c.invoice_no`, params);
    pdfTable(doc, ['Date', 'Invoice', 'Shop', 'Salesman', 'Amount', 'Reason'],
      rows.map((c) => [c.cancel_date, c.invoice_no, c.shop_name.slice(0, 22), c.salesman_code, rs(c.amount), c.reason.slice(0, 40)]),
      [58, 88, 110, 55, 65, 130]);
  }

  if (report === 'shortages') {
    const params = salesmanId ? [from, to, salesmanId] : [from, to];
    const where = salesmanId ? 'AND si.salesman_id = $3' : '';
    const rows = await q(`
      SELECT si.short_date, si.product, si.qty, si.amount, si.reason, b.invoice_no, u.code AS salesman_code
      FROM short_items si JOIN bills b ON b.id = si.bill_id JOIN users u ON u.id = si.salesman_id
      WHERE si.short_date BETWEEN $1 AND $2 ${where}
      ORDER BY si.short_date, b.invoice_no`, params);
    pdfTable(doc, ['Date', 'Invoice', 'Product', 'Qty', 'Amount', 'Reason'],
      rows.map((r) => [r.short_date, r.invoice_no, r.product.slice(0, 26), r.qty, rs(r.amount), r.reason.slice(0, 38)]),
      [58, 88, 120, 35, 65, 140]);
  }

  if (report === 'cash-rollup') {
    const { rows, total } = await cashRollup({ from, to, salesmanId });
    pdfTable(doc, ['Denomination', 'Count', 'Amount'],
      rows.map((r) => [`Rs. ${r.denom}`, r.count, rs(r.amount)]).concat([['Total', '', rs(total)]]),
      [140, 100, 140]);
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(9).fillColor('#182233')
      .text(`Cash collected between ${from} and ${to}. Use this sheet to prepare bank deposit bundles.`);
  }

  /* Collection report — invoice-wise per-day register (CO-SHIP layout). */
  if (report === 'collection') {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#182233').text('Collection Report');
    doc.font('Helvetica').fontSize(8.5).fillColor('#5A6B7B')
      .text('Invoice-wise register · cancelled bills excluded · amounts in rupees');
    doc.moveDown(0.5);
    const totalLine = (label, n, amount) => {
      const y0 = doc.y;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#182233');
      doc.text(`${label} (${n} ${n === 1 ? 'bill' : 'bills'})`, 36, y0, { width: 300 })
        .text(rs(amount), { width: 180, align: 'right' });
      doc.moveDown(0.5);
    };
    const rows = (await billsFor({ from, to, salesmanId })).filter((b) => !b.cancelled_at);
    let sno = 0;
    let grand = 0;
    let dayDate = null;
    const dayRows = [];
    const flushDay = async () => {
      if (dayDate === null) return;
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#182233')
        .text(`${dayDate} · ${dayRows.length} ${dayRows.length === 1 ? 'bill' : 'bills'}`);
      doc.moveDown(0.3);
      pdfTable(doc, ['S.No', 'Invoice', 'Party', 'Amount'], dayRows, [42, 120, 205, 90]);
      totalLine('Day total', dayRows.length, dayRows.reduce((a, r) => a + Number(r[3] ? r[3].replace(/[^\d.]/g, '') : 0), 0));
      dayRows.length = 0;
    };
    for (const b of rows) {
      if (b.bill_date !== dayDate) {
        await flushDay();
        dayDate = b.bill_date;
        doc.moveDown(0.2);
      }
      sno += 1;
      grand += Number(b.amount || 0);
      dayRows.push([sno, b.invoice_no, b.shop_name.slice(0, 30), rs(b.amount)]);
    }
    await flushDay();
    doc.moveDown(0.8);
    totalLine('Grand total', sno, grand);
  }

  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#5A6B7B')
      .text(`Field Ledger · generated ${todayISO()}`, 36, doc.page.height - 40, { align: 'left' });
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), filename: `field-ledger-${report}-${from}_to_${to}.pdf` };
}
