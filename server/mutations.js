/**
 * Write operations — now async for PostgreSQL.
 */
import { billRow, round2, q1, q, qx, tx } from './db.js';
import { todayISO } from './dates.js';
import { saveDataUrl } from './attachments.js';
import { deleteFile } from './storage.js';
import { verifyPassword } from './auth.js';
import { snapshotBill, trashEntity } from './trash.js';
import { recordAudit } from './audit.js';

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
  // Online uploads arrive as an already-stored name; offline data URLs are
  // materialised now (Supabase Storage or disk). If the insert fails we remove
  // the file we just created so nothing is orphaned.
  let attachment = payload.attachment || null;
  let storedFile = null;
  if (!attachment && payload.attachment_data) {
    storedFile = await saveDataUrl(payload.attachment_data);
    attachment = storedFile;
  }

  let r;
  try {
    r = await qx(
      `INSERT INTO bills (invoice_no, shop_id, salesman_id, amount, bill_date, source, attachment, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`,
      [invoiceNo, shopId, ownerId, round2(amt), date, source, attachment, clientId],
    );
  } catch (err) {
    if (storedFile) await deleteFile(storedFile);
    // Unique constraint on invoice_no — a concurrent upload of the same
    // invoice won the race. Surface the friendly message instead of a 500.
    if (err?.code === '23505') {
      throw new HttpError(409, `Invoice ${invoiceNo} is already in the book — use a different invoice number.`);
    }
    throw err;
  }

  // No row back with a client_id means a concurrent replay of this offline op
  // won the race and committed between our check and our insert — report this
  // one as already recorded instead of failing with a duplicate-key 500.
  if (!r.rows[0] && clientId) {
    if (storedFile) await deleteFile(storedFile);
    const existing = await q1('SELECT id FROM bills WHERE client_id = $1', [clientId]);
    if (existing) return { bill: await billRow(existing.id), deduped: true };
  }

  return { bill: await billRow(r.rows[0].id) };
}

/* ------------------------------------------------------------- bill edit --- */

// Office corrections to a bill: invoice number, amount, date, salesman, and
// the shop card (name/area/owner/phone). Every changed field lands in the
// bill_edits audit trail with before→after values. Money is guarded so the
// ledger can never be corrupted by an edit: no edits to cancelled bills, an
// amount can never drop below what has already been collected, and invoice
// numbers stay unique (races surface as the friendly duplicate message).
const EDITABLE_SHOP = ['name', 'area', 'owner_name', 'phone'];
const FIELD_LABEL = {
  invoice_no: 'Invoice no.', amount: 'Amount', bill_date: 'Bill date',
  salesman_id: 'Salesman', name: 'Shop name', area: 'Area',
  owner_name: 'Owner', phone: 'Phone',
};

