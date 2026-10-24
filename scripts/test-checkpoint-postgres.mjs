// Opt-in, synthetic-only integration test. No production config or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import pg from 'pg';
import {migrate} from '../src/migrations.js';
import {Repository} from '../src/repository.js';
import http from 'node:http';
import {createHandler} from '../src/app.js';

// Maintainer harness. Requires Docker and two images already present locally (it never pulls):
//   CHECKPOINT_DB_IMAGE   image ID of a PostgreSQL 16 image (for example the one docker-compose.yml pins)
//   CHECKPOINT_APP_IMAGE  image ID of this application built from the Dockerfile
// Usage: CHECKPOINT_DB_IMAGE=sha256:... CHECKPOINT_APP_IMAGE=sha256:... node scripts/test-checkpoint-postgres.mjs --isolated
const dbImage=process.env.CHECKPOINT_DB_IMAGE||'';
const appImage=process.env.CHECKPOINT_APP_IMAGE||'';
const sha=x=>createHash('sha256').update(x).digest('hex');

async function inside(phase) {
  assert.equal(process.env.CHECKPOINT_FIXTURE,'1');assert.equal(process.platform,'linux');
  assert.ok(['prepare','reopen','restore'].includes(phase));
  const database=phase==='restore'?'rvw_checkpoint_restored':'rvw_checkpoint_fixture';
  const pool=new pg.Pool({host:'127.0.0.1',port:5432,database,user:'postgres',max:8,connectionTimeoutMillis:3000,statement_timeout:10000});
  const dir=new URL('../db/migrations/',import.meta.url),files=(await fs.readdir(dir)).filter(x=>x.endsWith('.sql')).sort();
  const r=new Repository(pool),data={title:'Synthetic checkpoint',content_markdown:'Synthetic public draft; no legal assertions.'};
  const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
    if(phase==='prepare') {
      const base=await fs.mkdtemp(path.join(os.tmpdir(),'checkpoint-migrations-'));
      for(const f of files.filter(x=>x<'013_'))await fs.copyFile(new URL(f,dir),path.join(base,f));
      await migrate(pool,pathToFileURL(base+'/'));
      assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,12);
      const legacy=await r.createProject({title:'Synthetic pre-migration project'});
      const original=await r.saveCheckpoint(legacy.project_id,{title:'Pre-migration draft',content_markdown:'Preserve this synthetic pre-migration draft.'});
      await Promise.all([migrate(pool),migrate(pool)]);
      assert.deepEqual((await pool.query('SELECT * FROM article_versions WHERE article_version_id=$1',[original.article_version_id])).rows[0],original);
      assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,files.length);
      console.log('PASS upgrade from 12 with existing rows and concurrent migration replay');
      const broken=path.join(base,'failure');await fs.mkdir(broken);
      await fs.writeFile(path.join(broken,'999_fixture_failure.sql'),'BEGIN; CREATE TABLE checkpoint_should_rollback(id int); SELECT checkpoint_missing_function(); COMMIT;');
      await assert.rejects(migrate(pool,pathToFileURL(broken+'/')));
      assert.equal((await pool.query("SELECT to_regclass('checkpoint_should_rollback') AS name")).rows[0].name,null);
      assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE version='999_fixture_failure'")).rowCount,0);
      console.log('PASS failed migration rolls back DDL and ledger together');
      const project=await r.createProject({title:'Synthetic replay project'});
      const results=await Promise.all(Array.from({length:6},()=>r.saveCheckpoint(project.project_id,data,null,key)));
      assert.equal(new Set(results.map(x=>x.article_version_id)).size,1);
      assert.equal((await pool.query('SELECT * FROM article_versions WHERE project_id=$1',[project.project_id])).rowCount,1);
      await assert.rejects(r.saveCheckpoint(project.project_id,{...data,title:'Changed'},null,key),e=>e.statusCode===409);
      await assert.rejects(r.saveCheckpoint(project.project_id,{...data,source_content_sha256:'0'.repeat(64)},null,randomUUID()),e=>e.statusCode===400);
      console.log('PASS concurrent exact replay returns one version; conflicts and bad hash rejected');
      const other=await r.createProject({title:'Synthetic other project'}),raceKey=randomUUID();
      const race=await Promise.allSettled([r.saveCheckpoint(project.project_id,{...data,content_markdown:'Cross-project race A'},null,raceKey),r.saveCheckpoint(other.project_id,{...data,content_markdown:'Cross-project race B'},null,raceKey)]);
      assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(race.find(x=>x.status==='rejected').reason.statusCode,409);
      assert.equal((await pool.query("SELECT * FROM article_versions WHERE content_markdown LIKE 'Cross-project race %'")).rowCount,1);
      console.log('PASS cross-project key race rolls back losing version');
      const manual1=await r.saveCheckpoint(project.project_id,data),manual2=await r.saveCheckpoint(project.project_id,data);
      assert.notEqual(manual1.article_version_id,manual2.article_version_id);
      assert.equal(manual2.version_number,manual1.version_number+1);
      assert.equal(manual2.parent_version_id,manual1.article_version_id);
      assert.equal((await r.saveCheckpoint(project.project_id,data,null,key)).article_version_id,results[0].article_version_id);
      console.log('PASS manual repeated content creates versions; keyed retry still returns original');
      const server=http.createServer(createHandler(r,{}));
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try {
        const httpKey=randomUUID(),url=`http://127.0.0.1:${server.address().port}/api/projects/${project.project_id}/checkpoint`;
        const post=body=>fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':httpKey},body:JSON.stringify(body)});
        const first=await post(data);assert.equal(first.status,201);const firstBody=await first.json();
        const second=await post(data);assert.equal(second.status,201);assert.deepEqual(await second.json(),firstBody);
        const conflict=await post({...data,title:'Different title'});assert.equal(conflict.status,409);await conflict.arrayBuffer();
        assert.notEqual(firstBody.article_version_id,manual2.article_version_id);
        console.log('PASS actual HTTP checkpoint route preserves distinct request and retry semantics');
      } finally {await new Promise(resolve=>server.close(resolve));}
      await fs.rm(base,{recursive:true,force:true});
    } else {
      await migrate(pool);
      const {rows:[receipt]}=await pool.query('SELECT * FROM checkpoint_requests WHERE request_key=$1',[key]);assert.ok(receipt);
      const count=(await pool.query('SELECT count(*)::int n FROM article_versions')).rows[0].n;
      const accepted=await r.saveCheckpoint(receipt.project_id,data,null,key);
      assert.equal(accepted.article_version_id,receipt.article_version_id);assert.equal(accepted.content_hash,sha(data.content_markdown));
      assert.equal((await pool.query('SELECT count(*)::int n FROM article_versions')).rows[0].n,count);
      assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,files.length);
      console.log('PASS '+phase+' retains checkpoint receipt and version; replay makes no insert');
    }
    const snapshot={};for(const [table,order] of [['schema_migrations','version'],['projects','project_id'],['article_versions','article_version_id'],['checkpoint_requests','request_key']])snapshot[table]=(await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
    console.log('CHECKPOINT_PHASE '+JSON.stringify({phase,status:'PASSED',migrations:files.length,postgres:(await pool.query('SHOW server_version')).rows[0].server_version,node:process.version,snapshot_sha256:sha(JSON.stringify(snapshot))}));
  } finally {await pool.end();}
}

