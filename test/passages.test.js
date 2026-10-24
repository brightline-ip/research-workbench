import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkNormalizedText, rankPassages, validateVerificationEvidence } from '../src/passages.js';

test('passage chunks preserve exact normalized offsets and locators', () => {
  const text='First paragraph.\n\nThe official value is 42.\nSecond line.';
  const chunks=chunkNormalizedText(text,30);
  assert.ok(chunks.length>=2);
  for(const c of chunks) assert.equal(text.slice(c.normalized_start_offset,c.normalized_end_offset),c.passage_text);
  assert.match(chunks[1].locator,/normalized lines/);
});

test('deterministic retrieval ranks overlapping evidence', () => {
  const ranked=rankPassages('The official value is 42.',[
    {sequence_number:0,passage_text:'Unrelated background.'},
    {sequence_number:1,passage_text:'The official dataset reports a value of 42.'}
  ]);
  assert.equal(ranked[0].sequence_number,1);
});

test('verification rejects non-verbatim evidence and unsupported VERIFIED', () => {
  assert.throws(()=>validateVerificationEvidence({status:'VERIFIED',source_id:null,passage_id:null,extracted_passage:null},[]),/requires/);
  assert.throws(()=>validateVerificationEvidence({status:'OVERSTATED',source_id:'s',passage_id:'p',extracted_passage:'invented'},[{source_id:'s',passage_id:'p',passage_text:'actual'}]),/not verbatim/);
});


test('long paragraphs stay bounded and irregular whitespace keeps exact offsets',()=>{
  const text='A'.repeat(5000)+'\n\n\nB paragraph.\n \nC paragraph.';
  for(const chunk of chunkNormalizedText(text,1800)){
    assert.ok(chunk.passage_text.length<=1800);
    assert.equal(text.slice(chunk.normalized_start_offset,chunk.normalized_end_offset),chunk.passage_text);
  }
  assert.throws(()=>validateVerificationEvidence({status:'VERIFIED',source_id:'s',passage_id:'p',extracted_passage:' '},[{source_id:'s',passage_id:'p',passage_text:'a b'}]),/requires/);
});
