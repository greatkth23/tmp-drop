ALTER TABLE files ADD COLUMN staging_swept_at INTEGER;
CREATE INDEX staging_sweep ON files(staging_swept_at,created_at) WHERE staging_key IS NOT NULL;
