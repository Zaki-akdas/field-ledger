/**
 * Read side of the error sink (server/errors.js): filtered, paged listing for
 * the admin Errors page. Same clause-building style as listAudit.
 */
import { q, q1 } from './db.js';

export async function listErrors({ source, kind, userId, from, to, search, limit = 50, offset = 0, maxLimit = 500 } = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (source && source !== 'all') add('e.source = ?', source);
  if (kind && kind !== 'all') add('e.kind = ?', kind);
  if (userId) add('e.user_id = ?', userId);
  if (from) add('e.created_at >= ?', from);
  if (to) add('e.created_at <= ?', `${to}~`); // 'YYYY-MM-DD~' sorts after 'YYYY-MM-DDT…' timestamps
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(e.message ILIKE $${params.length} OR e.stack ILIKE $${params.length} OR e.user_code ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 50, 1), Math.max(Number(maxLimit) || 500, 1));
  const off = Math.max(Number(offset) || 0, 0);

  const [rows, count] = await Promise.all([
    q(
      `SELECT e.*, u.code AS user_code_join, u.name AS user_name
       FROM error_reports e LEFT JOIN users u ON u.id = e.user_id
       ${where}
       ORDER BY e.id DESC
       LIMIT ${lim} OFFSET ${off}`,
      params,
    ),
    q1(`SELECT COUNT(*)::int AS n FROM error_reports e ${where}`, params),
  ]);
  return { rows, total: count?.n || 0 };
}

/** Count of reports newer than the admin's last-seen marker (sidebar badge). */
export async function unreadErrorsCount(afterId) {
  const row = await q1(`SELECT COUNT(*)::int AS n FROM error_reports WHERE id > $1`, [afterId]);
  return row?.n || 0;
}

/** Newest report id — the seed value for the last-seen marker. */
export async function latestErrorId() {
  const row = await q1(`SELECT COALESCE(MAX(id), 0)::int AS id FROM error_reports`);
  return row?.id || 0;
}

/** Distinct kinds + a quick source split for the page's filter chips. */
export async function errorFacets() {
  const [kinds, sources] = await Promise.all([
    q(`SELECT kind, COUNT(*)::int AS n FROM error_reports GROUP BY kind ORDER BY n DESC LIMIT 12`),
    q(`SELECT source, COUNT(*)::int AS n FROM error_reports GROUP BY source`),
  ]);
  return { kinds, sources };
}
