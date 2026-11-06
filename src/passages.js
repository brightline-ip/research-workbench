import crypto from 'node:crypto';

const words = text => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !['the','and','that','with','from','this','were','have','into'].includes(w)));

// Some stored "normalized" files are gzip bytes or partly garbled PDF extraction. Partial text must not pass as a
// complete source, and readable files in the stored corpus stay under 1% control characters. U+FFFD does not count:
// a Latin-1 page decoded as UTF-8 is still usable. The original stays stored for a better extraction.
export function isUnreadableText(text) {
  if (!text) return false;
  if (text.charCodeAt(0) === 0x1f && text.charCodeAt(1) === 0xfffd) return true;
  let bad = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c < 32 && ![9, 10, 12, 13].includes(c)) bad++; }
  return bad / text.length > 0.01;
}

export function chunkNormalizedText(text, maxChars = 1800) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('Invalid passage size');
  text = text.replaceAll('\0', ''); // PostgreSQL text cannot hold NUL; a stray one must not block the whole source. Offsets refer to this text.
  const chunks = [];
  let start=0;
  while(start<text.length){
    while(start<text.length && /\s/.test(text[start]))start++;
    if(start>=text.length)break;
    let end=Math.min(start+maxChars,text.length);
    if(end<text.length){
      const boundary=text.lastIndexOf('\n\n',end);
      if(boundary>start)end=boundary;
    }
    chunks.push({start,text:text.slice(start,end)});
    start=end;
  }
  return chunks.map((chunk, sequence_number) => {
    const before = text.slice(0, chunk.start);
    const startLine = (before.match(/\n/g) || []).length + 1;
    const endLine = startLine + (chunk.text.match(/\n/g) || []).length;
    return { sequence_number, normalized_start_offset: chunk.start, normalized_end_offset: chunk.start + chunk.text.length, locator: `normalized lines ${startLine}-${endLine}`, passage_text: chunk.text, passage_hash: crypto.createHash('sha256').update(chunk.text).digest('hex') };
  });
}

export function rankPassages(assertionText, passages, limit = 5) {
  const query = words(assertionText);
  return passages.map(p => {
    const terms = words(p.passage_text); let overlap = 0;
    for (const term of query) if (terms.has(term)) overlap++;
    return { ...p, retrieval_score: query.size ? overlap / query.size : 0 };
  }).filter(p => p.retrieval_score > 0).sort((a,b) => b.retrieval_score - a.retrieval_score || a.sequence_number - b.sequence_number).slice(0, limit);
}

export function validateVerificationEvidence(result, candidates) {
  if (result.status === 'VERIFIED' && (!result.source_id || !result.passage_id || !result.extracted_passage?.trim())) throw new Error('VERIFIED requires an acquired source passage');
  if (result.extracted_passage) {
    const candidate = candidates.find(p => p.passage_id === result.passage_id && p.source_id === result.source_id);
    if (!candidate || !candidate.passage_text.includes(result.extracted_passage)) throw new Error('Verification passage is not verbatim retrieved evidence');
  }
  return result;
}
