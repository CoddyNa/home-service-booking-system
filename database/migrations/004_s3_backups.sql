-- S3-backed, manually initiated backup operations. File storage is currently not
-- integrated in this app; files_status is deliberately reported as not_applicable.
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS s3_key TEXT;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS files_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS upload_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
CREATE TABLE IF NOT EXISTS backup_operations (
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('backup','verify','restore','cleanup')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','complete','failed')),
  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  database_status TEXT NOT NULL DEFAULT 'pending',
  files_status TEXT NOT NULL DEFAULT 'not_applicable',
  upload_status TEXT NOT NULL DEFAULT 'pending',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE backup_operations ADD COLUMN IF NOT EXISTS backup_id TEXT;
CREATE INDEX IF NOT EXISTS idx_backup_records_expiration ON backup_records(expires_at) WHERE status='complete';
CREATE INDEX IF NOT EXISTS idx_backup_operations_created ON backup_operations(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_backup_operation_at_a_time ON backup_operations(operation_type)
  WHERE operation_type='backup' AND status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_restore_per_backup ON backup_operations(backup_id)
  WHERE operation_type='restore' AND status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_restore_operation_at_a_time ON backup_operations(operation_type)
  WHERE operation_type='restore' AND status IN ('queued','running');

