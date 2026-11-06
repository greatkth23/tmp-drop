ALTER TABLE files ADD COLUMN batch_id TEXT;
CREATE INDEX files_batch ON files(batch_id,state,completed_at);
CREATE TABLE download_archives (token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, file_ids TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX download_archives_expiry ON download_archives(expires_at);
