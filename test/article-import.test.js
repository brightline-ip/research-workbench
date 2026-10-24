import test from 'node:test';
import assert from 'node:assert/strict';
import { ArticleImportService } from '../src/article-import.js';

test('markdown import creates an immutable checkpoint with provenance metadata',async()=>{
  let saved;
  const repository={saveCheckpoint:async(id,value)=>(saved={id,...value},{article_version_id:'v1'})};
  const service=new ArticleImportService(repository,{artifactPython:null});
  const result=await service.import('p1',{filename:'My Article.md',data:Buffer.from('# Heading\n\nClaim.')});
  assert.equal(saved.title,'My Article');assert.equal(saved.content_markdown,'# Heading\n\nClaim.');
  assert.equal(result.import.format,'md');assert.equal(result.import.byte_length,17);assert.equal(result.import.content_hash.length,64);
});

test('article import rejects unsupported formats',async()=>{
  const service=new ArticleImportService({},{artifactPython:null});
  await assert.rejects(()=>service.import('p1',{filename:'article.exe',data:Buffer.from('x')}),/supported article formats/);
});
