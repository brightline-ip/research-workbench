BEGIN;
ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'AUTHOR_CORPUS' CHECK(mode IN('AUTHOR_CORPUS','INDEPENDENT_DISCOVERY'));
ALTER TABLE verification_runs ADD COLUMN IF NOT EXISTS discovery_run_id UUID REFERENCES discovery_runs(discovery_run_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS adversarial_runs (
 adversarial_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 article_version_id UUID NOT NULL REFERENCES article_versions(article_version_id) ON DELETE CASCADE,author_verification_run_id UUID NOT NULL REFERENCES verification_runs(verification_run_id) ON DELETE RESTRICT,
 independent_discovery_run_id UUID REFERENCES discovery_runs(discovery_run_id) ON DELETE SET NULL,independent_verification_run_id UUID REFERENCES verification_runs(verification_run_id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN('RUNNING','COMPLETE','FAILED','NEEDS_REVIEW')),model_name TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS adversarial_comparisons (
 adversarial_comparison_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),adversarial_run_id UUID NOT NULL REFERENCES adversarial_runs(adversarial_run_id) ON DELETE CASCADE,
 assertion_id UUID NOT NULL REFERENCES assertions(assertion_id) ON DELETE CASCADE,author_result_id UUID REFERENCES verification_results(verification_result_id) ON DELETE SET NULL,
 independent_result_id UUID REFERENCES verification_results(verification_result_id) ON DELETE SET NULL,comparison_status TEXT NOT NULL CHECK(comparison_status IN('AGREES','MATERIAL_DISAGREEMENT','AUTHOR_ONLY_SUPPORT','INDEPENDENT_ONLY_SUPPORT','BOTH_DEFECTIVE')),
 materiality TEXT NOT NULL CHECK(materiality IN('LOW','MEDIUM','HIGH','CRITICAL')),rationale TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(adversarial_run_id,assertion_id));
CREATE TABLE IF NOT EXISTS red_team_runs (
 red_team_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),adversarial_run_id UUID NOT NULL REFERENCES adversarial_runs(adversarial_run_id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN('RUNNING','COMPLETE','FAILED')),thesis_survives TEXT CHECK(thesis_survives IN('YES','QUALIFIED','NO','INDETERMINATE')),
 executive_assessment TEXT,model_name TEXT,provider_response_id TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS red_team_findings (
 red_team_finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),red_team_run_id UUID NOT NULL REFERENCES red_team_runs(red_team_run_id) ON DELETE CASCADE,
 assertion_id UUID REFERENCES assertions(assertion_id) ON DELETE SET NULL,finding_type TEXT NOT NULL CHECK(finding_type IN('PUBLIC_CHALLENGE','CREDIBILITY_RISK','CORRECTION_REQUIRED','OMITTED_AUTHORITY','FAILED_PREMISE','THESIS_RISK')),
 severity TEXT NOT NULL CHECK(severity IN('LOW','MEDIUM','HIGH','CRITICAL')),challenge TEXT NOT NULL,evidence_basis TEXT NOT NULL,recommended_action TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reconciliation_runs (
 reconciliation_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),adversarial_run_id UUID NOT NULL REFERENCES adversarial_runs(adversarial_run_id) ON DELETE CASCADE,red_team_run_id UUID NOT NULL REFERENCES red_team_runs(red_team_run_id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN('RUNNING','COMPLETE','FAILED','NEEDS_HUMAN_REVIEW')),overall_disposition TEXT CHECK(overall_disposition IN('PUBLISHABLE','PUBLISHABLE_WITH_CORRECTIONS','MAJOR_REVISION','WITHHOLD')),
 summary TEXT,required_actions JSONB NOT NULL DEFAULT '[]'::jsonb,model_name TEXT,provider_response_id TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS adversarial_runs_article_idx ON adversarial_runs(article_version_id,created_at DESC);
COMMIT;
