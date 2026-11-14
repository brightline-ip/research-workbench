import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitation, parseCitation, pinHolds } from '../src/citations.js';
import { missingQuotes } from '../src/passages.js';

const passage=(source_id,title,text,sequence_number=0,canonical_url='')=>({source_id,title,canonical_url,passage_text:text,sequence_number});
const quote='shall not be prior art to the claimed invention';
const page=(n,text,printed)=>`<!-- source_locator: page:${n} -->\n${text}${printed?`\n${printed}`:''}\n`;
const oa=passage('oa','Office Action.pdf',page(1,'The claims are rejected.')+page(3,`The examiner says it ${quote} here.`));
const guide=passage('guide','hartwell-guide.txt','Licensees must file quarterly reports within thirty days of each quarter end.');
const claim=(citation,text=`The action says it "${quote}".`)=>({citation_as_written:citation,evidence_span:text,assertion_text:text});
const verified=source_id=>({status:'VERIFIED',source_id,extracted_passage:quote});
const clean={codes:[],notes:[],status:null};
const plainClaim=(citation,text='The claim fails.')=>({citation_as_written:citation,evidence_span:text,assertion_text:text});

test('real citation forms are recognised',()=>{
  const ids=text=>parseCitation(text).ids.map(i=>i.kind);
  assert.deepEqual(ids('U.S. Patent No. 9,876,543'),['number']);
  assert.deepEqual(ids('US 9876543 B2'),['number']);
  assert.deepEqual(ids('US 2019/0123456'),['number']);
  assert.deepEqual(ids("the '543 patent"),['short']);
  assert.deepEqual(ids('123 F.3d 456'),['reporter']);
  assert.deepEqual(ids('550 U.S. 398'),['reporter']);
  assert.deepEqual(ids('KSR, 550 U.S. at 416'),['reporter']);
  assert.deepEqual(ids('35 U.S.C. § 102(b)(1)'),['section']);
  assert.deepEqual(ids('37 C.F.R. 1.116'),['section']);
  assert.deepEqual(ids('MPEP § 2143'),['section']);
  assert.deepEqual(parseCitation('Ariad Pharms., Inc. v. Eli Lilly & Co.').ids[0].parties,[['ariad'],['eli','lilly']]);
  assert.deepEqual(parseCitation('Bd. of Trs. of Leland Stanford Jr. Univ. v. Roche').ids[0].parties,[['leland','stanford'],['roche']]);
  assert.deepEqual(parseCitation('United States v. Jones').ids[0].parties,[['jones']]);
  assert.deepEqual(parseCitation('Compare Bilski v. Kappos').ids[0].parties,[['bilski'],['kappos']]);
  assert.deepEqual(parseCitation('In re Bilski, 545 F.3d 943').ids.map(id=>id.kind).sort(),['case','reporter']);
  const pinOf=text=>parseCitation(text).pins[0];
  assert.deepEqual(pinOf('35 U.S.C. 102(b)(1)').subs,['(b)','(1)']);
  assert.equal(pinOf('Office Action at 3').kind,'page');
  assert.equal(pinOf('Office Action at 3-4').to,4);
  assert.equal(pinOf('Smith, ¶ 12').value,12);
  assert.equal(pinOf('Smith [0012]').value,12);
  assert.equal(pinOf('Smith, col. 3, ll. 5-7').kind,'unchecked');
  assert.equal(parseCitation('123 F.3d 456, 460 (Fed. Cir.)').pins.at(-1).kind,'unchecked','a reporter page is not a page of the copy');
});

test('ordinary prose is not a citation',()=>{
  for(const text of ['The company reported revenue of $2,500,000 in 2019.','It sold 1,250,000 units.','In 2021 U.S. 30-year mortgage rates rose.','Revenue Q1 vs. Q2 grew.','Plan A vs. Plan B.'])
    assert.deepEqual(parseCitation(null,text).sentenceIds,[],text);
  for(const text of ['The composition was heated at 150 degrees.','It began at 10:30.','[2019] EWCA Civ 12'])
    assert.deepEqual(parseCitation(null,text).pins,[],text);
  for(const text of ['The composition was heated at 150 degrees for two hours.','The company reported revenue of $2,500,000 in 2019.'])
    assert.deepEqual(checkCitation(plainClaim(null,text),[guide],{status:'VERIFIED',source_id:'guide'}),clean,text);
});

