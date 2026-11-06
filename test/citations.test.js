import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitation, parseCitation, pinHolds } from '../src/citations.js';

const passage=(source_id,title,text,sequence_number=0,canonical_url='')=>({source_id,title,canonical_url,passage_text:text,sequence_number});
const quote='shall not be prior art to the claimed invention';
const page=(n,text,printed)=>`<!-- source_locator: page:${n} -->\n${text}${printed?`\n${printed}`:''}\n`;
const oa=passage('oa','Office Action.pdf',page(1,'The claims are rejected.')+page(3,`The examiner says it ${quote} here.`));
const guide=passage('guide','hartwell-guide.txt','Licensees must file quarterly reports within thirty days of each quarter end.');
const claim=(citation,text=`The action says it "${quote}".`)=>({citation_as_written:citation,evidence_span:text,assertion_text:text});
const verified=source_id=>({status:'VERIFIED',source_id,extracted_passage:quote});
const clean={codes:[],notes:[],status:null};

test('real citation forms are recognised',()=>{
  const ids=text=>parseCitation(text).ids.map(i=>i.kind);
  assert.deepEqual(ids('U.S. Patent No. 9,876,543'),['number']);
  assert.deepEqual(ids('US 9876543 B2'),['number']);
  assert.deepEqual(ids('US 2019/0123456'),['number']);
  assert.deepEqual(ids("the '543 patent"),['short']);
  assert.deepEqual(ids('123 F.3d 456'),['reporter']);
  assert.deepEqual(ids('550 U.S. 398'),['reporter']);
  assert.deepEqual(ids('35 U.S.C. § 102(b)(1)'),['section']);
  assert.deepEqual(ids('37 C.F.R. 1.116'),['section']);
  assert.deepEqual(ids('MPEP § 2143'),['section']);
  assert.deepEqual(parseCitation('Ariad Pharms., Inc. v. Eli Lilly & Co.').ids[0].parties,['ariad','eli']);
  const pinOf=text=>parseCitation(text).pins[0];
  assert.deepEqual(pinOf('35 U.S.C. 102(b)(1)').subs,['(b)','(1)']);
  assert.equal(pinOf('Office Action at 3').kind,'page');
  assert.equal(pinOf('Office Action at 3-4').to,4);
  assert.equal(pinOf('Smith, ¶ 12').value,12);
  assert.equal(pinOf('Smith [0012]').value,12);
  assert.equal(pinOf('Smith, col. 3, ll. 5-7').kind,'unchecked');
  assert.equal(parseCitation('123 F.3d 456, 460 (Fed. Cir.)').pins.at(-1).kind,'unchecked','a reporter page is not a page of the copy');
});

test('a document named after the authority wins over one that lists it',()=>{
  const action=passage('oa','Office Action.pdf','References cited: U.S. Patent No. 9,876,543. The examiner says it shall not be prior art to the claimed invention at all.');
  const reference=passage('ref','US9876543B2.pdf','The lever arm is attached to the base member by a hinge in this design.');
  const text=`U.S. Patent No. 9,876,543 says "shall not be prior art to the claimed invention".`;
  const check=checkCitation({citation_as_written:'U.S. Patent No. 9,876,543',evidence_span:text,assertion_text:text},[action,reference],{status:'VERIFIED',source_id:'oa',extracted_passage:'shall not be prior art to the claimed invention'});
  assert.ok(check.codes.includes('QUOTE_IN_OTHER_SOURCE'));assert.equal(check.status,'MISCITED');
  assert.deepEqual(parseCitation('In re Bilski, 545 F.3d 943').ids.map(id=>id.kind).sort(),['case','reporter']);
});

