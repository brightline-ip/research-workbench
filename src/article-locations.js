import crypto from 'node:crypto';

export function articleBlocks(markdown) {
  const blocks = [];
  const pattern = /\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/g;
  for (const match of markdown.matchAll(pattern)) blocks.push({ block_index: blocks.length, start_offset: match.index, text: match[0] });
  return blocks;
}

// Models often copy a span with typographic quotes or dashes straightened, whitespace or line
// breaks collapsed, Markdown emphasis or link targets dropped, or a middle part elided with
// "...". Matching is done on a normalized view, but the stored evidence_span is always the
// exact article substring between the matched offsets, so it stays verbatim article text.
const CHAR_MAP = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ' };
const DROPPED = new Set(['*', '_', '`', '[', ']', '​', '­']);

function normalizeWithMap(text) {
  const chars = [], map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ']' && text[i + 1] === '(') { const close = text.indexOf(')', i + 2); if (close > 0 && !/\s/.test(text.slice(i + 2, close))) { i = close; continue; } }
    if (DROPPED.has(c)) continue;
    if (c === '…') { for (const dot of '...') { chars.push(dot); map.push(i); } continue; }
    let out = CHAR_MAP[c] ?? c;
    if (/\s/.test(out)) { if (!chars.length || chars[chars.length - 1] === ' ') continue; out = ' '; }
    const lower = out.toLowerCase(); chars.push(lower.length === 1 ? lower : out); map.push(i);
  }
  if (chars[chars.length - 1] === ' ') { chars.pop(); map.pop(); }
  return { text: chars.join(''), map };
}

function findNormalized(text, span) {
  const hay = normalizeWithMap(text), needle = normalizeWithMap(span).text.replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, '');
  if (needle.length < 8) return null;
  const parts = needle.split(/\s*\.\.\.\s*/).filter(part => part.length >= 4);
  if (!parts.length) return null;
  let at = hay.text.indexOf(parts[0]);
  if (at < 0) return null;
  const startNorm = at;
  let endNorm = at + parts[0].length;
  for (const part of parts.slice(1)) { at = hay.text.indexOf(part, endNorm); if (at < 0) return null; endNorm = at + part.length; }
  return { start: hay.map[startNorm], end: hay.map[endNorm - 1] + 1, elided: parts.length > 1 };
}

function locateSpan(blocks, item) {
  const preferred = blocks[item.block_index];
  const exact = preferred?.text.indexOf(item.evidence_span);
  if (exact >= 0) return { block: preferred, within: exact, length: item.evidence_span.length, method: 'EXACT' };
  const others = blocks.filter(block => block !== preferred && block.text.includes(item.evidence_span));
  if (others.length === 1) return { block: others[0], within: others[0].text.indexOf(item.evidence_span), length: item.evidence_span.length, method: 'EXACT_OTHER_BLOCK' };
  const ordered = preferred ? [preferred, ...blocks.filter(block => block !== preferred)] : blocks;
  for (const block of ordered) {
    const found = findNormalized(block.text, item.evidence_span);
    if (found) return { block, within: found.start, length: found.end - found.start, method: found.elided ? 'NORMALIZED_ELIDED' : 'NORMALIZED' };
  }
  return null;
}

// Diagnostic for a span that could not be located. It names lengths and match depth only,
// never article or model text, so it is safe for logs and error_message.
function mismatchDetail(blocks, item) {
  const block = blocks[item.block_index];
  if (!block) return `block ${item.block_index} does not exist (article has ${blocks.length} blocks)`;
  const hay = normalizeWithMap(block.text).text, needle = normalizeWithMap(item.evidence_span).text;
  let lo = 0, hi = needle.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (hay.includes(needle.slice(0, mid))) lo = mid; else hi = mid - 1; }
  return `block ${item.block_index}, span ${item.evidence_span.length} chars, first ${lo} of ${needle.length} normalized chars found in the block`;
}

export function locateAssertions(markdown, extraction) {
  const blocks = articleBlocks(markdown);
  return extraction.assertions.map((item, index) => {
    if (!blocks[item.block_index] && !blocks.some(block => block.text.includes(item.evidence_span))) throw new Error(`Assertion ${index} references missing block ${item.block_index}`);
    const found = locateSpan(blocks, item);
    if (!found) throw new Error(`Assertion ${index} evidence_span is not verbatim article text (${mismatchDetail(blocks, item)})`);
    const start_offset = found.block.start_offset + found.within;
    const end_offset = start_offset + found.length;
    const evidence_span = markdown.slice(start_offset, end_offset);
    const assertion_fingerprint = crypto.createHash('sha256').update(`${start_offset}:${end_offset}:${item.normalized_proposition}`).digest('hex');
    return { ...item, block_index: found.block.block_index, evidence_span, span_match: found.method, start_offset, end_offset, assertion_fingerprint };
  });
}
