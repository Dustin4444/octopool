CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_events(created_at);
