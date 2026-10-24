import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../src/app.js';

async function withServer(fn) {
  const calls = [];
  const repo = {
    listProjects: async () => [{ project_id: '1', title: 'Test' }],
    createProject: async b => (calls.push(['create', b]), { project_id: '1', ...b }),
    getWorkspace: async id => id === 'missing' ? null : { project: { project_id: id }, articles: [], messages: [] },
    createDraft: async (id, instruction) => (calls.push(['draft', id, instruction]), { version: { version_number: 1 } }),
    saveCheckpoint: async (id, body) => (calls.push(['checkpoint', id, body]), { version_number: 2 }),
    extractAssertions: async (id, version,_orchestrator,_model,scope) => (calls.push(['assertions', id, version,scope]), { run: { coverage_complete: true }, assertions: [] })
    ,reviewAssertions: async(id,version,decisions)=>(calls.push(['review',id,version,decisions]),{article_version_id:version,decisions})
    ,registerSource: async (id, body) => (calls.push(['source', id, body]), { source_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
    ,acquireRegisteredSource: async (id, source, acquisition, root) => (calls.push(['acquire', id, source, Boolean(acquisition), root]), { source: { source_id: source } })
  };
  const verificationService={run:async(id,version,mode)=>(calls.push(['verify',id,version,mode]),{run:{status:'COMPLETE'},results:[]})};
  const discoveryService={run:async(id,version,policy)=>(calls.push(['discover',id,version,policy]),{run:{status:'COMPLETE'},snapshot:{status:'SEALED',source_count:1}}),estimate:async(id,version)=>(calls.push(['estimate',id,version]),{planned_groups:4,max_external_queries:4,estimated_runtime_minutes_low:2,estimated_runtime_minutes_high:6})};
  const articleImportService={import:async(id,input)=>(calls.push(['import',id,input.filename,input.data.toString()]),{version:{version_number:1}})};
  const adversarialService={run:async(id,version,run)=>(calls.push(['adversarial',id,version,run]),{run:{status:'COMPLETE'}}),resume:async(id,run)=>(calls.push(['resume-adversarial',id,run]),{run:{status:'COMPLETE'}})};
  const corpusImportService={import:async(id,body)=>(calls.push(['corpus-import',id,body]),{source:{source_id:'source-1'}})};
  const server = http.createServer(createHandler(repo, {}, { acquireSource: async () => ({}), sourceStorageRoot: '/storage', verificationService, discoveryService, articleImportService,adversarialService,corpusImportService }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, calls); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('project API creates and reloads state', () => withServer(async (base, calls) => {
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Project', topic: 'Topic' }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).project_id, '1');
  const loaded = await fetch(`${base}/api/projects/1`);
  assert.equal(loaded.status, 200);
  assert.deepEqual(calls[0], ['create', { title: 'Project', topic: 'Topic' }]);
}));

test('verification API binds a run to article version and mode', () => withServer(async (base,calls)=>{
  const response=await fetch(`${base}/api/projects/1/verify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'version-1',mode:'AUTHOR_CORPUS'})});
  assert.equal(response.status,201);assert.deepEqual(calls[0],['verify','1','version-1','AUTHOR_CORPUS']);
}));

test('discovery API builds and seals a corpus for an explicit article version', () => withServer(async (base,calls)=>{
  const response=await fetch(`${base}/api/projects/1/discover`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'version-1',policy:{warehouse_first:true}})});
  assert.equal(response.status,201);assert.deepEqual(calls[0],['discover','1','version-1',{warehouse_first:true}]);
  assert.equal((await response.json()).snapshot.status,'SEALED');
}));

test('discovery preflight returns query and runtime estimates without starting a run',()=>withServer(async(base,calls)=>{const response=await fetch(`${base}/api/projects/1/discovery-estimate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'version-1'})});assert.equal(response.status,200);const body=await response.json();assert.equal(body.estimated_runtime_minutes_high,6);assert.deepEqual(calls[0],['estimate','1','version-1'])}));

test('adversarial API binds independent validation to the author run',()=>withServer(async(base,calls)=>{const response=await fetch(`${base}/api/projects/1/adversarial`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'v1',author_verification_run_id:'author-1'})});assert.equal(response.status,201);assert.deepEqual(calls[0],['adversarial','1','v1','author-1'])}));

test('source API registers and acquires a project source', () => withServer(async (base, calls) => {
  const registered = await fetch(`${base}/api/projects/1/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canonical_url: 'https://example.gov/report' }) });
  assert.equal(registered.status, 201);
  const acquired = await fetch(`${base}/api/projects/1/sources/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/acquire`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(acquired.status, 201);
  assert.equal(calls[0][0], 'source'); assert.equal(calls[1][0], 'acquire');
}));

test('assertion endpoint binds extraction to an explicit article version', () => withServer(async (base, calls) => {
  const scope={include_block_indexes:[2,4],exclude_sections:['Planning']};
  const response = await fetch(`${base}/api/projects/1/assertions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ article_version_id: 'version-1',scope }) });
  assert.equal(response.status, 201);
  assert.deepEqual(calls[0], ['assertions', '1', 'version-1',scope]);
}));

test('bridge APIs route explicit assertion review and exact corpus document import',()=>withServer(async(base,calls)=>{
  const decisions=[{assertion_id:'a',verification_scope:'EXCLUDED',reason:'Planning'}];
  const reviewed=await fetch(`${base}/api/projects/1/assertions-review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'v1',decisions})});
  assert.equal(reviewed.status,200);
  const imported=await fetch(`${base}/api/projects/1/corpus-import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({collection:'legal',document_id:'a'.repeat(64),assertion_links:[]})});
  assert.equal(imported.status,201);
  assert.deepEqual(calls[0],['review','1','v1',decisions]);assert.equal(calls[1][0],'corpus-import');
}));

test('checkpoint endpoint preserves versioning through repository boundary', () => withServer(async (base, calls) => {
  const response = await fetch(`${base}/api/projects/1/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Article', content_markdown: '# Revised' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).version_number, 2);
  assert.equal(calls[0][0], 'checkpoint');
}));

test('article import endpoint accepts a raw supported document', () => withServer(async (base,calls)=>{
  const response=await fetch(`${base}/api/projects/1/import?filename=article.md`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:'# Article'});
  assert.equal(response.status,201);assert.deepEqual(calls[0],['import','1','article.md','# Article']);
}));
