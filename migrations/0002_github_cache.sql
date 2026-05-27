ALTER TABLE callers ADD COLUMN github_user_id INTEGER;

UPDATE callers
SET github_user_id = 58493
WHERE github_user_id IS NULL
  AND lower(github_login) = 'steipete'
  AND lower(org_login) = 'openclaw';

CREATE TABLE IF NOT EXISTS github_cache_entries (
  cache_key TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_json TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  route_kind TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_headers_json TEXT NOT NULL,
  body_json TEXT NOT NULL,
  body_encoding TEXT NOT NULL,
  identity_id TEXT,
  identity_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_cache_pool_route_expires
  ON github_cache_entries(pool_id, route_key, expires_at);
