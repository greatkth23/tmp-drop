PRAGMA foreign_keys = ON;
CREATE TABLE trusted_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('browser','shortcut')),
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE temp_sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX temp_expiry ON temp_sessions(expires_at);
CREATE TABLE download_sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, pin_version TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX download_expiry ON download_sessions(expires_at);
CREATE TABLE admin_grants (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, target_id TEXT,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE totp_uses (secret_version TEXT NOT NULL, time_step INTEGER NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY(secret_version,time_step));
CREATE TABLE auth_attempts (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, ip_key TEXT NOT NULL, attempted_at INTEGER NOT NULL);
CREATE INDEX auth_ip_time ON auth_attempts(purpose,ip_key,attempted_at);
CREATE INDEX auth_global_time ON auth_attempts(purpose,attempted_at);
CREATE TABLE daily_usage (day_utc TEXT PRIMARY KEY, admitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK(admitted_bytes >= 0));
CREATE TABLE quota_state (id INTEGER PRIMARY KEY CHECK(id=1), reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0), ready_bytes INTEGER NOT NULL DEFAULT 0 CHECK(ready_bytes>=0));
INSERT INTO quota_state(id) VALUES(1);
CREATE TABLE files (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('web_multipart','shortcut_put')),
  state TEXT NOT NULL CHECK(state IN ('CREATING','UPLOADING','FINALIZING','READY','CANCEL_REQUESTED','CANCELLED','FAILED','EXPIRED','DELETING','DELETED')),
  filename TEXT NOT NULL, declared_mime TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=34359738368),
  retention_seconds INTEGER NOT NULL CHECK(retention_seconds IN(3600,21600,86400,259200)),
  final_key TEXT NOT NULL UNIQUE, staging_key TEXT, multipart_id TEXT,
  capability_hash TEXT NOT NULL UNIQUE, capability_expires_at INTEGER NOT NULL,
  owner_device_id TEXT REFERENCES trusted_devices(id), owner_session_id TEXT REFERENCES temp_sessions(id),
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, first_part_at INTEGER,
  completed_at INTEGER, expires_at INTEGER, final_etag TEXT, actual_size_bytes INTEGER,
  pinned_source_etag TEXT, finalize_started_at INTEGER, finalize_lease_until INTEGER,
  cancel_requested_at INTEGER, deleted_at INTEGER, last_error_code TEXT,
  quota_bucket TEXT NOT NULL DEFAULT 'reserved' CHECK(quota_bucket IN('reserved','ready','released')),
  CHECK((owner_device_id IS NOT NULL) != (owner_session_id IS NOT NULL)),
  CHECK(state!='READY' OR (completed_at IS NOT NULL AND expires_at IS NOT NULL AND actual_size_bytes=size_bytes))
);
CREATE INDEX file_list ON files(state,completed_at DESC,id DESC);
CREATE INDEX file_expiry ON files(state,expires_at);
CREATE INDEX file_cap_expiry ON files(state,capability_expires_at);
CREATE INDEX file_device ON files(owner_device_id,state);
CREATE INDEX file_session ON files(owner_session_id,state);
CREATE TABLE upload_parts (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, part_number INTEGER NOT NULL CHECK(part_number>0),
  state TEXT NOT NULL CHECK(state IN('SENDING','DONE','UNCERTAIN')),
  bytes INTEGER NOT NULL, etag TEXT, attempt_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(file_id,part_number)
);
CREATE TABLE idempotency_keys (
  principal_id TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id), response_ciphertext TEXT, expires_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,key_hash)
);
CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL UNIQUE REFERENCES files(id), type TEXT NOT NULL,
  run_after INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, last_error_code TEXT
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, actor_id TEXT, resource_id TEXT,
  result TEXT NOT NULL, created_at INTEGER NOT NULL, request_id TEXT NOT NULL
);
CREATE INDEX audit_time ON audit_events(created_at);

-- The file insert is the admission transaction: SQLite serializes the trigger with the insert.
CREATE TRIGGER file_admission BEFORE INSERT ON files BEGIN
  SELECT (CASE WHEN (SELECT reserved_bytes+ready_bytes FROM quota_state WHERE id=1)+NEW.size_bytes>107374182400 THEN RAISE(ABORT,'STORAGE_QUOTA_EXCEEDED') END);
  SELECT (CASE WHEN (SELECT count(*) FROM files WHERE state IN('CREATING','UPLOADING','FINALIZING'))>=8 THEN RAISE(ABORT,'ACTIVE_UPLOAD_LIMIT') END);
  SELECT (CASE WHEN (SELECT count(*) FROM files WHERE state IN('CREATING','UPLOADING','FINALIZING') AND (owner_device_id=NEW.owner_device_id OR owner_session_id=NEW.owner_session_id))>=4 THEN RAISE(ABORT,'ACTIVE_UPLOAD_LIMIT') END);
  SELECT (CASE WHEN NEW.owner_device_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM trusted_devices WHERE id=NEW.owner_device_id AND revoked_at IS NULL) THEN RAISE(ABORT,'DEVICE_REVOKED') END);
  SELECT (CASE WHEN NEW.owner_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM temp_sessions WHERE id=NEW.owner_session_id AND revoked_at IS NULL AND expires_at>NEW.created_at) THEN RAISE(ABORT,'UPLOAD_SESSION_EXPIRED') END);
  INSERT INTO daily_usage(day_utc,admitted_bytes) VALUES(date(NEW.created_at/1000,'unixepoch'),0) ON CONFLICT DO NOTHING;
  SELECT (CASE WHEN (SELECT admitted_bytes FROM daily_usage WHERE day_utc=date(NEW.created_at/1000,'unixepoch'))+NEW.size_bytes>214748364800 THEN RAISE(ABORT,'DAILY_QUOTA_EXCEEDED') END);
  UPDATE quota_state SET reserved_bytes=reserved_bytes+NEW.size_bytes WHERE id=1;
  UPDATE daily_usage SET admitted_bytes=admitted_bytes+NEW.size_bytes WHERE day_utc=date(NEW.created_at/1000,'unixepoch');
END;
CREATE TRIGGER file_quota_transfer AFTER UPDATE OF quota_bucket ON files WHEN OLD.quota_bucket!=NEW.quota_bucket BEGIN
  UPDATE quota_state SET
    reserved_bytes=reserved_bytes-(CASE WHEN OLD.quota_bucket='reserved' THEN OLD.size_bytes ELSE 0 END)+(CASE WHEN NEW.quota_bucket='reserved' THEN NEW.size_bytes ELSE 0 END),
    ready_bytes=ready_bytes-(CASE WHEN OLD.quota_bucket='ready' THEN OLD.size_bytes ELSE 0 END)+(CASE WHEN NEW.quota_bucket='ready' THEN NEW.size_bytes ELSE 0 END)
  WHERE id=1;
END;
