import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownerDecisionProblem, revisionFindings } from '../src/revision-policy.js';
import { DiscoveryService } from '../src/discovery.js';
import { CorpusImportService } from '../src/corpus-import.js';

const assertions=[{assertion_id:'a',evidence_span:'The sky is green.'},{assertion_id:'b',evidence_span:'Nothing checked here.'},{assertion_id:'c',evidence_span:'A found problem.'}];
const results=[{assertion_id:'a',verification_result_id:'ra',status:'UNSUPPORTED',not_checked_reason:null,assertion_as_made:'The sky is green.'},
  {assertion_id:'b',verification_result_id:'rb',status:'UNVERIFIABLE',not_checked_reason:'NO_SOURCES',assertion_as_made:'Nothing checked here.'},
  {assertion_id:'c',verification_result_id:'rc',status:'OVERSTATED',not_checked_reason:null,assertion_as_made:'A found problem.'}];

test('a claim where nothing was compared reaches Fix draft only when the author decides',()=>{
  assert.deepEqual(revisionFindings(assertions,results).map(f=>f.assertion_id),['a','c']);
  const found=revisionFindings(assertions,results,[{assertion_id:'b',decision:'NEEDS_EVIDENCE'},{assertion_id:'a',decision:'REMOVE'}]);
  assert.deepEqual(found.map(f=>[f.assertion_id,f.owner_decision]),[['a','REMOVE'],['b','NEEDS_EVIDENCE'],['c',undefined]]);
});

test('a reply that ignores the author is not applied',()=>{
  const findings=revisionFindings(assertions,results,[{assertion_id:'a',decision:'REMOVE'},{assertion_id:'b',decision:'NEEDS_EVIDENCE'}]);
  const reply=(a,b,content)=>({content_markdown:content,issue_resolutions:[{verification_result_id:'ra',action:a},{verification_result_id:'rb',action:b},{verification_result_id:'rc',action:'QUALIFIED'}]});
  assert.equal(ownerDecisionProblem(findings,reply('REMOVED','NEEDS_EVIDENCE','Other text. [EVIDENCE NEEDED: x]')),null);
  assert.match(ownerDecisionProblem(findings,reply('QUALIFIED','NEEDS_EVIDENCE','Other text.')),/still in the revised draft/);
  assert.match(ownerDecisionProblem(findings,reply('REMOVED','NEEDS_EVIDENCE','The sky is green. Other text.')),/still in the revised draft/,'the words are still there, whatever the model reported');
  assert.match(ownerDecisionProblem(findings,reply('REMOVED','QUALIFIED','Other text.')),/needing evidence/);
});

function discovery(passages){
  const service=Object.create(DiscoveryService.prototype);
  service.pool={query:async()=>({rows:passages})};
  return service;
}
const today=new Date().toISOString(),longAgo=new Date(Date.now()-200*86400000).toISOString();
const claim={assertion_text:'Licensees must submit quarterly royalty reports within thirty days'};
const passage={passage_text:'Licensees must submit quarterly royalty reports within thirty days after each quarter.',sequence_number:0};

test('a stored primary source saves the search only when it is recent and really covers the claim',async()=>{
  const covers=(sources,rows,days=90)=>discovery(rows).storedPrimaryCovers(claim,sources,days);
  const primary={source_id:'s',authority_tier:'PRIMARY',retrieved_at:today};
  assert.equal(await covers([primary],[passage]),true);
  assert.equal(await covers([{...primary,retrieved_at:longAgo}],[passage]),false,'too old');
  assert.equal(await covers([{...primary,authority_tier:'SECONDARY'}],[passage]),false,'not primary');
  assert.equal(await covers([primary],[{passage_text:'Royalty reports are discussed elsewhere.',sequence_number:0}]),false,'shares only a few words');
  assert.equal(await covers([primary],[passage],0),false,'turned off');
  assert.equal(await covers([],[passage]),false);
});

test('web discovery can reuse a kept file but never a private one',async()=>{
  const queries=[];
  const service=Object.create(DiscoveryService.prototype);
  service.pool={query:async(sql,params)=>(queries.push({sql,params}),{rows:[]})};
  await service.warehouseCandidates({normalized_proposition:'a statement about patents'});
  assert.match(queries[0].sql,/canonical_url NOT LIKE \$2 OR s\.canonical_url LIKE \$3/);
  assert.equal(queries[0].params[2],'https://get-files.invalid/shared/%');
});

test('a kept file gets a shared address and a label recorded as the caller\'s',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kept-')),original=Buffer.from('kept file');
  const id=crypto.createHash('sha256').update(original).digest('hex');let saved;
  const fetchImpl=async url=>url.includes('/original?')?new Response(original):url.includes('/normalized?')?new Response(Buffer.from('text')):Response.json({status:'ready',origins:[]});
  const service=new CorpusImportService({importCorpusSource:async(project,input)=>(saved=input,{source:{}})},{baseUrl:'http://127.0.0.1:8766',token:'t',storageRoot:root,fetchImpl});
  const links=[{assertion_id:'a',relationship_type:'BACKGROUND',proposition_source_class:'PRIMARY',classification_reason:'Kept.'}];
  await service.import('p',{collection:'research',document_id:id,local_source:true,shared:true,authority_tier:'PRIMARY',assertion_links:links});
  assert.equal(saved.canonical_url,`https://get-files.invalid/shared/research/${id}`);
  assert.equal(saved.authority_tier,'PRIMARY');assert.equal(saved.provenance.authority_assigned_by,'CALLER');
  await service.import('p',{collection:'research',document_id:id,local_source:true,authority_tier:'NOT A TIER',assertion_links:links});
  assert.equal(saved.canonical_url,`https://get-files.invalid/research/${id}`);assert.equal(saved.authority_tier,null);
  await fs.rm(root,{recursive:true,force:true});
});
