BEGIN;
ALTER TABLE verification_results DROP CONSTRAINT verification_results_status_check;
ALTER TABLE verification_results ADD CONSTRAINT verification_results_status_check CHECK (
  status IN ('VERIFIED','OVERSTATED','MISCITED','UNSUPPORTED','CONTRADICTED','STALE','UNVERIFIABLE','FABRICATED','NOT_APPLICABLE')
);
ALTER TABLE assertions DROP CONSTRAINT assertions_verification_state_check;
ALTER TABLE assertions ADD CONSTRAINT assertions_verification_state_check CHECK (
  verification_state IN ('VERIFIED','OVERSTATED','MISCITED','UNSUPPORTED','CONTRADICTED','STALE','UNVERIFIABLE','FABRICATED','NOT_APPLICABLE')
);
-- Intentionally do not rewrite prior run results or their recorded counters.
COMMIT;
