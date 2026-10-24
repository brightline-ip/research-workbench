export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['research_brief', 'article'],
  properties: {
    research_brief: {
      type: 'object', additionalProperties: false,
      required: ['topic', 'scope', 'research_questions', 'source_plan', 'limitations'],
      properties: {
        topic: { type: 'string' }, scope: { type: 'string' },
        research_questions: { type: 'array', items: { type: 'string' } },
        source_plan: { type: 'array', items: { type: 'string' } },
        limitations: { type: 'array', items: { type: 'string' } }
      }
    },
    article: {
      type: 'object', additionalProperties: false,
      required: ['title', 'content_markdown'],
      properties: { title: { type: 'string' }, content_markdown: { type: 'string' } }
    }
  }
};

export const ASSERTION_CLASSES = [
  'DIRECT_QUOTE','LEGAL_HOLDING','LEGAL_CHARACTERIZATION','STATUTORY_OR_REGULATORY_REQUIREMENT',
  'AGENCY_POSITION','AGENCY_PRACTICE','QUANTITATIVE','DATE_OR_EVENT','TREND','TECHNICAL_FACT',
  'HISTORICAL_FACT','ANALYTICAL_INFERENCE','OPINION','UNSOURCED_ASSERTION'
];

export const ASSERTION_EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['coverage_complete', 'coverage_notes', 'assertions'],
  properties: {
    coverage_complete: { type: 'boolean' },
    coverage_notes: { type: 'string' },
    assertions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['block_index','evidence_span','assertion_text','normalized_proposition','assertion_class','load_bearing','load_bearing_reason','citation_as_written','source_required','primary_source_required'],
      properties: {
        block_index: { type: 'integer', minimum: 0 }, evidence_span: { type: 'string' },
        assertion_text: { type: 'string' }, normalized_proposition: { type: 'string' },
        assertion_class: { type: 'string', enum: ASSERTION_CLASSES }, load_bearing: { type: 'boolean' },
        load_bearing_reason: { type: ['string','null'] }, citation_as_written: { type: ['string','null'] },
        source_required: { type: 'boolean' }, primary_source_required: { type: 'boolean' }
      }
    }}
  }
};

export const SOURCE_CLASSIFICATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['proposition_source_class','classification_reason','relationship_type','discovery_only'],
  properties: {
    proposition_source_class: { type: 'string', enum: ['PRIMARY','SECONDARY','UNKNOWN'] },
    classification_reason: { type: 'string' },
    relationship_type: { type: 'string', enum: ['SUPPORTS','QUALIFIES','CONTRADICTS','BACKGROUND'] },
    discovery_only: { type: 'boolean' }
  }
};

export const VERIFICATION_STATUSES = ['VERIFIED','OVERSTATED','MISCITED','UNSUPPORTED','CONTRADICTED','STALE','UNVERIFIABLE','FABRICATED'];
export const DEFECT_CODES = ['WRONG_PIN_CITE','QUOTE_MISMATCH','NON_PRIMARY_SUPPORT','DICTA_AS_HOLDING','CONCURRENCE_AS_MAJORITY','DISSENT_AS_MAJORITY','HEADNOTE_AS_OPINION','NONPRECEDENTIAL_AS_BINDING','NONCONTROLLING_AS_CONTROLLING','SUPERSEDED_AUTHORITY','WRONG_DATA_VINTAGE','WRONG_DENOMINATOR','METRIC_DEFINITION_MISMATCH','ENDPOINT_SELECTION','CORRELATION_AS_CAUSATION','UNSUPPORTED_INFERENCE','OMITTED_QUALIFICATION','OMITTED_CONTRARY_AUTHORITY','TEMPORAL_IMPOSSIBILITY','CONCEPT_CONFLATION'];

export const VERIFICATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['source_id','passage_id','assertion_as_made','source_actually_establishes','material_gap','extracted_passage','status','defect_codes','confidence','recommended_remediation'],
  properties: {
    source_id: { type: ['string','null'] }, passage_id: { type: ['string','null'] },
    assertion_as_made: { type: 'string' }, source_actually_establishes: { type: 'string' }, material_gap: { type: 'string' },
    extracted_passage: { type: ['string','null'] }, status: { type: 'string', enum: VERIFICATION_STATUSES },
    defect_codes: { type: 'array', items: { type: 'string', enum: DEFECT_CODES } },
    confidence: { type: ['number','null'], minimum: 0, maximum: 1 }, recommended_remediation: { type: 'string' }
  }
};

