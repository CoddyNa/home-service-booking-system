-- 001_init.sql
-- Basic schema for the secure auth system

-- Roles table (static list)
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT
);

-- Insert default roles (id values will be stable because of SERIAL)
INSERT INTO roles (name, description) VALUES
    ('user', 'Standard user'),
    ('customer', 'Customer who browses and books home services'),
    ('provider', 'Service provider with approved marketplace access'),
    ('support_agent', 'Support staff with ticket-scoped access'),
    ('staff', 'Staff member'),
    ('auditor', 'Read‑only auditor'),
    ('admin', 'Administrator with full privileges')
ON CONFLICT (name) DO NOTHING;

-- Users table (one role per user for simplicity)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT,
    role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT;

-- Sessions table (optional, for server‑side session store)
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires TIMESTAMP WITH TIME ZONE NOT NULL,
    data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- TOTP credentials (optional, one per user)
CREATE TABLE IF NOT EXISTS totp_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Password reset tokens (store hash only)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user_expiry ON password_reset_tokens(user_id, expires_at);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata JSONB,
    outcome TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Backup records (metadata only)
CREATE TABLE IF NOT EXISTS backup_records (
    id SERIAL PRIMARY KEY,
    backup_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    status TEXT,
    size_bytes BIGINT,
    checksum TEXT,
    initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Enable row‑level security for high‑privilege tables (optional example)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
