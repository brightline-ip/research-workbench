BEGIN;
ALTER TABLE revision_runs ADD COLUMN IF NOT EXISTS issue_resolutions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE revision_runs ADD COLUMN IF NOT EXISTS change_summary TEXT;
ALTER TABLE revision_runs ADD COLUMN IF NOT EXISTS issues_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revision_runs ADD COLUMN IF NOT EXISTS issues_changed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revision_runs ADD COLUMN IF NOT EXISTS issues_unresolved INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS revision_runs_one_active_per_project
  ON revision_runs(project_id) WHERE status='RUNNING';
COMMIT;
