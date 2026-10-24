import fs from 'node:fs/promises';
import path from 'node:path';

export async function migrate(pool, directory = new URL('../db/migrations/', import.meta.url)) {
  const client=await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727401, 1)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for(const file of (await fs.readdir(directory)).filter(f=>f.endsWith('.sql')).sort()) {
      const version=path.basename(file,'.sql');
      if((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version])).rowCount)continue;
      const sql=(await fs.readFile(new URL(file,directory),'utf8')).replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.query('SELECT pg_advisory_unlock(727401, 1)').catch(()=>{}); client.release(); }
}
