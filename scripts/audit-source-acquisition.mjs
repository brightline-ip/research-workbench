// Read-only audit. Run in the application's environment; credentials are never printed.
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Use the project root as the working directory, including when piped over stdin.
const { loadConfig } = await import(pathToFileURL(path.resolve('src/config.js')).href);

const config = loadConfig();
const pool = new pg.Pool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: projects } = await client.query('SELECT project_id,title FROM projects ORDER BY created_at');
  const { rows: sources } = await client.query(`SELECT s.*, ARRAY(SELECT ps.project_id FROM project_sources ps WHERE ps.source_id=s.source_id) AS project_ids,
    (SELECT count(*)::int FROM source_text_chunks c WHERE c.source_id=s.source_id) AS chunk_count,
    (SELECT count(DISTINCT r.assertion_id)::int FROM assertion_source_relationships r WHERE r.source_id=s.source_id) AS linked_assertions
    FROM sources s ORDER BY s.canonical_url`);
  const { rows: attempts } = await client.query('SELECT * FROM source_access_attempts ORDER BY attempt_timestamp');
  const { rows: candidateFailures } = await client.query(`SELECT project_id,source_id,candidate_url,candidate_title,disposition_reason,count(*)::int AS assertion_candidate_rows
    FROM discovery_candidates dc JOIN discovery_runs dr USING(discovery_run_id)
    WHERE disposition='ACQUISITION_FAILED' GROUP BY project_id,source_id,candidate_url,candidate_title,disposition_reason`);
  const { rows: discoveryRuns } = await client.query('SELECT discovery_run_id,project_id,status,created_at,completed_at,assertions_total,assertions_searched,external_candidates,primary_sources_acquired,error_message FROM discovery_runs ORDER BY created_at');
  const { rows: verificationRuns } = await client.query('SELECT verification_run_id,project_id,status,created_at,status_counts,source_acquisition_failures FROM verification_runs ORDER BY created_at');
  await client.query('COMMIT');
  const storageRoot = path.resolve(config.sourceStorageRoot);
  for (const source of sources) {
    source.file_audit = {};
    for (const [kind, key] of [['original',source.original_storage_path],['normalized',source.normalized_storage_path]]) {
      if (!key) continue;
      const full = path.resolve(storageRoot,key);
      if (!full.startsWith(storageRoot + path.sep)) { source.file_audit[kind] = {error:'Invalid storage path'}; continue; }
      try {
        const bytes = await fs.readFile(full);
        const item = {bytes:bytes.length,sha256:hash(bytes)};
        if (kind === 'original') item.matches_source_hash = item.sha256 === source.content_hash;
        if (kind === 'normalized') {
          const text = bytes.toString('utf8');
          item.characters = text.length;
          item.challenge_markers = [...text.matchAll(/.{0,60}(?:verify you are human|checking your browser|access denied|enable javascript and cookies|just a moment|captcha|request unsuccessful|incapsula incident|web access has been blocked).{0,100}/gi)].slice(0,5).map(m=>m[0]);
          if (item.challenge_markers.length || text.length < 300) item.preview = text.slice(0,500);
        }
        source.file_audit[kind] = item;
      } catch (error) { source.file_audit[kind] = {error:error.code || error.name}; }
    }
  }
  const codeHashes = {};
  for (const file of ['src/source-acquisition.js','src/discovery.js','src/verification.js','src/repository.js']) codeHashes[file] = hash(await fs.readFile(file));
  console.log(JSON.stringify({audited_at:new Date().toISOString(),projects,sources,attempts,candidateFailures,discoveryRuns,verificationRuns,codeHashes},null,2));
} finally { client.release(); await pool.end(); }
