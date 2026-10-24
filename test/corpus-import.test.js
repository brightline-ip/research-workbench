import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CorpusImportService } from '../src/corpus-import.js';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture({status='ready',badOriginal=false,normalized=Buffer.from('Official holding text.')}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'corpus-import-')),tokenFile=path.join(root,'token');await fs.writeFile(tokenFile,'test-token');
  const original=Buffer.from('official original'),id=hash(original),calls=[];let saved;
  const repository={importCorpusSource:async(project,input)=>(saved={project,input},{source:{source_id:'s'},linked_assertions:input.assertion_links.length})};
  const fetchImpl=async(url,options)=>{calls.push({url,authorization:options.headers.authorization});
    if(url.includes('/original?'))return new Response(badOriginal?Buffer.from('wrong'):original,{headers:{'content-type':'application/pdf'}});
    if(url.includes('/normalized?'))return new Response(normalized,{headers:{'content-type':'text/plain'}});
    return Response.json({id,status,title:'Official source',media_type:'application/pdf',origins:[{source_url:'https://court.gov/opinion.pdf'}],manifest:{warnings:['tables require review']}})
  };
  return {root,id,calls,get saved(){return saved},service:new CorpusImportService(repository,{baseUrl:'http://127.0.0.1:8766',tokenFile,storageRoot:path.join(root,'sources'),fetchImpl})};
}

test('imports exact corpus bytes, hashes, warnings, and explicit links without accepting paths',async()=>{
  const f=await fixture();
  const input={collection:'legal',document_id:f.id,source_type:'JUDICIAL_OPINION',assertion_links:[{assertion_id:'a',relationship_type:'SUPPORTS',proposition_source_class:'PRIMARY',classification_reason:'Direct opinion.'}]};
  const result=await f.service.import('p',input);
  assert.equal(result.linked_assertions,1);assert.equal(f.saved.input.content_hash,f.id);assert.equal(f.saved.input.provenance.retrieval_method,'SOURCE_CORPUS');
  assert.deepEqual(f.saved.input.provenance.extraction_warnings,['tables require review']);assert.ok(f.saved.input.normalized_content_hash);
  assert.ok(f.calls.every(call=>call.authorization==='Bearer test-token'));assert.ok(f.calls.every(call=>!call.url.includes('path=')));
  assert.equal(hash(await fs.readFile(path.join(f.root,'sources',f.saved.input.original_storage_path))),f.id);
});

test('fails closed on original hash mismatch and incomplete extraction',async()=>{
  const bad=await fixture({badOriginal:true});
  await assert.rejects(bad.service.import('p',{collection:'legal',document_id:bad.id,assertion_links:[{assertion_id:'a'}]}),/hash does not match/);
  const incomplete=await fixture({status:'needs_review'});
  await assert.rejects(incomplete.service.import('p',{collection:'legal',document_id:incomplete.id,assertion_links:[{assertion_id:'a'}]}),/needs_review/);
});

test('rejects arbitrary identifiers and missing explicit assertion links before network access',async()=>{
  const f=await fixture();
  await assert.rejects(f.service.import('p',{collection:'../private',document_id:f.id,assertion_links:[{assertion_id:'a'}]}),/valid collection/);
  await assert.rejects(f.service.import('p',{collection:'legal',document_id:f.id,path:'C:\\secret',assertion_links:[]}),/assertion_links/);
  assert.equal(f.calls.length,0);
});
