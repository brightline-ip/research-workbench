// Rows saved by older runs must not read as findings or leak raw errors. The stored row is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReport, coverageText, displayResult, needsAttention } from '../public/report-model.js';
import { revisionFindings } from '../src/revision-policy.js';
import { compare, currentComparisons } from '../src/adversarial.js';
import { ExportService } from '../src/exports.js';
import { accessWallPhrases } from '../src/passages.js';
import { readableDiscoveryFailures, storedFailureReason } from '../src/evidence-store.js';
import { evidenceGaps } from '../src/verification.js';

const claim = { assertion_id: 'a', source_required: true, primary_source_required: true, load_bearing: true };
const oldRow = (over = {}) => ({
  verification_result_id: 'r', assertion_id: 'a', status: 'UNSUPPORTED', source_id: null, passage_id: null, evidence_passage_id: null, provider_response_id: null,
  assertion_as_made: 'Claim', source_actually_establishes: 'No adequate passage meeting the source requirements in the approved corpus establishes this assertion.',
  material_gap: 'Adequate support meeting the claim source requirements is absent from the approved corpus.',
  recommended_remediation: 'Locate adequate primary evidence, narrow the assertion, or delete it.', candidate_passage_count: null, not_checked_reason: null, ...over,
});

test('an old no-candidate row reads as nothing checked and the stored row is untouched', () => {
  const stored = oldRow(), shown = displayResult(claim, stored);
  assert.equal(shown.status, 'UNVERIFIABLE'); assert.equal(shown.not_checked_reason, 'OLDER_RUN'); assert.equal(shown.original_status, 'UNSUPPORTED');
  assert.match(shown.material_gap, /^Nothing was checked/);
  assert.doesNotMatch(`${shown.material_gap} ${shown.source_actually_establishes} ${shown.recommended_remediation}`, /absent from|delete it/);
  assert.equal(stored.status, 'UNSUPPORTED'); assert.equal(displayResult(claim, shown).status, 'UNVERIFIABLE', 'applying the rule twice changes nothing');
  const unavailable = displayResult(claim, oldRow({ status: 'UNVERIFIABLE', material_gap: 'Evidence access or normalization was insufficient for a substantive determination.' }));
  assert.equal(unavailable.not_checked_reason, 'OLDER_RUN'); assert.equal(unavailable.original_status, 'UNVERIFIABLE');
});

test('the old-row rule does not swallow real verdicts', () => {
  for (const over of [{ source_id: 's' }, { evidence_passage_id: 'p' }, { provider_response_id: 'resp' }, { candidate_passage_count: 0 }, { material_gap: 'Not found in the 3 passages retrieved' }, { status: 'CONTRADICTED' }]) {
    const row = oldRow(over), shown = displayResult(claim, row);
    assert.equal(shown.status, row.status); assert.equal(shown.not_checked_reason, null);
  }
  assert.equal(displayResult({ ...claim, source_required: false, primary_source_required: false }, oldRow()).status, 'NOT_APPLICABLE', 'no source was requested');
});

test('report counts treat an old row like any claim with nothing compared, and Fix draft leaves it alone', () => {
  const { counts, rows } = buildReport([claim], [oldRow()]);
  assert.equal(counts.nothing_compared, 1); assert.equal(counts.older_not_checked, 1); assert.equal(counts.not_checked, 0, 'this was no provider failure');
  assert.ok(needsAttention(rows[0].result));
  assert.deepEqual(revisionFindings([claim], [oldRow()]), [], 'a gap in the check is not a finding to fix');
});

test('an old row is not a shared defect, in a new comparison or a stored one', () => {
  const author = displayResult(claim, oldRow()), independent = displayResult(claim, oldRow({ verification_result_id: 'i' }));
  assert.equal(compare(author, independent, true).comparison_status, 'MATERIAL_DISAGREEMENT');
  const stored = { assertion_id: 'a', author_result_id: 'r', independent_result_id: 'i', comparison_status: 'BOTH_DEFECTIVE', materiality: 'CRITICAL', rationale: 'Both runs classified the assertion UNSUPPORTED.' };
  const [row] = currentComparisons([stored], [claim], [oldRow(), oldRow({ verification_result_id: 'i' })]);
  assert.equal(row.comparison_status, 'MATERIAL_DISAGREEMENT'); assert.equal(row.stored_comparison_status, 'BOTH_DEFECTIVE'); assert.match(row.rationale, /Neither run assessed/);
  const real = oldRow({ source_id: 's', provider_response_id: 'x' });
  assert.deepEqual(currentComparisons([stored], [claim], [real, { ...real, verification_result_id: 'i' }]), [stored], 'real verdicts keep the saved comparison');
});

