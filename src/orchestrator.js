import { fetchJson } from './safety.js';
import { FIX_DRAFT_INSTRUCTION } from './revision-policy.js';
import { DRAFT_SCHEMA, ASSERTION_EXTRACTION_SCHEMA, SOURCE_CLASSIFICATION_SCHEMA, VERIFICATION_SCHEMA, REVISION_SCHEMA, RED_TEAM_SCHEMA, RECONCILIATION_SCHEMA, assertDraftContract, assertExtractionContract, assertSourceClassificationContract, assertVerificationContract, assertRevisionContract, assertRedTeamContract, assertReconciliationContract } from './contracts.js';

const EXTRACTION_INSTRUCTION = `Decompose the supplied article into material atomic propositions. Extract externally checkable facts, numbers, dates, quotations, attributions, authority characterizations, comparisons, causal claims, current-status claims, and the factual premises of an argument. Do not split one proposition into redundant fragments. Omit headings, navigation, rhetorical questions, and pure descriptions of this document's purpose or organization, such as "This memorandum identifies and frames the issues." If a material opinion, recommendation, or document-internal statement must remain in the ledger, set source_required=false and primary_source_required=false; it does not need outside proof merely because it appears in the article. Separate any factual premise embedded in an opinion into its own source_required=true assertion. Claims about outside events, people, sources, quotations, and legal holdings still require evidence, even when introduced by "this document says" or expressed tentatively. If uncertain whether a factual claim needs evidence, set source_required=true. primary_source_required=true always implies source_required=true. Use the supplied zero-based block_index and copy evidence_span verbatim from that block. assertion_text must express exactly one substantive proposition. Identify load-bearing assertions independently of citations and explain every true determination. coverage_complete is true only after every block was examined and every material assertion was represented; omitted nonclaims do not make coverage incomplete. Do not verify anything.`;

const SYSTEM_INSTRUCTION = `You create an initial research brief and draft for an evidence-first research workbench. This is drafting, not verification. Never claim that a source was acquired or inspected unless the user supplied its contents. Mark citations that require acquisition as [SOURCE REQUIRED]. Distinguish known limitations in the research brief. Return only the requested JSON structure.`;

export function createOrchestrator(config, fetchImpl = fetch) {
  if (config.orchestrationMode === 'n8n') {
    return { draft: (input) => draftViaN8n(config, input, fetchImpl), extractAssertions: (input) => extractViaN8n(config, input, fetchImpl), classifySource: (input) => classifySourceViaN8n(config, input, fetchImpl), verifyAssertion: (input) => verifyViaN8n(config, input, fetchImpl), reviseArticle:(input)=>reviseViaN8n(config,input,fetchImpl),redTeam:(input)=>redTeamViaN8n(config,input,fetchImpl),reconcile:(input)=>reconcileViaN8n(config,input,fetchImpl) };
  }
  return { draft: (input) => draftViaOpenAI(config, input, fetchImpl), extractAssertions: (input) => extractViaOpenAI(config, input, fetchImpl), classifySource: (input) => classifySourceViaOpenAI(config, input, fetchImpl), verifyAssertion: (input) => verifyViaOpenAI(config, input, fetchImpl), reviseArticle:(input)=>reviseViaOpenAI(config,input,fetchImpl),redTeam:(input)=>redTeamViaOpenAI(config,input,fetchImpl),reconcile:(input)=>reconcileViaOpenAI(config,input,fetchImpl) };
}

async function structuredOpenAI(config, fetchImpl, { instructions, input, schema, name, model = config.openaiModel }) {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
  const payload = await fetchJson(fetchImpl, 'https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify({ model, instructions, input, text: { format: { type: 'json_schema', name, strict: true, schema } } })
  });
  const text = payload.output_text || payload.output?.flatMap(i => i.content || []).find(c => c.type === 'output_text')?.text;
  if (!text) throw new Error('OpenAI response contained no output text');
  return { value: JSON.parse(text), responseId: payload.id || null };
}

async function draftViaOpenAI(config, input, fetchImpl) {
  const { value } = await structuredOpenAI(config, fetchImpl, { instructions: SYSTEM_INSTRUCTION, input: `Project topic: ${input.topic}\nUser instruction: ${input.instruction}`, schema: DRAFT_SCHEMA, name: 'research_draft' });
  return assertDraftContract(value);
}

