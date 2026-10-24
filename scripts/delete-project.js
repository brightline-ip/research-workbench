// Operator command: permanently delete one project's database rows and stored report files.
//   npm run delete-project -- <project-id>          (shows what would be deleted)
//   npm run delete-project -- <project-id> --yes    (deletes)
// Acquired sources in the shared source warehouse are content-addressed and may be used by other
// projects, so they are kept (see docs/OPERATIONS.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deleteProject(pool, { projectStorageRoot }, projectId, { confirm = false } = {}) {
  if (!UUID.test(String(projectId || ''))) throw new Error('A project id (UUID) is required.');
  const { rows: [project] } = await pool.query('SELECT project_id,title FROM projects WHERE project_id=$1', [projectId]);
  if (!project) throw new Error('Project not found.');
  const directory = path.join(path.resolve(projectStorageRoot), projectId.toLowerCase());
  if (!confirm) return { project, deleted: false, directory };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // These two tables reference the project without ON DELETE CASCADE.
    await client.query('DELETE FROM checkpoint_requests WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM operation_requests WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM projects WHERE project_id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  // Files go only after the database commit succeeded.
  await fs.rm(directory, { recursive: true, force: true });
  return { project, deleted: true, directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: pg } = await import('pg');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const id = process.argv[2], confirm = process.argv.includes('--yes');
  const pool = new pg.Pool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg);
  try {
    const result = await deleteProject(pool, config, id, { confirm });
    console.log(result.deleted ? `Deleted project "${result.project.title}" and ${result.directory}.` : `Would delete project "${result.project.title}" and ${result.directory}. Re-run with --yes to delete permanently.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
