import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDraftContract, assertExtractionContract, assertSourceClassificationContract, assertVerificationContract, assertRedTeamContract, assertReconciliationContract } from '../src/contracts.js';
import { createOrchestrator } from '../src/orchestrator.js';

const valid = { research_brief: { topic: 'T', scope: 'S', research_questions: [], source_plan: [], limitations: [] }, article: { title: 'A', content_markdown: '# A' } };

test('draft contract accepts the canonical shape', () => assert.equal(assertDraftContract(valid), valid));
test('draft contract rejects missing article content', () => assert.throws(() => assertDraftContract({ research_brief: { topic: 'T' }, article: { title: 'A' } }), /valid article/));
test('OpenAI orchestration sends a strict structured-output request', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url, ...options }; return Response.json({ output_text: JSON.stringify(valid) }); };
  const output = await createOrchestrator({ orchestrationMode: 'openai', openaiApiKey: 'test-only', openaiModel: 'test-model' }, fetchImpl).draft({ topic: 'T', instruction: 'Draft' });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.text.format.strict, true);
  assert.equal(output.article.title, 'A');
});

test('atomic extraction contract requires load-bearing reasons', () => {
  const item = { block_index: 0, evidence_span: 'A.', assertion_text: 'A.', normalized_proposition: 'A', assertion_class: 'TECHNICAL_FACT', load_bearing: true, load_bearing_reason: null, citation_as_written: null, source_required: true, primary_source_required: true };
  assert.throws(() => assertExtractionContract({ coverage_complete: true, coverage_notes: '', assertions: [item] }), /load-bearing/);
});

test('OpenAI assertion extraction uses the dedicated strict schema', async () => {
  let body; const result = { coverage_complete: true, coverage_notes: 'All blocks examined.', assertions: [] };
  const fetchImpl = async (_url, options) => { body=JSON.parse(options.body); return Response.json({ id: 'resp_test', output_text: JSON.stringify(result) }); };
  const output = await createOrchestrator({ orchestrationMode: 'openai', openaiApiKey: 'test-only', openaiModel: 'test-model' }, fetchImpl).extractAssertions({ article_version_id: 'v1', blocks: [{ block_index: 0, text: '# Title' }] });
  assert.equal(body.text.format.name, 'atomic_assertion_extraction');
  assert.equal(body.text.format.strict, true);
  assert.equal(output.provider_response_id, 'resp_test');
});

test('source classification is proposition-specific and constrained', () => {
  const value = { proposition_source_class: 'PRIMARY', classification_reason: 'The agency dataset directly reports the tested value.', relationship_type: 'SUPPORTS', discovery_only: false };
  assert.equal(assertSourceClassificationContract(value), value);
  assert.throws(() => assertSourceClassificationContract({ ...value, proposition_source_class: 'REPUTABLE' }), /source class/);
});

test('verification contract enforces the canonical taxonomy and comparison fields', () => {
  const value={source_id:null,passage_id:null,assertion_as_made:'A',source_actually_establishes:'Nothing acquired.',material_gap:'Evidence unavailable.',extracted_passage:null,status:'UNVERIFIABLE',defect_codes:[],confidence:null,recommended_remediation:'Acquire the source.'};
  assert.equal(assertVerificationContract(value),value);
  assert.throws(()=>assertVerificationContract({...value,status:'SUPPORTED'}),/status/);
});
test('red-team and reconciliation ids that are blank or "null" become null; an unknown real id is still refused', () => {
  const ok='11111111-1111-4111-8111-111111111111';
  const base={thesis_survives:'YES',executive_assessment:'x',findings:['','null',null,undefined,ok].map(id=>({assertion_id:id,finding_type:'THESIS_RISK',severity:'LOW',challenge:'c',evidence_basis:'e',recommended_action:'a'}))};
  const out=assertRedTeamContract(base,[ok]);
  assert.deepEqual(out.findings.map(f=>f.assertion_id),[null,null,null,null,ok]);
  assert.throws(()=>assertRedTeamContract({...base,findings:[{...base.findings[0],assertion_id:'22222222-2222-4222-8222-222222222222'}]},[ok]),/unknown assertion/);
  const rec=assertReconciliationContract({overall_disposition:'PUBLISHABLE',summary:'s',required_actions:[{assertion_id:'null',action:'a',reason:'r',requires_reverification:false},{assertion_id:ok,action:'a',reason:'r',requires_reverification:false}]},[ok]);
  assert.deepEqual(rec.required_actions.map(a=>a.assertion_id),[null,ok]);
});