async function extractViaOpenAI(config, input, fetchImpl) {
  const instructions = EXTRACTION_INSTRUCTION;
  const { value, responseId } = await structuredOpenAI(config, fetchImpl, { instructions, input: JSON.stringify({ article_version_id: input.article_version_id, blocks: input.blocks }), schema: ASSERTION_EXTRACTION_SCHEMA, name: 'atomic_assertion_extraction', model: config.claimExtractionModel || config.openaiModel });
  return { ...assertExtractionContract(value), provider_response_id: responseId };
}

async function classifySourceViaOpenAI(config, input, fetchImpl) {
  const instructions = `Classify a candidate source only for the proposition supplied. PRIMARY means the document is direct evidence for that proposition, not merely reputable. Search metadata and summaries are discovery aids, not evidence. If the actual source has not been acquired, do not assert that it supports the proposition; use BACKGROUND and discovery_only=true unless the relationship is independently evident from supplied source text. Return the strict JSON contract.`;
  const { value } = await structuredOpenAI(config, fetchImpl, { instructions, input: JSON.stringify(input), schema: SOURCE_CLASSIFICATION_SCHEMA, name: 'source_classification' });
  return assertSourceClassificationContract(value);
}

async function verifyViaOpenAI(config, input, fetchImpl) {
  const instructions = `Perform only the canonical verification transaction: LOCATE, PIN CITE, EXTRACT, COMPARE, CLASSIFY, RECOMMEND. You may use only the retrieved candidate passages supplied. Copy extracted_passage verbatim and return its source_id and passage_id. Store separately what the assertion says, what the source establishes, and the material gap. Choose exactly one status: VERIFIED, OVERSTATED, MISCITED, UNSUPPORTED, CONTRADICTED, STALE, UNVERIFIABLE, or FABRICATED. VERIFIED requires adequate proposition-specific evidence satisfying assertion.primary_source_required. When true, only PRIMARY passages qualify; when false, relevant SECONDARY passages may qualify for what that source actually establishes and no omitted material qualifier. Search snippets, model knowledge, absence of contrary evidence, and citation form cannot establish VERIFIED. Secondary commentary cannot establish what a primary authority actually held. Do not revise the article.`;
  const { value, responseId } = await structuredOpenAI(config, fetchImpl, { instructions, input: JSON.stringify(input), schema: VERIFICATION_SCHEMA, name: 'assertion_verification', model: config.verificationModel || config.openaiModel });
  return { ...assertVerificationContract(value), provider_response_id: responseId };
}

async function reviseViaOpenAI(config,input,fetchImpl){
  const instructions=FIX_DRAFT_INSTRUCTION;
  const {value,responseId}=await structuredOpenAI(config,fetchImpl,{instructions,input:JSON.stringify(input),schema:REVISION_SCHEMA,name:'evidence_guided_revision',model:config.revisionModel||config.openaiModel});
  return {...assertRevisionContract(value,input.verification_results.map(r=>r.verification_result_id)),provider_response_id:responseId};
}
async function redTeamViaOpenAI(config,input,fetchImpl){const instructions='NOT_APPLICABLE means no external check was requested; treat it as neither a defect nor proof of truth. Examine factual premises separately. Act as an independent adversarial reviewer, not an editor. Construct the strongest competent evidence-bounded challenge to the article. Use only supplied article text, assertions, exact verification records, run comparison, and source metadata. Identify public challenge, credibility, correction, omitted-authority, failed-premise, and thesis risks. Do not invent contrary authority and do not rewrite the article.';const{value,responseId}=await structuredOpenAI(config,fetchImpl,{instructions,input:JSON.stringify(input),schema:RED_TEAM_SCHEMA,name:'adversarial_red_team',model:config.verificationModel});return{...assertRedTeamContract(value,input.assertions.map(a=>a.assertion_id)),provider_response_id:responseId}}
async function reconcileViaOpenAI(config,input,fetchImpl){const instructions='Reconcile the author-corpus verification, independent verification, deterministic disagreements, and red-team findings. Do not rewrite the article. Produce a publication disposition and the minimum required actions. Preserve uncertainty, prefer primary evidence, and require reverification for any substantive correction.';const{value,responseId}=await structuredOpenAI(config,fetchImpl,{instructions,input:JSON.stringify(input),schema:RECONCILIATION_SCHEMA,name:'adversarial_reconciliation',model:config.revisionModel});return{...assertReconciliationContract(value,input.assertions.map(a=>a.assertion_id)),provider_response_id:responseId}}

