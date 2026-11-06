import { EvidenceStore, storedFailureReason } from './evidence-store.js';
import { rankPassages, validateVerificationEvidence } from './passages.js';
import { requiresExternalEvidence } from '../public/report-model.js';
import { mapConcurrent } from './concurrency.js';
import { isPermanentProviderFailure } from './safety.js';

const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const eligibleClass=(assertion,link)=>link.proposition_source_class==='PRIMARY'||(assertion.primary_source_required===false&&link.proposition_source_class==='SECONDARY');
const uniqueSources=links=>[...new Map(links.map(l=>[l.source_id,l])).values()];
const NOT_CHECKED_REMEDY={
  NO_SOURCES:'Link or discover a source for this claim, then verify again.',
  NO_ELIGIBLE_SOURCE:'Add a source that qualifies for this claim, or correct its source class or source requirement, then verify again.',
  SOURCES_UNAVAILABLE:'Acquire a readable copy of the source (check the run\'s evidence_gaps), then verify again.',
  NO_MATCHING_PASSAGE:'Open the stored source to see whether it is on topic or a login or access page, then add a better source and verify again.',
};
// No passage reached the model for this claim, so nothing is known about its support: the status must not read as a finding.
export function notCheckedResult(assertion,links,evidence,eligiblePassages){
  const withText=link=>link.membership_status==='ACCEPTED'&&evidence.passages.some(p=>p.source_id===link.source_id);
  const unreadable=uniqueSources(links.filter(link=>eligibleClass(assertion,link)&&!withText(link)));
  const failures=(evidence.manifest.discovery_failures||[]).filter(f=>f.assertion_id===assertion.assertion_id);
  let reason,why;
  if(unreadable.length||failures.length){
    reason='SOURCES_UNAVAILABLE';
    why=[unreadable.length&&`${plural(unreadable.length,'linked source')} had no readable text (failed, blocked, not downloaded, unreadable, or a suspected login or access page)`,failures.length&&`${plural(failures.length,'discovered source')} could not be fetched or ${failures.length===1?'was':'were'} held for review`].filter(Boolean).join('; ');
  }else if(eligiblePassages){
    reason='NO_MATCHING_PASSAGE';
    why=`${plural(eligiblePassages,'eligible passage')} shared no word with this claim, so nothing was sent to the model; the source may be off topic or a login or access page`;
  }else if(links.length){
    reason='NO_ELIGIBLE_SOURCE';
    why=`${plural(uniqueSources(links).length,'source')} linked (${[...new Set(links.map(l=>l.proposition_source_class))].join(', ')}), none eligible because this claim needs a source classed ${assertion.primary_source_required===false?'PRIMARY or SECONDARY':'PRIMARY'}`;
  }else{
    reason='NO_SOURCES';
    why='no source is linked to this claim';
  }
  return {
    source_id:null,passage_id:null,assertion_as_made:assertion.assertion_text,
    source_actually_establishes:'Nothing was checked. No passage was sent to the model, so this says nothing about whether the claim is supported.',
    material_gap:`Nothing was checked: ${why}.`,extracted_passage:null,status:'UNVERIFIABLE',
    defect_codes:assertion.primary_source_required!==false&&links.some(l=>l.proposition_source_class==='SECONDARY')?['NON_PRIMARY_SUPPORT']:[],confidence:null,
    recommended_remediation:NOT_CHECKED_REMEDY[reason],provider_response_id:null,not_checked_reason:reason,
  };
}
// The sources a run could not use and the claims left unexamined, stored on the run itself.
export function evidenceGaps(manifest,results){
  const discovery=new Map();
  for(const failure of manifest.discovery_failures||[]){
    const key=failure.candidate_url||`untitled:${failure.candidate_title||''}`;
    const row=discovery.get(key)||{candidate_url:failure.candidate_url||null,candidate_title:failure.candidate_title||null,disposition:failure.disposition,reason:storedFailureReason(failure.reason),assertion_ids:[]};
    row.assertion_ids.push(failure.assertion_id);discovery.set(key,row);
  }
  const not_checked={};
  for(const result of results)if(result.not_checked_reason)not_checked[result.not_checked_reason]=(not_checked[result.not_checked_reason]||0)+1;
  return {discovery_failures:[...discovery.values()],excluded_sources:manifest.excluded_sources||[],not_checked};
}

