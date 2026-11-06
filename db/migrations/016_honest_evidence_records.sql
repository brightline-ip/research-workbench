BEGIN;
-- Who classed a source for a claim: MODEL (classification or discovery model), CALLER (a person or client program
-- through the API or page), DEFAULT (code fallback for a reused source never assessed), UNKNOWN (linked before this column).
ALTER TABLE assertion_source_relationships ADD COLUMN class_assigned_by TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(class_assigned_by IN('MODEL','CALLER','DEFAULT','UNKNOWN'));
-- What each result actually examined. NULL means the run predates these columns.
ALTER TABLE verification_results ADD COLUMN candidate_passage_ids UUID[];
ALTER TABLE verification_results ADD COLUMN candidate_passage_count INTEGER;
ALTER TABLE verification_results ADD COLUMN not_checked_reason TEXT CHECK(not_checked_reason IN('NO_SOURCES','NO_ELIGIBLE_SOURCE','SOURCES_UNAVAILABLE','NO_MATCHING_PASSAGE','INVALID_MODEL_REPLY'));
ALTER TABLE verification_results ADD COLUMN source_class TEXT;
ALTER TABLE verification_results ADD COLUMN source_class_assigned_by TEXT;
-- Sources the run could not use, kept on the run so they cannot silently vanish.
ALTER TABLE verification_runs ADD COLUMN evidence_gaps JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE discovery_runs ADD COLUMN source_failures INTEGER NOT NULL DEFAULT 0;

-- Sealed evidence stays immutable. The only exception is scripts/delete-project.js, which names one project for its
-- own transaction (set_config(..., true) ends with the transaction); rows of every other project keep the protection.
-- This guards against mistakes in application code, not against a database owner, who can drop triggers anyway.
CREATE FUNCTION project_deletion_authorized(project UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT project IS NOT NULL AND current_setting('rw.deleting_project', true) = project::text
$$;
CREATE OR REPLACE FUNCTION protect_sealed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='evidence_passages' THEN
      IF EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=OLD.corpus_snapshot_id AND project_deletion_authorized(project_id)) THEN RETURN OLD; END IF;
    -- A source version can be shared, so it may go only during a project delete; the RESTRICT foreign keys still
    -- refuse the delete if any other snapshot refers to it.
    ELSIF coalesce(current_setting('rw.deleting_project', true),'')<>'' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Sealed evidence is immutable; create a new version';
END; $$;
CREATE OR REPLACE FUNCTION protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND project_deletion_authorized(OLD.project_id) THEN RETURN OLD; END IF;
  IF OLD.evidence_schema_version=2 AND OLD.status='SEALED' THEN
    RAISE EXCEPTION 'Sealed evidence snapshot is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION protect_snapshot_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=OLD.corpus_snapshot_id AND project_deletion_authorized(project_id)) THEN RETURN OLD; END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=OLD.corpus_snapshot_id AND evidence_schema_version=2 AND status='SEALED') THEN
    RAISE EXCEPTION 'Sealed snapshot membership is immutable';
  END IF;
  IF TG_OP IN ('UPDATE','INSERT') AND EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=NEW.corpus_snapshot_id AND evidence_schema_version=2 AND status='SEALED') THEN
    RAISE EXCEPTION 'Cannot append to sealed snapshot';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
COMMIT;