test('an office-action response: a reference named in the sentence does not replace the citation',()=>{
  const action=passage('oa','Office Action.pdf',page(4,'Smith does not disclose a hinge coupled to the base member, as conceded here.'));
  const smith=passage('ref','US5000001.pdf','Smith teaches a lever arm.');
  const text='Smith (U.S. Patent No. 5,000,001) does not disclose a hinge coupled to the base member, as the Examiner concedes (Office Action at 4).';
  const check=checkCitation(plainClaim('Office Action at 4',text),[action,smith],{status:'VERIFIED',source_id:'oa',extracted_passage:'Smith does not disclose a hinge coupled to the base member'});
  assert.deepEqual(check,clean);
  const absent=checkCitation(plainClaim('Office Action at 4',text),[action],{status:'VERIFIED',source_id:'oa',extracted_passage:'Smith does not disclose a hinge coupled to the base member'});
  assert.deepEqual(absent.codes,['CITED_SOURCE_NOT_IN_SOURCES']);assert.equal(absent.status,null,'noted, because the citation itself holds');
});

test('an authority absent from the run is unconfirmed, not wrong',()=>{
  const check=checkCitation(claim('U.S. Patent No. 9,876,543'),[oa,guide],verified('oa'));
  assert.deepEqual(check.codes,['CITED_SOURCE_NOT_IN_SOURCES']);assert.equal(check.status,'UNVERIFIABLE');assert.match(check.notes[0],/does not show it is wrong/);
});

test('an authority discussed in a source body is not called absent',()=>{
  const body=passage('oa','Office Action.pdf',`${'Background text. '.repeat(200)} Smith, U.S. Patent No. 5,000,001, discloses a lever arm.`);
  const text='Smith, U.S. Patent No. 5,000,001, discloses a lever arm.';
  assert.equal(checkCitation(plainClaim('Smith, U.S. Patent No. 5,000,001',text),[body],{status:'VERIFIED',source_id:'oa',extracted_passage:text}).status,null);
  assert.equal(checkCitation(plainClaim("The '001 patent",text),[body],{status:'VERIFIED',source_id:'oa',extracted_passage:text}).status,null,'a short form found in the body');
  const ksr=passage('oa','Office Action.pdf','Under KSR Int\'l Co. v. Teleflex Inc., 550 U.S. 398, 416, it would have been obvious.');
  assert.equal(checkCitation(plainClaim('KSR, 550 U.S. at 416'),[ksr],{status:'VERIFIED',source_id:'oa'}).status,null);
});

test('loose matches no longer pass a named authority',()=>{
  const room=passage('r','Lease','The office is in Room 102 of the building.');
  assert.deepEqual(checkCitation(plainClaim('35 U.S.C. § 102'),[room],{status:'VERIFIED',source_id:'r'}).codes,['CITED_SOURCE_NOT_IN_SOURCES']);
  const words=passage('w','Notes','We believe the include file is fine.');
  assert.deepEqual(checkCitation(plainClaim('Ariad Pharms., Inc. v. Eli Lilly'),[words],{status:'VERIFIED',source_id:'w'}).codes,['CITED_SOURCE_NOT_IN_SOURCES']);
  const statute=passage('st','§102. Conditions','35 U.S.C. 102 Novelty.',0,'https://uscode.house.gov/us/usc/t35/s102/');
  assert.deepEqual(checkCitation(plainClaim('35 U.S.C. § 102'),[statute],{status:'VERIFIED',source_id:'st'}),clean);
});

test('subsections are checked only against the statute itself',()=>{
  const statute=passage('st','§102. Conditions','§102. Novelty. (a) A person. (b ) Exceptions. (1) Disclosures made 1 year or less.');
  const ask=(citation,source)=>checkCitation(plainClaim(citation),[source],{status:'VERIFIED',source_id:source.source_id});
  assert.deepEqual(ask('35 U.S.C. 102(b)(1)',statute),clean,'spacing from OCR does not matter');
  const version=ask('35 U.S.C. 102(c)(9)',statute);
  assert.deepEqual(version.codes,['PIN_NOT_CHECKED'],'a statute has versions');assert.equal(version.status,null);assert.match(version.notes[0],/different version/);
  const action=passage('oa','Office Action.pdf','The claims are rejected under 35 U.S.C. 102(a)(2).');
  const elsewhere=ask('35 U.S.C. § 102(b)(2)(C)',action);
  assert.deepEqual(elsewhere.codes,['PIN_NOT_CHECKED']);assert.equal(elsewhere.status,null);
});

test('a quotation must be in the cited source when the citation is sure',()=>{
  const memo=passage('m','Hartwell Licensing Guide',guide.passage_text);
  const check=checkCitation(claim('Hartwell Licensing Guide'),[oa,memo],verified('oa'));
  assert.deepEqual(check.codes,['QUOTE_IN_OTHER_SOURCE','CITED_SOURCE_NOT_USED']);assert.equal(check.status,'MISCITED');
});

