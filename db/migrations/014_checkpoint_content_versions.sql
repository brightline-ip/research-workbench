BEGIN;
-- A checkpoint is a versioned save, not content deduplication. Explicit manual
-- saves and distinct request keys may share text while preserving title,
-- provenance and parent history. Exact retry deduplication belongs to 013's
-- checkpoint_requests; (project_id, version_number) remains unique.
ALTER TABLE article_versions
  DROP CONSTRAINT article_versions_project_id_content_hash_key;
CREATE INDEX article_versions_project_content_hash_idx
  ON article_versions(project_id, content_hash);
COMMIT;
