ALTER TABLE callers ADD COLUMN dashboard_role TEXT NOT NULL DEFAULT 'none'
  CHECK (dashboard_role IN ('none', 'admin'));

UPDATE callers
SET dashboard_role = 'admin'
WHERE github_user_id = 58493
  AND lower(org_login) = 'openclaw';

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  next_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  session_hash TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL REFERENCES callers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_web_sessions_caller_expires ON web_sessions(caller_id, expires_at);
