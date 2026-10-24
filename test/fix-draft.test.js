import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRevisionContract } from '../src/contracts.js';
import { Repository } from '../src/repository.js';
import { createOrchestrator } from '../src/orchestrator.js';

function output(ids) {
  return {title:'Draft',content_markdown:ids.map(id=>`Claim ${id}. [EVIDENCE NEEDED: support for ${id}]`).join('\n'),
    change_summary:'Flagged missing evidence.',applied_verification_result_ids:[],
    issue_resolutions:ids.map(id=>({verification_result_id:id,action:'NEEDS_EVIDENCE',reason:'No passage establishes this claim.',revised_excerpt:`Claim ${id}. [EVIDENCE NEEDED: support for ${id}]`}))};
}

test('revision contract requires every issue exactly once, including issues beyond report preview',()=>{
  const ids=Array.from({length:122},(_,i)=>`r${i}`),value=output(ids);
  assert.equal(assertRevisionContract(value,ids),value);
  assert.throws(()=>assertRevisionContract(output(ids.slice(0,20)),ids),/all 122/);
  assert.throws(()=>assertRevisionContract({...value,issue_resolutions:[...value.issue_resolutions,value.issue_resolutions[0]]},ids),/more than once/);
  assert.throws(()=>assertRevisionContract(output(['unknown']),ids),/unknown/);
});

test('unresolved claims need visible markers and corrected excerpts must exist in the draft',()=>{
  const value=output(['a']);
  assert.throws(()=>assertRevisionContract({...value,content_markdown:'Unchanged claim.'},['a']),/excerpt/);
  assert.throws(()=>assertRevisionContract({...value,content_markdown:'Claim.',issue_resolutions:[{...value.issue_resolutions[0],revised_excerpt:'Claim.'}]},['a']),/marked/);
  assert.throws(()=>assertRevisionContract({...value,applied_verification_result_ids:['a']},['a']),/documented changes/);
  const corrected={...value,issue_resolutions:[{...value.issue_resolutions[0],action:'CORRECTED'}],applied_verification_result_ids:['a']};
  assert.equal(assertRevisionContract(corrected,['a']),corrected);
});

function fixture({staleAtCommit=false, modelOutput=null}={}) {
  const calls=[],saved=[];
  const context={article_version_id:'v1',title:'Original',content_markdown:'Original draft.',verification_status:'COMPLETE',verification_mode:'AUTHOR_CORPUS'};
  const assertions=Array.from({length:26},(_,i)=>({assertion_id:`a${i}`,assertion_text:`Claim ${i}`,evidence_span:`Claim ${i}`,source_required:i!==25,primary_source_required:false}));
  const results=assertions.map((a,i)=>({assertion_id:a.assertion_id,verification_result_id:`r${i}`,assertion_as_made:a.assertion_text,status:'UNSUPPORTED'}));
  let latestReads=0;
  const client={release(){},async query(sql,args=[]){
    calls.push({sql,args});
    if(sql.startsWith('SELECT av.*'))return {rows:[context]};
    if(sql.startsWith('SELECT article_version_id'))return {rows:[{article_version_id:++latestReads>1&&staleAtCommit?'v2':'v1'}]};
    if(sql.startsWith('SELECT vr.*'))return {rows:results};
    if(sql.startsWith('SELECT * FROM assertions'))return {rows:assertions};
    if(sql.startsWith('INSERT INTO revision_runs'))return {rows:[{revision_run_id:'revision'}]};
    if(sql.startsWith('UPDATE revision_runs SET status=\'COMPLETE\''))return {rows:[{status:'COMPLETE',issues_changed:args[6],issues_unresolved:args[7]}]};
    return {rows:[]};
  }};
  const pool={query:client.query.bind(client),connect:async()=>client};
  const repository=new Repository(pool);
  repository.saveCheckpoint=async(_project,data)=>{saved.push(data);return {article_version_id:'new',version_number:2};};
  let input;
  const orchestrator={reviseArticle:async value=>{input=value;return modelOutput||output(value.verification_results.map(r=>r.verification_result_id));}};
  return {repository,orchestrator,calls,saved,get input(){return input;}};
}

test('Fix draft includes all actionable findings and atomically saves the complete audit',async()=>{
  const f=fixture();const result=await f.repository.reviseArticle('p','v1','run','Fix every issue',f.orchestrator);
  assert.equal(f.input.verification_results.length,25); // report preview is only 20
  assert.equal(f.saved.length,1);assert.equal(result.run.issues_unresolved,25);
  const update=f.calls.find(c=>c.sql.startsWith("UPDATE revision_runs SET status='COMPLETE'"));
  const decisions=JSON.parse(update.args[4]);assert.equal(decisions.length,25);assert.equal(decisions[0].original_assertion,'Claim 0');
  assert.ok(f.calls.some(c=>c.sql==='COMMIT'));
});

test('incomplete model response fails without saving a new draft',async()=>{
  const f=fixture({modelOutput:output(['r0'])});
  await assert.rejects(f.repository.reviseArticle('p','v1','run','Fix',f.orchestrator),/all 25/);
  assert.equal(f.saved.length,0);assert.ok(f.calls.some(c=>c.sql.includes("status='FAILED'")));
});

test('a concurrent checkpoint prevents revision from applying to the wrong parent',async()=>{
  const f=fixture({staleAtCommit:true});
  await assert.rejects(f.repository.reviseArticle('p','v1','run','Fix',f.orchestrator),/draft changed while revision/);
  assert.equal(f.saved.length,0);assert.ok(f.calls.some(c=>c.sql==='ROLLBACK'));
});

test('both provider paths require the same complete issue audit',async()=>{
  for(const mode of ['openai','n8n']){
    let body;const expected=output(['a']);
    const fetchImpl=async(_url,options)=>{body=JSON.parse(options.body);return Response.json(mode==='openai'?{output_text:JSON.stringify(expected)}:{result:expected});};
    const orchestrator=createOrchestrator({orchestrationMode:mode,openaiApiKey:'test',n8nWebhookUrl:'https://test.invalid',n8nWebhookAuthHeader:'test'},fetchImpl);
    const result=await orchestrator.reviseArticle({article:{content_markdown:'Original'},verification_results:[{verification_result_id:'a'}]});
    assert.equal(result.issue_resolutions.length,1);assert.match(body.instructions,/EVERY/);assert.match(body.instructions,/Missing evidence alone is not proof/);
    const schema=mode==='openai'?body.text.format.schema:body.schema;
    assert.ok(schema.required.includes('issue_resolutions'));
  }
});
