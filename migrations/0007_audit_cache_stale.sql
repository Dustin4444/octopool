PRAGMA foreign_keys = OFF;

CREATE TABLE audit_events_new (
  request_id TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  route_kind TEXT NOT NULL,
  identity_id TEXT,
  status INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER NOT NULL,
  cache_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cache_status IN ('hit', 'stale', 'miss', 'bypass', 'unknown')),
  cacheable INTEGER NOT NULL DEFAULT 0
    CHECK (cacheable IN (0, 1))
);

INSERT INTO audit_events_new (
  request_id,
  caller_id,
  pool_id,
  route_key,
  route_kind,
  identity_id,
  status,
  error_code,
  created_at,
  duration_ms,
  cache_status,
  cacheable
)
SELECT
  request_id,
  caller_id,
  pool_id,
  route_key,
  route_kind,
  identity_id,
  status,
  error_code,
  created_at,
  duration_ms,
  cache_status,
  cacheable
FROM audit_events;

DROP TABLE audit_events;
ALTER TABLE audit_events_new RENAME TO audit_events;

CREATE INDEX IF NOT EXISTS idx_audit_pool_created ON audit_events(pool_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_pool_cache_created
  ON audit_events(pool_id, cache_status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_pool_route_cache_created
  ON audit_events(pool_id, route_kind, cache_status, created_at);

PRAGMA foreign_keys = ON;
