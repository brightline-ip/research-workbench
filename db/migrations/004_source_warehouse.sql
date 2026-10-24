BEGIN;

CREATE TABLE IF NOT EXISTS sources (
  source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url TEXT NOT NULL UNIQUE,
  canonical_identity TEXT,
  title TEXT,
  source_type TEXT NOT NULL DEFAULT 'OTHER' CHECK (source_type IN ('STATUTE','REGULATION','JUDICIAL_OPINION','AGENCY_DOCUMENT','GOVERNMENT_DATASET','PATENT','SEC_FILING','ACADEMIC','NEWS','WEB_PAGE','OTHER')),
  issuing_authority TEXT,
  jurisdiction TEXT,
  publication_date DATE,
  version_label TEXT,
  retrieval_status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (retrieval_status IN ('DISCOVERED','ACQUIRING','ACQUIRED','NORMALIZED','FAILED')),
  retrieved_at TIMESTAMPTZ,
  final_url TEXT,
  http_status INTEGER,
  media_type TEXT,
  byte_length BIGINT,
  content_hash TEXT,
  original_storage_path TEXT,
  normalized_storage_path TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sources_content_hash_unique
  ON sources(content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_sources (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  membership_status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (membership_status IN ('CANDIDATE','ACCEPTED','REJECTED')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, source_id)
);

CREATE TABLE IF NOT EXISTS assertion_source_relationships (
  relationship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('SUPPORTS','QUALIFIES','CONTRADICTS','BACKGROUND')),
  proposition_source_class TEXT NOT NULL CHECK (proposition_source_class IN ('PRIMARY','SECONDARY','UNKNOWN')),
  classification_reason TEXT NOT NULL,
  discovery_only BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(assertion_id, source_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS source_access_attempts (
  access_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  assertion_id UUID REFERENCES assertions(assertion_id) ON DELETE SET NULL,
  source_id UUID REFERENCES sources(source_id) ON DELETE SET NULL,
  candidate_source TEXT,
  canonical_url TEXT NOT NULL,
  attempt_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('SUCCESS','FAILED','BLOCKED')),
  failure_reason TEXT,
  alternative_attempted TEXT,
  http_status INTEGER,
  final_url TEXT
);

COMMIT;

