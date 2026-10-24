BEGIN;
ALTER TABLE assertion_extraction_runs ADD COLUMN IF NOT EXISTS provider_response_id TEXT;
COMMIT;