export class VerificationService {
  constructor(pool, orchestrator, storageRoot, modelName = null, concurrency = 3, evidenceStore = null) { this.pool=pool; this.orchestrator=orchestrator; this.storageRoot=storageRoot; this.modelName=modelName; this.concurrency=concurrency; this.evidenceStore=evidenceStore||new EvidenceStore(pool,storageRoot); }

  async run(projectId, articleVersionId, mode = 'AUTHOR_CORPUS',options={}) {
    const { rows: assertions } = await this.pool.query('SELECT * FROM assertions WHERE project_id=$1 AND article_version_id=$2 ORDER BY start_offset,created_at', [projectId, articleVersionId]);
    if (!assertions.length) return null;
    const { rows: [run] } = await this.pool.query(`INSERT INTO verification_runs(project_id,article_version_id,mode,model_name,assertions_extracted,discovery_run_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [projectId, articleVersionId, mode, this.modelName, assertions.length,options.discoveryRunId||null]);
    try {
      const snapshotId=options.corpusSnapshotId || (await this.evidenceStore.seal(projectId,articleVersionId,options.discoveryRunId||null,{mode})).corpus_snapshot_id;
      const evidence=await this.evidenceStore.load(projectId,articleVersionId,snapshotId,assertions,options.discoveryRunId||null);
      await this.pool.query('UPDATE verification_runs SET corpus_snapshot_id=$2 WHERE verification_run_id=$1',[run.verification_run_id,snapshotId]);
      const results = await mapConcurrent(assertions, this.concurrency, assertion => this.#verifyOne(run.verification_run_id, assertion,evidence));
      // Attempted means passages went to the model. A claim with nothing to compare was not attempted.
      const attempted = results.filter(result => result.candidate_passage_count > 0).length;
      const counts = Object.fromEntries([...new Set(results.map(r => r.status))].map(status => [status, results.filter(r => r.status === status).length]));
      const sourceMetrics={primary_sources:new Set(evidence.manifest.links.filter(l=>l.proposition_source_class==='PRIMARY'&&evidence.manifest.versions.some(v=>v.source_id===l.source_id)).map(l=>l.source_id)).size,failures:new Set(evidence.manifest.links.filter(l=>['FAILED','BLOCKED'].includes(l.retrieval_status)).map(l=>l.source_id)).size};
      const gaps=evidenceGaps(evidence.manifest,results);
      const { rows: [completed] } = await this.pool.query(`UPDATE verification_runs SET status='COMPLETE',assertions_attempted=$2,assertions_not_attempted=$3,primary_sources_acquired=$4,source_acquisition_failures=$5,status_counts=$6,evidence_gaps=$7,completed_at=now() WHERE verification_run_id=$1 RETURNING *`,
        [run.verification_run_id, attempted, assertions.length-attempted, sourceMetrics.primary_sources || 0, (sourceMetrics.failures || 0)+gaps.discovery_failures.length, counts, gaps]);
      return { run: completed, results };
    } catch (error) {
      await this.pool.query(`UPDATE verification_runs SET status='FAILED',error_message=$2,completed_at=now() WHERE verification_run_id=$1`, [run.verification_run_id,error.message]).catch(()=>{});
      throw error;
    }
  }

  async #verifyOne(runId, assertion,evidence) {
    if (!requiresExternalEvidence(assertion)) {
      return this.#saveResult(runId, assertion, {
        source_id: null, passage_id: null, assertion_as_made: assertion.assertion_text,
        source_actually_establishes: 'External verification does not apply under the recorded claim classification.',
        material_gap: '', extracted_passage: null, status: 'NOT_APPLICABLE', defect_codes: [], confidence: null,
        recommended_remediation: 'No external check required. This statement has not been verified against external evidence.',
      });
    }
    const links=evidence.manifest.links.filter(l=>l.assertion_id===assertion.assertion_id);
    const passages=links.filter(l=>l.membership_status==='ACCEPTED').flatMap(l=>evidence.passages.filter(p=>p.source_id===l.source_id).map(p=>({...p,...evidence.manifest.versions.find(v=>v.source_version_id===p.source_version_id).metadata,proposition_source_class:l.proposition_source_class,relationship_type:l.relationship_type,class_assigned_by:l.class_assigned_by||'UNKNOWN'})));
    const primary = passages.filter(p => eligibleClass(assertion,p));
    const candidates = rankPassages(assertion.assertion_text, primary);
    let result;
    if (!candidates.length) {
      result = notCheckedResult(assertion,links,evidence,primary.length);
    } else {
      try { result = validateVerificationEvidence(await this.orchestrator.verifyAssertion({ assertion: { assertion_id: assertion.assertion_id, assertion_text: assertion.assertion_text, assertion_class: assertion.assertion_class, citation_as_written: assertion.citation_as_written, primary_source_required: assertion.primary_source_required !== false }, candidate_passages: candidates.map(p => ({ source_id:p.source_id,passage_id:p.passage_id,title:p.title,issuing_authority:p.issuing_authority,locator:p.locator,relationship_type:p.relationship_type,proposition_source_class:p.proposition_source_class,passage_text:p.passage_text })) }), candidates);
        // UNSUPPORTED is the model's reading of these passages only, so the record says what it was shown.
        if(result.status==='UNSUPPORTED')result={...result,material_gap:`Not found in the ${plural(new Set(candidates.map(p=>p.passage_id)).size,'passage')} retrieved (the best word matches among ${plural(primary.length,'eligible passage')}). ${result.material_gap||''}`.trim()}; }
      catch(error){if(error.publicMessage&&error.statusCode)throw error;if(error.providerReason){const message=`Verification stopped before finishing: the AI provider failed (${error.providerReason}). This run is incomplete and unchecked claims have no result. ${isPermanentProviderFailure(error.providerReason)?'Fix the provider setup, then run verification again.':'Retry when the provider is available.'}`;throw Object.assign(new Error(message),{statusCode:isPermanentProviderFailure(error.providerReason)?500:503,publicMessage:message,providerReason:error.providerReason})}result={source_id:null,passage_id:null,assertion_as_made:assertion.assertion_text,source_actually_establishes:'The verifier did not return a valid verbatim evidence extraction.',material_gap:`Verification output failed evidence validation: ${error.message}`,extracted_passage:null,status:'UNVERIFIABLE',defect_codes:[],confidence:null,recommended_remediation:'Retry verification or inspect the retrieved primary passages manually.',provider_response_id:null,not_checked_reason:'INVALID_MODEL_REPLY'}}
    }
    const passage = result.passage_id ? candidates.find(p => p.passage_id === result.passage_id) : null;
    return this.#saveResult(runId, assertion, result, passage, candidates);
  }

  async #saveResult(runId, assertion, result, passage = null, candidates = []) {
    const candidateIds=[...new Set(candidates.map(p=>p.passage_id))];
    const { rows: [saved] } = await this.pool.query(`INSERT INTO verification_results(verification_run_id,assertion_id,source_id,passage_id,assertion_as_made,source_actually_establishes,material_gap,extracted_passage,pin_cite,status,defect_codes,confidence,recommended_remediation,provider_response_id,evidence_passage_id,candidate_passage_ids,candidate_passage_count,not_checked_reason,source_class,source_class_assigned_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, [runId,assertion.assertion_id,result.source_id,null,result.assertion_as_made,result.source_actually_establishes,result.material_gap,result.extracted_passage,passage?.locator || null,result.status,result.defect_codes,result.confidence,result.recommended_remediation,result.provider_response_id || null,result.passage_id,candidateIds,candidateIds.length,result.not_checked_reason||null,passage?.proposition_source_class||null,passage?.class_assigned_by||null]);
    await this.pool.query('UPDATE assertions SET verification_state=$2,updated_at=now() WHERE assertion_id=$1', [assertion.assertion_id,result.status]);
    return saved;
  }
}
