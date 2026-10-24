import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { acquireSource } from '../src/source-acquisition.js';
import { prepareProjectPdfText } from '../src/source-normalization.js';

test('PDF acquisition detects native bytes, extracts text, and retains the original', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rw-pdf-'));
  const bytes=Buffer.from('%PDF-test');
  try {
    const result=await acquireSource('https://example.gov/pdf',{
      storageRoot:root, lookup:async()=>[{address:'203.0.113.10'}],
      fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'application/octet-stream'}}),
      extractPdf:async file=>{assert.deepEqual(await fs.readFile(file),bytes);return '<!-- PDF page 1 -->\n\nAn official finding.';},
    });
    assert.equal(result.mediaType,'application/pdf');
    assert.match(await fs.readFile(result.normalizedPath,'utf8'),/official finding/);
    assert.equal(result.normalizationError,null);
    assert.equal(result.contentHash,crypto.createHash('sha256').update(bytes).digest('hex'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('unreadable PDFs retain native bytes without fabricating normalized evidence',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rw-pdf-'));
  try {
    const result=await acquireSource('https://example.gov/pdf',{
      storageRoot:root,lookup:async()=>[{address:'203.0.113.10'}],fetchImpl:async()=>new Response('%PDF-test'),
      extractPdf:async()=>{throw new Error('Needs OCR');},
    });
    assert.equal(result.normalizedPath,null);assert.equal(result.normalizationError,'Needs OCR');
    assert.equal(await fs.readFile(result.originalPath,'utf8'),'%PDF-test');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('stored PDF repair checks hashes and never refetches the original',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rw-pdf-'));
  const key='aa/hash/original/source.pdf',updates=[];
  try {
    await fs.mkdir(path.dirname(path.join(root,key)),{recursive:true});await fs.writeFile(path.join(root,key),'%PDF-test');
    const hash=crypto.createHash('sha256').update('%PDF-test').digest('hex');
    const pool={query:async(sql,args)=>sql.startsWith('SELECT')?{rows:[{source_id:'a',original_storage_path:key,content_hash:hash},{source_id:'b',original_storage_path:key,content_hash:'changed'}]}:(updates.push(args),{rows:[]})};
    let extracted=0;
    const result=await prepareProjectPdfText(pool,root,'project',async()=>{extracted++;return 'Page text';});
    assert.equal(extracted,1);assert.equal(result.prepared,1);assert.equal(result.needs_attention,1);
    assert.match(result.sources[1].reason,/hash mismatch/);
    assert.equal(await fs.readFile(path.join(root,updates[0][1]),'utf8'),'Page text');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
