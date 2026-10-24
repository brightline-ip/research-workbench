BEGIN;
CREATE TABLE checkpoint_requests (
  request_key UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id),
  request_hash TEXT NOT NULL,
  article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
