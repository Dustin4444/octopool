CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS callers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  org_login TEXT NOT NULL,
  org_verified_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS caller_pools (
  caller_id TEXT NOT NULL REFERENCES callers(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (caller_id, pool_id)
);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pat', 'github_app')),
  login TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  weight INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identity_scopes (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT,
  permission TEXT NOT NULL DEFAULT 'read',
  allow_private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_id, owner, repo)
);

CREATE TABLE IF NOT EXISTS audit_events (
  request_id TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  route_kind TEXT NOT NULL,
  identity_id TEXT,
  status INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identities_pool_status ON identities(pool_id, status);
CREATE INDEX IF NOT EXISTS idx_identity_scopes_owner_repo ON identity_scopes(owner, repo);
CREATE INDEX IF NOT EXISTS idx_audit_pool_created ON audit_events(pool_id, created_at);
