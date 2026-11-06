import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { VerificationService } from '../src/verification.js';
import { chunkNormalizedText, isUnreadableText } from '../src/passages.js';
import { normalizeText } from '../src/source-acquisition.js';
import { readiness } from '../src/readiness.js';
import { createHandler, failureLogFields } from '../src/app.js';
import { buildReport, displayResult, needsAttention } from '../public/report-model.js';
import { revisionFindings } from '../src/revision-policy.js';
import { compare } from '../src/adversarial.js';
import { createOrchestrator } from '../src/orchestrator.js';
import { isPermanentProviderFailure } from '../src/safety.js';

const passage='A practitioner may limit the scope of the representation if the limitation is reasonable.';
const assertion=id=>({assertion_id:id,assertion_text:'A practitioner may limit the scope of the representation',assertion_class:'LEGAL_HOLDING',citation_as_written:null,primary_source_required:true,source_required:true});
function harness(ids){
  const saved=[],updates=[];
  const pool={async query(sql,args){
    if(/^SELECT \* FROM assertions/.test(sql))return{rows:ids.map(assertion)};
    if(/INSERT INTO verification_runs/.test(sql))return{rows:[{verification_run_id:'run'}]};
    if(/INSERT INTO verification_results/.test(sql)){saved.push({assertion_id:args[1],status:args[9]});return{rows:[saved.at(-1)]}}
    if(/UPDATE verification_runs/.test(sql)){updates.push(sql);if(/COMPLETE/.test(sql))return{rows:[{status:'COMPLETE',status_counts:args[5]}]}}
    return{rows:[]};
  }};
  const store={async seal(){return{corpus_snapshot_id:'c'}},async load(){return{
    manifest:{links:ids.map(assertion_id=>({assertion_id,source_id:'s',membership_status:'ACCEPTED',proposition_source_class:'PRIMARY',relationship_type:'SUPPORTS',retrieval_status:'NORMALIZED'})),versions:[{source_id:'s',source_version_id:'v',normalized_content_hash:'h',metadata:{title:'T'}}]},
    passages:[{source_id:'s',source_version_id:'v',passage_id:'p',sequence_number:0,locator:'normalized lines 1-1',passage_text:passage}]}}};
  return{pool,store,saved,updates};
}
const providerError=()=>Object.assign(new Error('Provider request failed'),{providerReason:'HTTP 503: adapter busy; retry later'});
const verified={source_id:'s',passage_id:'p',assertion_as_made:'x',source_actually_establishes:'x',material_gap:'',extracted_passage:passage,status:'VERIFIED',defect_codes:[],confidence:1,recommended_remediation:'none'};

test('a provider failure fails the run with its reason and saves no result for unchecked claims',async()=>{
  const {pool,store,saved,updates}=harness(['a','b','c','d']);let calls=0;
  const orchestrator={async verifyAssertion(){calls++;if(calls===2)throw providerError();return verified}};
  await assert.rejects(new VerificationService(pool,orchestrator,'/x','m',1,store).run('p','v'),error=>{
    assert.equal(error.statusCode,503);
    assert.match(error.publicMessage,/incomplete/);
    assert.match(error.publicMessage,/adapter busy/);
    return true;
  });
  assert.equal(calls,2,'no further claims are sent once the provider has failed');
  assert.deepEqual(saved.map(r=>r.status),['VERIFIED'],'no invented UNVERIFIABLE result');
  assert.ok(updates.some(sql=>/status='FAILED'/.test(sql)));
  assert.ok(!updates.some(sql=>/status='COMPLETE'/.test(sql)));
});

test('invalid model evidence is still a per-claim finding, not a run failure',async()=>{
  const {pool,store,saved}=harness(['a']);
  const orchestrator={async verifyAssertion(){return{...verified,extracted_passage:'text the source never says'}}};
  const {run}=await new VerificationService(pool,orchestrator,'/x','m',1,store).run('p','v');
  assert.equal(run.status,'COMPLETE');
  assert.deepEqual(saved.map(r=>r.status),['UNVERIFIABLE']);
});

