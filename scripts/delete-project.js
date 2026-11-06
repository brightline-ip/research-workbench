// Operator command: permanently delete one project: its database rows, its report files, and every stored source
// that no other project uses.
//   npm run delete-project -- <project-id>          (shows what would be deleted)
//   npm run delete-project -- <project-id> --yes    (deletes)
// Sources another project still refers to are kept untouched (see docs/OPERATIONS.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sources this project touched and no other project refers to in any way.
const SOURCES_ONLY_HERE = `WITH mine AS (
    SELECT source_id FROM project_sources WHERE project_id=$1
    UNION SELECT r.source_id FROM assertion_source_relationships r JOIN assertions a USING(assertion_id) WHERE a.project_id=$1
    UNION SELECT d.source_id FROM discovery_candidates d JOIN discovery_runs dr USING(discovery_run_id) WHERE dr.project_id=$1 AND d.source_id IS NOT NULL
    UNION SELECT source_id FROM source_access_attempts WHERE project_id=$1 AND source_id IS NOT NULL
    UNION SELECT css.source_id FROM corpus_snapshot_sources css JOIN corpus_snapshots cs USING(corpus_snapshot_id) WHERE cs.project_id=$1
  )
  SELECT s.source_id,s.original_storage_path,s.normalized_storage_path FROM sources s JOIN mine USING(source_id)
  WHERE NOT EXISTS(SELECT 1 FROM project_sources o WHERE o.source_id=s.source_id AND o.project_id<>$1)
    AND NOT EXISTS(SELECT 1 FROM assertion_source_relationships r JOIN assertions a USING(assertion_id) WHERE r.source_id=s.source_id AND a.project_id<>$1)
    AND NOT EXISTS(SELECT 1 FROM corpus_snapshot_sources css JOIN corpus_snapshots cs USING(corpus_snapshot_id) WHERE css.source_id=s.source_id AND cs.project_id<>$1)
    AND NOT EXISTS(SELECT 1 FROM evidence_passages ep JOIN corpus_snapshots cs USING(corpus_snapshot_id) WHERE ep.source_id=s.source_id AND cs.project_id<>$1)
    AND NOT EXISTS(SELECT 1 FROM verification_results vr JOIN verification_runs v USING(verification_run_id) WHERE vr.source_id=s.source_id AND v.project_id<>$1)`;

// Explicit order, children first: these rows sit behind RESTRICT keys and sealed-evidence triggers that a plain cascade cannot pass.
const DELETES = [
  'DELETE FROM reconciliation_runs WHERE adversarial_run_id IN (SELECT adversarial_run_id FROM adversarial_runs WHERE project_id=$1)',
  'DELETE FROM red_team_runs WHERE adversarial_run_id IN (SELECT adversarial_run_id FROM adversarial_runs WHERE project_id=$1)',
  'DELETE FROM adversarial_runs WHERE project_id=$1',
  'DELETE FROM revision_runs WHERE project_id=$1',
  'DELETE FROM analysis_runs WHERE project_id=$1',
  'DELETE FROM verification_results WHERE verification_run_id IN (SELECT verification_run_id FROM verification_runs WHERE project_id=$1)',
  'DELETE FROM verification_runs WHERE project_id=$1',
  'DELETE FROM evidence_passages WHERE corpus_snapshot_id IN (SELECT corpus_snapshot_id FROM corpus_snapshots WHERE project_id=$1)',
  'DELETE FROM corpus_snapshot_sources WHERE corpus_snapshot_id IN (SELECT corpus_snapshot_id FROM corpus_snapshots WHERE project_id=$1)',
  'DELETE FROM corpus_snapshots WHERE project_id=$1',
  // These two tables reference the project without ON DELETE CASCADE.
  'DELETE FROM checkpoint_requests WHERE project_id=$1',
  'DELETE FROM operation_requests WHERE project_id=$1',
  'DELETE FROM projects WHERE project_id=$1',
];
const RUNNING = ['assertion_extraction_runs', 'discovery_runs', 'verification_runs', 'adversarial_runs', 'revision_runs'].map(table => `SELECT 1 FROM ${table} WHERE project_id=$1 AND status='RUNNING'`).join(' UNION ALL ');

