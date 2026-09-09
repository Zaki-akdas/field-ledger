/**
 * Trash bin — hard deletes land here as full JSONB snapshots and stay
 * restorable for TRASH_DAYS (30). A real wipe only happens when an entry
 * expires or the admin purges it from the bin explicitly.
 *
 * Payload shape per entity:
 *   bill     → { bill, shop, salesman, collections[], cash_denominations[],
 *               short_items[], cancellations[], bill_edits[], bank_matches[] }
 *   shop     → { shop, salesman, bills: [ {bill, …children}, … ] }
 *   salesman → { user, shops[], bills: [ {bill, …children}, … ],
 *               day_sessions[] }
 *
 * Restore order matters: parent rows first (users → shops → bills), children
 * after (collections → denominations → shorts → cancellations → edits →
 * bank matches). Restoring a bill whose shop/salesman is still alive just
 * skips those parent inserts (id-based ON CONFLICT DO NOTHING).
 */
import { q, q1, tx } from './db.js';
import { recordAudit } from './audit.js';

/** Same shape as mutations.HttpError — defined here to avoid a circular import. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const TRASH_DAYS = 30;

/* ---------------------------------------------------------------- helpers --- */

const trashExpiry = () => {
  const d = new Date(Date.now() + TRASH_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

/** INSERT … ON CONFLICT (id) DO NOTHING, built from the row's own keys. */
async function insertRow(client, table, row) {
  if (!row || row.id == null) return;
  const keys = Object.keys(row);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const values = keys.map((k) => row[k]);
  await client.query(
    `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')})
     VALUES (${placeholders.join(',')})
     ON CONFLICT (id) DO NOTHING`,
    values,
  );
}

/** Copy every child row of a bill from its live table into the payload. */
async function snapshotBillChildren(client, billId) {
  const [collections, short_items, cancellations, bill_edits, bank_matches] = await Promise.all([
    q('SELECT * FROM collections WHERE bill_id = $1', [billId], client),
    q('SELECT * FROM short_items WHERE bill_id = $1', [billId], client),
    q('SELECT * FROM cancellations WHERE bill_id = $1', [billId], client),
    q('SELECT * FROM bill_edits WHERE bill_id = $1', [billId], client),
    q('SELECT * FROM bank_matches WHERE collection_id IN (SELECT id FROM collections WHERE bill_id = $1)', [billId], client),
  ]);
  // Cash denominations hang off collections, so gather them per collection.
  const cash_denominations = [];
  for (const c of collections) {
    cash_denominations.push(...await q('SELECT * FROM cash_denominations WHERE collection_id = $1', [c.id], client));
  }
  return { collections, cash_denominations, short_items, cancellations, bill_edits, bank_matches };
}

/* --------------------------------------------------------------- snapshots --- */

/** Snapshot one bill (with all children) and delete the live row. The shop
 * row itself survives unless `dropShop` — purges are surgical by default. */
export async function snapshotBill(client, billId, { dropShop = false } = {}) {
  const bill = await q1('SELECT * FROM bills WHERE id = $1', [billId], client);
  if (!bill) return null;
  const children = await snapshotBillChildren(client, bill.id);
  const shop = await q1('SELECT * FROM shops WHERE id = $1', [bill.shop_id], client);
  const salesman = await q1('SELECT * FROM users WHERE id = $1', [bill.salesman_id], client);

  await client.query('DELETE FROM bills WHERE id = $1', [bill.id]);
  if (dropShop) {
    await client.query('DELETE FROM bill_edits WHERE shop_id = $1', [bill.shop_id]);
    await client.query('DELETE FROM shops WHERE id = $1', [bill.shop_id]);
  }
  return {
    bill,
    ...children,
    ...(dropShop ? { shop } : {}),
    salesman: dropShop ? salesman : null,
  };
}

/* ----------------------------------------------------------------- restore --- */

/** Rebuild a snapshot payload's rows in the live tables, parents first. */
export async function restoreFromTrash(payload) {
  await tx(async (client) => {
    const p = payload || {};

    // 0. Salesman referenced by a shop/bill restore (already alive = no-op).
    if (p.salesman) await insertRow(client, 'users', p.salesman);

    // 1. Salesman (a purged salesman restore).
    if (p.user) await insertRow(client, 'users', p.user);

    // 2. Shops — direct shop restores carry one; bill restores may carry one
    //    when the purge took the shop with it.
    const shops = p.shop ? [p.shop] : (p.shops || []);
    for (const s of shops) await insertRow(client, 'shops', s);

    // 3. Bills and their children.
    const bills = p.bill ? [{ bill: p.bill, ...p }] : (p.bills || []);
    for (const b of bills) {
      const bill = b.bill || b;
      await insertRow(client, 'bills', bill);
      for (const c of b.collections || []) {
        await insertRow(client, 'collections', c);
        for (const d of b.cash_denominations || []) {
          if (d.collection_id === c.id) await insertRow(client, 'cash_denominations', d);
        }
      }
      for (const s of b.short_items || []) await insertRow(client, 'short_items', s);
      for (const c of b.cancellations || []) await insertRow(client, 'cancellations', c);
      for (const e of b.bill_edits || []) await insertRow(client, 'bill_edits', e);
      for (const m of b.bank_matches || []) await insertRow(client, 'bank_matches', m);
    }

    // 4. Edit rows that referenced the shop or salesman directly (no bill).
    for (const e of p.shop_edits || []) await insertRow(client, 'bill_edits', e);
    for (const e of p.salesman_edits || []) await insertRow(client, 'bill_edits', e);

    // 5. Day sessions (salesman restore).
    for (const ds of p.day_sessions || []) await insertRow(client, 'day_sessions', ds);
  });
}

/* --------------------------------------------------------------- mutations --- */

/** Move one entity into the trash (called by the purge mutations). Pass
 * `client` to stay inside the caller's transaction so the snapshot and the
 * delete commit or roll back as one. */
export async function trashEntity({ entity, entityId, user, snapshot, label, client = null }) {
  if (!snapshot) throw new HttpError(500, 'Nothing to snapshot.');
  const row = await q1(
    `INSERT INTO trash (entity, entity_id, label, payload, deleted_by, deleted_by_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, expires_at`,
    [entity, entityId, label, JSON.stringify(snapshot), user.id, user.name, trashExpiry()],
    client,
  );
  return row;
}

/** List everything still in the bin, newest first. */
export async function listTrash() {
  return q(`
    SELECT id, entity, entity_id, label, deleted_by_name, deleted_at, expires_at,
      CASE entity
        WHEN 'bill' THEN (payload->>'bill')::jsonb->>'invoice_no'
        WHEN 'shop' THEN payload->>'shop_name'
        ELSE payload->>'user_name'
      END AS preview,
      CASE entity
        WHEN 'bill' THEN 1
        WHEN 'shop' THEN jsonb_array_length(COALESCE(payload->'bills', '[]'::jsonb))
        ELSE jsonb_array_length(COALESCE(payload->'bills', '[]'::jsonb))
      END AS bill_count
    FROM trash
    WHERE purged_at IS NULL AND expires_at > now()::text
    ORDER BY deleted_at DESC`);
}

/** Restore one trash entry back into the live tables. */
export async function restoreTrash({ trashId, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can restore records.');
  const entry = await q1('SELECT * FROM trash WHERE id = $1 AND purged_at IS NULL', [Number(trashId)]);
  if (!entry) throw new HttpError(404, 'That trash entry is gone (already restored, purged, or expired).');
  if (entry.expires_at <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    throw new HttpError(410, 'That entry expired — restore is no longer possible.');
  }
  await restoreFromTrash(entry.payload);
  await q('UPDATE trash SET purged_at = now()::text, purged_by = $1 WHERE id = $2', [user.id, entry.id]);
  await recordAudit({
    action: 'restore', entity: entry.entity, entityId: entry.entity_id,
    label: entry.label,
    details: { trash_id: entry.id },
    actor: user,
  });
  return { restored: true, id: entry.id, entity: entry.entity, label: entry.label };
}

/** Wipe one trash entry for good (no restore possible afterwards). */
export async function purgeTrash({ trashId, user }) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only the office can empty the bin.');
  const r = await q(
    'UPDATE trash SET purged_at = now()::text, purged_by = $1 WHERE id = $2 AND purged_at IS NULL RETURNING id, label, entity, entity_id',
    [user.id, Number(trashId)],
  );
  if (!r[0]) throw new HttpError(404, 'Trash entry not found (already purged or expired).');
  await recordAudit({
    action: 'trash_purge', entity: r[0].entity || 'trash', entityId: r[0].entity_id ?? null,
    label: r[0].label,
    details: { trash_id: r[0].id },
    actor: user,
  });
  return { purged: true, id: r[0].id, label: r[0].label };
}

/** Remove every expired entry. Cheap enough to run on every trash list. */
export async function sweepExpiredTrash(user = null) {
  const r = await q("DELETE FROM trash WHERE purged_at IS NULL AND expires_at <= now()::text RETURNING id, entity, entity_id, label");
  if (r.length > 0) {
    await recordAudit({
      action: 'trash_sweep', entity: 'trash',
      label: `${r.length} expired ${r.length === 1 ? 'entry' : 'entries'} auto-wiped`,
      details: { swept: r.length, ids: r.map((x) => x.id) },
      actor: user || { id: null, name: 'system' },
    });
  }
  return r.length;
}