test('ordinary prose is not a citation',()=>{
  for(const text of ['The company reported revenue of $2,500,000 in 2019.','It sold 1,250,000 units.','In 2021 U.S. 30-year mortgage rates rose.'])
    assert.deepEqual(parseCitation(null,text).ids,[],text);
  for(const text of ['The composition was heated at 150 degrees.','It began at 10:30.','[2019] EWCA Civ 12'])
    assert.deepEqual(parseCitation(null,text).pins,[],text);
  const sentence='The composition was heated at 150 degrees for two hours.';
  assert.deepEqual(checkCitation({citation_as_written:null,evidence_span:sentence,assertion_text:sentence},[guide],{status:'VERIFIED',source_id:'guide'}),clean);
  const money='The company reported revenue of $2,500,000 in 2019.';
  assert.deepEqual(checkCitation({citation_as_written:null,evidence_span:money,assertion_text:money},[guide],{status:'VERIFIED',source_id:'guide'}),clean);
});

test('an authority absent from the run is unconfirmed, not wrong',()=>{
  const check=checkCitation(claim('U.S. Patent No. 9,876,543'),[oa,guide],verified('oa'));
  assert.deepEqual(check.codes,['CITED_SOURCE_NOT_IN_SOURCES']);assert.equal(check.status,'UNVERIFIABLE');assert.match(check.notes[0],/does not show it is wrong/);
});

test('an authority discussed in a source body is not called absent',()=>{
  const body=passage('oa','Office Action.pdf',`${'Background text. '.repeat(200)} Smith, U.S. Patent No. 5,000,001, discloses a lever arm.`);
  const text='Smith, U.S. Patent No. 5,000,001, discloses a lever arm.';
  const check=checkCitation({citation_as_written:'Smith, U.S. Patent No. 5,000,001',evidence_span:text,assertion_text:text},[body],{status:'VERIFIED',source_id:'oa',extracted_passage:text});
  assert.deepEqual(check.codes,[]);assert.equal(check.status,null);
});

test('loose matches no longer pass a named authority',()=>{
  const text='The claim fails.';
  const room=passage('r','Lease','The office is in Room 102 of the building.');
  assert.deepEqual(checkCitation({citation_as_written:'35 U.S.C. § 102',evidence_span:text,assertion_text:text},[room],{status:'VERIFIED',source_id:'r'}).codes,['CITED_SOURCE_NOT_IN_SOURCES']);
  const words=passage('w','Notes','We believe the include file is fine.');
  assert.deepEqual(checkCitation({citation_as_written:'Ariad Pharms., Inc. v. Eli Lilly',evidence_span:text,assertion_text:text},[words],{status:'VERIFIED',source_id:'w'}).codes,['CITED_SOURCE_NOT_IN_SOURCES']);
  const statute=passage('st','§102. Conditions','35 U.S.C. 102 Novelty.',0,'https://uscode.house.gov/us/usc/t35/s102/');
  assert.deepEqual(checkCitation({citation_as_written:'35 U.S.C. § 102',evidence_span:text,assertion_text:text},[statute],{status:'VERIFIED',source_id:'st'}),clean);
});

test('subsections are checked after the section',()=>{
  const statute=passage('st','§102. Conditions','§102. Novelty. (a) A person. (b) Exceptions. (1) Disclosures made 1 year or less.');
  const text='A disclosure within 1 year is excepted.';
  const ask=citation=>checkCitation({citation_as_written:citation,evidence_span:text,assertion_text:text},[statute],{status:'VERIFIED',source_id:'st'});
  assert.deepEqual(ask('35 U.S.C. 102(b)(1)'),clean);
  const wrong=ask('35 U.S.C. 102(c)(9)');
  assert.deepEqual(wrong.codes,['WRONG_PIN_CITE']);assert.equal(wrong.status,'MISCITED');
});

test('a quotation must be in the cited source when the citation is sure',()=>{
  const memo=passage('m','Hartwell Licensing Guide',guide.passage_text);
  const check=checkCitation(claim('Hartwell Licensing Guide'),[oa,memo],verified('oa'));
  assert.ok(check.codes.includes('QUOTE_IN_OTHER_SOURCE'));assert.ok(check.codes.includes('CITED_SOURCE_NOT_USED'));assert.equal(check.status,'MISCITED');
});

