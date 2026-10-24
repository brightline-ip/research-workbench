BEGIN;
ALTER TABLE assertion_extraction_runs ADD COLUMN IF NOT EXISTS verification_scope JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS verification_scope TEXT NOT NULL DEFAULT 'EXTERNAL' CHECK(verification_scope IN('EXTERNAL','EXCLUDED'));
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS scope_reason TEXT;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS assertion_review_decisions(
 decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE, assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,
 before_value JSONB NOT NULL, after_value JSONB NOT NULL, reason TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assertion_review_article_idx ON assertion_review_decisions(article_version_id,decided_at);
COMMIT;
