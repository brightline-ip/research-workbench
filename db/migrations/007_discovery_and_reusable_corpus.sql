BEGIN;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS authority_tier TEXT NOT NULL DEFAULT 'UNASSESSED' CHECK (authority_tier IN ('PRIMARY','OFFICIAL_SECONDARY','SECONDARY','DISCOVERY_ONLY','UNASSESSED'));
ALTER TABLE sources ADD COLUMN IF NOT EXISTS effective_date DATE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS superseded_at DATE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS superseded_by_source_id UUID REFERENCES sources(source_id) ON DELETE SET NULL;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_freshness_checked_at TIMESTAMPTZ;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS freshness_status TEXT NOT NULL DEFAULT 'UNCHECKED' CHECK (freshness_status IN ('CURRENT','POSSIBLY_STALE','SUPERSEDED','WITHDRAWN','VACATED','REVERSED','UNCHECKED','UNKNOWN'));
ALTER TABLE sources ADD COLUMN IF NOT EXISTS freshness_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS provider_identifiers JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS sources_canonical_identity_idx ON sources(canonical_identity) WHERE canonical_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_authority_freshness_idx ON sources(authority_tier,freshness_status,last_freshness_checked_at);
CREATE INDEX IF NOT EXISTS sources_provider_identifiers_gin_idx ON sources USING GIN(provider_identifiers);

CREATE TABLE IF NOT EXISTS discovery_runs (
 discovery_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN('RUNNING','COMPLETE','FAILED','NEEDS_REVIEW')), policy JSONB NOT NULL,
 model_name TEXT, assertions_total INTEGER NOT NULL DEFAULT 0, assertions_searched INTEGER NOT NULL DEFAULT 0,
 warehouse_candidates INTEGER NOT NULL DEFAULT 0, external_candidates INTEGER NOT NULL DEFAULT 0, primary_sources_acquired INTEGER NOT NULL DEFAULT 0,
 coverage_notes TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS discovery_queries (
 discovery_query_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),discovery_run_id UUID NOT NULL REFERENCES discovery_runs(discovery_run_id) ON DELETE CASCADE,
 assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,provider TEXT NOT NULL,query_text TEXT NOT NULL,
 query_type TEXT NOT NULL CHECK(query_type IN('WAREHOUSE','GENERAL_WEB','GOVINFO','FEDERAL_REGISTER','CONGRESS','E_CFR','COURT','AGENCY','CITATOR','OTHER')),
 result_count INTEGER NOT NULL DEFAULT 0,response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS discovery_candidates (
 discovery_candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),discovery_run_id UUID NOT NULL REFERENCES discovery_runs(discovery_run_id) ON DELETE CASCADE,
 assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,discovery_query_id UUID REFERENCES discovery_queries(discovery_query_id) ON DELETE SET NULL,
 source_id UUID REFERENCES sources(source_id) ON DELETE SET NULL,candidate_url TEXT,candidate_title TEXT,issuing_authority TEXT,proposed_source_type TEXT,
 proposed_authority_tier TEXT,relationship_type TEXT,disposition TEXT NOT NULL DEFAULT 'PENDING' CHECK(disposition IN('PENDING','ACCEPTED','REJECTED','DUPLICATE','ACQUISITION_FAILED','HUMAN_REVIEW')),
 disposition_reason TEXT,rank_score NUMERIC,provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS corpus_snapshots (
 corpus_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,discovery_run_id UUID REFERENCES discovery_runs(discovery_run_id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'BUILDING' CHECK(status IN('BUILDING','SEALED','INVALIDATED')),policy JSONB NOT NULL,manifest_hash TEXT,source_count INTEGER NOT NULL DEFAULT 0,
 sealed_at TIMESTAMPTZ,invalidation_reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS corpus_snapshot_sources (
 corpus_snapshot_id UUID NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id) ON DELETE CASCADE,source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
 source_content_hash TEXT NOT NULL,normalized_content_hash TEXT,authority_tier TEXT NOT NULL,freshness_status TEXT NOT NULL,
 proposition_scope JSONB NOT NULL DEFAULT '[]'::jsonb,added_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(corpus_snapshot_id,source_id));
CREATE INDEX IF NOT EXISTS discovery_runs_project_article_idx ON discovery_runs(project_id,article_version_id,created_at DESC);
CREATE INDEX IF NOT EXISTS discovery_candidates_assertion_idx ON discovery_candidates(assertion_id,disposition,rank_score DESC);
CREATE INDEX IF NOT EXISTS corpus_snapshots_article_idx ON corpus_snapshots(article_version_id,created_at DESC);
COMMIT;
