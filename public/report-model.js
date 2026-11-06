// Shared by the browser and exports. Historical results remain unchanged in storage.
export function requiresExternalEvidence(assertion) {
  return assertion?.source_required !== false || assertion?.primary_source_required === true;
}

// Older runs saved provider outages as UNVERIFIABLE. New runs stop instead and save no result for those claims.
export function wasNotChecked(result) {
  return result?.status === 'UNVERIFIABLE' && /^Verification output failed evidence validation: Provider request failed/.test(result.material_gap || '');
}

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
  return result;
}

export function needsAttention(result) {
  return Boolean(result && !['VERIFIED', 'NOT_APPLICABLE'].includes(result.status));
}

export function buildReport(assertions = [], results = []) {
  const byId = new Map(results.map(result => [result.assertion_id, result]));
  const rows = assertions.map(assertion => ({assertion, result: displayResult(assertion, byId.get(assertion.assertion_id))}));
  const counts = {total: assertions.length, verified: 0, attention: 0, not_applicable: 0, not_checked: 0, pending: 0, legacy_adjusted: 0};
  for (const {result} of rows) {
    if (!result) counts.pending++;
    else if (result.status === 'VERIFIED') counts.verified++;
    else if (result.status === 'NOT_APPLICABLE') counts.not_applicable++;
    else if (result.status === 'NOT_CHECKED') counts.not_checked++;
    else counts.attention++;
    if (result?.status === 'NOT_APPLICABLE' && result.original_status) counts.legacy_adjusted++;
  }
  // Concrete discrepancies first, then missing evidence; load-bearing items lead within each group.
  const priority = {CONTRADICTED: 0, FABRICATED: 0, MISCITED: 1, OVERSTATED: 1, STALE: 1, UNSUPPORTED: 2, UNVERIFIABLE: 3, NOT_CHECKED: 3, VERIFIED: 4, NOT_APPLICABLE: 5};
  rows.sort((a,b) => (priority[a.result?.status] ?? 3) - (priority[b.result?.status] ?? 3) || Number(b.assertion.load_bearing) - Number(a.assertion.load_bearing));
  return {rows, counts};
}
