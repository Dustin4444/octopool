CREATE TABLE IF NOT EXISTS github_public_api_rates (
  resource TEXT PRIMARY KEY,
  limit_count INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