test('old provider failures display as not checked and are counted apart',()=>{
  const old={assertion_id:'a',status:'UNVERIFIABLE',material_gap:'Verification output failed evidence validation: Provider request failed, timed out, or returned invalid data (HTTP 503: adapter busy; retry later).'};
  const real={assertion_id:'b',status:'UNVERIFIABLE',material_gap:'Evidence access or normalization was insufficient for a substantive determination.'};
  const shown=displayResult(assertion('a'),old);
  assert.equal(shown.status,'NOT_CHECKED');
  assert.equal(shown.original_status,'UNVERIFIABLE');
  assert.ok(needsAttention(shown));
  assert.equal(displayResult(assertion('b'),real).status,'UNVERIFIABLE');
  const {counts}=buildReport([assertion('a'),assertion('b')],[old,real]);
  assert.equal(counts.not_checked,1);
  assert.equal(counts.attention,1);
  assert.equal(counts.legacy_adjusted,0);
});

const pool={query:async()=>({rows:[]})};
const adapterConfig={orchestrationMode:'n8n',n8nWebhookUrl:'http://adapter.test:8790/v1/structured',n8nDiscoveryWebhookUrl:'http://adapter.test:8790/v1/discovery',n8nWebhookAuthHeader:'x',sourceStorageRoot:'.',projectStorageRoot:'.',operationLimits:{minFreeBytes:1}};
const check=(report,name)=>report.checks.find(item=>item.name===name);

test('readiness blocks when the gateway does not answer',async()=>{
  const report=await readiness(pool,adapterConfig,async()=>{throw new Error('ECONNREFUSED')});
  assert.equal(report.status,'BLOCKED');
  assert.equal(check(report,'draft_model').status,'BLOCKED');
  assert.equal(check(report,'autonomous_discovery').status,'BLOCKED');
  assert.match(check(report,'draft_model').detail,/not answering/);
});

test('readiness probes n8n on its own health route and makes no call in direct mode',async()=>{
  const n8n={...adapterConfig,n8nWebhookUrl:'http://n8n.test:5678/webhook/abc',n8nDiscoveryWebhookUrl:'http://n8n.test:5678/webhook/def'};
  const up=await readiness(pool,n8n,async url=>{assert.equal(url,'http://n8n.test:5678/healthz');return new Response('{}')});
  assert.equal(check(up,'draft_model').status,'READY');
  const direct=await readiness(pool,{...adapterConfig,orchestrationMode:'openai',openaiApiKey:'k'},async()=>{throw new Error('must not be called')});
  assert.equal(check(direct,'draft_model').status,'READY');
});

test('unreadable text is recognized and ordinary text is not',()=>{
  assert.ok(isUnreadableText('\u001f�\b\0\0\0\0\0\0\u0003��'+'x'.repeat(5000)),'gzip bytes decoded as text');
  assert.ok(isUnreadableText('N\0 \0 \0 \0 \0 \0'.repeat(50)+'text'.repeat(100)),'garbled extraction');
  assert.ok(!isUnreadableText('Plain legal text with curly “quotes” and § symbols.\n\n\tNext page\f'));
  assert.ok(!isUnreadableText('Good opinion text. '.repeat(2000)+'\0\0\0'),'a stray NUL is not garbage');
  assert.ok(!isUnreadableText(''));
  assert.ok(!isUnreadableText(Buffer.from('La décision a été rendue à la Cour de Paris. ','latin1').toString('utf8').repeat(200)),'Latin-1 text decoded as UTF-8 stays usable');
});

test('a stray NUL cannot reach the database and offsets stay exact',()=>{
  const chunks=chunkNormalizedText('First\0 paragraph.\n\nSecond paragraph.',18);
  assert.ok(chunks.every(c=>!c.passage_text.includes('\0')));
  const clean='First paragraph.\n\nSecond paragraph.';
  for(const c of chunks)assert.equal(clean.slice(c.normalized_start_offset,c.normalized_end_offset),c.passage_text);
  assert.deepEqual(chunkNormalizedText(clean,18),chunks,'text without NUL chunks exactly as before, so sealed snapshots still match');
});

test('gzip sent without a header is decompressed and corrupt gzip gives no text',()=>{
  const html='<html><body><p>Article 3 text</p></body></html>';
  assert.equal(normalizeText(zlib.gzipSync(html),'text/html'),'Article 3 text');
  assert.equal(normalizeText(Buffer.from([0x1f,0x8b,8,0,1,2,3]),'text/html'),null);
  assert.equal(normalizeText(Buffer.from(html),'text/html'),'Article 3 text');
});

