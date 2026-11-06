// Questions of fact about a citation, settled in code: is the cited authority among the sources, is a quotation in that
// source and not merely in some other one, and do the quoted words sit where the pin cite says? Nothing here looks an
// authority up in the world or judges whether a passage supports a claim.
import { overturnsResult, quotedPieces, wordsOnly } from './passages.js';

const HEAD_CHARS=2000;
const STOP_WORDS=new Set(['see','also','the','and','for','from','with','this','that','page','pages','para','paragraph','slide','section','note','supra','infra','ibid','cited','citing','quoting']);
const tokens=text=>(String(text||'').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[]).filter(word=>!STOP_WORDS.has(word)&&!/^\d+$/.test(word));
const SUBSECTIONS=/\([a-zA-Z0-9]+\)/g;

export function parseCitation(text){
  const source=String(text||'').normalize('NFKC'),ids=[],pins=[];
  const each=(pattern,build)=>{for(const match of source.matchAll(pattern))build(match)};
  each(/\b(?:U\.?S\.?\s*)?(?:Pat(?:ent)?\.?\s*(?:No\.?\s*)?)?(\d{1,2},\d{3},\d{3})\b/g,m=>ids.push({kind:'patent',value:m[1].replaceAll(',',''),label:m[0].trim()}));
  each(/\b(20\d{2})\/(\d{7})\b/g,m=>ids.push({kind:'publication',value:m[1]+m[2],label:m[0]}));
  each(/\b\d{1,4}\s+(?:F\.\s?(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?[23]d)?|U\.S\.|S\.\s?Ct\.|U\.?S\.?P\.?Q\.?(?:2d)?)\s+\d{1,5}\b/g,m=>ids.push({kind:'reporter',value:wordsOnly(m[0]),label:m[0]}));
  each(/\b\d{1,2}\s+(?:U\.?\s?S\.?\s?C\.?(?:\s?A\.?)?|C\.?\s?F\.?\s?R\.?)\s*(?:§+|sec(?:tion)?\.?)?\s*(\d+(?:\.\d+)?[a-z]*)((?:\([a-zA-Z0-9]+\))*)/g,m=>{
    ids.push({kind:'section',value:m[1],label:m[0].trim()});
    if(m[2])pins.push({kind:'subsection',section:m[1],subs:m[2].match(SUBSECTIONS).map(s=>s.toLowerCase()),label:m[0].trim()});
  });
  each(/\bMPEP\s*(?:§+\s*)?(\d+(?:\.\d+)*)/gi,m=>ids.push({kind:'section',value:m[1],label:m[0]}));
  each(/\b([A-Z][\w'&.-]+)(?:\s+[A-Z][\w'&.-]+){0,3}\s+v\.?s?\.?\s+([A-Z][\w'&.-]+)/g,m=>ids.push({kind:'case',parties:[m[1].replace(/\W+$/,'').toLowerCase(),m[2].replace(/\W+$/,'').toLowerCase()],label:m[0]}));
  const reporter=ids.some(id=>id.kind==='reporter');
  each(/¶+\s*\[?(\d{1,5})\]?|\bpara(?:graph)?s?\.?\s*\[?(\d{1,5})\]?|\[(\d{4,5})\]/gi,m=>pins.push({kind:'paragraph',value:Number(m[1]||m[2]||m[3]),label:m[0]}));
  each(/\bslide\s+(\d{1,4})\b/gi,m=>pins.push({kind:'slide',value:Number(m[1]),label:m[0]}));
  // A reporter's page numbers are not the pages of a downloaded copy, so they cannot be checked from its text.
  each(/\b(?:at|pp?\.|pg\.|page)\s*(\d{1,4})\b/gi,m=>pins.push(reporter?{kind:'unchecked',label:m[0]}:{kind:'page',value:Number(m[1]),label:m[0]}));
  each(/\bcol(?:umn)?s?\.?\s*\d+[^;)]*|\b\d{1,3}:\d{1,3}(?:\s*-\s*\d+)?\b/gi,m=>pins.push({kind:'unchecked',label:m[0].trim()}));
  if(reporter)each(/,\s*(\d{1,5})(?=\s*(?:\(|$|;))/g,m=>pins.push({kind:'unchecked',label:`at ${m[1]}`}));
  return {ids,pins};
}

function matchesSource(id,head){
  const lower=head.toLowerCase();
  if(id.kind==='case')return id.parties.every(party=>lower.includes(party));
  if(id.kind==='section')return new RegExp(`(?<![\\d.])${id.value.replace('.','\\.')}(?![\\d])`,'i').test(head);
  return wordsOnly(head).includes(id.value);
}

// Which qualifying sources a citation points to. `specific` means it names an authority precisely enough that absence means something.
export function citedSources(parsed,citation,sources){
  const ids=parsed.ids;
  if(ids.length){
    const found=sources.filter(s=>ids.some(id=>matchesSource(id,s.head)));
    return {specific:true,cited:found};
  }
  const words=[...new Set(tokens(citation))];
  if(!words.length)return {specific:false,cited:[]};
  const found=sources.filter(s=>{const title=new Set(tokens(s.title));return words.filter(w=>title.has(w)).length>=Math.max(1,Math.ceil(words.length/2))});
  return {specific:false,cited:found};
}

const LOCATOR=/<!--\s*(?:source_locator:\s*(page|slide):\s*|PDF (page) )(\d+)\s*-->/gi;
function segments(text,pattern,keyOf){
  const marks=[...text.matchAll(pattern)];
  return marks.map((mark,index)=>({key:keyOf(mark),text:text.slice(mark.index+mark[0].length,marks[index+1]?.index??text.length)}));
}

// true: the pin holds. false: it does not. null: this source's text has nothing to check it against.
export function pinHolds(pin,text,quote){
  const inside=segment=>!quote||wordsOnly(segment).includes(wordsOnly(quote));
  if(pin.kind==='page'||pin.kind==='slide'){
    const parts=segments(text,LOCATOR,mark=>`${(mark[1]||mark[2]).toLowerCase()}:${Number(mark[3])}`);
    if(!parts.length)return null;
    const wanted=parts.filter(part=>part.key===`${pin.kind}:${pin.value}`);
    return wanted.length?wanted.some(part=>inside(part.text)):false;
  }
  if(pin.kind==='paragraph'){
    const parts=segments(text,/\[(\d{4,5})\]|¶\s*(\d{1,5})/g,mark=>Number(mark[1]||mark[2]));
    if(!parts.length)return null;
    const wanted=parts.filter(part=>part.key===pin.value);
    return wanted.length?wanted.some(part=>inside(part.text)):false;
  }
  if(pin.kind==='subsection'){
    const start=text.search(new RegExp(`(?<![\\d.])${pin.section.replace('.','\\.')}(?![\\d])`));
    if(start<0)return null;
    let at=start;const lower=text.toLowerCase();
    for(const sub of pin.subs){at=lower.indexOf(sub,at);if(at<0)return false}
    return true;
  }
  return null;
}

export function checkCitation(assertion,passages,result){
  const citation=assertion.citation_as_written||'';
  const parsed=parseCitation(`${citation} ${assertion.evidence_span||assertion.assertion_text||''}`);
  if(!citation&&!parsed.ids.length&&!parsed.pins.length)return {codes:[],notes:[],overturn:false};
  const bySource=new Map();
  for(const p of [...passages].sort((a,b)=>a.sequence_number-b.sequence_number)){
    const entry=bySource.get(p.source_id)||{source_id:p.source_id,title:p.title||'',url:p.canonical_url||'',text:''};
    entry.text+=`${p.passage_text}\n`;bySource.set(p.source_id,entry);
  }
  const sources=[...bySource.values()].map(s=>({...s,head:`${s.title} ${s.url} ${s.text.slice(0,HEAD_CHARS)}`}));
  const {specific,cited}=citedSources(parsed,citation,sources);
  const codes=[],notes=[];let overturn=false;
  if(specific&&!cited.length){
    const names=parsed.ids.map(id=>id.label).join(', ');
    return {codes:['CITED_SOURCE_NOT_IN_SOURCES'],notes:[`Citation check: ${names} is not among the qualifying sources, so this citation could not be confirmed.`],overturn:true};
  }
  const pieces=quotedPieces(`${assertion.evidence_span||''} ${assertion.assertion_text||''}`);
  const scope=cited.length?cited:sources.filter(s=>s.source_id===result.source_id);
  if(cited.length){
    const inCited=piece=>cited.some(s=>wordsOnly(s.text).includes(wordsOnly(piece)));
    const inOther=piece=>sources.some(s=>wordsOnly(s.text).includes(wordsOnly(piece)));
    const misplaced=pieces.filter(piece=>!inCited(piece)&&inOther(piece));
    if(misplaced.length){
      codes.push('QUOTE_IN_OTHER_SOURCE');
      notes.push(`Citation check: ${misplaced.map(q=>`"${q}"`).join(', ')} is in another source, not in the one cited.`);
      if(misplaced.some(overturnsResult))overturn=true;
    }
    if(result.source_id&&!cited.some(s=>s.source_id===result.source_id)){
      codes.push('CITED_SOURCE_NOT_USED');
      notes.push('Citation check: the passage quoted as support comes from a different source than the one cited.');
      overturn=true;
    }
  }
  const quote=pieces[0]||(result.extracted_passage&&cited.some(s=>s.source_id===result.source_id)?result.extracted_passage:null);
  const unchecked=[];
  for(const pin of parsed.pins){
    const answers=pin.kind==='unchecked'?[null]:scope.map(s=>pinHolds(pin,s.text,pin.kind==='subsection'?null:quote));
    if(answers.includes(true))continue;
    if(answers.length&&answers.every(answer=>answer===false)){
      codes.push('WRONG_PIN_CITE');
      notes.push(`Citation check: "${pin.label}" does not hold: ${quote&&pin.kind!=='subsection'?'the quoted words are not at that spot':'that spot is not in the source'}.`);
      overturn=true;
    }else unchecked.push(pin.label);
  }
  if(unchecked.length){
    codes.push('PIN_NOT_CHECKED');
    notes.push(`Citation check: ${unchecked.map(label=>`"${label}"`).join(', ')} could not be checked from the source's text. Check this by hand.`);
  }
  return {codes,notes,overturn};
}
