import test from 'node:test';
import assert from 'node:assert/strict';
import { articleBlocks, locateAssertions } from '../src/article-locations.js';

const markdown = '# Finding\n\nThe rate rose from 10% to 15% in 2025. It then stabilized.\n\nAnalysis follows.';

test('article blocks preserve exact global offsets', () => {
  const blocks = articleBlocks(markdown);
  assert.deepEqual(blocks.map(b => b.text), ['# Finding', 'The rate rose from 10% to 15% in 2025. It then stabilized.', 'Analysis follows.']);
  assert.equal(markdown.slice(blocks[1].start_offset, blocks[1].start_offset + blocks[1].text.length), blocks[1].text);
});

test('multiple atomic assertions map to one exact article span', () => {
  const extraction = { assertions: [
    { block_index: 1, evidence_span: 'The rate rose from 10% to 15% in 2025.', normalized_proposition: 'The rate was 10% initially.' },
    { block_index: 1, evidence_span: 'The rate rose from 10% to 15% in 2025.', normalized_proposition: 'The rate was 15% in 2025.' }
  ]};
  const located = locateAssertions(markdown, extraction);
  assert.equal(located.length, 2);
  assert.equal(markdown.slice(located[0].start_offset, located[0].end_offset), extraction.assertions[0].evidence_span);
  assert.notEqual(located[0].assertion_fingerprint, located[1].assertion_fingerprint);
});

test('non-verbatim model spans fail closed', () => {
  assert.throws(() => locateAssertions(markdown, { assertions: [{ block_index: 1, evidence_span: 'rate was about 15%', normalized_proposition: 'x' }] }), /not verbatim/);
});


const styled = '## Rule\n\nUnder **37 C.F.R. § 1.113**, the examiner’s “final” action—once made—closes\nprosecution, see [MPEP 706.07](https://www.uspto.gov/web/offices/pac/mpep/s706.html).\n\nOther text.';

test('typographic, whitespace, and Markdown differences still map to the exact article span', () => {
  const span = 'Under 37 C.F.R. § 1.113, the examiner\'s "final" action-once made-closes prosecution, see MPEP 706.07';
  const [located] = locateAssertions(styled, { assertions: [{ block_index: 1, evidence_span: span, normalized_proposition: 'x' }] });
  assert.equal(located.span_match, 'NORMALIZED');
  assert.equal(styled.slice(located.start_offset, located.end_offset), located.evidence_span);
  assert.ok(located.evidence_span.startsWith('Under **37') && located.evidence_span.endsWith('706.07'));
});

test('an elided span covers the article text between its ends', () => {
  const [located] = locateAssertions(styled, { assertions: [{ block_index: 1, evidence_span: 'the examiner’s “final” action … closes prosecution', normalized_proposition: 'x' }] });
  assert.equal(located.span_match, 'NORMALIZED_ELIDED');
  assert.equal(located.evidence_span, 'the examiner’s “final” action—once made—closes\nprosecution');
});

test('a verbatim span with the wrong block index is relocated to the one block containing it', () => {
  const [located] = locateAssertions(markdown, { assertions: [{ block_index: 0, evidence_span: 'It then stabilized.', normalized_proposition: 'x' }] });
  assert.equal(located.block_index, 1);
  assert.equal(located.span_match, 'EXACT_OTHER_BLOCK');
});

test('an unlocatable span reports match depth without quoting text', () => {
  assert.throws(() => locateAssertions(markdown, { assertions: [{ block_index: 1, evidence_span: 'The rate rose sharply to 99%', normalized_proposition: 'x' }] }),
    error => /not verbatim article text \(block 1, span 28 chars, first 14 of 28/.test(error.message) && !error.message.includes('sharply'));
});
