import { EvidenceStore } from './evidence-store.js';
import { rankPassages, validateVerificationEvidence } from './passages.js';
import { requiresExternalEvidence } from '../public/report-model.js';
import { mapConcurrent } from './concurrency.js';
import { isPermanentProviderFailure } from './safety.js';

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
      const attempted = results.filter(result => result.status !== 'NOT_APPLICABLE').length;
      const counts = Object.fromEntries([...new Set(results.map(r => r.status))].map(status => [status, results.filter(r => r.status === status).length]));
      const sourceMetrics={primary_sources:new Set(evidence.manifest.links.filter(l=>l.proposition_source_class==='PRIMARY'&&evidence.manifest.versions.some(v=>v.source_id===l.source_id)).map(l=>l.source_id)).size,failures:evidence.manifest.links.filter(l=>['FAILED','BLOCKED'].includes(l.retrieval_status)).length};
      const { rows: [completed] } = await this.pool.query(`UPDATE verification_runs SET status='COMPLETE',assertions_attempted=$2,assertions_not_attempted=$3,primary_sources_acquired=$4,source_acquisition_failures=$5,status_counts=$6,completed_at=now() WHERE verification_run_id=$1 RETURNING *`,
        [run.verification_run_id, attempted, assertions.length-attempted, sourceMetrics.primary_sources || 0, sourceMetrics.failures || 0, counts]);
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
    const passages=links.filter(l=>l.membership_status==='ACCEPTED').flatMap(l=>evidence.passages.filter(p=>p.source_id===l.source_id).map(p=>({...p,...evidence.manifest.versions.find(v=>v.source_version_id===p.source_version_id).metadata,proposition_source_class:l.proposition_source_class,relationship_type:l.relationship_type})));
    const primary = passages.filter(p => p.proposition_source_class === 'PRIMARY' || (assertion.primary_source_required === false && p.proposition_source_class === 'SECONDARY'));
    const candidates = rankPassages(assertion.assertion_text, primary);
    let result;
    if (!candidates.length) {
      const access={secondary_count:links.filter(l=>l.proposition_source_class==='SECONDARY').length};
      const unavailable=links.some(l=>['FAILED','BLOCKED','ACQUIRING'].includes(l.retrieval_status)||(l.membership_status==='ACCEPTED'&&!evidence.manifest.versions.some(v=>v.source_id===l.source_id&&v.normalized_content_hash)));
      result = {
        source_id: null, passage_id: null, assertion_as_made: assertion.assertion_text,
        source_actually_establishes: unavailable ? 'No adequate passage meeting the source requirements could be acquired and inspected.' : 'No adequate passage meeting the source requirements in the approved corpus establishes this assertion.',
        material_gap: unavailable ? 'Evidence access or normalization was insufficient for a substantive determination.' : 'Adequate support meeting the claim source requirements is absent from the approved corpus.',
        extracted_passage: null, status: unavailable ? 'UNVERIFIABLE' : 'UNSUPPORTED',
        defect_codes: assertion.primary_source_required !== false && (access?.secondary_count || 0) > 0 ? ['NON_PRIMARY_SUPPORT'] : [], confidence: null,
        recommended_remediation: unavailable ? 'Acquire and normalize the authoritative source, then retry verification.' : 'Locate adequate primary evidence, narrow the assertion, or delete it.', provider_response_id: null
      };
    } else {
      try { result = validateVerificationEvidence(await this.orchestrator.verifyAssertion({ assertion: { assertion_id: assertion.assertion_id, assertion_text: assertion.assertion_text, assertion_class: assertion.assertion_class, citation_as_written: assertion.citation_as_written, primary_source_required: assertion.primary_source_required !== false }, candidate_passages: candidates.map(p => ({ source_id:p.source_id,passage_id:p.passage_id,title:p.title,issuing_authority:p.issuing_authority,locator:p.locator,relationship_type:p.relationship_type,proposition_source_class:p.proposition_source_class,passage_text:p.passage_text })) }), candidates); }
      catch(error){if(error.publicMessage&&error.statusCode)throw error;if(error.providerReason){const message=`Verification stopped before finishing: the AI provider failed (${error.providerReason}). This run is incomplete and unchecked claims have no result. Retry when the provider is available.`;throw Object.assign(new Error(message),{statusCode:isPermanentProviderFailure(error.providerReason)?500:503,publicMessage:message,providerReason:error.providerReason})}result={source_id:null,passage_id:null,assertion_as_made:assertion.assertion_text,source_actually_establishes:'The verifier did not return a valid verbatim evidence extraction.',material_gap:`Verification output failed evidence validation: ${error.message}`,extracted_passage:null,status:'UNVERIFIABLE',defect_codes:[],confidence:null,recommended_remediation:'Retry verification or inspect the retrieved primary passages manually.',provider_response_id:null}}
    }
    const passage = result.passage_id ? candidates.find(p => p.passage_id === result.passage_id) : null;
    return this.#saveResult(runId, assertion, result, passage);
  }

  async #saveResult(runId, assertion, result, passage = null) {
    const { rows: [saved] } = await this.pool.query(`INSERT INTO verification_results(verification_run_id,assertion_id,source_id,passage_id,assertion_as_made,source_actually_establishes,material_gap,extracted_passage,pin_cite,status,defect_codes,confidence,recommended_remediation,provider_response_id,evidence_passage_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [runId,assertion.assertion_id,result.source_id,null,result.assertion_as_made,result.source_actually_establishes,result.material_gap,result.extracted_passage,passage?.locator || null,result.status,result.defect_codes,result.confidence,result.recommended_remediation,result.provider_response_id || null,result.passage_id]);
    await this.pool.query('UPDATE assertions SET verification_state=$2,updated_at=now() WHERE assertion_id=$1', [assertion.assertion_id,result.status]);
    return saved;
  }
}
