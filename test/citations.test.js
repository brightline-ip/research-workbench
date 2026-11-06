import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitation, parseCitation, pinHolds } from '../src/citations.js';

const passage=(source_id,title,text,sequence_number=0,canonical_url='')=>({source_id,title,canonical_url,passage_text:text,sequence_number});
const quote='shall not be prior art to the claimed invention';
const oa=passage('oa','office-action.pdf',`<!-- source_locator: page:1 -->\nThe claims are rejected.\n<!-- source_locator: page:3 -->\nThe examiner says it ${quote} here.\n`);
const guide=passage('guide','hartwell-guide.txt','Licensees must file quarterly reports within thirty days of each quarter end.');
const claim=(citation,text=`The action says it "${quote}".`)=>({citation_as_written:citation,evidence_span:text,assertion_text:text});
const verified=source_id=>({status:'VERIFIED',source_id,extracted_passage:quote});

test('citation forms are recognised',()=>{
  const ids=text=>parseCitation(text).ids.map(i=>i.kind);
  assert.deepEqual(ids('U.S. Patent No. 9,876,543'),['patent']);
  assert.deepEqual(ids('US 2019/0123456'),['publication']);
  assert.deepEqual(ids('123 F.3d 456'),['reporter']);
  assert.deepEqual(ids('35 U.S.C. § 102(b)(1)'),['section']);
  assert.deepEqual(ids('37 C.F.R. 1.116'),['section']);
  assert.deepEqual(ids('MPEP § 2143'),['section']);
  assert.deepEqual(ids('Smith Corp. v. Jones'),['case']);
  assert.deepEqual(ids('the guide'),[]);
  assert.deepEqual(parseCitation('35 U.S.C. 102(b)(1)').pins[0].subs,['(b)','(1)']);
  assert.equal(parseCitation('Office Action at 3').pins[0].kind,'page');
  assert.equal(parseCitation('Smith, ¶ 12').pins[0].value,12);
  assert.equal(parseCitation('Smith [0012]').pins[0].value,12);
  assert.equal(parseCitation('Smith, col. 3, ll. 5-7').pins[0].kind,'unchecked');
  assert.equal(parseCitation('123 F.3d 456, 460 (Fed. Cir.)').pins.at(-1).kind,'unchecked','a reporter page is not a page of the copy');
});

test('a specific authority that is not among the sources overturns a VERIFIED',()=>{
  const check=checkCitation(claim('U.S. Patent No. 9,876,543'),[oa,guide],verified('oa'));
  assert.deepEqual(check.codes,['CITED_SOURCE_NOT_IN_SOURCES']);assert.equal(check.overturn,true);assert.match(check.notes[0],/9,876,543/);
});

test('a specific authority found by its identifier passes',()=>{
  const statute=passage('st','§102. Conditions','35 U.S.C. 102 Novelty. (a) A person. (b) Exceptions. (1) Disclosures made 1 year or less.');
  const text='A disclosure within 1 year is excepted.';
  assert.deepEqual(checkCitation({citation_as_written:'35 U.S.C. 102(b)(1)',evidence_span:text,assertion_text:text},[statute],{status:'VERIFIED',source_id:'st'}).codes,[]);
  const missing=checkCitation({citation_as_written:'35 U.S.C. 102(c)(9)',evidence_span:text,assertion_text:text},[statute],{status:'VERIFIED',source_id:'st'});
  assert.deepEqual(missing.codes,['WRONG_PIN_CITE']);assert.equal(missing.overturn,true);
});

test('a quotation must be in the cited source, not merely in some source',()=>{
  const check=checkCitation(claim('Hartwell guide'),[oa,guide],verified('oa'));
  assert.ok(check.codes.includes('QUOTE_IN_OTHER_SOURCE'));assert.ok(check.codes.includes('CITED_SOURCE_NOT_USED'));assert.equal(check.overturn,true);
});

test('a quotation in the cited source passes',()=>{
  assert.deepEqual(checkCitation(claim('office action'),[oa,guide],verified('oa')),{codes:[],notes:[],overturn:false});
});

test('a page pin is checked against the page markers in the source',()=>{
  assert.deepEqual(checkCitation(claim('Office Action at 3'),[oa],verified('oa')).codes,[]);
  const wrong=checkCitation(claim('Office Action at 1'),[oa],verified('oa'));
  assert.deepEqual(wrong.codes,['WRONG_PIN_CITE']);assert.equal(wrong.overturn,true);assert.match(wrong.notes[0],/not at that spot/);
  assert.deepEqual(checkCitation(claim('Office Action at 9'),[oa],verified('oa')).codes,['WRONG_PIN_CITE'],'a page the source does not have');
});

test('a pin that cannot be checked is said to be unchecked and does not overturn',()=>{
  for(const citation of ['office action at 3 col. 3, ll. 5-7']){
    const check=checkCitation(claim(citation),[oa],verified('oa'));
    assert.ok(check.codes.includes('PIN_NOT_CHECKED'));assert.equal(check.overturn,false);
  }
  const noMarkers=passage('n','notes.txt',`Plain text where it ${quote} without page marks.`);
  const check=checkCitation(claim('notes at 3'),[noMarkers],verified('n'));
  assert.deepEqual(check.codes,['PIN_NOT_CHECKED']);assert.equal(check.overturn,false);
});

test('paragraph and slide pins',()=>{
  const app=`[0011] First paragraph here. [0012] The widget has a lever arm attached. [0013] Next.`;
  assert.equal(pinHolds({kind:'paragraph',value:12},app,'widget has a lever'),true);
  assert.equal(pinHolds({kind:'paragraph',value:11},app,'widget has a lever'),false);
  assert.equal(pinHolds({kind:'paragraph',value:99},app,null),false);
  assert.equal(pinHolds({kind:'paragraph',value:1},'no marks',null),null);
  const deck='<!-- source_locator: slide:2 -->\nRevenue grew.';
  assert.equal(pinHolds({kind:'slide',value:2},deck,'revenue grew'),true);
  assert.equal(pinHolds({kind:'slide',value:3},deck,'revenue grew'),false);
  const pdf='<!-- PDF page 4 -->\n\nA sentence on four.';
  assert.equal(pinHolds({kind:'page',value:4},pdf,'sentence on four'),true);
});

test('no citation and no quotation means nothing to check',()=>{
  assert.deepEqual(checkCitation({citation_as_written:null,evidence_span:'A plain claim.',assertion_text:'A plain claim.'},[guide],{status:'VERIFIED',source_id:'guide'}),{codes:[],notes:[],overturn:false});
});