export const REVISION_SCHEMA = {
  type:'object',additionalProperties:false,required:['title','content_markdown','change_summary','applied_verification_result_ids','issue_resolutions'],properties:{
    title:{type:'string'},content_markdown:{type:'string'},change_summary:{type:'string'},applied_verification_result_ids:{type:'array',items:{type:'string'}},
    issue_resolutions:{type:'array',items:{type:'object',additionalProperties:false,
      required:['verification_result_id','action','reason','revised_excerpt'],properties:{
        verification_result_id:{type:'string'},action:{type:'string',enum:['CORRECTED','QUALIFIED','REMOVED','NEEDS_EVIDENCE','NEEDS_REVIEW']},
        reason:{type:'string'},revised_excerpt:{type:['string','null']}
      }
    }}
  }
};
export const RED_TEAM_SCHEMA={type:'object',additionalProperties:false,required:['thesis_survives','executive_assessment','findings'],properties:{thesis_survives:{type:'string',enum:['YES','QUALIFIED','NO','INDETERMINATE']},executive_assessment:{type:'string'},findings:{type:'array',items:{type:'object',additionalProperties:false,required:['assertion_id','finding_type','severity','challenge','evidence_basis','recommended_action'],properties:{assertion_id:{type:['string','null']},finding_type:{type:'string',enum:['PUBLIC_CHALLENGE','CREDIBILITY_RISK','CORRECTION_REQUIRED','OMITTED_AUTHORITY','FAILED_PREMISE','THESIS_RISK']},severity:{type:'string',enum:['LOW','MEDIUM','HIGH','CRITICAL']},challenge:{type:'string'},evidence_basis:{type:'string'},recommended_action:{type:'string'}}}}}};
export const RECONCILIATION_SCHEMA={type:'object',additionalProperties:false,required:['overall_disposition','summary','required_actions'],properties:{overall_disposition:{type:'string',enum:['PUBLISHABLE','PUBLISHABLE_WITH_CORRECTIONS','MAJOR_REVISION','WITHHOLD']},summary:{type:'string'},required_actions:{type:'array',items:{type:'object',additionalProperties:false,required:['assertion_id','action','reason','requires_reverification'],properties:{assertion_id:{type:['string','null']},action:{type:'string'},reason:{type:'string'},requires_reverification:{type:'boolean'}}}}}};

export function assertDraftContract(value) {
  if (!value || typeof value !== 'object') throw new Error('Draft output is not an object');
  if (!value.research_brief || typeof value.research_brief.topic !== 'string') throw new Error('Draft output has no valid research brief');
  if (!value.article || typeof value.article.title !== 'string' || typeof value.article.content_markdown !== 'string') throw new Error('Draft output has no valid article');
  return value;
}

export function assertExtractionContract(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.assertions)) throw new Error('Extraction output has no assertions array');
  if (typeof value.coverage_complete !== 'boolean' || typeof value.coverage_notes !== 'string') throw new Error('Extraction output has invalid coverage metadata');
  for (const [index, item] of value.assertions.entries()) {
    if (!Number.isInteger(item.block_index) || item.block_index < 0 || !item.evidence_span || !item.assertion_text || !item.normalized_proposition) throw new Error(`Assertion ${index} has invalid identity or location fields`);
    if (!ASSERTION_CLASSES.includes(item.assertion_class)) throw new Error(`Assertion ${index} has invalid class`);
    if (typeof item.load_bearing !== 'boolean' || (item.load_bearing && !item.load_bearing_reason?.trim())) throw new Error(`Assertion ${index} has invalid load-bearing classification`);
    if (typeof item.source_required !== 'boolean' || typeof item.primary_source_required !== 'boolean') throw new Error(`Assertion ${index} has invalid source requirements`);
  }
  return value;
}

