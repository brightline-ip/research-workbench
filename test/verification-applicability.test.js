import { compare } from '../src/adversarial.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationService } from '../src/verification.js';
import { buildReport, displayResult, requiresExternalEvidence } from '../public/report-model.js';
import { mapConcurrent } from '../src/concurrency.js';

test('non-source statements bypass evidence retrieval and a claim with no source is not reported as a finding', async () => {
  const claims = [
    {assertion_id:'intro', project_id:'p', assertion_text:'This memorandum identifies and frames the issues.', source_required:false, primary_source_required:false},
    {assertion_id:'fact', project_id:'p', assertion_text:'The report was published in 2026.', source_required:true},
  ];
  let metrics;
  const snapshots={seal:async()=>({corpus_snapshot_id:'snapshot'}),load:async()=>({manifest:{links:[],versions:[]},passages:[]})};
  const pool = {async query(sql, values = []) {
    if (sql.startsWith('SELECT * FROM assertions')) return {rows:claims};
    if (sql.startsWith('INSERT INTO verification_runs')) return {rows:[{verification_run_id:'run'}]};
    if (sql.startsWith('SELECT s.* FROM sources')) return {rows:[]};
    if (sql.startsWith('SELECT c.*')) {assert.equal(values[0],'fact');evidenceQueries++;return {rows:[]};}
    if (sql.includes('AS failures') && !sql.includes('AS primary_sources')) return {rows:[{}]};
    if (sql.startsWith('INSERT INTO verification_results')) return {rows:[{assertion_id:values[1],status:values[9],candidate_passage_count:values[16]}]};
    if (sql.includes('AS primary_sources')) return {rows:[{}]};
    if (sql.startsWith('UPDATE verification_runs')) {metrics=values;return {rows:[{}]};}
    if (sql.startsWith('UPDATE assertions')) return {rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result = await new VerificationService(pool,{verifyAssertion(){throw new Error('No model call expected');}},'.',null,3,snapshots).run('p','v');
  assert.deepEqual(result.results.map(r=>r.status),['NOT_APPLICABLE','UNVERIFIABLE']);

  assert.deepEqual(metrics.slice(1,3),[0,2],'neither claim had passages sent to the model');
  assert.equal(metrics[5].NOT_APPLICABLE,1);
});

test('legacy report excludes only automatic missing-source flags and preserves stored records', () => {
  const claim = {assertion_id:'1',source_required:false,primary_source_required:false};
  const old = {assertion_id:'1',status:'UNSUPPORTED',material_gap:'No primary passage'};
  const report = buildReport([claim],[old]);
  assert.equal(report.counts.attention,0);
  assert.equal(report.counts.not_applicable,1);
  assert.equal(report.rows[0].result.original_status,'UNSUPPORTED');
  assert.equal(old.status,'UNSUPPORTED');
  assert.equal(old.material_gap,'No primary passage');
  assert.equal(displayResult(claim,{...old,status:'CONTRADICTED'}).status,'CONTRADICTED');
  assert.equal(displayResult(claim,{...old,source_id:'evidence'}).status,'UNSUPPORTED');
  assert.equal(requiresExternalEvidence({...claim,primary_source_required:true}),true);
  assert.equal(requiresExternalEvidence({}),true);
});

test('bounded verification workers preserve order and never exceed their limit', async () => {
  let active=0, maximum=0;
  const result=await mapConcurrent([30,10,20,5],2,async delay=>{
    active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,delay));active--;return delay;
  });
  assert.deepEqual(result,[30,10,20,5]);assert.equal(maximum,2);
});

test('worker errors drain in-flight operations before failing the run', async () => {
  let finished=false;
  await assert.rejects(mapConcurrent([0,1,2],2,async item=>{
    if(item===0){await new Promise(resolve=>setTimeout(resolve,5));throw new Error('database failure');}
    await new Promise(resolve=>setTimeout(resolve,20));finished=true;
  }),/database failure/);
  assert.equal(finished,true);
});

test('secondary evidence is eligible only when the claim explicitly permits it', async () => {
  for (const primaryRequired of [true,false]) {
    let modelCalls=0;
    const claim={assertion_id:'a',project_id:'p',assertion_text:'The author recommends reform.',source_required:true,primary_source_required:primaryRequired};
    const pool={async query(sql,values=[]){
      if(sql.startsWith('SELECT * FROM assertions'))return {rows:[claim]};
      if(sql.startsWith('INSERT INTO verification_runs'))return {rows:[{verification_run_id:'run'}]};
      if(sql.startsWith('SELECT s.* FROM sources'))return {rows:[]};
      if(sql.startsWith('SELECT c.*'))return {rows:[{source_id:'s',passage_id:'passage',passage_text:claim.assertion_text,proposition_source_class:'SECONDARY',sequence_number:0}]};
      if(sql.includes('AS primary_sources'))return {rows:[{}]};
      if(sql.includes('AS failures'))return {rows:[{secondary_count:1}]};
      if(sql.startsWith('INSERT INTO verification_results'))return {rows:[{status:values[9],defect_codes:values[10],not_checked_reason:values[17]}]};
      if(sql.startsWith('UPDATE'))return {rows:[{}]};
      throw new Error(sql);
    }};
    const orchestrator={async verifyAssertion(input){modelCalls++;assert.equal(input.assertion.primary_source_required,false);return {status:'VERIFIED',source_id:'s',passage_id:'passage',extracted_passage:claim.assertion_text,defect_codes:[]};}};
    const snapshots={seal:async()=>({corpus_snapshot_id:'snapshot'}),load:async()=>({manifest:{links:[{assertion_id:'a',source_id:'s',membership_status:'ACCEPTED',proposition_source_class:'SECONDARY'}],versions:[{source_id:'s',source_version_id:'sv',normalized_content_hash:'hash',metadata:{}}]},passages:[{source_id:'s',source_version_id:'sv',passage_id:'passage',passage_text:claim.assertion_text,sequence_number:0}]})};
    const {results}=await new VerificationService(pool,orchestrator,'.',null,3,snapshots).run('p','v');
    assert.equal(modelCalls,primaryRequired?0:1);
    assert.equal(results[0].status,primaryRequired?'UNVERIFIABLE':'VERIFIED');
    assert.equal(results[0].not_checked_reason,primaryRequired?'NO_ELIGIBLE_SOURCE':null);
    assert.deepEqual(results[0].defect_codes,primaryRequired?['NON_PRIMARY_SUPPORT']:[]);
  }
});

test('adversarial agreement on nonapplicability is not a defect',()=>{assert.equal(compare({status:'NOT_APPLICABLE'},{status:'NOT_APPLICABLE'},true).comparison_status,'AGREES');assert.equal(compare({status:'UNSUPPORTED'},{status:'UNSUPPORTED'},true).comparison_status,'BOTH_DEFECTIVE')});
