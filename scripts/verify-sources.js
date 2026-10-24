import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/repository.js';
import { acquireSource } from '../src/source-acquisition.js';

const config = loadConfig();
const pool = new pg.Pool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg);
const repository = new Repository(pool);
const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-warehouse-'));
const body = '<!doctype html><article><h1>Controlled authority</h1><p>The official value is 42.</p></article>';
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const projects = [];
const sourceIds = new Set();
try {
  projects.push(await repository.createProject({ title: 'Source integration A', topic: 'Controlled' }));
  projects.push(await repository.createProject({ title: 'Source integration B', topic: 'Controlled' }));
  const version = await repository.saveCheckpoint(projects[0].project_id, { title: 'Controlled article', content_markdown: 'The official value is 42.' });
  const extraction = await repository.extractAssertions(projects[0].project_id, version.article_version_id, { extractAssertions: async () => ({ coverage_complete: true, coverage_notes: 'Complete.', assertions: [{ block_index: 0, evidence_span: 'The official value is 42.', assertion_text: 'The official value is 42.', normalized_proposition: 'official value = 42', assertion_class: 'QUANTITATIVE', load_bearing: true, load_bearing_reason: 'Central tested value.', citation_as_written: null, source_required: true, primary_source_required: true }] }) }, 'CONTROLLED_TEST');
  const candidateA = await repository.registerSource(projects[0].project_id, { canonical_url: `http://127.0.0.1:${port}/authority-a?utm_source=test`, title: 'Controlled authority', source_type: 'AGENCY_DOCUMENT', assertion_id: extraction.assertions[0].assertion_id, relationship_type: 'SUPPORTS', proposition_source_class: 'PRIMARY', classification_reason: 'The issuing authority directly reports the tested value.' });
  const acquiredA = await repository.acquireRegisteredSource(projects[0].project_id, candidateA.source_id, (url, options) => acquireSource(url, { ...options, allowPrivate: true }), storageRoot);
  sourceIds.add(acquiredA.source.source_id);
  const candidateB = await repository.registerSource(projects[1].project_id, { canonical_url: `http://127.0.0.1:${port}/authority-b`, title: 'Duplicate route', source_type: 'AGENCY_DOCUMENT' });
  sourceIds.add(candidateB.source_id);
  const acquiredB = await repository.acquireRegisteredSource(projects[1].project_id, candidateB.source_id, (url, options) => acquireSource(url, { ...options, allowPrivate: true }), storageRoot);
  sourceIds.add(acquiredB.source.source_id);
  const workspaceA = await repository.getWorkspace(projects[0].project_id);
  const workspaceB = await repository.getWorkspace(projects[1].project_id);
  const normalized = await fs.readFile(path.join(storageRoot, acquiredA.source.normalized_storage_path), 'utf8');
  const { rows: [counts] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM sources WHERE content_hash=$1) AS warehouse_copies,
    (SELECT count(*)::int FROM project_sources WHERE source_id=$2) AS project_memberships,
    (SELECT count(*)::int FROM source_access_attempts WHERE source_id=$2 AND result='SUCCESS') AS successful_accesses,
    (SELECT count(*)::int FROM assertion_source_relationships WHERE source_id=$2 AND proposition_source_class='PRIMARY' AND relationship_type='SUPPORTS') AS proposition_relationships`, [acquiredA.source.content_hash, acquiredA.source.source_id]);
  const valid = acquiredA.source.retrieval_status === 'NORMALIZED' && acquiredB.deduplicated && acquiredA.source.source_id === acquiredB.source.source_id && counts.warehouse_copies === 1 && counts.project_memberships === 2 && counts.successful_accesses === 2 && counts.proposition_relationships === 1 && workspaceA.sources.length === 1 && workspaceB.sources.length === 1 && normalized.includes('The official value is 42.');
  if (!valid) throw new Error(`Source warehouse invariants failed: ${JSON.stringify(counts)}`);
  console.log(JSON.stringify({ status: 'SOURCE_WAREHOUSE_OK', actual_http_acquisition: true, original_preserved: true, normalized_text: true, warehouse_copies: counts.warehouse_copies, project_memberships: counts.project_memberships, access_attempts: counts.successful_accesses, proposition_specific_relationships: counts.proposition_relationships, content_deduplicated: true }));
} finally {
  for (const project of projects) await pool.query('DELETE FROM projects WHERE project_id=$1', [project.project_id]).catch(() => {});
  for (const sourceId of sourceIds) await pool.query('DELETE FROM sources WHERE source_id=$1', [sourceId]).catch(() => {});
  await pool.end(); await new Promise(resolve => server.close(resolve)); await fs.rm(storageRoot, { recursive: true, force: true });
}