test('an Office Action quoting the case a response cites is fine',()=>{
  const words='the combination of familiar elements according to known methods is likely to be obvious';
  const ksr=passage('ksr','KSR Intl v Teleflex opinion',`KSR v. Teleflex, 550 U.S. 398. ${words} when it does no more.`);
  const action=passage('oa','Office Action.pdf',`As KSR said, ${words}.`);
  const result={status:'VERIFIED',source_id:'oa',extracted_passage:words};
  assert.deepEqual(checkCitation(plainClaim('KSR, 550 U.S. 398'),[ksr,action],result),clean);
  const only=checkCitation(plainClaim('KSR, 550 U.S. 398'),[passage('ksr','KSR opinion','KSR v. Teleflex, 550 U.S. 398. Other words entirely.'),action],result);
  assert.deepEqual(only.codes,['CITED_SOURCE_NOT_USED']);assert.equal(only.status,'UNVERIFIABLE');
});

test('page furniture and stray numbers inside a quotation are not a false alarm',()=>{
  const cmecf=passage('b','Opinion',`The court held that the shall not be prior\nCase 1:19-cv-01234 Document 45 Filed 01/02/20 Page 8 of 30 PageID #: 1234\nart to the claimed invention at all.`);
  assert.deepEqual(missingQuotes({assertion_text:'It says "shall not be prior art to the claimed invention".'},[cmecf]),[]);
  const footnote=passage('f','Opinion','The inventor knew at the time of invention3 and addressed the problem directly.');
  assert.deepEqual(missingQuotes({assertion_text:'It says "at the time of invention and addressed the problem".'},[footnote]),[]);
  const transcript=passage('t','Deposition','2 A. Yes, we tested the device\n3 and it failed every time we ran it.');
  assert.deepEqual(missingQuotes({assertion_text:'He said "we tested the device and it failed every time".'},[transcript]),[]);
  assert.deepEqual(missingQuotes({assertion_text:'It says "the moon is made of green cheese today".'},[cmecf]),['the moon is made of green cheese today'],'a truly absent quotation is still caught');
});

test('a document named after the authority wins over one that lists it',()=>{
  const action=passage('oa','Office Action.pdf',`References cited: U.S. Patent No. 9,876,543. The examiner says it ${quote} at all.`);
  const reference=passage('ref','US9876543B2.pdf','The lever arm is attached to the base member by a hinge in this design.');
  const text=`U.S. Patent No. 9,876,543 says "${quote}".`;
  const check=checkCitation(plainClaim('U.S. Patent No. 9,876,543',text),[action,reference],verified('oa'));
  assert.ok(check.codes.includes('QUOTE_IN_OTHER_SOURCE'));assert.equal(check.status,'MISCITED');
});

test('a short form finds its patent, and generic words pick nothing',()=>{
  const hinge='the lever arm is attached to the base member by a hinge';
  const patent=passage('pat','US9876543B2.pdf',page(3,hinge));
  const response=passage('resp','Patent Owner Response.docx','We respond to the rejection.');
  const text=`The '543 patent at 3 discloses that "${hinge}".`;
  assert.deepEqual(checkCitation(plainClaim("The '543 patent at 3",text),[oa,patent,response],{status:'VERIFIED',source_id:'pat',extracted_passage:hinge}),clean);
  assert.equal(checkCitation(claim('the patent'),[oa,response],verified('oa')).status,null);
});

test('a single distinctive word can point at a source but cannot overturn',()=>{
  const decl=passage('d','Smith-Declaration.pdf','Unrelated text.');
  const check=checkCitation(claim('Smith Decl.'),[oa,decl],verified('oa'));
  assert.ok(check.codes.includes('CITED_SOURCE_NOT_USED'));assert.equal(check.status,null);
});

test('a page pin follows a believable printed number',()=>{
  const brief=passage('b','Brief',page(1,'Cover')+page(2,'Contents')+page(3,`It ${quote}.`,'1')+page(4,'Other text.','2')+page(5,'More text.','3'));
  const ask=citation=>checkCitation(claim(citation),[brief],{status:'VERIFIED',source_id:'b',extracted_passage:quote});
  assert.deepEqual(ask('Brief at 1'),clean,'printed page 1 is the file\'s third page');
  const byFile=ask('Brief at 3');
  assert.deepEqual(byFile.codes,['PIN_NOT_CHECKED'],'the file\'s own page, reported because the page prints another number');assert.equal(byFile.status,null);assert.match(byFile.notes[0],/printed page 1/);
  const wrong=ask('Brief at 2');
  assert.deepEqual(wrong.codes,['WRONG_PIN_CITE']);assert.equal(wrong.status,'MISCITED');assert.match(wrong.notes[0],/printed page 1/);
});

