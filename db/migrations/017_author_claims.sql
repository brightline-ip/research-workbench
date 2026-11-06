BEGIN;
-- Statements the author said are their own claims. Later extractions in the project record the same words as needing no source.
CREATE TABLE author_claims (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  claim_hash TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, claim_hash)
);
-- A web search can be skipped when a stored source's passages cover a claim, so this lookup now runs once per claim.
CREATE INDEX IF NOT EXISTS evidence_passages_source_id_idx ON evidence_passages(source_id);
COMMIT;
