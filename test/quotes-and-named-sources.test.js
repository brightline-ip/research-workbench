import test from 'node:test';
import assert from 'node:assert/strict';
import { missingQuotes, overturnsResult, quotedPieces, validateVerificationEvidence } from '../src/passages.js';
import { sanitizeDiscoveredUrl } from '../src/discovery-urls.js';
import { revisionFindings } from '../src/revision-policy.js';
import { decodeHtmlEntities } from '../src/source-acquisition.js';
import { fetchJson, isPermanentProviderFailure } from '../src/safety.js';
import { LOCAL_SOURCE_PREFIX } from '../src/corpus-import.js';
import { DiscoveryService } from '../src/discovery.js';

const passage=(text,sequence_number=0,source_id='s')=>({source_id,passage_id:`p${sequence_number}`,sequence_number,passage_text:text});
const sentence='A disclosure made 1 year or less before the effective filing date shall not be prior art.';

test('VERIFIED needs a quote long enough to judge; other statuses may quote briefly',()=>{
  const candidates=[passage(sentence)];
  assert.throws(()=>validateVerificationEvidence({status:'VERIFIED',source_id:'s',passage_id:'p0',extracted_passage:'1 year'},candidates),/long enough/);
  assert.ok(validateVerificationEvidence({status:'VERIFIED',source_id:'s',passage_id:'p0',extracted_passage:sentence},candidates));
  assert.ok(validateVerificationEvidence({status:'CONTRADICTED',source_id:'s',passage_id:'p0',extracted_passage:'1 year'},candidates));
});

test('quotations are split at ellipses and brackets, and short phrases are not treated as quotations',()=>{
  assert.deepEqual(quotedPieces('The court said “the claim is plainly invalid ... under the statute as written.”'),['the claim is plainly invalid','under the statute as written']);
  assert.ok(overturnsResult('the claim is plainly invalid'));assert.ok(!overturnsResult('the Licensed Products'));
  assert.deepEqual(quotedPieces('So-called "scare quotes" and 5" screens'),[]);
});

test('a quotation is checked word for word across passages, ignoring typography, case and spacing',()=>{
  const passages=[passage('The patent shall last until the end of',0),passage('twenty years, the Act’s full term.',1)];
  assert.deepEqual(missingQuotes({assertion_text:'It says "until the end of twenty years".'},passages),[]);
  assert.deepEqual(missingQuotes({assertion_text:'It says "the ACT\'S FULL   term".'},passages),[]);
  assert.deepEqual(missingQuotes({assertion_text:'It says "until the end of thirty years".'},passages),['until the end of thirty years']);
  assert.deepEqual(missingQuotes({assertion_text:'"a well-known \ufb01eld of law"'},[passage('A well-\nknown fi'),{...passage('eld of law.',1)}]),[],'a word cut by a passage boundary or a line-break hyphen, and a ligature');
  assert.deepEqual(missingQuotes({assertion_text:'No quotation here.'},passages),[]);
});

test('a quotation is found only within one source, not across two',()=>{
  const passages=[passage('the first half',0,'a'),passage('of the sentence',1,'b')];
  assert.deepEqual(missingQuotes({assertion_text:'"the first half of the sentence"'},passages),['the first half of the sentence']);
});

test('a reserved address can never be a discovered source',()=>{
  assert.throws(()=>sanitizeDiscoveredUrl(`${LOCAL_SOURCE_PREFIX}research/${'a'.repeat(64)}`),/reserved/);
});

test('Fix draft leaves claims where nothing was compared out of its findings',()=>{
  const assertions=[{assertion_id:'a'},{assertion_id:'b'}];
  const found=revisionFindings(assertions,[{assertion_id:'a',status:'UNSUPPORTED',not_checked_reason:null},{assertion_id:'b',status:'UNVERIFIABLE',not_checked_reason:'NO_SOURCES'}]);
  assert.deepEqual(found.map(r=>r.assertion_id),['a']);
});

test('HTML entities in a source decode once, including the ones law pages use',()=>{
  assert.equal(decodeHtmlEntities('you&rsquo;re &sect; 102 &#8212; a&#x20;b &amp;lt; &unknown;'),'you’re § 102 — a b &lt; &unknown;');
});

test('a provider rejection names its error code, never its message, and no credit is not worth retrying',async()=>{
  const reply=(status,body)=>async()=>new Response(JSON.stringify(body),{status});
  await assert.rejects(fetchJson(reply(429,{error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'secret text'}}),'https://x',{}),error=>{
    assert.equal(error.providerReason,'HTTP 429: credit_balance_exhausted');assert.ok(!error.message.includes('secret text'));return true});
  await assert.rejects(fetchJson(reply(429,{error:{code:'Not A Code!',message:'x'}}),'https://x',{}),error=>error.providerReason==='HTTP 429');
  assert.ok(isPermanentProviderFailure('HTTP 429: credit_balance_exhausted'));
  assert.ok(!isPermanentProviderFailure('HTTP 429: rate_limit_exceeded'));
});

test('web discovery never reuses a file a caller named',async()=>{
  const queries=[];
  const service=Object.create(DiscoveryService.prototype);
  service.pool={query:async(sql,params)=>(queries.push({sql,params}),{rows:[]})};
  await service.warehouseCandidates({normalized_proposition:'a statement about patents'});
  assert.match(queries[0].sql,/canonical_url NOT LIKE \$2/);
  assert.equal(queries[0].params[1],`${LOCAL_SOURCE_PREFIX}%`);
});
