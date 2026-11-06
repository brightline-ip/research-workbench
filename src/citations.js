// Questions of fact about a citation, settled in code where the text allows: is the cited authority among the sources, is a
// quotation in the source cited, and do the quoted words sit where the pin cite says? Nothing here looks an authority up in
// the world or judges whether a passage supports a claim. A false alarm costs a lawyer's trust, so a check overturns a
// VERIFIED only when it is sure, and otherwise says what it found and leaves the result alone.
import { overturnsResult, quotedPieces, sourceWords, wordsOnly } from './passages.js';

const HEAD_CHARS=2000,LABEL_CHARS=60;
const STOP_WORDS=new Set(['see','also','the','and','for','from','with','this','that','page','pages','para','paragraph','slide','section','note','supra','infra','ibid','cited','citing','quoting','decl','decls','depo','exhs','corp','resp','mem']);
// Words that name a kind of document. Alone they say nothing about which document is meant.
const GENERIC_WORDS=new Set(['patent','application','publication','action','office','exhibit','declaration','response','reference','specification','document','report','brief','memo','memorandum','letter','file','draft','opinion','order','owner','court','guide','notes']);
const PARTY_WORDS=/^(?:inc|corp|corporation|co|company|ltd|llc|llp|lp|plc|pharms|pharm|pharmaceuticals|techs|technologies|holdings|int'l|intl|the|of|et|al|bd|trs|univ|united|states|people|commonwealth|state)$/;
const tokens=text=>(String(text||'').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[]).filter(word=>!STOP_WORDS.has(word)&&!/^\d+$/.test(word));
const label=text=>{const clean=String(text).replace(/\s+/g,' ').trim();return clean.length>LABEL_CHARS?`${clean.slice(0,LABEL_CHARS)}…`:clean};
const SUBSECTIONS=/\([a-zA-Z0-9]+\)/g;
const REPORTERS=String.raw`(?:F\.\s?(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?[23]d)?|S\.\s?Ct\.|U\.?S\.?P\.?Q\.?(?:2d)?)`;

// The word most likely to identify a party. "Bd. of Trs. of Leland Stanford Jr. Univ." is found under "stanford".
function party(words){
  const parts=words.toLowerCase().split(/[\s,]+/).map(word=>word.replace(/[^\p{L}\p{N}'-]/gu,'')).filter(word=>word.length>=3&&!PARTY_WORDS.test(word));
  return parts.sort((a,b)=>b.length-a.length)[0]||null;
}

// Authorities named precisely enough that their absence means something. Bare numbers are never authorities.
function authorities(source){
  const ids=[];
  const each=(pattern,build)=>{for(const match of source.matchAll(pattern))build(match)};
  each(/\b(?:U\.?S\.?\s+)?Pat(?:ent)?\.?\s*(?:App(?:lication|l)?\.?\s*)?(?:No\.?|Number)?\s*(\d{1,2},\d{3},\d{3}|\d{7,8})\b/gi,m=>ids.push({kind:'number',value:m[1].replaceAll(',',''),label:m[0]}));
  each(/\bUS\s*(\d{1,2},?\d{3},?\d{3})\s*[AB]\d\b/gi,m=>ids.push({kind:'number',value:m[1].replaceAll(',',''),label:m[0]}));
  each(/\b(20\d{2})\/(\d{7})\b/g,m=>ids.push({kind:'number',value:m[1]+m[2],label:m[0]}));
  each(/['’](\d{3})\s+(?:patent|application|publication)\b/gi,m=>ids.push({kind:'short',value:m[1],label:m[0]}));
  each(new RegExp(String.raw`\b\d{1,4}\s+${REPORTERS}\s+\d{1,5}\b|\b\d{1,3}\s+U\.S\.\s+\d{1,4}\b`,'g'),m=>ids.push({kind:'reporter',value:wordsOnly(m[0]),label:m[0]}));
  // "KSR, 550 U.S. at 416": the volume and reporter are what a short form gives.
  each(new RegExp(String.raw`\b(\d{1,4}\s+${REPORTERS})\s+at\s+\d{1,5}\b|\b(\d{1,3}\s+U\.S\.)\s+at\s+\d{1,4}\b`,'g'),m=>ids.push({kind:'reporter',value:wordsOnly(m[1]||m[2]),label:m[0]}));
  each(/\b(\d{1,2})\s+(U\.?\s?S\.?\s?C\.?(?:\s?A\.?)?|C\.?\s?F\.?\s?R\.?)\s*(?:§+|sec(?:tion)?\.?)?\s*(\d+(?:\.\d+)?[a-z]*)/g,m=>ids.push({kind:'section',code:/c/i.test(m[2][0])?'cfr':'usc',title:m[1],value:m[3],label:m[0]}));
  each(/\bMPEP\s*(?:§+\s*)?(\d+(?:\.\d+)*)/gi,m=>ids.push({kind:'section',code:'mpep',value:m[1],label:m[0]}));
  each(/\bIn re\s+([A-Z][\w'&.-]+)/g,m=>{const a=party(m[1]);if(a)ids.push({kind:'case',parties:[a],label:m[0]})});
  each(/\b([A-Z][\w'&.-]*(?:,?\s+(?:[A-Z][\w'&.-]*|of|the|&)){0,8}),?\s+v\.\s+([A-Z][\w'&.-]*(?:,?\s+[A-Z][\w'&.-]*){0,4})/g,m=>{const names=[party(m[1]),party(m[2])].filter(Boolean);if(names.length)ids.push({kind:'case',parties:names,label:m[0]})});
  return ids;
}

function unique(ids){
  const seen=new Set();
  return ids.filter(id=>{const key=JSON.stringify([id.kind,id.value,id.parties,id.title]);if(seen.has(key))return false;seen.add(key);return true}).map(id=>({...id,label:label(id.label)}));
}

// Pin cites come only from the citation itself. Prose such as "heated at 150 degrees" is not a pin.
function pins(citation,ids){
  const source=String(citation||'').normalize('NFKC'),found=[];
  const reporter=ids.some(id=>id.kind==='reporter');
  const each=(pattern,build)=>{for(const match of source.matchAll(pattern))build(match)};
  each(/\b(\d{1,2})\s+(?:U\.?\s?S\.?\s?C\.?(?:\s?A\.?)?|C\.?\s?F\.?\s?R\.?)\s*(?:§+|sec(?:tion)?\.?)?\s*(\d+(?:\.\d+)?[a-z]*)((?:\([a-zA-Z0-9]+\))+)/g,m=>found.push({kind:'subsection',section:m[2],subs:m[3].match(SUBSECTIONS).map(s=>s.toLowerCase()),label:m[0]}));
  each(/¶+\s*\[?(\d{1,5})\]?|\bpara(?:graph)?s?\.?\s*\[?(\d{1,5})\]?|\[(0\d{3,4})\]/gi,m=>found.push({kind:'paragraph',value:Number(m[1]||m[2]||m[3]),label:m[0]}));
  each(/\bslides?\s+(\d{1,4})\b/gi,m=>found.push({kind:'slide',value:Number(m[1]),label:m[0]}));
  // A reporter's page numbers are not the pages of a downloaded copy.
  each(/\b(?:at|pp?\.|pg\.|page)\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?![\d:])/gi,m=>found.push(reporter?{kind:'unchecked',label:m[0]}:{kind:'page',from:Number(m[1]),to:Number(m[2]||m[1]),label:m[0]}));
  each(/\bcol(?:umn)?s?\.?\s*\d+(?:\s*,?\s*(?:ll?\.?|lines?)\s*\d+(?:\s*[-–]\s*\d+)?)?|\b\d{1,3}:\d{1,3}(?:\s*[-–]\s*\d+)?\b/gi,m=>found.push({kind:'unchecked',label:m[0]}));
  if(reporter)each(/,\s*(\d{1,5})(?=\s*(?:\(|$|;))/g,m=>found.push({kind:'unchecked',label:`at ${m[1]}`}));
  const seen=new Set();
  return found.map(pin=>({...pin,label:label(pin.label)})).filter(pin=>{const key=`${pin.kind}:${pin.label}`;if(seen.has(key))return false;seen.add(key);return true});
}

export function parseCitation(citation,sentence=''){
  const cited=unique(authorities(String(citation||'').normalize('NFKC')));
  const inSentence=unique(authorities(String(sentence||'').normalize('NFKC')));
  return {ids:cited,sentenceIds:inSentence.filter(id=>!cited.some(other=>JSON.stringify([other.kind,other.value,other.parties])===JSON.stringify([id.kind,id.value,id.parties]))),pins:pins(citation,cited)};
}

function matchesSource(id,text){
  if(id.kind==='case')return id.parties.every(name=>new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[^\p{L}\p{N}'-]/gu,'')}(?![\\p{L}\\p{N}])`,'iu').test(text));
  if(id.kind==='short')return new RegExp(`\\d{1,2},?\\d{3},?${id.value}(?!\\d)`).test(text);
  if(id.kind==='section'){
    const number=id.value.replace('.','\\.');
    if(id.code==='mpep')return text.toLowerCase().includes('mpep')&&new RegExp(`(?<![\\d.])${number}(?![\\d])`).test(text);
    const code=id.code==='cfr'?'c\\.?\\s?f\\.?\\s?r\\.?':'u\\.?\\s?s\\.?\\s?c\\.?';
    return new RegExp(`§+\\s*${number}(?![\\d])|\\bsec(?:tion)?\\.?\\s*${number}(?![\\d])|${code}[^\\n]{0,24}?(?<![\\d.])${number}(?![\\d])|/t?${id.title||''}[^\\s]{0,8}s${number}(?![\\d])`,'i').test(text);
  }
  return wordsOnly(text).includes(id.value);
}

// Which qualifying sources the citation points to, and how sure that is. Only the citation itself decides: a sentence naming a
// reference while citing the Office Action points at the Office Action.
export function citedSources(parsed,citation,sources){
  if(parsed.ids.length){
    // A document named after the authority is the authority. Another document that merely lists it near the top is not.
    const byName=sources.filter(s=>parsed.ids.some(id=>matchesSource(id,`${s.title} ${s.url}`)));
    const cited=byName.length?byName:sources.filter(s=>parsed.ids.some(id=>matchesSource(id,s.head)));
    const mentioned=cited.length>0||sources.some(s=>parsed.ids.some(id=>matchesSource(id,`${s.title} ${s.url} ${s.text}`)));
    return {named:true,sure:cited.length>0,cited,mentioned};
  }
  const words=[...new Set(tokens(citation))];
  const distinctive=words.filter(word=>!GENERIC_WORDS.has(word));
  // Two matching words, or one distinctive word when it is all the citation has. "The patent" alone points at nothing.
  if(!words.length||(words.length===1&&!distinctive.length))return {named:false,sure:false,cited:[],mentioned:false};
  const cited=sources.filter(s=>{const title=new Set(tokens(s.title));return words.every(word=>title.has(word))});
  return {named:false,sure:words.length>=2&&cited.length>0,cited,mentioned:cited.length>0};
}

const LOCATOR=/<!--\s*(?:source_locator:\s*(page|slide):\s*|PDF (page) )(\d+)\s*-->/gi;
function markedParts(text){
  const marks=[...text.matchAll(LOCATOR)];
  // Extraction writes the next page's heading before its marker, so it is not the end of this page.
  return marks.map((mark,index)=>({kind:(mark[1]||mark[2]).toLowerCase(),number:Number(mark[3]),text:text.slice(mark.index+mark[0].length,marks[index+1]?.index??text.length).replace(/\n##\s+(?:page|slide)\s+\d+\s*$/i,'\n')}));
}
function edgeNumber(text){
  const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
  for(const line of [lines.at(-1),lines[0]]){
    const match=/^(?:page\s+|pg\.?\s+|p\.\s*|-\s*)?(\d{1,4})(?:\s*-|\s+of\s+\d{1,4})?$/i.exec(line||'');
    if(match)return Number(match[1]);
  }
  return null;
}
// A printed page number is believed only when it is near the file's own count and the next or previous page agrees. A line
// number from a pleading, a year or a table figure at the edge of a page does neither.
const MAX_FRONT_MATTER=30;
function printedPages(parts){
  const edges=parts.map(part=>edgeNumber(part.text));
  return parts.map((part,index)=>{
    const value=edges[index];
    if(value===null||part.number-value<0||part.number-value>MAX_FRONT_MATTER)return null;
    const agrees=edges[index+1]===value+1&&parts[index+1].number===part.number+1||edges[index-1]===value-1&&parts[index-1].number===part.number-1;
    return agrees?value:null;
  });
}

// {holds:true} the pin holds; {holds:false} it does not, for certain; {holds:null,where} it could not be settled.
export function pinHolds(pin,text,quote){
  const has=segment=>sourceWords(segment).includes(wordsOnly(quote));
  if(pin.kind==='page'||pin.kind==='slide'){
    if(!quote)return {holds:null};
    const parts=markedParts(text).filter(part=>part.kind===pin.kind);
    if(!parts.length)return {holds:null};
    if(pin.kind==='slide'){
      if(parts.some(part=>part.number===pin.value&&has(part.text)))return {holds:true};
      const where=parts.find(part=>has(part.text));
      return where?{holds:false,where:`slide ${where.number}`}:{holds:null};
    }
    // A quotation may run across a page break, so a page and its neighbour are read together too.
    const printed=printedPages(parts);
    const whole=parts.flatMap((part,index)=>has(part.text)?[index]:[]);
    const located=whole.length?whole:parts.flatMap((part,index)=>parts[index+1]&&has(`${part.text}\n${parts[index+1].text}`)?[index,index+1]:[]);
    if(!located.length)return {holds:null};
    const inRange=number=>number>=pin.from&&number<=pin.to;
    if(located.some(index=>printed[index]===null?inRange(parts[index].number):inRange(printed[index])))return {holds:true};
    // A pin to the file's own page, where the page prints another number: possibly how the writer counted, so it is reported.
    if(located.some(index=>inRange(parts[index].number)))return {holds:null,where:`page ${parts[located[0]].number} of the file, printed page ${printed[located[0]]}`};
    // Only a page's believable printed number can show the pin is wrong: a file's count differs after a cover sheet.
    if(located.every(index=>printed[index]!==null))return {holds:false,where:`printed page ${printed[located[0]]}`};
    return {holds:null,where:`page ${parts[located[0]].number} of the file`};
  }
  if(pin.kind==='paragraph'){
    // A numbered paragraph starts a line. "Compl. ¶ 7" or "[2019] EWCA" in the middle of the text only refers to something.
    const marks=[...text.matchAll(/^[ \t]*(?:\[(0\d{3,4})\]|¶\s*(\d{1,5}))/gm)];
    if(!marks.length||!quote)return {holds:null};
    const parts=marks.map((mark,index)=>({number:Number(mark[1]||mark[2]),text:text.slice(mark.index+mark[0].length,marks[index+1]?.index??text.length)}));
    if(parts.some(part=>part.number===pin.value&&has(part.text)))return {holds:true};
    const where=parts.find(part=>has(part.text));
    return where?{holds:false,where:`paragraph ${where.number}`}:{holds:null};
  }
  if(pin.kind==='subsection'){
    const number=pin.section.replace('.','\\.');
    const start=text.search(new RegExp(`(?:§+\\s*|\\bsec(?:tion)?\\.?\\s*|\\.\\s?[Cc]\\.?\\s*(?:§+\\s*)?)${number}(?![\\d])|^\\s*${number}\\.`,'m'));
    if(start<0)return {holds:null};
    let at=start;const compact=text.toLowerCase().replace(/\(\s+/g,'(').replace(/\s+\)/g,')');
    for(const sub of pin.subs){at=compact.indexOf(sub,at);if(at<0)return {holds:false,where:null}}
    return {holds:true};
  }
  return {holds:null};
}

const NOTHING={codes:[],notes:[],status:null};
const namedAfter=(section,s)=>new RegExp(`(?<![\\d.])${section.replace('.','\\.')}(?![\\d])`).test(`${s.title} ${s.url}`);

// status: the status a VERIFIED should become, or null to leave it.
export function checkCitation(assertion,passages,result,prepared=new Map()){
  const citation=assertion.citation_as_written||'';
  const sentence=assertion.evidence_span||assertion.assertion_text||'';
  const parsed=parseCitation(citation,sentence);
  if(!citation&&!parsed.sentenceIds.length)return NOTHING;
  const bySource=new Map();
  for(const p of [...passages].sort((a,b)=>a.sequence_number-b.sequence_number)){
    const entry=bySource.get(p.source_id)||{source_id:p.source_id,title:p.title||'',url:p.canonical_url||'',text:''};
    entry.text+=`${p.passage_text}\n`;bySource.set(p.source_id,entry);
  }
  const sources=[...bySource.values()].map(s=>({...s,head:`${s.title} ${s.url} ${s.text.slice(0,HEAD_CHARS)}`}));
  const plain=s=>{if(!prepared.has(s.source_id))prepared.set(s.source_id,sourceWords(s.text));return prepared.get(s.source_id)};
  const {named,sure,cited,mentioned}=citedSources(parsed,citation,sources);
  const codes=[],notes=[];let status=null;
  const absent=ids=>{
    const names=ids.map(id=>id.label).join(', ');
    codes.push('CITED_SOURCE_NOT_IN_SOURCES');
    notes.push(`Citation check: ${names} is not among this run's sources, so this citation could not be confirmed. That does not show it is wrong.`);
  };
  if(named&&!mentioned){absent(parsed.ids);return {codes,notes,status:'UNVERIFIABLE'}}
  // A reference named in the sentence, when the citation itself points elsewhere, is reported at most.
  const missing=parsed.sentenceIds.filter(id=>!sources.some(s=>matchesSource(id,`${s.title} ${s.url} ${s.text}`)));
  if(missing.length){absent(missing);if(!citation)status='UNVERIFIABLE'}
  const pieces=quotedPieces(sentence);
  if(cited.length){
    const elsewhere=pieces.filter(piece=>!cited.some(s=>plain(s).includes(wordsOnly(piece)))&&sources.some(s=>plain(s).includes(wordsOnly(piece))));
    if(elsewhere.length){
      codes.push('QUOTE_IN_OTHER_SOURCE');
      notes.push(`Citation check: ${elsewhere.map(q=>`"${label(q)}"`).join(', ')} is in another source, not in the one cited.`);
      if(sure&&elsewhere.some(overturnsResult))status='MISCITED';
    }
    if(result.source_id&&!cited.some(s=>s.source_id===result.source_id)){
      codes.push('CITED_SOURCE_NOT_USED');
      notes.push('Citation check: the passage quoted as support comes from a different source than the one cited.');
      if(sure)status='MISCITED';
    }
  }
  const scope=cited.length?cited:sources.filter(s=>s.source_id===result.source_id);
  const quote=pieces[0]||(scope.some(s=>s.source_id===result.source_id)?result.extracted_passage:null);
  const unchecked=[];
  for(const pin of parsed.pins){
    // Whether a subsection exists can be read only from the statute, not from a document that mentions it.
    const among=pin.kind==='subsection'?scope.filter(s=>namedAfter(pin.section,s)):scope;
    const answers=pin.kind==='unchecked'?[]:among.map(s=>pinHolds(pin,s.text,pin.kind==='subsection'?null:quote));
    if(answers.some(answer=>answer.holds===true))continue;
    const where=answers.find(answer=>answer.where)?.where;
    if(answers.length&&answers.every(answer=>answer.holds===false)){
      codes.push('WRONG_PIN_CITE');
      notes.push(`Citation check: "${pin.label}" does not hold: ${where?`the words are at ${where}`:'that spot is not in the source'}.`);
      status='MISCITED';
    }else unchecked.push(where?`"${pin.label}" (the words are on ${where}; printed page numbers may differ)`:`"${pin.label}"`);
  }
  if(unchecked.length){
    codes.push('PIN_NOT_CHECKED');
    notes.push(`Citation check: ${unchecked.join(', ')} could not be settled from the source's text. Check this by hand.`);
  }
  return {codes,notes,status};
}
