import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHandler } from '../src/app.js';
import { privateAddress, pinnedRequest, acquireSource } from '../src/source-acquisition.js';
import { parserEnvironment, runParser, readBounded, fetchJson } from '../src/safety.js';
import { DiscoveryService } from '../src/discovery.js';

async function serve(t, repository={}, services={}) {
  const server=http.createServer(createHandler(repository,{},services));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  return `http://127.0.0.1:${server.address().port}`;
}
test('localhost rejects foreign Origin, DNS-rebinding Host and cross-site requests before any repository call',async t=>{
  let calls=0;const base=await serve(t,{listProjects:async()=>{calls++;return []}});
  for(const headers of [{origin:'https://attacker.invalid'},{host:'rebind.attacker.invalid'},{'sec-fetch-site':'cross-site'},{origin:'null'},{'sec-fetch-site':'same-site'}]) {
    const status=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/projects',{headers},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)});
    assert.equal(status,403,JSON.stringify(headers));
  }
  assert.equal(calls,0);
  assert.equal((await fetch(base+'/api/projects',{headers:{origin:base}})).status,200);
});
test('API rejects simple cross-origin form bodies and malformed JSON objects',async t=>{
  let calls=0;const base=await serve(t,{createProject:async()=>{calls++;return {}}});
  assert.equal((await fetch(base+'/api/projects',{method:'POST',body:'{"title":"bad"}'})).status,415);
  for(const body of ['null','[]','{'])assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body})).status,400);
  assert.equal(calls,0);
});
test('stored hostile HTML is an attachment with a sandbox and safe filename',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rw-security-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'evil.html'),'<script>fetch("/api/projects")</script>');
  const base=await serve(t,{getSource:async()=>({original_storage_path:'evil.html',media_type:'text/html'})},{sourceStorageRoot:root});
  const response=await fetch(base+'/api/projects/abc/sources/def/original');
  assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.match(response.headers.get('content-security-policy'),/^sandbox;/);
});
test('raw exception details never reach the response or request log',async t=>{
  const secret='FAKE_PRIVATE_EXCEPTION_CANARY';const logs=[];t.mock.method(console,'error',value=>logs.push(value));
  const base=await serve(t,{listProjects:async()=>{throw new Error(secret)}});
  const response=await fetch(base+'/api/projects');const body=await response.json();
  assert.equal(response.status,500);assert.ok(body.request_id);assert.ok(!JSON.stringify([body,logs]).includes(secret));
});
test('parallel project mutations are rejected and the guard releases after completion',async t=>{
  let release,started;const entered=new Promise(r=>started=r);let calls=0;
  const base=await serve(t,{saveCheckpoint:async()=>{calls++;started();await new Promise(r=>release=r);return {}}});
  const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'T',content_markdown:'A'})};
  const first=fetch(base+'/api/projects/abc/checkpoint',options);await entered;
  assert.equal((await fetch(base+'/api/projects/ABC/checkpoint',options)).status,409);assert.equal(calls,1);
  release();assert.equal((await first).status,201);
});
test('manual source classifications still enforce assertion ownership',async t=>{
  let registered=false;const base=await serve(t,{getAssertion:async()=>null,registerSource:async()=>{registered=true}});
  const response=await fetch(base+'/api/projects/abc/sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({canonical_url:'https://example.org',assertion_id:'foreign',proposition_source_class:'PRIMARY'})});
  assert.equal(response.status,404);assert.equal(registered,false);
});
test('SSRF rejects private, mapped IPv6, shared-address and multicast destinations',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','224.0.0.1','::1','::ffff:7f00:1','::ffff:c0a8:101','fd00::1','fe80::1','2002:7f00:1::'])assert.equal(privateAddress(ip),true,ip);
  assert.equal(privateAddress('93.184.216.34'),false);assert.equal(privateAddress('2606:4700:4700::1111'),false);
});
test('source socket lookup uses only the prevalidated DNS address and preserves the hostname',async()=>{
  const url=new URL('https://example.org/document');const record={address:'93.184.216.34',family:4};let checked=false;
  const response=await pinnedRequest(url,record,AbortSignal.timeout(1000),(target,options,callback)=>{
    assert.equal(target.hostname,'example.org');assert.equal(options.agent,false);
    options.lookup(target.hostname,{all:true},(error,records)=>{assert.equal(error,null);assert.deepEqual(records,[record]);checked=true});
    const request=new EventEmitter();request.end=()=>{const stream=Readable.from([Buffer.from('safe')]);stream.statusCode=200;stream.headers={'content-type':'text/plain'};callback(stream)};return request;
  });
  assert.ok(checked);assert.equal(await response.text(),'safe');
});
test('redirect to private network is blocked before the second HTTP request',async()=>{
  let calls=0;await assert.rejects(acquireSource('https://example.org',{lookup:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>{calls++;return new Response('',{status:302,headers:{location:'http://127.0.0.1/'}})}}),/private/);assert.equal(calls,1);
});
test('source transport handles bodyless and invalid status codes without crashing',async()=>{
  const fixture=status=>(_url,_options,callback)=>{
    const request=new EventEmitter();request.end=()=>{const stream=Readable.from([]);stream.statusCode=status;stream.headers={};callback(stream)};return request;
  };
  const url=new URL('https://example.org'),record={address:'93.184.216.34',family:4};
  assert.equal((await pinnedRequest(url,record,AbortSignal.timeout(1000),fixture(204))).status,204);
  await assert.rejects(pinnedRequest(url,record,AbortSignal.timeout(1000),fixture(600)),/invalid HTTP/);
});
test('streamed response limit cancels oversized chunked downloads',async()=>{
  let cancelled=false;const response=new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8))},cancel(){cancelled=true}}));
  await assert.rejects(readBounded(response,10),/byte limit/);assert.ok(cancelled);
});
test('provider failure and timeout are bounded, sanitized, and never retried',async t=>{
  const server=http.createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
  await assert.rejects(fetchJson(fetch,`http://127.0.0.1:${server.address().port}`,{},30),/timed out/);
  let calls=0;await assert.rejects(fetchJson(async()=>{calls++;return new Response('FAKE_SECRET',{status:401})},'https://example.org',{}),error=>!error.message.includes('FAKE_SECRET'));assert.equal(calls,1);
});
test('document subprocesses have no model or database credential environment',async t=>{
  const old=process.env.PGPASSWORD;process.env.PGPASSWORD='FAKE_SECRET';t.after(()=>{if(old===undefined)delete process.env.PGPASSWORD;else process.env.PGPASSWORD=old});
  assert.equal(parserEnvironment().PGPASSWORD,undefined);
  const result=await runParser(process.execPath,['-e','process.stdout.write(String(process.env.PGPASSWORD))']);assert.equal(result.stdout,'undefined');
  await assert.rejects(runParser('rw-missing-executable-test',[]),/Document processor failed/);
  await assert.rejects(runParser(process.execPath,['-e','setInterval(()=>{},1000)'],{},{timeout:50}),/Document processor failed/);
});
test('warehouse reuse adds membership in the requesting project',async()=>{
  const queries=[];const service=new DiscoveryService({query:async(sql,args)=>{queries.push({sql,args});return{rows:[]}}},{},{});
  await service.acceptExisting('run',{assertion_id:'a',project_id:'p'},{source_id:'s'});
  assert.match(queries[0].sql,/INSERT INTO project_sources/);assert.deepEqual(queries[0].args,['p','s']);
});
import { OperationLimits } from '../src/operation-limits.js';
test('HTTP operation keys stop duplicate verification before service execution',async t=>{
  const keys=new Set();let calls=0;
  const limits=new OperationLimits({query:async(sql,[key])=>{if(keys.has(key))return {rowCount:0};keys.add(key);return {rowCount:1};}});
  const base=await serve(t,{}, {operationLimits:limits,verificationService:{run:async()=>{calls++;return {run:{status:'COMPLETE'}};}}});
  const endpoint=base+'/api/projects/11111111-1111-1111-1111-111111111111/verify';
  const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_version_id:'22222222-2222-2222-2222-222222222222'})};
  assert.equal((await fetch(endpoint,options)).status,400);
  options.headers['idempotency-key']='33333333-3333-3333-3333-333333333333';
  assert.equal((await fetch(endpoint,options)).status,201);
  assert.equal((await fetch(endpoint,options)).status,409);
  assert.equal(calls,1);
});
test('low disk space blocks new mutations before writing project data',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rw-space-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const limits=new OperationLimits({}, {storageRoots:[root],minFreeBytes:Number.MAX_SAFE_INTEGER});
  let calls=0;const base=await serve(t,{createProject:async()=>{calls++;}}, {operationLimits:limits});
  assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:'{"title":"fixture"}'})).status,503);
  assert.equal(calls,0);
});
test('provider failures carry a controlled reason: known adapter errors, status, or transport class, never raw text',async()=>{
  await assert.rejects(fetchJson(async()=>Response.json({error:'subscription usage or rate limit reached'},{status:502}),'https://example.org',{}),
    error=>/\(HTTP 502: subscription usage or rate limit reached\)\. No automatic retry/.test(error.message)&&error.providerReason==='HTTP 502: subscription usage or rate limit reached');
  await assert.rejects(fetchJson(async()=>Response.json({error:'FAKE_SECRET prompt text'},{status:500}),'https://example.org',{}),
    error=>/\(HTTP 500\)/.test(error.message)&&!error.message.includes('FAKE_SECRET'));
  await assert.rejects(fetchJson(async()=>{throw Object.assign(new TypeError('fetch failed FAKE_SECRET'),{cause:{code:'ECONNREFUSED'}})},'https://example.org',{}),
    error=>/connection failed \(ECONNREFUSED\)/.test(error.message)&&!error.message.includes('FAKE_SECRET'));
  await assert.rejects(fetchJson(async()=>new Response('not json FAKE_SECRET'),'https://example.org',{}),error=>/not valid JSON/.test(error.message)&&!error.message.includes('FAKE_SECRET'));
});
