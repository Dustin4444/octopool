ALTER TABLE identities ADD COLUMN installation_id INTEGER;

CREATE TABLE IF NOT EXISTS github_public_repos (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_github_public_repos_expires
  ON github_public_repos(expires_at);
