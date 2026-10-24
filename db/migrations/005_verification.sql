BEGIN;

CREATE TABLE IF NOT EXISTS source_text_chunks (
  passage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
  normalized_start_offset INTEGER NOT NULL CHECK (normalized_start_offset >= 0),
  normalized_end_offset INTEGER NOT NULL CHECK (normalized_end_offset > normalized_start_offset),
  locator TEXT NOT NULL,
  passage_text TEXT NOT NULL,
  passage_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_id, sequence_number),
  UNIQUE(source_id, passage_hash)
);

CREATE TABLE IF NOT EXISTS verification_runs (
  verification_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('AUTHOR_CORPUS','INDEPENDENT_DISCOVERY')),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE','FAILED')),
  model_role TEXT NOT NULL DEFAULT 'VERIFICATION_MODEL',
  model_name TEXT,
  assertions_extracted INTEGER NOT NULL DEFAULT 0,
  assertions_attempted INTEGER NOT NULL DEFAULT 0,
  assertions_not_attempted INTEGER NOT NULL DEFAULT 0,
  primary_sources_acquired INTEGER NOT NULL DEFAULT 0,
  source_acquisition_failures INTEGER NOT NULL DEFAULT 0,
  status_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS verification_results (
  verification_result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_run_id UUID NOT NULL REFERENCES verification_runs(verification_run_id) ON DELETE CASCADE,
  assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(source_id) ON DELETE RESTRICT,
  passage_id UUID REFERENCES source_text_chunks(passage_id) ON DELETE RESTRICT,
  assertion_as_made TEXT NOT NULL,
  source_actually_establishes TEXT NOT NULL,
  material_gap TEXT NOT NULL,
  extracted_passage TEXT,
  pin_cite TEXT,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','OVERSTATED','MISCITED','UNSUPPORTED','CONTRADICTED','STALE','UNVERIFIABLE','FABRICATED')),
  defect_codes TEXT[] NOT NULL DEFAULT '{}',
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  recommended_remediation TEXT NOT NULL,
  provider_response_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(verification_run_id, assertion_id)
);

CREATE INDEX IF NOT EXISTS source_text_chunks_source_sequence_idx ON source_text_chunks(source_id, sequence_number);
CREATE INDEX IF NOT EXISTS verification_results_assertion_idx ON verification_results(assertion_id, created_at DESC);

COMMIT;