async function isolated() {
  if(!/^sha256:[a-f0-9]{64}$/.test(dbImage)||!/^sha256:[a-f0-9]{64}$/.test(appImage))throw Error('Set CHECKPOINT_DB_IMAGE and CHECKPOINT_APP_IMAGE to local image IDs (sha256:...).');
  const root=fileURLToPath(new URL('../',import.meta.url)),suffix=randomUUID(),name='rvw-checkpoint-'+suffix,volume=name+'-data';
  const docker=(args,extra={})=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,windowsHide:true,...extra});
  let volumeCreated=false,containerCreated=false;
  const phaseResults=[];let evidence;
  try {
    for(const image of [dbImage,appImage])assert.equal(JSON.parse(docker(['image','inspect',image]))[0].Id,image);
    docker(['volume','create','--label','rvw.checkpoint-fixture='+suffix,volume]);volumeCreated=true;
    docker(['run','-d','--name',name,'--label','rvw.checkpoint-fixture='+suffix,'--network','none','--read-only','--user','999:999','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=64m','--tmpfs','/var/run/postgresql:rw,nosuid,size=16m,uid=999,gid=999','--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB=rvw_checkpoint_fixture',dbImage]);containerCreated=true;
    const waitReady=async()=>{for(let i=0;i<60;i++){if(!JSON.parse(docker(['inspect',name]))[0].State.Running){const log=spawnSync('docker',['logs','--tail','30',name],{encoding:'utf8',windowsHide:true,timeout:10000});throw Error('Synthetic database stopped: '+log.stdout+log.stderr);}try{docker(['exec',name,'pg_isready','-U','postgres','-d','rvw_checkpoint_fixture'],{stdio:'pipe'});return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Synthetic database not ready');};
    await waitReady();
    const inspect=JSON.parse(docker(['inspect',name]))[0];assert.equal(inspect.HostConfig.NetworkMode,'none');assert.deepEqual(inspect.HostConfig.PortBindings,{});
    const run=phase=>{
      const output=docker(['run','--rm','--network','container:'+name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=64m,uid=1000,gid=1000','--env','CHECKPOINT_FIXTURE=1',...['src','public','db'].flatMap(part=>['--mount',`type=bind,source=${path.join(root,part)},target=/app/${part},readonly`]),'--mount',`type=bind,source=${fileURLToPath(import.meta.url)},target=/app/scripts/test-checkpoint-postgres.mjs,readonly`,'--entrypoint','node',appImage,'scripts/test-checkpoint-postgres.mjs','--inside',phase],{maxBuffer:2*1024*1024});
      process.stdout.write(output);const line=output.split('\n').find(x=>x.startsWith('CHECKPOINT_PHASE '));assert.ok(line);phaseResults.push(JSON.parse(line.slice(17)));
    };
    run('prepare');
    docker(['restart',name]);await waitReady();run('reopen');
    docker(['exec',name,'pg_dump','-U','postgres','--format=custom','--file=/tmp/checkpoint.dump','rvw_checkpoint_fixture']);
    docker(['exec',name,'createdb','-U','postgres','rvw_checkpoint_restored']);
    docker(['exec',name,'pg_restore','-U','postgres','--exit-on-error','--dbname=rvw_checkpoint_restored','/tmp/checkpoint.dump']);
    run('restore');
    assert.equal(new Set(phaseResults.map(x=>x.snapshot_sha256)).size,1,'Restart and restored checkpoint tables must exactly match');
    const migrationFiles=(await fs.readdir(new URL('../db/migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort();
    const hashes={};for(const file of migrationFiles)hashes[file]=sha(await fs.readFile(new URL('../db/migrations/'+file,import.meta.url)));
    evidence={status:'PASSED',db_image:dbImage,app_image:appImage,phases:phaseResults,migration_sha256:hashes,repository_sha256:sha(await fs.readFile(new URL('../src/repository.js',import.meta.url))),harness_sha256:sha(await fs.readFile(fileURLToPath(import.meta.url))),checked_at:new Date().toISOString()};
  } finally {
    // Delete only our labeled, exact generated container/volume, never a live target.
    if(containerCreated){const x=JSON.parse(docker(['inspect',name]))[0];assert.equal(x.Config.Labels['rvw.checkpoint-fixture'],suffix);docker(['rm','-f',name]);}
    if(volumeCreated){const x=JSON.parse(docker(['volume','inspect',volume]))[0];assert.equal(x.Labels['rvw.checkpoint-fixture'],suffix);docker(['volume','rm',volume]);}
  }
  evidence.fixture_cleanup_complete=true;
  console.log('CHECKPOINT_EVIDENCE '+JSON.stringify(evidence));
}
if(process.argv[2]==='--inside')await inside(process.argv[3]);
else if(process.argv[2]==='--isolated')await isolated();
else throw Error('Use --isolated; no live database option exists.');
