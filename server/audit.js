/**
 * Audit log — one append-only row per destructive or restorative action:
 * soft delete, hard delete (purge), trash restore, trash erase, factory
 * reset, and the periodic trash sweep. Rows carry the actor, the entity,
 * a human-readable label, and a JSONB bag of action-specific details.
 *
 * Nothing in the app ever updates or deletes audit rows — the log only
 * grows. Writers must never let an audit failure abort the business
 * action it describes: recordAudit is fire-and-forget by design.
 */
import { q, q1 } from './db.js';

/** Write one audit row. Best-effort: failures are logged, never thrown,
 * so a broken audit sink can't block the action it records. */
export async function recordAudit({ action, entity, entityId = null, label = null, details = null, actor }) {
  try {
    await q(
      `INSERT INTO audit_log (action, entity, entity_id, label, details, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        action,
        entity,
        entityId,
        label,
        details ? JSON.stringify(details) : null,
        actor?.id ?? null,
        actor?.name || 'unknown',
      ],
    );
  } catch (err) {
    console.error('[audit] failed to record', action, entity, entityId, err.message);
  }
}

/** Read the log, newest first, with optional filters and pagination.
 * Returns { rows, total } — total is the filtered count so the UI can size
 * the pager without a second query shape. Admin-only by caller. */
export async function listAudit({ action, entity, actorId, from, to, limit = 200, offset = 0, maxLimit = 500 } = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (action) add('a.action = ?', action);
  if (entity) add('a.entity = ?', entity);
  if (actorId) add('a.actor_id = ?', actorId);
  if (from) add('a.created_at >= ?', from);
  if (to) add('a.created_at <= ?', `${to}~`); // 'YYYY-MM-DD~' sorts after 'YYYY-MM-DDT…' timestamps
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Limit is capped server-side so a caller can't ask for the whole table
  // (exports lift the cap with maxLimit).
  const lim = Math.min(Math.max(Number(limit) || 200, 1), Math.max(Number(maxLimit) || 500, 1));
  const off = Math.max(Number(offset) || 0, 0);

  const [rows, count] = await Promise.all([
    q(
      `SELECT a.*, u.code AS actor_code
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.id DESC
       LIMIT ${lim} OFFSET ${off}`,
      params,
    ),
    // Filtered total for the pager. Same WHERE, no LIMIT — a count over the
    // indexed table stays cheap even as the log grows.
    q1(`SELECT COUNT(*)::int AS n FROM audit_log a ${where}`, params),
  ]);
  return { rows, total: count?.n || 0 };
}