async function removeFiles(root, keys) {
  const failed = [];
  if (!keys.length) return failed;
  if (!root) return keys;
  const base = path.resolve(root);
  for (const key of keys) {
    const target = path.resolve(base, key);
    if (!target.startsWith(base + path.sep)) { failed.push(key); continue; }
    try {
      await fs.rm(target, { force: true, maxRetries: 3 });
      // Remove folders left empty, stopping at the first one still in use.
      for (let folder = path.dirname(target); folder.startsWith(base + path.sep); folder = path.dirname(folder)) await fs.rmdir(folder);
    } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT', 'EPERM'].includes(error.code) || error.path === target) failed.push(key); }
  }
  return failed;
}

export async function deleteProject(pool, { projectStorageRoot, sourceStorageRoot }, projectId, { confirm = false } = {}) {
  if (!UUID.test(String(projectId || ''))) throw new Error('A project id (UUID) is required.');
  const { rows: [project] } = await pool.query('SELECT project_id,title FROM projects WHERE project_id=$1', [projectId]);
  if (!project) throw new Error('Project not found.');
  const directory = path.join(path.resolve(projectStorageRoot), projectId.toLowerCase());
  if (!confirm) return { project, deleted: false, directory, sources_only_in_this_project: (await pool.query(SOURCES_ONLY_HERE, [projectId])).rows.length };
  const client = await pool.connect();
  let sourceFiles = [];
  let sourcesDeleted = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [projectId]);
    if ((await client.query(RUNNING, [projectId])).rows.length) throw new Error('An operation is still running on this project. Wait for it to finish; if the app stopped, start it once so interrupted runs are closed, then retry.');
    // Lifts the sealed-evidence triggers for this one project until this transaction ends (migration 016).
    await client.query("SELECT set_config('rw.deleting_project',$1,true)", [projectId.toLowerCase()]);
    const { rows: sources } = await client.query(SOURCES_ONLY_HERE, [projectId]);
    const sourceIds = sources.map(source => source.source_id);
    for (const sql of DELETES) await client.query(sql, [projectId]);
    if (sourceIds.length) {
      const { rows: versions } = await client.query('DELETE FROM source_versions WHERE source_id=ANY($1::uuid[]) RETURNING original_storage_path,normalized_storage_path', [sourceIds]);
      await client.query('DELETE FROM sources WHERE source_id=ANY($1::uuid[])', [sourceIds]);
      sourcesDeleted = sourceIds.length;
      const keys = [...new Set([...sources, ...versions].flatMap(row => [row.original_storage_path, row.normalized_storage_path]).filter(Boolean))];
      // A file stays if any remaining row still points at it.
      const { rows: stillUsed } = await client.query(`SELECT original_storage_path AS key FROM sources WHERE original_storage_path=ANY($1) UNION SELECT normalized_storage_path FROM sources WHERE normalized_storage_path=ANY($1)
        UNION SELECT original_storage_path FROM source_versions WHERE original_storage_path=ANY($1) UNION SELECT normalized_storage_path FROM source_versions WHERE normalized_storage_path=ANY($1)`, [keys]);
      const kept = new Set(stillUsed.map(row => row.key));
      sourceFiles = keys.filter(key => !kept.has(key));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  // Files go only after the database commit succeeded.
  await fs.rm(directory, { recursive: true, force: true });
  const file_errors = await removeFiles(sourceStorageRoot, sourceFiles);
  return { project, deleted: true, directory, sources_deleted: sourcesDeleted, source_files_deleted: sourceFiles.length - file_errors.length, file_errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: pg } = await import('pg');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const id = process.argv[2], confirm = process.argv.includes('--yes');
  const pool = new pg.Pool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg);
  try {
    const result = await deleteProject(pool, config, id, { confirm });
    if (!result.deleted) console.log(`Would delete project "${result.project.title}", ${result.directory}, and ${result.sources_only_in_this_project} stored source(s) no other project uses. Re-run with --yes to delete permanently.`);
    else {
      console.log(`Deleted project "${result.project.title}", ${result.directory}, ${result.sources_deleted} source(s) no other project uses and ${result.source_files_deleted} stored file(s).`);
      if (result.file_errors.length) { console.error(`These stored files could not be removed; delete them by hand: ${result.file_errors.join(', ')}`); process.exitCode = 1; }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
