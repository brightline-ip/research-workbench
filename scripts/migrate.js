import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrations.js';
const config=loadConfig();
const pool=new pg.Pool(config.databaseUrl?{connectionString:config.databaseUrl}:config.pg);
try { await migrate(pool); console.log('Migrations complete.'); }
catch { console.error('Migration failed; the current migration was rolled back. Check database connectivity, role permissions, and schema compatibility.'); process.exitCode=1; }
finally { await pool.end(); }