test('a short form finds its patent, and generic words pick nothing',()=>{
  const patent=passage('pat','US9876543B2.pdf',page(3,'the lever arm is attached to the base member by a hinge'));
  const response=passage('resp','Patent Owner Response.docx','We respond to the rejection.');
  const text='The \'543 patent at 3 discloses that "the lever arm is attached to the base member by a hinge".';
  const citation="The '543 patent at 3";
  const check=checkCitation({citation_as_written:citation,evidence_span:text,assertion_text:text},[oa,patent,response],{status:'VERIFIED',source_id:'pat',extracted_passage:'the lever arm is attached to the base member by a hinge'});
  assert.deepEqual(check,clean);
  assert.equal(checkCitation(claim('the patent'),[oa,response],verified('oa')).status,null);
});

test('a single distinctive word can point at a source but cannot overturn',()=>{
  const decl=passage('d','Smith-Declaration.pdf','Unrelated text.');
  const check=checkCitation(claim('Smith Decl.'),[oa,decl],verified('oa'));
  assert.ok(check.codes.includes('CITED_SOURCE_NOT_USED'));assert.equal(check.status,null);
});

test('a page pin is confirmed by the page\'s own printed number',()=>{
  const brief=passage('b','Brief',page(1,'Cover')+page(2,'Contents')+page(3,`It ${quote}.`,'1')+page(4,'Other text.','2'));
  const ask=citation=>checkCitation(claim(citation),[brief],{status:'VERIFIED',source_id:'b',extracted_passage:quote});
  assert.deepEqual(ask('Brief at 1'),clean,'printed page 1 is the file\'s third page');
  const wrong=ask('Brief at 2');
  assert.deepEqual(wrong.codes,['WRONG_PIN_CITE']);assert.equal(wrong.status,'MISCITED');assert.match(wrong.notes[0],/printed page 1/);
});

test('without printed numbers a page pin never overturns, and says where the words are',()=>{
  assert.deepEqual(checkCitation(claim('office action at 3'),[oa],verified('oa')),clean);
  const other=checkCitation(claim('office action at 1'),[oa],verified('oa'));
  assert.deepEqual(other.codes,['PIN_NOT_CHECKED']);assert.equal(other.status,null);assert.match(other.notes[0],/page 3 of the file/);
});

test('a quotation across a page break and a missing page do not raise an alarm',()=>{
  const split=passage('s','Exhibit Binder',page(4,'It shall not be prior')+page(5,'art to the claimed invention.'));
  assert.equal(pinHolds({kind:'page',from:4,to:4,label:'at 4'},split.passage_text,quote).holds,true);
  const gap=passage('g','Exhibit Binder',page(1,'One.')+page(3,`It ${quote}.`));
  assert.equal(checkCitation(claim('exhibit binder at 2'),[gap],{status:'VERIFIED',source_id:'g',extracted_passage:quote}).status,null);
});

test('column and line cites are reported as unchecked and notes are short and single',()=>{
  const check=checkCitation(claim(`office action, col. 3, ll. 5-7 ${'x'.repeat(5000)}`),[oa],verified('oa'));
  assert.deepEqual(check.codes,['PIN_NOT_CHECKED']);assert.equal(check.status,null);assert.ok(check.notes.join(' ').length<300);
  const twice=claim('office action at 1','The action at 1 says it "shall not be prior art to the claimed invention".');
  assert.equal(checkCitation(twice,[oa],verified('oa')).notes.length,1);
});

test('paragraph and slide numbers are real numbers, so a wrong one can overturn',()=>{
  const app=`[0011] First paragraph here. [0012] The widget has a lever arm attached. [0013] Next.`;
  assert.equal(pinHolds({kind:'paragraph',value:12},app,'widget has a lever').holds,true);
  assert.deepEqual(pinHolds({kind:'paragraph',value:11},app,'widget has a lever'),{holds:false,where:'paragraph 12'});
  assert.equal(pinHolds({kind:'paragraph',value:1},'no marks','x').holds,null);
  const deck='<!-- source_locator: slide:2 -->\nRevenue grew.\n<!-- source_locator: slide:3 -->\nOther.';
  assert.equal(pinHolds({kind:'slide',value:2},deck,'revenue grew').holds,true);
  assert.deepEqual(pinHolds({kind:'slide',value:3},deck,'revenue grew'),{holds:false,where:'slide 2'});
});
