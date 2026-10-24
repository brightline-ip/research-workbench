BEGIN;

ALTER TABLE project_artifacts DROP CONSTRAINT IF EXISTS project_artifacts_artifact_type_check;
ALTER TABLE project_artifacts ADD CONSTRAINT project_artifacts_artifact_type_check CHECK (artifact_type IN ('RESEARCH_BRIEF','ARTICLE','VERIFICATION_REPORT','DATASET','SPREADSHEET','CHART','PDF_EXPORT','DOCX_EXPORT','CSV_EXPORT','SOURCE_BUNDLE','OTHER'));

CREATE TABLE IF NOT EXISTS revision_runs (
  revision_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  source_article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,
  verification_run_id UUID NOT NULL REFERENCES verification_runs(verification_run_id) ON DELETE RESTRICT,
  output_article_version_id UUID REFERENCES article_versions(article_version_id) ON DELETE SET NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','COMPLETE','FAILED')),
  applied_verification_result_ids UUID[] NOT NULL DEFAULT '{}',
  model_name TEXT,
  provider_response_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assertion_dependencies (
  premise_assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,
  conclusion_assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'REQUIRES' CHECK(dependency_type IN ('REQUIRES','SUPPORTS','QUALIFIES')),
  rationale TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(premise_assertion_id,conclusion_assertion_id),
  CHECK(premise_assertion_id<>conclusion_assertion_id)
);

CREATE TABLE IF NOT EXISTS datasets (
  dataset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  schema_json JSONB NOT NULL,
  records_json JSONB NOT NULL CHECK(jsonb_typeof(records_json)='array'),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  source_ids UUID[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,content_hash)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  analysis_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL REFERENCES datasets(dataset_id) ON DELETE RESTRICT,
  instruction TEXT NOT NULL,
  execution_method TEXT NOT NULL DEFAULT 'DETERMINISTIC_JS',
  operation TEXT NOT NULL CHECK(operation IN ('DESCRIBE','GROUP_COUNT','GROUP_MEAN','PERCENTAGE')),
  parameters JSONB NOT NULL DEFAULT '{}',
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  result_data JSONB,
  result_summary TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','COMPLETE','FAILED')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

COMMIT;

