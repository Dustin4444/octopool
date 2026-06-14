ALTER TABLE audit_events ADD COLUMN fallback_reason TEXT;

ALTER TABLE audit_events ADD COLUMN coalesced INTEGER NOT NULL DEFAULT 0
  CHECK (coalesced IN (0, 1));
