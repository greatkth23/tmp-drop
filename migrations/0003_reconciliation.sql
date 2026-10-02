ALTER TABLE upload_parts ADD COLUMN lease_until INTEGER;
ALTER TABLE upload_parts ADD COLUMN reconcile_token TEXT;
ALTER TABLE upload_parts ADD COLUMN reconcile_lease_until INTEGER;
CREATE INDEX part_recovery ON upload_parts(state, lease_until, updated_at);
ALTER TABLE files ADD COLUMN object_checked_at INTEGER;
CREATE TABLE reconciliation_state (
  id TEXT PRIMARY KEY, cursor TEXT, lease_token TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE orphan_candidates (
  object_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, sightings INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE reconciliation_reports (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, created_at INTEGER NOT NULL, report_json TEXT NOT NULL
);
CREATE INDEX reconciliation_report_time ON reconciliation_reports(created_at);
