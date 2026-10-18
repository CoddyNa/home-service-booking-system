-- Metadata for locally stored AES-256-GCM encrypted PostgreSQL archives.
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS encryption_iv TEXT;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS encryption_tag TEXT;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS restored_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_backup_records_backup_id ON backup_records(backup_id);
