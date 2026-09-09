-- Audit log: who deleted/restored/purged what, and when. Append-only from
-- the app's point of view — rows are never updated or deleted (except by an
-- explicit future retention policy). Applied by tools/init-db.mjs; safe to
-- re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  -- delete | purge | restore | trash_purge | trash_sweep | factory_reset
  action TEXT NOT NULL,
  -- bill | shop | salesman | trash | system
  entity TEXT NOT NULL,
  -- Live-row id where applicable (bill id, shop id, …); NULL for whole-book
  -- actions like factory reset.
  entity_id INTEGER,
  -- Human-readable one-liner, e.g. "INV/2026/9001 · Sharma General Store".
  label TEXT,
  -- JSONB bag for action-specific facts: counts, salesman name, trash id,
  -- restore scope, etc. Schema-proof across future changes.
  details JSONB,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