async function draftViaN8n(config, input, fetchImpl) {
  const value=await structuredN8n(config,fetchImpl,{operation:'draft',instructions:SYSTEM_INSTRUCTION,input:`Project topic: ${input.topic}\nUser instruction: ${input.instruction}`,schema:DRAFT_SCHEMA,name:'research_draft',model:config.openaiModel});
  return assertDraftContract(value);
}

async function extractViaN8n(config, input, fetchImpl) {
  const instructions = EXTRACTION_INSTRUCTION;
  const value=await structuredN8n(config,fetchImpl,{operation:'assertions',instructions,input:JSON.stringify(input),schema:ASSERTION_EXTRACTION_SCHEMA,name:'atomic_assertion_extraction',model:config.claimExtractionModel});
  return assertExtractionContract(value);
}

async function classifySourceViaN8n(config,input,fetchImpl){const instructions=`Classify a candidate source only for the supplied proposition. PRIMARY means direct evidence, not merely reputable. If the source has not been acquired, do not assert support from unseen content. Return only the requested JSON.`;return assertSourceClassificationContract(await structuredN8n(config,fetchImpl,{operation:'classify_source',instructions,input:JSON.stringify(input),schema:SOURCE_CLASSIFICATION_SCHEMA,name:'source_classification',model:config.openaiModel}))}
async function verifyViaN8n(config,input,fetchImpl){const instructions=`Perform only LOCATE, PIN CITE, EXTRACT, COMPARE, CLASSIFY, RECOMMEND using supplied passages. Copy extracted_passage verbatim. VERIFIED requires adequate proposition-specific evidence satisfying assertion.primary_source_required. When true, only PRIMARY passages qualify; when false, relevant SECONDARY passages may qualify for what that source actually establishes. Do not revise the article.`;const value=await structuredN8n(config,fetchImpl,{operation:'verify',instructions,input:JSON.stringify(input),schema:VERIFICATION_SCHEMA,name:'assertion_verification',model:config.verificationModel});return assertVerificationContract(value)}
async function reviseViaN8n(config,input,fetchImpl){const instructions=FIX_DRAFT_INSTRUCTION;const value=await structuredN8n(config,fetchImpl,{operation:'revise',instructions,input:JSON.stringify(input),schema:REVISION_SCHEMA,name:'evidence_guided_revision',model:config.revisionModel});return assertRevisionContract(value,input.verification_results.map(r=>r.verification_result_id))}
async function redTeamViaN8n(config,input,fetchImpl){const instructions='NOT_APPLICABLE means no external check was requested; treat it as neither a defect nor proof of truth. Examine factual premises separately. Act as an independent adversarial reviewer, not an editor. Construct the strongest competent evidence-bounded challenge using only supplied records. Identify credibility, omitted-authority, correction, failed-premise, and thesis risks. Invent nothing and do not rewrite.';return assertRedTeamContract(await structuredN8n(config,fetchImpl,{operation:'red_team',instructions,input:JSON.stringify(input),schema:RED_TEAM_SCHEMA,name:'adversarial_red_team',model:config.verificationModel}),input.assertions.map(a=>a.assertion_id))}
async function reconcileViaN8n(config,input,fetchImpl){const instructions='NOT_APPLICABLE is neither a defect nor proof of truth. Reconcile the two verification runs and red-team findings without rewriting. Produce a publication disposition and minimum required actions. Preserve uncertainty and require reverification after substantive corrections.';return assertReconciliationContract(await structuredN8n(config,fetchImpl,{operation:'reconcile',instructions,input:JSON.stringify(input),schema:RECONCILIATION_SCHEMA,name:'adversarial_reconciliation',model:config.revisionModel}),input.assertions.map(a=>a.assertion_id))}
async function structuredN8n(config,fetchImpl,payload){if(!config.n8nWebhookUrl)throw new Error('N8N_DRAFT_WEBHOOK_URL is not configured');if(!config.n8nWebhookAuthHeader)throw new Error('N8N_WEBHOOK_AUTH_HEADER is not configured');const headers={'content-type':'application/json',authorization:config.n8nWebhookAuthHeader};const body=await fetchJson(fetchImpl,config.n8nWebhookUrl,{method:'POST',headers,body:JSON.stringify(payload)});if(body?.error)throw new Error('n8n research gateway returned a controlled error');return body?.result??body}
