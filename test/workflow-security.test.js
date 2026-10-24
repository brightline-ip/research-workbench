import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const workflow=JSON.parse(await fs.readFile(new URL('../extras/n8n/research-workbench-ai-gateway.json',import.meta.url),'utf8'));
const run=(name,body)=>vm.runInNewContext(`(function(){${workflow.nodes.find(n=>n.name===name).parameters.jsCode}})()`,{$input:{first:()=>({json:{body}})}},{timeout:1000});
test('workflow has two authenticated, connected, bounded production paths with no pinned data',()=>{
  const names=new Set(workflow.nodes.map(n=>n.name));assert.equal(names.size,workflow.nodes.length);
  assert.equal(workflow.nodes.filter(n=>n.type==='n8n-nodes-base.webhook').length,2);
  for(const node of workflow.nodes){assert.ok(!node.disabled);if(node.type==='n8n-nodes-base.webhook'){assert.equal(node.parameters.authentication,'headerAuth');assert.ok(node.credentials.httpHeaderAuth);}}
  const visited=new Set();const walk=name=>{if(visited.has(name))return;visited.add(name);for(const outputs of Object.values(workflow.connections[name]||{}))for(const edges of outputs)for(const edge of edges){assert.ok(names.has(edge.node));walk(edge.node)}};
  for(const node of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.webhook'))walk(node.name);
  // The paid Fireworks fallback is kept for history but deliberately unreachable ($0 cap).
  const disconnected=new Set(['Fireworks - Structured Research Fallback','Parse Fireworks Structured Result']);
  assert.deepEqual(workflow.nodes.map(n=>n.name).filter(n=>!visited.has(n)).sort(),[...disconnected].sort());assert.ok(!workflow.pinData||Object.keys(workflow.pinData).length===0);
  assert.equal(workflow.settings.executionTimeout,300);
  assert.equal(workflow.settings.saveDataErrorExecution,'none');assert.equal(workflow.settings.saveDataSuccessExecution,'none');assert.equal(workflow.settings.saveExecutionProgress,false);
});
test('gateway Code nodes reject unapproved operations, costly model overrides and large discovery bodies',()=>{
  const valid={operation:'verify',instructions:'Use supplied evidence',input:'fixture',schema:{type:'object'},model:'gpt-5.4'};
  assert.equal(run('Validate Gateway Request',valid)[0].json.operation,'verify');
  assert.throws(()=>run('Validate Gateway Request',{...valid,operation:'execute_shell'}),/Unsupported operation/);
  assert.throws(()=>run('Validate Gateway Request',{...valid,model:'unapproved-expensive-model'}),/not allowed/);
  assert.throws(()=>run('Prepare Discovery',{assertion_text:'x'.repeat(1800001),normalized_proposition:'x'}),/too large/);
});
test('workflow parsers return controlled errors for malformed provider output',()=>{
  for(const name of ['Parse Structured Result','Parse Discovery']){
    const code=workflow.nodes.find(n=>n.name===name).parameters.jsCode;
    const result=vm.runInNewContext(`(function(){${code}})()`,{$input:{first:()=>({json:{output:[{content:[{text:'not JSON FAKE_SECRET'}]}]}})}},{timeout:1000});
    assert.ok(result[0].json.error);assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
  }
});
