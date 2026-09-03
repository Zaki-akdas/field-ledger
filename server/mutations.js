/**
 * Write operations — now async for PostgreSQL.
 */
import { billRow, round2, q1, qx, tx } from './db.js';
import { todayISO } from './dates.js';
import { saveDataUrl } from './attachments.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const money = (n) => round2(Number(n) || 0);
export const MODE_LABEL = { cash: 'Cash', online: 'Online', cheque: 'Cheque', credit_note: 'Credit note' };

function assertOwnBill(user, bill) {
  if (user.role === 'admin') return;
  if (!bill || bill.salesman_id !== user.id) {
    throw new HttpError(403, 'This bill is not on your route.');
  }
}

/* ------------------------------------------------------------------ bill --- */

export async function createBill({ payload = {}, user }) {
  const invoiceNo = String(payload.invoice_no || '').trim();
  const shopName = String(payload.shop_name || '').trim();
  const area = String(payload.area || '').trim();
  const amt = Number(payload.amount);

  if (!invoiceNo) throw new HttpError(400, 'Enter the invoice number.');
  if (!shopName) throw new HttpError(400, 'Enter the customer or shop name.');
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a bill amount greater than zero.');

  const dupe = await q1('SELECT b.*, s.name AS shop_name FROM bills b JOIN shops s ON s.id = b.shop_id WHERE b.invoice_no = $1', [invoiceNo]);
  if (dupe) {
    throw new HttpError(409, `Invoice ${invoiceNo} is already in the book — ${dupe.shop_name}, ₹${Number(dupe.amount).toLocaleString('en-IN')}. Use a different invoice number.`);
  }

  const ownerId = user.role === 'admin' && payload.salesman_id ? Number(payload.salesman_id) : user.id;
  const date = payload.bill_date || todayISO();
  const clientId = payload.client_id ? String(payload.client_id) : null;

  if (clientId) {
    const existing = await q1('SELECT id FROM bills WHERE client_id = $1', [clientId]);
    if (existing) return { bill: await billRow(existing.id), deduped: true };
  }

  // Find or create shop
  let shop = await q1('SELECT * FROM shops WHERE name = $1 AND COALESCE(area, $2) = $2', [shopName, area || '']);
  let shopId;
  if (shop) {
    shopId = shop.id;
  } else {
    const r = await qx('INSERT INTO shops (name, area, salesman_id) VALUES ($1, $2, $3) RETURNING id', [shopName, area || null, ownerId]);
    shopId = r.rows[0].id;
  }

  const source = (payload.attachment || payload.attachment_data) ? 'photo' : 'manual';
  const attachment = payload.attachment || saveDataUrl(payload.attachment_data) || null;

  const r = await qx(
    `INSERT INTO bills (invoice_no, shop_id, salesman_id, amount, bill_date, source, attachment, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [invoiceNo, shopId, ownerId, round2(amt), date, source, attachment, clientId],
  );

  return { bill: await billRow(r.rows[0].id) };
}

/* ------------------------------------------------------------ collection --- */

export async function recordCollection({ payload = {}, user }) {
  const bill = await billRow(Number(payload.bill_id));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  assertOwnBill(user, bill);

  const cid = payload.client_id ? String(payload.client_id) : null;
  if (cid) {
    const existing = await q1("SELECT bill_id FROM collections WHERE client_id LIKE $1 LIMIT 1", [`${cid}:%`]);
    if (existing) return { bill: await billRow(existing.bill_id), deduped: true };
  }

  if (bill.cancelled_at) {
    throw new HttpError(409, `Invoice ${bill.invoice_no} is cancelled. Un-cancel it before collecting.`);
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (entries.length === 0) {
    throw new HttpError(400, 'Add at least one collection mode — cash, online, cheque, or credit note.');
  }

  const clean = [];
  for (const e of entries) {
    const mode = String(e.mode || '');
    const amount = money(e.amount);
    if (!['cash', 'online', 'cheque', 'credit_note'].includes(mode)) {
      throw new HttpError(400, `Unknown collection mode "${mode}".`);
    }
    if (amount <= 0) {
      throw new HttpError(400, `${MODE_LABEL[mode]} amount is zero. Enter the amount or remove the row.`);
    }
    if (mode === 'cash') {
      const counted = (e.denominations || []).reduce((a, d) => a + Number(d.denom) * Number(d.count), 0);
      if (Math.abs(counted - amount) > 0.5) {
        throw new HttpError(422, `Cash counted (₹${counted.toLocaleString('en-IN')}) doesn't match the cash amount entered (₹${amount.toLocaleString('en-IN')}). Re-count the bundle below.`);
      }
    }
    if (mode === 'online' && !String(e.ref_no || '').trim()) {
      throw new HttpError(422, 'Add the UTR or reference number for the online payment.');
    }
    if (mode === 'cheque' && (!String(e.ref_no || '').trim() || !String(e.bank || '').trim())) {
      throw new HttpError(422, 'Add the cheque number and the bank name.');
    }
    if (mode === 'credit_note' && !String(e.ref_no || '').trim()) {
      throw new HttpError(422, 'Add the credit note number.');
    }
    clean.push({ ...e, mode, amount });
  }

  const total = round2(clean.reduce((a, e) => a + e.amount, 0));
  if (payload.declared_total != null && Math.abs(Number(payload.declared_total) - total) > 1) {
    throw new HttpError(422, `Amount entered (₹${Number(payload.declared_total).toLocaleString('en-IN')}) doesn't match the sum of ${clean.map((e) => MODE_LABEL[e.mode].toLowerCase()).join(' + ')} (₹${total.toLocaleString('en-IN')}). Check the entries below.`);
  }

  const outstanding = round2(bill.expected_amount - bill.collected_amount);
  if (total > outstanding + 1) {
    throw new HttpError(422, `Collected (₹${total.toLocaleString('en-IN')}) is more than the ₹${outstanding.toLocaleString('en-IN')} outstanding on invoice ${bill.invoice_no}. Split the extra onto another bill.`);
  }

  const date = payload.collection_date || todayISO();

  await tx(async (client) => {
    for (const e of clean) {
      const r = await client.query(
        `INSERT INTO collections
          (bill_id, salesman_id, mode, amount, ref_no, bank, cheque_date, note, attachment, collection_date, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          bill.id, bill.salesman_id, e.mode, e.amount,
          e.ref_no ? String(e.ref_no).trim() : null,
          e.bank ? String(e.bank).trim() : null,
          e.cheque_date || null,
          e.note ? String(e.note).trim() : null,
          e.attachment || saveDataUrl(e.attachment_data) || null,
          date,
          cid ? `${cid}:${e.mode}` : null,
        ],
      );
      if (e.mode === 'cash') {
        const colId = r.rows[0].id;
        for (const d of e.denominations || []) {
          if (Number(d.count) > 0) {
            await client.query(
              'INSERT INTO cash_denominations (collection_id, denom, count) VALUES ($1, $2, $3)',
              [colId, Number(d.denom), Number(d.count)],
            );
          }
        }
      }
    }
  }, user);

  return { bill: await billRow(bill.id), collected: total };
}

/* ---------------------------------------------------------- cancellation --- */

export async function cancelBill({ payload = {}, user }) {
  const bill = await billRow(Number(payload.bill_id));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  assertOwnBill(user, bill);

  const cid = payload.client_id ? String(payload.client_id) : null;
  if (cid) {
    const existing = await q1('SELECT bill_id FROM cancellations WHERE client_id = $1', [cid]);
    if (existing) return { bill: await billRow(existing.bill_id), deduped: true };
  }

  if (bill.cancelled_at) throw new HttpError(409, `Invoice ${bill.invoice_no} is already cancelled.`);
  if (bill.collected_amount > 0) {
    throw new HttpError(422, `₹${bill.collected_amount.toLocaleString('en-IN')} is already collected against invoice ${bill.invoice_no}. Reverse that collection first, then mark it cancelled.`);
  }
  const why = String(payload.reason || '').trim();
  if (!why) throw new HttpError(422, 'Say why the bill is being cancelled.');

  const date = todayISO();
  await tx(async (client) => {
    await client.query(
      `INSERT INTO cancellations (bill_id, invoice_no, amount, reason, salesman_id, cancel_date, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [bill.id, bill.invoice_no, bill.amount, why, bill.salesman_id, date, cid],
    );
    await client.query(`UPDATE bills SET cancelled_at = NOW() AT TIME ZONE 'utc' WHERE id = $1`, [bill.id]);
  }, user);

  return { bill: await billRow(bill.id) };
}

export async function uncancelBill({ billId, user }) {
  const bill = await billRow(Number(billId));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  assertOwnBill(user, bill);
  await tx(async (client) => {
    await client.query('DELETE FROM cancellations WHERE bill_id = $1', [bill.id]);
    await client.query('UPDATE bills SET cancelled_at = NULL WHERE id = $1', [bill.id]);
  }, user);
  return { bill: await billRow(bill.id) };
}

/* --------------------------------------------------------------- short --- */

export async function addShortItems({ payload = {}, user }) {
  const bill = await billRow(Number(payload.bill_id));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  assertOwnBill(user, bill);

  const cid = payload.client_id ? String(payload.client_id) : null;
  if (cid) {
    const existing = await q1("SELECT id FROM short_items WHERE client_id LIKE $1 LIMIT 1", [`${cid}:%`]);
    if (existing) return { bill: await billRow(bill.id), short_total: 0, deduped: true };
  }

  if (bill.cancelled_at) throw new HttpError(409, 'Bill is cancelled — a cancelled bill has no shortage.');
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new HttpError(400, 'Add at least one short item.');

  const clean = [];
  for (const it of items) {
    const product = String(it.product || '').trim();
    const qty = Number(it.qty);
    const rate = money(it.rate);
    const reason = String(it.reason || '').trim();
    if (!product) throw new HttpError(422, 'Name the product that came up short.');
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(422, `Enter a quantity for ${product}.`);
    if (rate < 0) throw new HttpError(422, `Enter a rate for ${product}.`);
    if (!reason) throw new HttpError(422, `Say why ${product} was short.`);
    clean.push({ product, qty, rate, amount: round2(qty * rate), reason });
  }

  const total = round2(clean.reduce((a, i) => a + i.amount, 0));
  const remainingAfter = round2(bill.amount - bill.short_amount - total);
  if (remainingAfter < -0.5) {
    throw new HttpError(422, `Shortage of ₹${total.toLocaleString('en-IN')} is more than the ₹${round2(bill.amount - bill.short_amount).toLocaleString('en-IN')} left on invoice ${bill.invoice_no}. Check the quantity or rate.`);
  }

  const date = todayISO();
  let skipped = 0;
  await tx(async (client) => {
    for (let idx = 0; idx < clean.length; idx++) {
      const it = clean[idx];
      const clientKey = cid ? `${cid}:${idx}` : null;
      if (clientKey) {
        const exists = await client.query('SELECT id FROM short_items WHERE client_id = $1 LIMIT 1', [clientKey]);
        if (exists.rows.length) { skipped += 1; continue; }
      }
      await client.query(
        `INSERT INTO short_items (bill_id, salesman_id, product, qty, rate, amount, reason, short_date, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [bill.id, bill.salesman_id, it.product, it.qty, it.rate, it.amount, it.reason, date, clientKey],
      );
    }
  }, user);

  if (skipped && skipped === clean.length) return { bill: await billRow(bill.id), short_total: 0, deduped: true };
  return { bill: await billRow(bill.id), short_total: total };
}

export const SYNC_TYPES = {
  bill: createBill,
  collection: recordCollection,
  cancellation: cancelBill,
  'short-items': addShortItems,
};