async function failingResponse(error){
  const repository={getWorkspace:async()=>{throw error},getProject:async()=>{throw error}};
  const handler=createHandler(repository,{}, {});
  return new Promise((resolve,reject)=>{
    const res={statusCode:0,headers:{},headersSent:false,setHeader(k,v){this.headers[k]=v},writeHead(status,headers){this.statusCode=status;this.headers=headers;return this},end(body){resolve({status:this.statusCode,body:JSON.parse(body)})},destroy(){reject(new Error('destroyed'))}};
    const req={method:'GET',url:'/api/projects/11111111-1111-4111-8111-111111111111',headers:{host:'127.0.0.1:3080'},[Symbol.asyncIterator]:async function*(){}};
    Promise.resolve(handler(req,res)).catch(reject);
  });
}

test('callers learn the real failure class and never raw detail',async()=>{
  const log=console.error;console.error=()=>{};
  try{
    const provider=await failingResponse(providerError());
    assert.equal(provider.status,503);
    assert.match(provider.body.error,/AI provider failed \(HTTP 503: adapter busy/);
    const database=await failingResponse(Object.assign(new Error('secret row value'),{code:'22021',severity:'ERROR'}));
    assert.equal(database.status,500);
    assert.equal(database.body.reason,'database error 22021');
    assert.ok(!JSON.stringify(database.body).includes('secret'));
    const other=await failingResponse(new Error('secret path'));
    assert.equal(other.status,500);
    assert.equal(other.body.reason,undefined);
    assert.ok(!JSON.stringify(other.body).includes('secret'));
  }finally{console.error=log}
  assert.equal(failureLogFields({url:'/x'},{code:'22021',severity:'ERROR'}).reason,'database error 22021');
});

test('a rejection retrying cannot fix is not reported as temporary',async()=>{
  for(const reason of ['HTTP 400: Invalid gateway request','HTTP 401: unauthorized','HTTP 502: login rejected','HTTP 502: model not supported on the subscription'])assert.ok(isPermanentProviderFailure(reason),reason);
  for(const reason of ['HTTP 503: adapter busy; retry later','HTTP 429','HTTP 408','HTTP 502: subscription usage or rate limit reached','connection failed (ECONNREFUSED)','no response within 310 s'])assert.ok(!isPermanentProviderFailure(reason),reason);
  const {pool,store}=harness(['a']);
  const orchestrator={async verifyAssertion(){throw Object.assign(new Error('x'),{providerReason:'HTTP 401: unauthorized'})}};
  await assert.rejects(new VerificationService(pool,orchestrator,'/x','m',1,store).run('p','v'),error=>error.statusCode===500&&/HTTP 401/.test(error.publicMessage));
  const log=console.error;console.error=()=>{};
  try{const response=await failingResponse(Object.assign(new Error('x'),{providerReason:'HTTP 401: unauthorized'}));assert.equal(response.status,500);assert.match(response.body.error,/HTTP 401/)}finally{console.error=log}
});

test('a gateway error is a provider failure',async()=>{
  const orchestrator=createOrchestrator({orchestrationMode:'n8n',n8nWebhookUrl:'http://gateway.test/x',n8nWebhookAuthHeader:'a',verificationModel:'m'},async()=>new Response(JSON.stringify({error:'nope'})));
  await assert.rejects(orchestrator.verifyAssertion({assertion:{}}),error=>Boolean(error.providerReason));
});

test('an outage is not sent to Fix draft or compared as a shared defect',()=>{
  const gap='Verification output failed evidence validation: Provider request failed (HTTP 503)';
  const findings=revisionFindings([assertion('a'),assertion('b')],[{assertion_id:'a',status:'UNVERIFIABLE',material_gap:gap},{assertion_id:'b',status:'OVERSTATED',material_gap:'real'}]);
  assert.deepEqual(findings.map(f=>f.assertion_id),['b']);
  const shown={status:'NOT_CHECKED'};
  assert.notEqual(compare(shown,shown,true).comparison_status,'BOTH_DEFECTIVE');
  assert.equal(compare(shown,{status:'VERIFIED'},true).rationale,compare(null,{status:'VERIFIED'},true).rationale);
  assert.equal(compare({status:'UNSUPPORTED'},{status:'UNSUPPORTED'},true).comparison_status,'BOTH_DEFECTIVE');
});