test('a CSV export shows an old row as nothing checked and keeps the original status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-export-'));
  try {
    const pool = { query: async (sql, values) => ({ rows: [{ artifact_id: 'a', storage_path: values[4] }] }) };
    const service = new ExportService(pool, { projectStorageRoot: dir, artifactPython: null });
    service.payload = async () => ({ project: {}, article: { title: 'T', version_number: 1 }, assertions: [claim], verification_results: [oldRow()], sources: [], evidence: {} });
    const { output_path } = await service.generate('p', { article_version_id: 'v', verification_run_id: 'r', format: 'csv', scope: 'all' });
    const csv = await fs.readFile(output_path, 'utf8');
    assert.match(csv, /"UNVERIFIABLE","Claim"/); assert.match(csv, /"UNSUPPORTED","OLDER_RUN"/); assert.doesNotMatch(csv, /absent from the approved corpus/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('coverage text does not claim passages reached the model on an older run', () => {
  const run = { assertions_attempted: 4, assertions_extracted: 5 };
  assert.match(coverageText(run, [oldRow()]), /not recorded.*unknown/);
  assert.doesNotMatch(coverageText(run, [oldRow()]), /Passages sent to the model for 4/);
  assert.equal(coverageText(run, [oldRow({ candidate_passage_count: 2 })]), 'Passages sent to the model for 4 of 5 claims');
  assert.equal(coverageText(run, []), 'Passages sent to the model for 4 of 5 claims');
});

test('old raw failure reasons are reduced to fixed wording on read', () => {
  assert.equal(storedFailureReason('connect ECONNREFUSED 10.0.0.5:5432 password=secret'), 'The source could not be downloaded.');
  assert.equal(storedFailureReason('The operation was aborted due to timeout'), 'The download timed out.');
  assert.equal(storedFailureReason('Source URL resolves to a local or private network address'), 'Blocked: the address is not a public HTTP(S) source.');
  assert.equal(storedFailureReason('Source returned HTTP 403'), 'Source returned HTTP 403');
  assert.equal(storedFailureReason(null), null);
  for (const fixed of ['Blocked: the address is not a public HTTP(S) source.', 'The source exceeds the 25 MB download limit.', 'The source redirected too many times or without a target.', 'The download timed out.', 'The source could not be downloaded.', 'The model proposed an address that failed URL screening; it was not fetched.', 'Not fetched: DISCOVERY_REQUIRE_ACCEPTANCE is on. Add the URL as a source to accept it.']) assert.equal(storedFailureReason(fixed), fixed);
  const merged = readableDiscoveryFailures([
    { candidate_url: 'u', candidate_title: 't', disposition: 'ACQUISITION_FAILED', reason: 'raw one', assertion_ids: ['a'] },
    { candidate_url: 'u', candidate_title: 't', disposition: 'ACQUISITION_FAILED', reason: 'raw two', assertion_ids: ['b', 'a'] },
  ]);
  assert.deepEqual(merged, [{ candidate_url: 'u', candidate_title: 't', disposition: 'ACQUISITION_FAILED', reason: 'The source could not be downloaded.', assertion_ids: ['a', 'b'] }]);
  const gaps = evidenceGaps({ discovery_failures: [{ assertion_id: 'a', candidate_url: 'u', disposition: 'ACQUISITION_FAILED', reason: 'raw /private/path' }] }, []);
  assert.equal(gaps.discovery_failures[0].reason, 'The source could not be downloaded.');
});

test('a suspected access wall names the wording that matched', () => {
  assert.deepEqual(accessWallPhrases('Please enable JavaScript and sign in to continue.'), ['enable javascript', 'sign in']);
  assert.deepEqual(accessWallPhrases('Access denied'), ['access denied']);
  assert.deepEqual(accessWallPhrases('The court held that the claim was obvious.'), []);
});
