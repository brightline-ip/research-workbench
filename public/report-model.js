// Shared by the browser and exports. Historical results remain unchanged in storage.
export function requiresExternalEvidence(assertion) {
  return assertion?.source_required !== false || assertion?.primary_source_required === true;
}

// Older runs saved provider outages as UNVERIFIABLE. New runs stop instead and save no result for those claims.
export function wasNotChecked(result) {
  return result?.status === 'UNVERIFIABLE' && /^Verification output failed evidence validation: Provider request failed/.test(result.material_gap || '');
}

// Older runs that found no eligible passage sent nothing to a model and still saved a verdict in one of these fixed wordings.
const OLDER_NOTHING_COMPARED = {
  UNSUPPORTED: 'Adequate support meeting the claim source requirements is absent from the approved corpus.',
  UNVERIFIABLE: 'Evidence access or normalization was insufficient for a substantive determination.',
};
export function wasNothingCompared(result) {
  const wording = OLDER_NOTHING_COMPARED[result?.status];
  return Boolean(wording) && result.material_gap === wording && !result.source_id && !result.passage_id && !result.evidence_passage_id && !result.provider_response_id && result.candidate_passage_count == null;
}

// The one rule for older results, used by the workspace API, page, exports, comparison and Fix draft. Stored rows stay as saved.
export function displayResult(assertion, result) {
  if (!result) return null;
  if (wasNotChecked(result)) {
    return {
      ...result, status: 'NOT_CHECKED', original_status: result.status,
      source_actually_establishes: 'Not checked. The AI provider failed before this claim was assessed, so this says nothing about the evidence.',
      recommended_remediation: 'Run verification again.',
    };
  }
  if (result.status === 'UNSUPPORTED' && !result.source_id && !result.passage_id && !result.provider_response_id && !requiresExternalEvidence(assertion)) {
    return {
      ...result, status: 'NOT_APPLICABLE', original_status: result.status,
      material_gap: '',
      recommended_remediation: 'No external check was requested by the claim classification. This is not a verified finding.',
      source_actually_establishes: 'External verification does not apply under the recorded classification.',
    };
  }
  if (wasNothingCompared(result)) {
    return {
      ...result, status: 'UNVERIFIABLE', original_status: result.status, not_checked_reason: 'OLDER_RUN',
      source_actually_establishes: 'Nothing was checked. No passage was sent to the model, so this says nothing about whether the claim is supported.',
      material_gap: `Nothing was checked: this older run had no eligible passage for this claim, so no model compared anything. It was saved as ${result.status} in the wording used then.`,
      recommended_remediation: 'Run verification again. A new run records why no passage was available.',
    };
  }
  return result;
}

// Whether PRIMARY or SECONDARY came from a model or from whoever called the API. The class is not checked against the document.
const CLASS_ORIGIN = {MODEL: 'model judgment', CALLER: 'set by a person or API caller', DEFAULT: 'default for a source nobody assessed', UNKNOWN: 'origin not recorded'};
export function sourceClassLabel(result) {
  return result?.source_class ? `${result.source_class} (${CLASS_ORIGIN[result.source_class_assigned_by] || CLASS_ORIGIN.UNKNOWN})` : '';
}

// Older runs counted every claim as attempted, including those with nothing to compare, and recorded no passage counts.
export function coverageText(run, results = []) {
  if (results.some(result => result.candidate_passage_count == null)) return `Older run: passages sent to the model were not recorded, so it is unknown how many of ${run.assertions_extracted} claims reached the model. Its count of ${run.assertions_attempted} attempted includes claims with nothing to compare`;
  return `Passages sent to the model for ${run.assertions_attempted} of ${run.assertions_extracted} claims`;
}

export function needsAttention(result) {
  return Boolean(result && !['VERIFIED', 'NOT_APPLICABLE'].includes(result.status));
}

export function buildReport(assertions = [], results = []) {
  const byId = new Map(results.map(result => [result.assertion_id, result]));
  const rows = assertions.map(assertion => ({assertion, result: displayResult(assertion, byId.get(assertion.assertion_id))}));
  const counts = {total: assertions.length, verified: 0, attention: 0, not_applicable: 0, not_checked: 0, nothing_compared: 0, pending: 0, legacy_adjusted: 0, older_not_checked: 0};
  for (const {result} of rows) {
    if (!result) counts.pending++;
    else if (result.status === 'VERIFIED') counts.verified++;
    else if (result.status === 'NOT_APPLICABLE') counts.not_applicable++;
    else if (result.status === 'NOT_CHECKED') counts.not_checked++;
    else counts.attention++;
    if (result?.status === 'NOT_APPLICABLE' && result.original_status) counts.legacy_adjusted++;
    if (result?.not_checked_reason) counts.nothing_compared++;
    if (result?.not_checked_reason === 'OLDER_RUN') counts.older_not_checked++;
  }
  // Concrete discrepancies first, then missing evidence; load-bearing items lead within each group.
  const priority = {CONTRADICTED: 0, FABRICATED: 0, MISCITED: 1, OVERSTATED: 1, STALE: 1, UNSUPPORTED: 2, UNVERIFIABLE: 3, NOT_CHECKED: 3, VERIFIED: 4, NOT_APPLICABLE: 5};
  rows.sort((a,b) => (priority[a.result?.status] ?? 3) - (priority[b.result?.status] ?? 3) || Number(b.assertion.load_bearing) - Number(a.assertion.load_bearing));
  return {rows, counts};
}
