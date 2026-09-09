-- Trash bin: snapshots of hard-deleted records, restorable for 30 days.
-- Applied by tools/init-db.mjs; safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS trash (
  id SERIAL PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('bill', 'shop', 'salesman')),
  entity_id INTEGER,
  label TEXT NOT NULL,
  -- Full row snapshot plus every child row (collections, short_items,
  -- cancellations, bill_edits for bills; bills for shops; bills+children for
  -- salesmen). JSONB keeps this schema-proof across future column changes.
  payload JSONB NOT NULL,
  deleted_by INTEGER REFERENCES users(id),
  deleted_by_name TEXT,
  deleted_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text,
  expires_at TEXT NOT NULL,
  -- Permanently deleting an entry from the bin.
  purged_at TEXT,
  purged_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_trash_expires ON trash(expires_at);
CREATE INDEX IF NOT EXISTS idx_trash_entity ON trash(entity, entity_id);
