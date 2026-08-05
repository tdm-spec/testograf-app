CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_results_active_submitted
  ON results(deleted_at, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_results_test
  ON results(test_id, deleted_at, submitted_at DESC);
