import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workflowPath=process.env.GATEWAY_WORKFLOW_PATH||path.join(root,'extras','n8n','research-workbench-ai-gateway.json');
const workflow=JSON.parse(fs.readFileSync(workflowPath,'utf8'));
const byName=name=>workflow.nodes.find(node=>node.name===name);

async function runCode(name,input,references={}){
  const code=byName(name).parameters.jsCode;
  const context={Buffer,$input:{first:()=>({json:input})},$:nodeName=>({first:()=>({json:references[nodeName]})})};
  return new vm.Script(`(async()=>{${code}})()`).runInNewContext(context);
}

test('structured fallback is isolated from discovery and has strict transport bounds',()=>{
  const primary=byName('OpenAI - Structured Research');
  const fallback=byName('Fireworks - Structured Research Fallback');
  assert.equal(primary.onError,'continueErrorOutput');
  assert.equal(fallback.parameters.url,'https://api.fireworks.ai/inference/v1/chat/completions');
  assert.equal(fallback.parameters.authentication,'predefinedCredentialType');
  assert.equal(fallback.parameters.nodeCredentialType,'openAiApi');
  assert.equal(fallback.parameters.options.timeout,120000);
  assert.equal(fallback.parameters.options.redirect.redirect.followRedirects,false);
  assert.equal(fallback.retryOnFail,false);
  assert.equal(workflow.connections['OpenAI - Primary Source Discovery'].main.length,1);
  assert.equal(workflow.connections['OpenAI - Structured Research'].main[1][0].node,'Classify OpenAI Failure');
});

test('paid fallback is disabled: every primary failure fails closed without reaching Fireworks',async()=>{
  const source={name:'atomic_assertion_extraction',schema:{type:'object'},system:'system',input:'input'};
  for(const failure of [{statusCode:429,error:{code:'insufficient_quota'}},{httpCode:503},{code:'ETIMEDOUT'},{message:'timeout of 120000ms exceeded'},{statusCode:401}]){
    await assert.rejects(runCode('Classify OpenAI Failure',failure,{'Validate Gateway Request':source}),/Paid fallback disabled/);
  }
  assert.deepEqual(workflow.connections['OpenAI - Structured Research'].main[1].map(edge=>edge.node),['Classify OpenAI Failure']);
  assert.equal(workflow.connections['Classify OpenAI Failure'],undefined);
  const reachesFireworks=Object.values(workflow.connections).some(c=>c.main.flat().some(edge=>edge.node==='Fireworks - Structured Research Fallback'));
  assert.equal(reachesFireworks,false);
});

test('Fireworks parser requires stop, parses one object, and records provenance',async()=>{
  const response={id:'completion-1',model:'accounts/fireworks/models/deepseek-v4p1-flash',choices:[{finish_reason:'stop',message:{content:'{"coverage_complete":true,"coverage_notes":"ok","assertions":[]}'}}]};
  const parsed=await runCode('Parse Fireworks Structured Result',response);
  assert.equal(parsed[0].json.provider,'fireworks');
  assert.equal(parsed[0].json.result.provider_response_id,'fireworks:accounts/fireworks/models/deepseek-v4p1-flash:completion-1');
  await assert.rejects(runCode('Parse Fireworks Structured Result',{...response,choices:[{finish_reason:'length',message:{content:'{}'}}]}),/finish normally/);
  await assert.rejects(runCode('Parse Fireworks Structured Result',{...response,choices:[{finish_reason:'stop',message:{content:'not-json'}}]}),/not valid JSON/);
  await assert.rejects(runCode('Parse Fireworks Structured Result',{...response,choices:[{finish_reason:'stop',message:{content:'```json\\n{}\\n```'}}]}),/not valid JSON/);
  await assert.rejects(runCode('Parse Fireworks Structured Result',{...response,choices:[{finish_reason:'stop',message:{content:'Here is JSON: {}'}}]}),/not valid JSON/);
});
