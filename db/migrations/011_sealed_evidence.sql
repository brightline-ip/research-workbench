BEGIN;
CREATE TABLE source_versions (
  source_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  identity_hash TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  normalized_content_hash TEXT,
  original_storage_path TEXT NOT NULL,
  normalized_storage_path TEXT,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE corpus_snapshots ADD COLUMN evidence_manifest JSONB;
ALTER TABLE corpus_snapshots ADD COLUMN evidence_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE corpus_snapshot_sources ADD COLUMN source_version_id UUID REFERENCES source_versions(source_version_id) ON DELETE RESTRICT;
CREATE TABLE evidence_passages (
  evidence_passage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corpus_snapshot_id UUID NOT NULL REFERENCES corpus_snapshots(corpus_snapshot_id) ON DELETE RESTRICT,
  source_version_id UUID NOT NULL REFERENCES source_versions(source_version_id) ON DELETE RESTRICT,
  source_id UUID NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL,
  normalized_start_offset INTEGER NOT NULL,
  normalized_end_offset INTEGER NOT NULL,
  locator TEXT NOT NULL,
  passage_text TEXT NOT NULL,
  passage_hash TEXT NOT NULL,
  UNIQUE(corpus_snapshot_id,source_version_id,sequence_number)
);
ALTER TABLE verification_runs ADD COLUMN corpus_snapshot_id UUID REFERENCES corpus_snapshots(corpus_snapshot_id) ON DELETE RESTRICT;
ALTER TABLE verification_results ADD COLUMN evidence_passage_id UUID REFERENCES evidence_passages(evidence_passage_id) ON DELETE RESTRICT;
CREATE INDEX evidence_passages_snapshot_idx ON evidence_passages(corpus_snapshot_id);
CREATE FUNCTION protect_sealed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sealed evidence is immutable; create a new version';
END; $$;
CREATE TRIGGER source_versions_immutable BEFORE UPDATE OR DELETE ON source_versions FOR EACH ROW EXECUTE FUNCTION protect_sealed_evidence();
CREATE TRIGGER evidence_passages_immutable BEFORE UPDATE OR DELETE ON evidence_passages FOR EACH ROW EXECUTE FUNCTION protect_sealed_evidence();
CREATE FUNCTION protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence_schema_version=2 AND OLD.status='SEALED' THEN
    RAISE EXCEPTION 'Sealed evidence snapshot is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER corpus_snapshot_immutable BEFORE UPDATE OR DELETE ON corpus_snapshots FOR EACH ROW EXECUTE FUNCTION protect_snapshot();
CREATE FUNCTION protect_snapshot_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=OLD.corpus_snapshot_id AND evidence_schema_version=2 AND status='SEALED') THEN
    RAISE EXCEPTION 'Sealed snapshot membership is immutable';
  END IF;
  IF TG_OP IN ('UPDATE','INSERT') AND EXISTS(SELECT 1 FROM corpus_snapshots WHERE corpus_snapshot_id=NEW.corpus_snapshot_id AND evidence_schema_version=2 AND status='SEALED') THEN
    RAISE EXCEPTION 'Cannot append to sealed snapshot';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER snapshot_members_immutable BEFORE INSERT OR UPDATE OR DELETE ON corpus_snapshot_sources FOR EACH ROW EXECUTE FUNCTION protect_snapshot_members();
CREATE TRIGGER snapshot_passages_closed BEFORE INSERT ON evidence_passages FOR EACH ROW EXECUTE FUNCTION protect_snapshot_members();
ALTER TABLE article_versions ADD COLUMN import_metadata JSONB;
COMMIT;