export async function editBill({ billId, payload = {}, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can edit bills.');
  const bill = await billRow(Number(billId));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  if (bill.cancelled_at) throw new HttpError(409, 'This bill is cancelled — un-cancel it before editing.');

  const updates = [];
  if (payload.bill && typeof payload.bill === 'object') {
    const b = payload.bill;
    if (b.invoice_no !== undefined) {
      const inv = String(b.invoice_no || '').trim();
      if (!inv) throw new HttpError(400, 'Invoice number cannot be empty.');
      if (inv !== bill.invoice_no) updates.push({ field: 'invoice_no', value: inv });
    }
    if (b.amount !== undefined) {
      const amt = round2(Number(b.amount));
      if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a bill amount greater than zero.');
      if (amt < bill.collected_amount) {
        throw new HttpError(422, `₹${bill.collected_amount.toLocaleString('en-IN')} is already collected against this bill — the new amount cannot be less.`);
      }
      if (amt !== bill.amount) updates.push({ field: 'amount', value: amt });
    }
    if (b.bill_date !== undefined) {
      const d = String(b.bill_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Enter the bill date as YYYY-MM-DD.');
      if (d !== bill.bill_date) updates.push({ field: 'bill_date', value: d });
    }
    if (b.salesman_id !== undefined && Number(b.salesman_id) !== bill.salesman_id) {
      const sid = Number(b.salesman_id);
      const s = await q1("SELECT id, name FROM users WHERE id = $1 AND role = 'salesman' AND active = 1", [sid]);
      if (!s) throw new HttpError(400, 'Pick a valid salesman for this route.');
      updates.push({ field: 'salesman_id', value: sid });
    }
  }

  const shopUpdates = [];
  let shopCur = null;
  if (payload.shop && typeof payload.shop === 'object') {
    const s = payload.shop;
    shopCur = await q1('SELECT * FROM shops WHERE id = $1', [bill.shop_id]);
    if (!shopCur) throw new HttpError(404, 'The bill\'s shop no longer exists.');
    for (const f of EDITABLE_SHOP) {
      if (s[f] === undefined) continue;
      const v = String(s[f] ?? '').trim();
      if (v === (shopCur[f] || '')) continue;
      if (f === 'name' && !v) throw new HttpError(400, 'Shop name cannot be empty.');
      shopUpdates.push({ field: f, value: v || null });
    }
    // Renaming into another shop's identity would silently merge two shops.
    if (shopUpdates.some((u) => u.field === 'name' || u.field === 'area')) {
      const name = shopUpdates.find((u) => u.field === 'name')?.value ?? shopCur.name;
      const area = shopUpdates.find((u) => u.field === 'area')?.value ?? shopCur.area;
      const clash = await q1(
        "SELECT id FROM shops WHERE name = $1 AND COALESCE(area, '') = COALESCE($2, '') AND id <> $3",
        [name, area ?? '', shopCur.id],
      );
      if (clash) throw new HttpError(409, `Another shop is already named ${name}${area ? ` in ${area}` : ''}.`);
    }
  }

  if (updates.length === 0 && shopUpdates.length === 0) {
    return { bill: await billRow(bill.id), changed: [] };
  }

  const edits = [];
  await tx(async (client) => {
    for (const u of updates) {
      const before = u.field === 'salesman_id' ? bill.salesman_name : bill[u.field];
      await client.query(
        `UPDATE bills SET ${u.field} = $1 WHERE id = $2`,
        [u.field === 'salesman_id' ? u.value : String(u.value), bill.id],
      );
      edits.push({ field: u.field, old_value: before == null ? null : String(before), new_value: String(u.value) });
    }
    for (const u of shopUpdates) {
      await client.query(`UPDATE shops SET ${u.field} = $1 WHERE id = $2`, [u.value, bill.shop_id]);
      edits.push({ field: u.field, old_value: shopCur ? String(shopCur[u.field] ?? '') : null, new_value: u.value == null ? null : String(u.value) });
    }
    for (const e of edits) {
      await client.query(
        'INSERT INTO bill_edits (bill_id, shop_id, edited_by, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
        [bill.id, bill.shop_id, user.id, e.field, e.old_value, e.new_value],
      );
    }
  }).catch((err) => {
    if (err?.code === '23505') {
      throw new HttpError(409, `Invoice ${String(updates.find((u) => u.field === 'invoice_no')?.value ?? bill.invoice_no)} is already in the book — use a different invoice number.`);
    }
    throw err;
  });

  return { bill: await billRow(bill.id), changed: edits.map((e) => ({ ...e, label: FIELD_LABEL[e.field] || e.field })) };
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

  // Materialise offline data-URL photos before the transaction so storage
  // writes never sit inside it; if the transaction rolls back we delete them.
  const attached = [];
  const storedByIndex = [];
  for (let i = 0; i < clean.length; i++) {
    const e = clean[i];
    if (e.attachment) { attached.push(e.attachment); continue; }
    if (e.attachment_data) {
      const name = await saveDataUrl(e.attachment_data);
      attached.push(name);
      if (name) storedByIndex.push(i);
    } else {
      attached.push(null);
    }
  }

  let inserted = 0;
  try {
    await tx(async (client) => {
      for (let i = 0; i < clean.length; i++) {
        const e = clean[i];
        // ON CONFLICT: a concurrent replay of the same offline op may have
        // committed between the check above and this insert — never fail with
        // a duplicate-key 500, skip the already-recorded entry instead.
        const r = await client.query(
          `INSERT INTO collections
            (bill_id, salesman_id, mode, amount, ref_no, bank, cheque_date, note, attachment, collection_date, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (client_id) DO NOTHING RETURNING id`,
          [
            bill.id, bill.salesman_id, e.mode, e.amount,
            e.ref_no ? String(e.ref_no).trim() : null,
            e.bank ? String(e.bank).trim() : null,
            e.cheque_date || null,
            e.note ? String(e.note).trim() : null,
            attached[i],
            date,
            cid ? `${cid}:${e.mode}` : null,
          ],
        );
        if (!r.rows[0]) continue;
        inserted += 1;
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
  } catch (err) {
    for (const i of storedByIndex) {
      if (attached[i]) await deleteFile(attached[i]);
    }
    throw err;
  }

  // Nothing inserted for a client-tagged replay: another request already
  // recorded this offline op, so report it as deduped (never an error).
  if (cid && inserted === 0) return { bill: await billRow(bill.id), collected: total, deduped: true };
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
  let inserted = false;
  await tx(async (client) => {
    const r = await client.query(
      `INSERT INTO cancellations (bill_id, invoice_no, amount, reason, salesman_id, cancel_date, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`,
      [bill.id, bill.invoice_no, bill.amount, why, bill.salesman_id, date, cid],
    );
    inserted = Boolean(r.rows[0]);
    if (inserted) {
      await client.query(`UPDATE bills SET cancelled_at = NOW() AT TIME ZONE 'utc' WHERE id = $1`, [bill.id]);
    }
  }, user);

  // A concurrent replay of the same offline op committed first — report it as
  // already recorded instead of failing with a duplicate-key error.
  if (cid && !inserted) return { bill: await billRow(bill.id), deduped: true };
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
      // ON CONFLICT: a concurrent replay may have committed the same line since
      // the check above — never fail with a duplicate-key error, skip it.
      const r = await client.query(
        `INSERT INTO short_items (bill_id, salesman_id, product, qty, rate, amount, reason, short_date, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [bill.id, bill.salesman_id, it.product, it.qty, it.rate, it.amount, it.reason, date, clientKey],
      );
      if (!r.rows[0]) { skipped += 1; continue; }
    }
  }, user);

  if (skipped && skipped === clean.length) return { bill: await billRow(bill.id), short_total: 0, deduped: true };
  return { bill: await billRow(bill.id), short_total: total };
}

/* ------------------------------------------------------------ delete --- */

/** Delete a single bill (admin only). Refuses if the bill has collections against it. */
export async function deleteBill({ billId, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can delete bills.');
  const bill = await billRow(Number(billId));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  if (bill.collected_amount > 0) {
    throw new HttpError(409, `₹${bill.collected_amount.toLocaleString('en-IN')} is already collected — cancel or refund before deleting.`);
  }
  if (bill.short_count > 0) {
    throw new HttpError(409, 'This bill has shortage records — remove them before deleting.');
  }
  let shopRemoved = false;
  await tx(async (client) => {
    // Delete associated audit trail, shop if orphaned, and the bill itself.
    await client.query('DELETE FROM bill_edits WHERE bill_id = $1', [bill.id]);
    await client.query('DELETE FROM bills WHERE id = $1', [bill.id]);
    // Remove the shop if it has no other bills.
    const other = await client.query('SELECT 1 FROM bills WHERE shop_id = $1 LIMIT 1', [bill.shop_id]);
    if (other.rows.length === 0) {
      await client.query('DELETE FROM shops WHERE id = $1', [bill.shop_id]);
      shopRemoved = true;
    }
  });
  await recordAudit({
    action: 'delete', entity: 'bill', entityId: bill.id,
    label: `${bill.invoice_no} · ${bill.shop_name}`,
    details: { amount: bill.amount, shop_removed: shopRemoved },
    actor: user,
  });
  return { deleted: true };
}

/** Bulk-delete multiple bills (admin only). Skips bills with collections; returns counts. */
export async function deleteBills({ ids, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can delete bills.');
  const idList = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  if (idList.length === 0) throw new HttpError(400, 'Send an array of bill ids to delete.');
  const deleted = [];
  const skipped = [];
  for (const id of idList) {
    try {
      await deleteBill({ billId: id, user });
      deleted.push(id);
    } catch (err) {
      skipped.push({ id, reason: err.message });
    }
  }
  return { deleted, skipped };
}

/* ------------------------------------------------------------ salesman delete --- */

/** Deactivate a salesman (soft-delete). Admin only. Refuses if they have any bills. */
export async function deleteSalesman({ salesmanId, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can manage salesmen.');
  const id = Number(salesmanId);
  if (!id) throw new HttpError(400, 'Invalid salesman id.');
  const s = await q1('SELECT id, code, name, role FROM users WHERE id = $1 AND role = $2', [id, 'salesman']);
  if (!s) throw new HttpError(404, 'Salesman not found.');
  const billCount = await q1('SELECT COUNT(*)::int AS n FROM bills WHERE salesman_id = $1', [id]);
  if (billCount.n > 0) {
    throw new HttpError(409, `${s.name} has ${billCount.n} bill${billCount.n > 1 ? 's' : ''} — delete or reassign them first.`);
  }
  await q1('DELETE FROM users WHERE id = $1', [id]);
  await recordAudit({
    action: 'delete', entity: 'salesman', entityId: id,
    label: `${s.name} (${s.code})`,
    actor: user,
  });
  return { deleted: true, salesman: s };
}

/** Bulk-deactivate salesmen (soft-delete). Admin only. Skips those with bills. */
export async function deleteSalesmen({ ids, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can manage salesmen.');
  const idList = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  if (idList.length === 0) throw new HttpError(400, 'Send an array of salesman ids to delete.');
  const deleted = [];
  const skipped = [];
  for (const id of idList) {
    try {
      await deleteSalesman({ salesmanId: id, user });
      deleted.push(id);
    } catch (err) {
      skipped.push({ id, reason: err.message });
    }
  }
  return { deleted, skipped };
}

/* ------------------------------------------------------------ shop delete --- */

/** Delete a shop (admin only). Refuses if the shop has any bills. */
export async function deleteShop({ shopId, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can manage shops.');
  const id = Number(shopId);
  if (!id) throw new HttpError(400, 'Invalid shop id.');
  const s = await q1('SELECT id, name, area FROM shops WHERE id = $1', [id]);
  if (!s) throw new HttpError(404, 'Shop not found.');
  const billCount = await q1('SELECT COUNT(*)::int AS n FROM bills WHERE shop_id = $1', [id]);
  if (billCount.n > 0) {
    throw new HttpError(409, `${s.name} has ${billCount.n} bill${billCount.n > 1 ? 's' : ''} — delete or reassign them first.`);
  }
  await q1('DELETE FROM shops WHERE id = $1', [id]);
  await recordAudit({
    action: 'delete', entity: 'shop', entityId: id,
    label: s.area ? `${s.name} · ${s.area}` : s.name,
    actor: user,
  });
  return { deleted: true, shop: s };
}

/** Bulk-delete shops (admin only). Skips those with bills; returns counts. */
export async function deleteShops({ ids, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can manage shops.');
  const idList = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  if (idList.length === 0) throw new HttpError(400, 'Send an array of shop ids to delete.');
  const deleted = [];
  const skipped = [];
  for (const id of idList) {
    try {
      await deleteShop({ shopId: id, user });
      deleted.push(id);
    } catch (err) {
      skipped.push({ id, reason: err.message });
    }
  }
  return { deleted, skipped };
}

/* ---------------------------------------------------------- hard delete ---
 *
 * Purge = removal from the live ledger that ignores every safety check the
 * regular delete makes (collections, shortages, cancellations and all
 * history go with it). Nothing is truly destroyed though: each purge first
 * writes a full JSONB snapshot into the trash bin, restorable for 30 days.
 * Guarded twice: admin-only, and the admin must re-enter their own password
 * on every call — a stolen session alone cannot wipe records.
 */

/** Verifies the caller re-entered their own password before a purge. */
async function assertPassword(user, password) {
  if (!password) throw new HttpError(400, 'Re-enter your password to confirm this delete.');
  const row = await q1('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!row || !verifyPassword(String(password), row.password_hash)) {
    throw new HttpError(401, 'That password is not correct. Nothing was deleted.');
  }
}

/** HARD delete one bill — collections, shortages, cancellation and edit
 * history all move into the trash with it. The shop row is deliberately
 * kept (purges are surgical, not tidy-ups) and its snapshot is restorable
 * for 30 days from the Trash page. */
export async function purgeBill({ billId, user, password }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can hard-delete bills.');
  await assertPassword(user, password);
  const bill = await billRow(Number(billId));
  if (!bill) throw new HttpError(404, 'Bill not found.');
  return tx(async (client) => {
    const payload = await snapshotBill(client, bill.id);
    const t = await trashEntity({
      entity: 'bill', entityId: bill.id, user,
      snapshot: payload,
      label: `${bill.invoice_no} · ${bill.shop_name}`,
      client,
    });
    await recordAudit({
      action: 'purge', entity: 'bill', entityId: bill.id,
      label: `${bill.invoice_no} · ${bill.shop_name}`,
      details: { trash_id: t.id, restorable_until: t.expires_at, amount: bill.amount },
      actor: user,
    });
    return { purged: true, id: bill.id, invoice_no: bill.invoice_no, trash_id: t.id, restorable_until: t.expires_at };
  }, user);
}

/** HARD delete one shop and every bill ever raised against it. */
export async function purgeShop({ shopId, user, password }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can hard-delete shops.');
  await assertPassword(user, password);
  const id = Number(shopId);
  if (!id) throw new HttpError(400, 'Invalid shop id.');
  const shop = await q1('SELECT * FROM shops WHERE id = $1', [id]);
  if (!shop) throw new HttpError(404, 'Shop not found.');
  return tx(async (client) => {
    const billIds = (await q('SELECT id FROM bills WHERE shop_id = $1', [id], client)).map((r) => r.id);
    const bills = [];
    for (const bid of billIds) {
      bills.push(await snapshotBill(client, bid));
    }
    // bill_edits carry a shop FK without a bill — snapshot those too.
    const shopEdits = await q('SELECT * FROM bill_edits WHERE shop_id = $1', [id], client);
    await client.query('DELETE FROM bill_edits WHERE shop_id = $1', [id]);
    const salesman = shop.salesman_id
      ? await q1('SELECT * FROM users WHERE id = $1', [shop.salesman_id], client)
      : null;
    await client.query('DELETE FROM shops WHERE id = $1', [id]);
    const payload = {
      shop,
      shop_name: shop.name,
      salesman,
      shop_edits: shopEdits,
      bills,
    };
    const t = await trashEntity({
      entity: 'shop', entityId: id, user,
      snapshot: payload,
      label: `${shop.name}${shop.area ? ` · ${shop.area}` : ''} · ${bills.length} bill${bills.length === 1 ? '' : 's'}`,
      client,
    });
    await recordAudit({
      action: 'purge', entity: 'shop', entityId: id,
      label: `${shop.name}${shop.area ? ` · ${shop.area}` : ''}`,
      details: { trash_id: t.id, restorable_until: t.expires_at, bills_removed: bills.length },
      actor: user,
    });
    return { purged: true, id, shop: shop.name, bills_removed: bills.length, trash_id: t.id, restorable_until: t.expires_at };
  }, user);
}

/** HARD delete one salesman and their entire book — bills, collections,
 * shortages, cancellations, edit history and sessions all go to the bin. */
export async function purgeSalesman({ salesmanId, user, password }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can hard-delete salesmen.');
  if (Number(salesmanId) === user.id) throw new HttpError(400, 'You cannot hard-delete your own account.');
  await assertPassword(user, password);
  const id = Number(salesmanId);
  if (!id) throw new HttpError(400, 'Invalid salesman id.');
  const s = await q1('SELECT * FROM users WHERE id = $1 AND role = $2', [id, 'salesman']);
  if (!s) throw new HttpError(404, 'Salesman not found.');
  return tx(async (client) => {
    const billIds = (await q('SELECT id FROM bills WHERE salesman_id = $1', [id], client)).map((r) => r.id);
    const bills = [];
    for (const bid of billIds) {
      bills.push(await snapshotBill(client, bid));
    }
    const shops = await q('SELECT * FROM shops WHERE salesman_id = $1', [id], client);
    const daySessions = await q('SELECT * FROM day_sessions WHERE salesman_id = $1', [id], client);
    const edits = await q('SELECT * FROM bill_edits WHERE salesman_id = $1', [id], client);
    await client.query('DELETE FROM bills WHERE salesman_id = $1', [id]);
    await client.query('DELETE FROM bill_edits WHERE salesman_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]); // sessions cascade
    const payload = {
      user: s,
      user_name: s.name,
      user_code: s.code,
      shops,
      bills,
      day_sessions: daySessions,
      salesman_edits: edits,
    };
    const t = await trashEntity({
      entity: 'salesman', entityId: id, user,
      snapshot: payload,
      label: `${s.name} (${s.code}) · ${bills.length} bill${bills.length === 1 ? '' : 's'}`,
      client,
    });
    await recordAudit({
      action: 'purge', entity: 'salesman', entityId: id,
      label: `${s.name} (${s.code})`,
      details: { trash_id: t.id, restorable_until: t.expires_at, bills_removed: bills.length },
      actor: user,
    });
    return { purged: true, id, salesman: s.name, bills_removed: bills.length, trash_id: t.id, restorable_until: t.expires_at };
  }, user);
}

export const SYNC_TYPES = {
  bill: createBill,
  collection: recordCollection,
  cancellation: cancelBill,
  'short-items': addShortItems,
};