test('real extracted text: a footer number before the next page heading, and a quotation across pages',()=>{
  const marked=(n,text)=>`## Page ${n}\n<!-- source_locator: page:${n} -->\n\n${text}\n\n`;
  const brief=passage('b','Brief',marked(1,'Cover')+marked(2,`It ${quote}.\n1`)+marked(3,'Other text.\n2')+marked(4,'More text.\n3'));
  const ask=citation=>checkCitation(claim(citation),[brief],{status:'VERIFIED',source_id:'b',extracted_passage:quote});
  assert.deepEqual(ask('Brief at 1'),clean);
  assert.equal(ask('Brief at 3').status,'MISCITED');
  const split=[passage('s','Exhibit Binder',marked(4,'It shall not be prior\n3')+marked(5,'art to the claimed invention.\n4'))];
  assert.deepEqual(missingQuotes(claim('exhibit binder'),split),[],'a page break, its heading and a page number do not hide the words');
  assert.deepEqual(checkCitation(claim('exhibit binder at 3'),split,{status:'VERIFIED',source_id:'s',extracted_passage:null}),clean);
});

test('line numbers, years and table figures are not printed page numbers',()=>{
  const pleading=passage('c','Complaint',page(1,'Intro.','28')+page(2,`It ${quote}.`,'28')+page(3,'More.','28'));
  assert.equal(checkCitation(claim('Complaint at 5'),[pleading],{status:'VERIFIED',source_id:'c',extracted_passage:quote}).status,null);
  const report=passage('r','Annual Report',page(1,'Intro.')+page(3,`It ${quote}.\nRevenue by year\n2019`)+page(4,'Other.'));
  const check=checkCitation(claim('Annual Report at 2'),[report],{status:'VERIFIED',source_id:'r',extracted_passage:quote});
  assert.deepEqual(check.codes,['PIN_NOT_CHECKED']);assert.equal(check.status,null);
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
  assert.equal(checkCitation(claim('office action at 1','The action at 1 says it "shall not be prior art to the claimed invention".'),[oa],verified('oa')).notes.length,1);
});

test('paragraph marks must start a line, and a mere reference is not one',()=>{
  const app='[0011] First paragraph here.\n[0012] The widget has a lever arm attached.\n[0013] Next.';
  assert.equal(pinHolds({kind:'paragraph',value:12},app,'widget has a lever').holds,true);
  assert.deepEqual(pinHolds({kind:'paragraph',value:11},app,'widget has a lever'),{holds:false,where:'paragraph 12'});
  assert.equal(pinHolds({kind:'paragraph',value:1},'no marks','x').holds,null);
  assert.equal(pinHolds({kind:'paragraph',value:52},'[0044] Text. [0052] the widget has a lever arm','widget has a lever').holds,true,'a mark left in mid-line by two-column extraction');
  assert.equal(pinHolds({kind:'paragraph',value:99},'[0044] the widget has a lever arm','widget has a lever').holds,null,'the cited paragraph is not there, so nothing can be said');
  const okafor='[0030] A hinge connects the housings.\n[0031] A damping spring is coupled to the hinge to reduce vibration during operation.\n[0032] Other.';
  assert.equal(pinHolds({kind:'paragraph',value:31},okafor,'[0031] A damping spring is coupled to the hinge to reduce vibration during operation.').holds,true,'a real model quoted the paragraph mark with the words');
  const declaration='1. I am a witness.\n2. As alleged in Compl. ¶ 7, the widget has a lever arm.\n3. Done.';
  assert.equal(pinHolds({kind:'paragraph',value:3},declaration,'widget has a lever').holds,null);
  assert.equal(pinHolds({kind:'paragraph',value:14},'14. See [2019] EWCA Civ 12 where the widget has a lever arm.','widget has a lever').holds,null);
  const text="The '001 patent discloses a lever.";
  assert.equal(checkCitation(plainClaim("The '001 patent",text),[passage('o','Response',text)],{status:'VERIFIED',source_id:'o',extracted_passage:text}).status,null,'a source using only the short form');
  const deck='<!-- source_locator: slide:2 -->\nRevenue grew.\n<!-- source_locator: slide:3 -->\nOther.';
  assert.equal(pinHolds({kind:'slide',value:2},deck,'revenue grew').holds,true);
  assert.deepEqual(pinHolds({kind:'slide',value:3},deck,'revenue grew'),{holds:false,where:'slide 2'});
});

test('no citation and no named authority means nothing to check',()=>{
  assert.deepEqual(checkCitation(plainClaim(null,'A plain claim.'),[guide],{status:'VERIFIED',source_id:'guide'}),clean);
});