export function assertSourceClassificationContract(value) {
  if (!['PRIMARY','SECONDARY','UNKNOWN'].includes(value?.proposition_source_class)) throw new Error('Invalid proposition-specific source class');
  if (!['SUPPORTS','QUALIFIES','CONTRADICTS','BACKGROUND'].includes(value?.relationship_type) || !value.classification_reason?.trim() || typeof value.discovery_only !== 'boolean') throw new Error('Invalid source classification output');
  return value;
}

export function assertVerificationContract(value) {
  if (!VERIFICATION_STATUSES.includes(value?.status)) throw new Error('Invalid verification status');
  if (value.assertion_as_made === undefined || value.source_actually_establishes === undefined || value.material_gap === undefined || !value.recommended_remediation?.trim()) throw new Error('Verification comparison fields are incomplete');
  if (!Array.isArray(value.defect_codes) || value.defect_codes.some(code => !DEFECT_CODES.includes(code))) throw new Error('Invalid verification defect codes');
  if (value.confidence !== null && (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1)) throw new Error('Invalid verification confidence');
  return value;
}

export function assertRevisionContract(value, allowedResultIds=[]) {
  if(!value?.title?.trim()||!value?.content_markdown?.trim()||!value?.change_summary?.trim()||!Array.isArray(value.applied_verification_result_ids)||!Array.isArray(value.issue_resolutions)) throw new Error('Invalid revision output');
  const allowed=new Set(allowedResultIds),seen=new Set(),changed=new Set();
  for(const item of value.issue_resolutions){
    if(!allowed.has(item.verification_result_id))throw new Error('Revision referenced an unknown verification result');
    if(seen.has(item.verification_result_id))throw new Error('Revision listed an issue more than once');
    seen.add(item.verification_result_id);
    if(!['CORRECTED','QUALIFIED','REMOVED','NEEDS_EVIDENCE','NEEDS_REVIEW'].includes(item.action)||!item.reason?.trim())throw new Error('Revision issue has an invalid action or missing reason');
    if(item.action==='REMOVED'){
      if(item.revised_excerpt!==null)throw new Error('Removed issues must have no revised excerpt');
    }else if(!item.revised_excerpt?.trim()||!value.content_markdown.includes(item.revised_excerpt))throw new Error('Revision excerpt is absent from the revised draft');
    if(['CORRECTED','QUALIFIED','REMOVED'].includes(item.action))changed.add(item.verification_result_id);
    if(item.action==='NEEDS_EVIDENCE'&&!item.revised_excerpt.includes('[EVIDENCE NEEDED:'))throw new Error('Unresolved evidence must be marked in the draft');
    if(item.action==='NEEDS_REVIEW'&&!item.revised_excerpt.includes('[REVIEW NEEDED:'))throw new Error('Unresolved review must be marked in the draft');
  }
  if(seen.size!==allowed.size)throw new Error(`Revision did not account for all ${allowed.size} actionable issues`);
  const applied=new Set(value.applied_verification_result_ids);
  if(applied.size!==value.applied_verification_result_ids.length||applied.size!==changed.size||[...applied].some(id=>!changed.has(id)))throw new Error('Applied revision IDs do not match the documented changes');
  return value;
}
export function assertRedTeamContract(value,allowedAssertionIds=[]){if(!['YES','QUALIFIED','NO','INDETERMINATE'].includes(value?.thesis_survives)||!value.executive_assessment?.trim()||!Array.isArray(value.findings))throw new Error('Invalid red-team output');const allowed=new Set(allowedAssertionIds);for(const finding of value.findings){if(finding.assertion_id&&!allowed.has(finding.assertion_id))throw new Error('Red-team finding referenced an unknown assertion');if(!finding.challenge?.trim()||!finding.evidence_basis?.trim()||!finding.recommended_action?.trim())throw new Error('Incomplete red-team finding')}return value}
export function assertReconciliationContract(value,allowedAssertionIds=[]){if(!['PUBLISHABLE','PUBLISHABLE_WITH_CORRECTIONS','MAJOR_REVISION','WITHHOLD'].includes(value?.overall_disposition)||!value.summary?.trim()||!Array.isArray(value.required_actions))throw new Error('Invalid reconciliation output');const allowed=new Set(allowedAssertionIds);for(const action of value.required_actions)if(action.assertion_id&&!allowed.has(action.assertion_id))throw new Error('Reconciliation referenced an unknown assertion');return value}
