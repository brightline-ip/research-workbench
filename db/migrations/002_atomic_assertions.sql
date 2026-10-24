BEGIN;

CREATE TABLE IF NOT EXISTS assertion_extraction_runs (
  extraction_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE','FAILED')),
  coverage_complete BOOLEAN,
  coverage_notes TEXT,
  model_role TEXT NOT NULL DEFAULT 'CLAIM_EXTRACTION_MODEL',
  model_name TEXT,
  assertion_count INTEGER NOT NULL DEFAULT 0 CHECK (assertion_count >= 0),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (article_version_id)
);

CREATE TABLE IF NOT EXISTS assertions (
  assertion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,
  extraction_run_id UUID NOT NULL REFERENCES assertion_extraction_runs(extraction_run_id),
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  evidence_span TEXT NOT NULL,
  assertion_text TEXT NOT NULL,
  normalized_proposition TEXT NOT NULL,
  assertion_class TEXT NOT NULL CHECK (assertion_class IN (
    'DIRECT_QUOTE','LEGAL_HOLDING','LEGAL_CHARACTERIZATION','STATUTORY_OR_REGULATORY_REQUIREMENT',
    'AGENCY_POSITION','AGENCY_PRACTICE','QUANTITATIVE','DATE_OR_EVENT','TREND','TECHNICAL_FACT',
    'HISTORICAL_FACT','ANALYTICAL_INFERENCE','OPINION','UNSOURCED_ASSERTION'
  )),
  load_bearing BOOLEAN NOT NULL,
  load_bearing_reason TEXT,
  citation_as_written TEXT,
  source_required BOOLEAN NOT NULL,
  primary_source_required BOOLEAN NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIABLE' CHECK (verification_state IN (
    'VERIFIED','OVERSTATED','MISCITED','UNSUPPORTED','CONTRADICTED','STALE','UNVERIFIABLE','FABRICATED'
  )),
  assertion_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_version_id, assertion_fingerprint),
  CHECK (NOT load_bearing OR length(trim(load_bearing_reason)) > 0)
);

CREATE INDEX IF NOT EXISTS assertions_article_location_idx
  ON assertions(article_version_id, start_offset, end_offset);
CREATE INDEX IF NOT EXISTS assertions_review_queue_idx
  ON assertions(project_id, load_bearing DESC, verification_state);

COMMIT;
