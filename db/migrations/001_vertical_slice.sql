BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','RESEARCHING','DRAFTED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_threads (
  thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Project conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES conversation_threads(thread_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  referenced_article_version_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS article_versions (
  article_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  research_brief JSONB,
  change_summary TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('MODEL','USER','SYSTEM')),
  parent_version_id UUID REFERENCES article_versions(article_version_id),
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_number),
  UNIQUE (project_id, content_hash)
);

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_referenced_article_version_id_fkey;
ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_referenced_article_version_id_fkey
  FOREIGN KEY (referenced_article_version_id) REFERENCES article_versions(article_version_id);

CREATE TABLE IF NOT EXISTS project_artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('RESEARCH_BRIEF','ARTICLE','OTHER')),
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_path TEXT,
  article_version_id UUID REFERENCES article_versions(article_version_id),
  generated_by_run_type TEXT,
  generated_by_run_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_versions_project_latest_idx
  ON article_versions (project_id, version_number DESC);
CREATE INDEX IF NOT EXISTS conversation_messages_thread_time_idx
  ON conversation_messages (thread_id, created_at);

COMMIT;

