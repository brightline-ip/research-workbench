import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationLimits } from '../src/operation-limits.js';

test('AI limits fail closed without context, before oversized input, and after job limit',async()=>{
  let sent=0,charged=0;
  const limits=new OperationLimits({query:async()=>{charged++;return {rowCount:1};}},{jobCalls:1});
  const provider=limits.fetch(async()=>{sent++;return 'fixture';});
  await assert.rejects(provider('fixture',{body:'a'}),/active operation/);
  await limits.run(async()=>{
    await assert.rejects(provider('fixture',{body:'x'.repeat(1800001)}),/input size/);
    assert.equal(await provider('fixture',{body:'valid'}),'fixture');
    await assert.rejects(provider('fixture',{body:'valid'}),/limit/);
  });
  assert.equal(charged,1);assert.equal(sent,1);
});
test('daily exhaustion and expired jobs make no provider call',async()=>{
  let sent=0;
  const limits=new OperationLimits({query:async()=>({rowCount:0})});
  const provider=limits.fetch(async()=>{sent++;});
  await limits.run(async()=>{await assert.rejects(provider('fixture',{body:'a'}),/daily/);});
  limits.jobMilliseconds=1;
  await limits.run(async()=>{await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(provider('fixture',{body:'a'}),/time/);});
  assert.equal(sent,0);
});
test('idempotency keys are required and repeated accepted keys cannot execute again',async()=>{
  let queries=0;
  const limits=new OperationLimits({query:async()=>({rowCount:queries++===0?1:0})});
  await assert.rejects(limits.reserve('project','verify','bad'),/UUID/);
  await limits.reserve('project','verify','11111111-1111-1111-1111-111111111111');
  await assert.rejects(limits.reserve('project','verify','11111111-1111-1111-1111-111111111111'),/already accepted/);
});
test('limit messages name the limit, operations can have their own time budget, and a database stall is not a provider failure',async()=>{
  const limits=new OperationLimits({query:async()=>({rowCount:1})},{jobMilliseconds:1,operationMilliseconds:{discover:60000}});
  const provider=limits.fetch(async()=>'ok');
  await limits.run(async()=>{await new Promise(r=>setTimeout(r,5));assert.equal(await provider('fixture',{body:'a'}),'ok');},'discover');
  await limits.run(async()=>{await new Promise(r=>setTimeout(r,5));await assert.rejects(provider('fixture',{body:'a'}),/This verify operation reached its time limit of 0 minutes after 0 AI calls/);},'verify');
  const capped=new OperationLimits({query:async()=>({rowCount:1})},{jobCalls:1}),once=capped.fetch(async()=>'ok');
  await capped.run(async()=>{await once('f',{body:'a'});await assert.rejects(once('f',{body:'a'}),/limit of 1 AI calls/);});
  let sent=0;const stalled=new OperationLimits({query:async()=>{throw new Error('timeout exceeded when trying to connect')}}),guarded=stalled.fetch(async()=>{sent++;});
  await stalled.run(async()=>{await assert.rejects(guarded('f',{body:'a'}),error=>error.statusCode===503&&/database did not respond/.test(error.publicMessage));});
  assert.equal(sent,0);
});
