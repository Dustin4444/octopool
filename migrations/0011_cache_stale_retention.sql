ALTER TABLE github_cache_entries ADD COLUMN stale_expires_at TEXT;

UPDATE github_cache_entries
SET stale_expires_at = CASE
  WHEN (
    route_kind IN (
      'run_view', 'run_jobs', 'commit_check_runs', 'commit_check_suites',
      'commit_status', 'commit_statuses', 'ref_statuses', 'job_view'
    )
    AND unixepoch(expires_at) - unixepoch(created_at) >= 1800
  )
  OR route_kind IN ('commit_view', 'git_blob', 'git_commit', 'git_tree')
  THEN datetime(expires_at, '+24 hours')
  ELSE datetime(expires_at, '+2 hours')
END;

CREATE INDEX IF NOT EXISTS idx_github_cache_stale_expires
  ON github_cache_entries(stale_expires_at);
