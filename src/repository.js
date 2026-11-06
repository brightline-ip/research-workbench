import { assertRevisionContract } from './contracts.js';
import { revisionFindings } from './revision-policy.js';
import { displayResult, needsAttention } from '../public/report-model.js';
import { currentComparisons } from './adversarial.js';
import crypto from 'node:crypto';
import { articleBlocks, locateAssertions } from './article-locations.js';
import { canonicalizeUrl } from './source-acquisition.js';
import { DISCOVERY_FAILURES_SQL, readableDiscoveryFailures } from './evidence-store.js';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

export class Repository {
  constructor(pool) { this.pool = pool; }

  async listProjects() {
    const { rows } = await this.pool.query(`SELECT p.*, av.article_version_id, av.version_number, av.title AS article_title
      FROM projects p LEFT JOIN LATERAL (SELECT * FROM article_versions WHERE project_id=p.project_id ORDER BY version_number DESC LIMIT 1) av ON true
      ORDER BY p.updated_at DESC`);
    return rows;
  }

  async createProject({ title, topic }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [project] } = await client.query('INSERT INTO projects(title, topic) VALUES ($1,$2) RETURNING *', [title.trim(), topic?.trim() || null]);
      const { rows: [thread] } = await client.query('INSERT INTO conversation_threads(project_id) VALUES ($1) RETURNING *', [project.project_id]);
      await client.query('COMMIT');
      return { ...project, thread_id: thread.thread_id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getWorkspace(projectId) {
    const { rows: [project] } = await this.pool.query('SELECT * FROM projects WHERE project_id=$1', [projectId]);
    if (!project) return null;
    const [{ rows: articles }, { rows: messages }, { rows: assertions }, { rows: [assertion_extraction] }, { rows: sources }, { rows: [discovery_run] }, { rows: [corpus_snapshot] }, { rows: [verification_run] }, { rows: verification_results }, { rows: artifacts }] = await Promise.all([
      this.pool.query('SELECT * FROM article_versions WHERE project_id=$1 ORDER BY version_number DESC', [projectId]),
      this.pool.query(`SELECT m.* FROM conversation_messages m JOIN conversation_threads t USING(thread_id)
        WHERE t.project_id=$1 ORDER BY m.created_at`, [projectId]),
      this.pool.query(`SELECT a.* FROM assertions a JOIN article_versions av USING(article_version_id)
        WHERE a.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1)
        ORDER BY a.start_offset, a.created_at`, [projectId]),
      this.pool.query(`SELECT er.* FROM assertion_extraction_runs er JOIN article_versions av USING(article_version_id)
        WHERE er.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1)`, [projectId]),
      this.pool.query(`SELECT s.*, ps.membership_status FROM sources s JOIN project_sources ps USING(source_id)
        WHERE ps.project_id=$1 ORDER BY ps.added_at DESC`, [projectId]),
      this.pool.query(`SELECT dr.* FROM discovery_runs dr JOIN article_versions av USING(article_version_id)
        WHERE dr.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1)
        ORDER BY dr.created_at DESC LIMIT 1`, [projectId]),
      this.pool.query(`SELECT cs.* FROM corpus_snapshots cs JOIN article_versions av USING(article_version_id)
        WHERE cs.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1)
        ORDER BY cs.created_at DESC LIMIT 1`, [projectId]),
      this.pool.query(`SELECT vr.* FROM verification_runs vr JOIN article_versions av USING(article_version_id)
        WHERE vr.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1)
        AND vr.mode='AUTHOR_CORPUS'
        ORDER BY vr.created_at DESC LIMIT 1`, [projectId]),
      this.pool.query(`SELECT vrx.*,COALESCE(sv.metadata->>'title',s.title) AS source_title,COALESCE(ep.locator,c.locator) AS locator,COALESCE(ep.passage_text,c.passage_text) AS passage_text FROM verification_results vrx
        JOIN verification_runs vr USING(verification_run_id) LEFT JOIN sources s USING(source_id) LEFT JOIN source_text_chunks c USING(passage_id) LEFT JOIN evidence_passages ep ON ep.evidence_passage_id=vrx.evidence_passage_id LEFT JOIN source_versions sv ON sv.source_version_id=ep.source_version_id
        WHERE vr.verification_run_id=(SELECT verification_run_id FROM verification_runs vr2 JOIN article_versions av USING(article_version_id)
          WHERE vr2.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1) AND vr2.mode='AUTHOR_CORPUS' ORDER BY vr2.created_at DESC LIMIT 1)
        ORDER BY vrx.created_at`, [projectId]),
      this.pool.query(`SELECT * FROM project_artifacts WHERE project_id=$1 AND storage_path IS NOT NULL ORDER BY created_at DESC`, [projectId])
    ]);
    const {rows:[adversarial_run]}=await this.pool.query(`SELECT ar.* FROM adversarial_runs ar JOIN article_versions av USING(article_version_id) WHERE ar.project_id=$1 AND av.version_number=(SELECT max(version_number) FROM article_versions WHERE project_id=$1) ORDER BY ar.created_at DESC LIMIT 1`,[projectId]);
    let adversarial_comparisons=[],red_team_run=null,red_team_findings=[],reconciliation_run=null;
    if(adversarial_run){({rows:adversarial_comparisons}=await this.pool.query('SELECT * FROM adversarial_comparisons WHERE adversarial_run_id=$1 ORDER BY materiality DESC,created_at',[adversarial_run.adversarial_run_id]));const compared=adversarial_comparisons.flatMap(c=>[c.author_result_id,c.independent_result_id]).filter(Boolean);adversarial_comparisons=currentComparisons(adversarial_comparisons,assertions,(await this.pool.query('SELECT * FROM verification_results WHERE verification_result_id=ANY($1::uuid[])',[compared])).rows);({rows:[red_team_run]}=await this.pool.query('SELECT * FROM red_team_runs WHERE adversarial_run_id=$1 ORDER BY created_at DESC LIMIT 1',[adversarial_run.adversarial_run_id]));if(red_team_run)({rows:red_team_findings}=await this.pool.query('SELECT * FROM red_team_findings WHERE red_team_run_id=$1 ORDER BY severity DESC,created_at',[red_team_run.red_team_run_id]));({rows:[reconciliation_run]}=await this.pool.query('SELECT * FROM reconciliation_runs WHERE adversarial_run_id=$1 ORDER BY created_at DESC LIMIT 1',[adversarial_run.adversarial_run_id]))}
    const {rows:[revision_run]}=await this.pool.query(`SELECT rr.*, original.version_number AS source_version_number, original.content_markdown AS original_content_markdown, revised.version_number AS output_version_number, revised.content_markdown AS revised_content_markdown FROM revision_runs rr JOIN article_versions original ON original.article_version_id=rr.source_article_version_id LEFT JOIN article_versions revised ON revised.article_version_id=rr.output_article_version_id WHERE rr.project_id=$1 ORDER BY rr.created_at DESC LIMIT 1`,[projectId]);
    const {rows:discovery_failures}=discovery_run?await this.pool.query(DISCOVERY_FAILURES_SQL,[discovery_run.discovery_run_id]):{rows:[]};
    return { project, articles, messages, assertions, assertion_extraction: assertion_extraction || null, sources, discovery_run: discovery_run || null, discovery_failures:readableDiscoveryFailures(discovery_failures), corpus_snapshot: corpus_snapshot || null, verification_run: verification_run || null, verification_results:verification_results.map(result=>displayResult(assertions.find(a=>a.assertion_id===result.assertion_id),result)),adversarial_run:adversarial_run||null,adversarial_comparisons,red_team_run:red_team_run||null,red_team_findings,reconciliation_run:reconciliation_run||null, revision_run:revision_run||null, artifacts };
  }

  async getSource(projectId, sourceId) {
    const { rows: [source] } = await this.pool.query(`SELECT s.* FROM sources s JOIN project_sources ps USING(source_id) WHERE ps.project_id=$1 AND s.source_id=$2`, [projectId, sourceId]);
    return source || null;
  }

  async getArtifact(projectId, artifactId) {
    const { rows: [artifact] } = await this.pool.query(`SELECT * FROM project_artifacts WHERE project_id=$1 AND artifact_id=$2`, [projectId, artifactId]);
    return artifact || null;
  }

  async saveCheckpoint(projectId, data, transactionClient = null, requestKey = null) {
    if(requestKey!==null&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)||transactionClient))throw Object.assign(new Error('Invalid checkpoint request key'),{statusCode:400});
    if(data.source_content_sha256!==undefined&&data.source_content_sha256!==hash(data.content_markdown))throw Object.assign(new Error('Checkpoint content hash mismatch'),{statusCode:400});
    if (transactionClient) return this.#insertCheckpoint(projectId, data, transactionClient);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let requestHash;
      if(requestKey){
        requestHash=hash(JSON.stringify({projectId:projectId.toLowerCase(),title:data.title,content_markdown:data.content_markdown,created_by:data.created_by??'USER',research_brief:data.research_brief??null,change_summary:data.change_summary??null,import_metadata:data.import_metadata??null}));
        // Serializes same-project version creation and replay. Cross-project
        // reuse is also rejected by the global request-key unique constraint.
        await client.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE',[projectId]);
        const {rows:[existing]}=await client.query('SELECT * FROM checkpoint_requests WHERE request_key=$1',[requestKey]);
        if(existing){
          if(existing.project_id!==projectId.toLowerCase()||existing.request_hash!==requestHash)throw Object.assign(new Error('Checkpoint request key conflicts with different content'),{statusCode:409});
          const {rows:[version]}=await client.query('SELECT * FROM article_versions WHERE article_version_id=$1 AND project_id=$2',[existing.article_version_id,projectId]);
          if(!version)throw Error('Checkpoint receipt references missing version');
          await client.query('COMMIT');return version;
        }
      }
      const version = await this.#insertCheckpoint(projectId, data, client);
      if(requestKey&&version)await client.query('INSERT INTO checkpoint_requests(request_key,project_id,request_hash,article_version_id) VALUES($1,$2,$3,$4)',[requestKey,projectId,requestHash,version.article_version_id]);
      await client.query('COMMIT');
      return version;
    } catch (error) { await client.query('ROLLBACK'); if(requestKey&&error.code==='23505')throw Object.assign(new Error('Checkpoint request key conflict; inspect accepted result'),{statusCode:409});throw error; } finally { client.release(); }
  }

  async #insertCheckpoint(projectId, { title, content_markdown, created_by = 'USER', research_brief = null, change_summary = null, import_metadata = null }, client) {
    const contentHash = hash(content_markdown);
    const { rowCount } = await client.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [projectId]);
    if (!rowCount) return null;
    const { rows: [version] } = await client.query(`INSERT INTO article_versions
      (project_id, version_number, title, content_markdown, research_brief, change_summary, created_by, parent_version_id, content_hash, import_metadata)
      SELECT $1, COALESCE(MAX(version_number),0)+1, $2,$3,$4,$5,$6,
        (SELECT article_version_id FROM article_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1),$7,$8
      FROM article_versions WHERE project_id=$1 RETURNING *`,
      [projectId, title, content_markdown, research_brief, change_summary, created_by, contentHash, import_metadata]);
    await client.query('UPDATE projects SET status=$2, updated_at=now() WHERE project_id=$1', [projectId, created_by === 'MODEL' ? 'DRAFTED' : 'DRAFTED']);
    return version;
  }

  async createDraft(projectId, instruction, orchestrator) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      const { rows: [context] } = await client.query(`SELECT p.*, t.thread_id FROM projects p JOIN conversation_threads t USING(project_id) WHERE p.project_id=$1`, [projectId]);
      if (!context) return null;
      await client.query('INSERT INTO conversation_messages(thread_id,role,content) VALUES ($1,$2,$3)', [context.thread_id, 'user', instruction]);
      await client.query('UPDATE projects SET status=$2, updated_at=now() WHERE project_id=$1', [projectId, 'RESEARCHING']);
      const output = await orchestrator.draft({ project_id: projectId, topic: context.topic || context.title, instruction });
      await client.query('BEGIN');
      transactionOpen = true;
      const version = await this.saveCheckpoint(projectId, { ...output.article, research_brief: output.research_brief, created_by: 'MODEL', change_summary: 'Initial model draft' }, client);
      await client.query(`INSERT INTO project_artifacts(project_id,artifact_type,title,mime_type,article_version_id,metadata)
        VALUES ($1,'RESEARCH_BRIEF',$2,'application/json',$3,$4),($1,'ARTICLE',$5,'text/markdown',$3,'{}')`,
        [projectId, `Research brief: ${output.article.title}`, version.article_version_id, output.research_brief, output.article.title]);
      await client.query('INSERT INTO conversation_messages(thread_id,role,content,referenced_article_version_id) VALUES ($1,$2,$3,$4)',
        [context.thread_id, 'assistant', `Created research brief and article version ${version.version_number}.`, version.article_version_id]);
      await client.query('COMMIT');
      transactionOpen = false;
      return { output, version };
    } catch (error) {
      if (transactionOpen) try { await client.query('ROLLBACK'); } catch {}
      await client.query('UPDATE projects SET status=$2, updated_at=now() WHERE project_id=$1', [projectId, 'FAILED']).catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async extractAssertions(projectId, articleVersionId, orchestrator, modelName = null, scope = {}) {
    const { rows: [article] } = await this.pool.query('SELECT * FROM article_versions WHERE article_version_id=$1 AND project_id=$2', [articleVersionId, projectId]);
    if (!article) return null;
    const { rows: [existing] } = await this.pool.query('SELECT * FROM assertion_extraction_runs WHERE article_version_id=$1', [articleVersionId]);
    const normalizedScope={instruction:String(scope.instruction||'').trim().slice(0,2000),include_sections:Array.isArray(scope.include_sections)?scope.include_sections.map(String).slice(0,50):[],exclude_sections:Array.isArray(scope.exclude_sections)?scope.exclude_sections.map(String).slice(0,50):[],include_block_indexes:Array.isArray(scope.include_block_indexes)?[...new Set(scope.include_block_indexes.filter(Number.isSafeInteger))].sort((a,b)=>a-b):[],exclude_block_indexes:Array.isArray(scope.exclude_block_indexes)?[...new Set(scope.exclude_block_indexes.filter(Number.isSafeInteger))].sort((a,b)=>a-b):[]};
    if (existing?.status === 'COMPLETE') {
      const prior=existing.verification_scope||{};
      const sameScope=String(prior.instruction||'')===normalizedScope.instruction&&JSON.stringify(prior.include_sections||[])===JSON.stringify(normalizedScope.include_sections)&&JSON.stringify(prior.exclude_sections||[])===JSON.stringify(normalizedScope.exclude_sections)&&JSON.stringify(prior.include_block_indexes||[])===JSON.stringify(normalizedScope.include_block_indexes)&&JSON.stringify(prior.exclude_block_indexes||[])===JSON.stringify(normalizedScope.exclude_block_indexes);
      if(!sameScope)throw Object.assign(new Error('Assertions already exist for a different verification scope; create a new article checkpoint for a different scope.'),{statusCode:409,publicMessage:'Assertions already exist for a different verification scope; create a new article checkpoint for a different scope.'});
      const { rows: assertions } = await this.pool.query('SELECT * FROM assertions WHERE article_version_id=$1 ORDER BY start_offset, created_at', [articleVersionId]);
      return { run: existing, assertions, reused: true };
    }
    const { rows: [run] } = await this.pool.query(`INSERT INTO assertion_extraction_runs(project_id,article_version_id,model_name,verification_scope)
      VALUES ($1,$2,$3,$4) ON CONFLICT(article_version_id) DO UPDATE SET status='RUNNING', error_message=NULL, model_name=EXCLUDED.model_name,verification_scope=EXCLUDED.verification_scope RETURNING *`, [projectId, articleVersionId, modelName, normalizedScope]);
    try {
      const included=new Set(normalizedScope.include_block_indexes),excluded=new Set(normalizedScope.exclude_block_indexes);
      const blocks=articleBlocks(article.content_markdown).filter(block=>(!included.size||included.has(block.block_index))&&!excluded.has(block.block_index)).map(({block_index,text})=>({block_index,text}));
      if(!blocks.length)throw Object.assign(new Error('Verification scope selected no article blocks'),{statusCode:400});
      const extraction = await orchestrator.extractAssertions({ article_version_id: articleVersionId, verification_scope:normalizedScope, blocks });
      const located = locateAssertions(article.content_markdown, extraction);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM assertions WHERE article_version_id=$1', [articleVersionId]);
        const assertions = [];
        for (const item of located) {
          const values = [projectId, articleVersionId, run.extraction_run_id, item.block_index, item.start_offset, item.end_offset, item.evidence_span, item.assertion_text, item.normalized_proposition, item.assertion_class, item.load_bearing, item.load_bearing_reason, item.citation_as_written, item.source_required, item.primary_source_required, item.assertion_fingerprint];
          const { rows: [saved] } = await client.query(`INSERT INTO assertions(project_id,article_version_id,extraction_run_id,block_index,start_offset,end_offset,evidence_span,assertion_text,normalized_proposition,assertion_class,load_bearing,load_bearing_reason,citation_as_written,source_required,primary_source_required,assertion_fingerprint)
            VALUES (${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values);
          assertions.push(saved);
        }
        const { rows: [completed] } = await client.query(`UPDATE assertion_extraction_runs SET status='COMPLETE',coverage_complete=$2,coverage_notes=$3,assertion_count=$4,provider_response_id=$5,completed_at=now() WHERE extraction_run_id=$1 RETURNING *`, [run.extraction_run_id, extraction.coverage_complete, extraction.coverage_notes, assertions.length, extraction.provider_response_id || null]);
        await client.query('COMMIT');
        return { run: completed, assertions, reused: false };
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) {
      await this.pool.query(`UPDATE assertion_extraction_runs SET status='FAILED',error_message=$2,completed_at=now() WHERE extraction_run_id=$1`, [run.extraction_run_id, error.message]).catch(() => {});
      throw error;
    }
  }

  async registerSource(projectId, input) {
    const canonicalUrl = canonicalizeUrl(input.canonical_url);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [source] } = await client.query(`INSERT INTO sources(canonical_url,title,source_type,issuing_authority,jurisdiction,publication_date,version_label,canonical_identity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(canonical_url) DO UPDATE SET
        title=COALESCE(EXCLUDED.title,sources.title),issuing_authority=COALESCE(EXCLUDED.issuing_authority,sources.issuing_authority),updated_at=now() RETURNING *`,
        [canonicalUrl, input.title || null, input.source_type || 'OTHER', input.issuing_authority || null, input.jurisdiction || null, input.publication_date || null, input.version_label || null, input.canonical_identity || null]);
      await client.query(`INSERT INTO project_sources(project_id,source_id,membership_status) VALUES ($1,$2,'CANDIDATE') ON CONFLICT DO NOTHING`, [projectId, source.source_id]);
      if (input.assertion_id) await client.query(`INSERT INTO assertion_source_relationships(assertion_id,source_id,relationship_type,proposition_source_class,classification_reason,discovery_only,class_assigned_by)
        SELECT assertion_id,$2,$3,$4,$5,true,$7 FROM assertions WHERE assertion_id=$1 AND project_id=$6
        ON CONFLICT(assertion_id,source_id,relationship_type) DO UPDATE SET proposition_source_class=EXCLUDED.proposition_source_class,classification_reason=EXCLUDED.classification_reason,class_assigned_by=EXCLUDED.class_assigned_by`,
        [input.assertion_id, source.source_id, input.relationship_type || 'BACKGROUND', input.proposition_source_class || 'UNKNOWN', input.classification_reason || 'Not yet classified.', projectId, input.class_assigned_by || 'UNKNOWN']);
      await client.query('COMMIT'); return source;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getAssertion(projectId, assertionId) {
    const { rows: [assertion] } = await this.pool.query('SELECT * FROM assertions WHERE project_id=$1 AND assertion_id=$2', [projectId, assertionId]);
    return assertion || null;
  }

  async reviewAssertions(projectId, articleVersionId, decisions) {
    if(!Array.isArray(decisions)||!decisions.length||decisions.length>500)throw Object.assign(new Error('decisions must contain 1 to 500 items'),{statusCode:400});
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const article=await client.query('SELECT 1 FROM article_versions WHERE project_id=$1 AND article_version_id=$2 FOR UPDATE',[projectId,articleVersionId]);
      if(!article.rowCount){await client.query('ROLLBACK');return null}
      const sealed=await client.query('SELECT 1 FROM corpus_snapshots WHERE project_id=$1 AND article_version_id=$2 UNION ALL SELECT 1 FROM verification_runs WHERE project_id=$1 AND article_version_id=$2 LIMIT 1',[projectId,articleVersionId]);
      if(sealed.rowCount)throw Object.assign(new Error('Assertion review is closed after corpus sealing or verification starts.'),{statusCode:409,publicMessage:'Assertion review is closed after corpus sealing or verification starts.'});
      const seen=new Set(),saved=[];
      for(const decision of decisions){
        if(seen.has(decision.assertion_id))throw Object.assign(new Error('Each assertion may appear only once'),{statusCode:400});seen.add(decision.assertion_id);
        if(!['EXTERNAL','EXCLUDED'].includes(decision.verification_scope)||!decision.reason?.trim())throw Object.assign(new Error('verification_scope and reason are required'),{statusCode:400});
        const {rows:[before]}=await client.query('SELECT * FROM assertions WHERE project_id=$1 AND article_version_id=$2 AND assertion_id=$3 FOR UPDATE',[projectId,articleVersionId,decision.assertion_id]);
        if(!before)throw Object.assign(new Error('assertion not found in article version'),{statusCode:404});
        const allowed={};for(const key of ['assertion_text','normalized_proposition','assertion_class','citation_as_written','source_required','primary_source_required'])if(Object.hasOwn(decision,key))allowed[key]=decision[key];
        const scope=decision.verification_scope;
        let sourceRequired=scope==='EXCLUDED'?false:(Object.hasOwn(allowed,'source_required')?Boolean(allowed.source_required):before.source_required);
        let primaryRequired=scope==='EXCLUDED'?false:(Object.hasOwn(allowed,'primary_source_required')?Boolean(allowed.primary_source_required):before.primary_source_required);
        if(primaryRequired)sourceRequired=true;
        const text=String(allowed.assertion_text??before.assertion_text).trim(),proposition=String(allowed.normalized_proposition??before.normalized_proposition).trim();
        if(!text||!proposition)throw Object.assign(new Error('Corrected assertion text and proposition cannot be blank'),{statusCode:400});
        const fingerprint=hash(`${before.start_offset}:${before.end_offset}:${proposition}`);
        const {rows:[after]}=await client.query(`UPDATE assertions SET assertion_text=$2,normalized_proposition=$3,assertion_class=$4,citation_as_written=$5,source_required=$6,primary_source_required=$7,assertion_fingerprint=$8,verification_scope=$9,scope_reason=$10,reviewed_at=now(),updated_at=now() WHERE assertion_id=$1 RETURNING *`,
          [before.assertion_id,text,proposition,allowed.assertion_class??before.assertion_class,Object.hasOwn(allowed,'citation_as_written')?allowed.citation_as_written:before.citation_as_written,sourceRequired,primaryRequired,fingerprint,scope,decision.reason.trim()]);
        await client.query('INSERT INTO assertion_review_decisions(project_id,article_version_id,assertion_id,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6)',[projectId,articleVersionId,before.assertion_id,before,after,decision.reason.trim()]);saved.push(after);
      }
      await client.query('COMMIT');return {article_version_id:articleVersionId,decisions:saved};
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
  }

  async importCorpusSource(projectId,input){
    const canonicalUrl=canonicalizeUrl(input.canonical_url),client=await this.pool.connect();
    const validTypes=new Set(['STATUTE','REGULATION','JUDICIAL_OPINION','AGENCY_DOCUMENT','GOVERNMENT_DATASET','PATENT','SEC_FILING','ACADEMIC','NEWS','WEB_PAGE','OTHER']);
    const validRelationships=new Set(['SUPPORTS','QUALIFIES','CONTRADICTS','BACKGROUND']),validClasses=new Set(['PRIMARY','SECONDARY','UNKNOWN']);
    try{await client.query('BEGIN');
      const {rows:[found]}=await client.query('SELECT * FROM sources WHERE content_hash=$1 OR canonical_url=$2 ORDER BY (content_hash IS NOT DISTINCT FROM $1) DESC LIMIT 1 FOR UPDATE',[input.content_hash,canonicalUrl]);
      let source;
      if(found){({rows:[source]}=await client.query(`UPDATE sources SET title=COALESCE($2,title),source_type=$3,issuing_authority=COALESCE($4,issuing_authority),jurisdiction=COALESCE($5,jurisdiction),publication_date=COALESCE($6,publication_date),version_label=COALESCE($7,version_label),canonical_identity=COALESCE($8,canonical_identity),retrieval_status=$9,retrieved_at=now(),final_url=$10,media_type=$11,byte_length=$12,content_hash=$13,original_storage_path=$14,normalized_storage_path=$15,provenance=$16,updated_at=now() WHERE source_id=$1 RETURNING *`,[found.source_id,input.title||null,validTypes.has(input.source_type)?input.source_type:'OTHER',input.issuing_authority||null,input.jurisdiction||null,input.publication_date||null,input.version_label||null,input.content_hash,input.retrieval_status,canonicalUrl,input.media_type,input.byte_length,input.content_hash,input.original_storage_path,input.normalized_storage_path,input.provenance]))}
      else {({rows:[source]}=await client.query(`INSERT INTO sources(canonical_url,title,source_type,issuing_authority,jurisdiction,publication_date,version_label,canonical_identity,retrieval_status,retrieved_at,final_url,media_type,byte_length,content_hash,original_storage_path,normalized_storage_path,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$1,$10,$11,$12,$13,$14,$15) RETURNING *`,[canonicalUrl,input.title||null,validTypes.has(input.source_type)?input.source_type:'OTHER',input.issuing_authority||null,input.jurisdiction||null,input.publication_date||null,input.version_label||null,input.content_hash,input.retrieval_status,input.media_type,input.byte_length,input.content_hash,input.original_storage_path,input.normalized_storage_path,input.provenance]))}
      await client.query("INSERT INTO project_sources(project_id,source_id,membership_status) VALUES($1,$2,'ACCEPTED') ON CONFLICT(project_id,source_id) DO UPDATE SET membership_status='ACCEPTED'",[projectId,source.source_id]);
      for(const link of input.assertion_links){if(!validRelationships.has(link.relationship_type)||!validClasses.has(link.proposition_source_class)||!link.classification_reason?.trim())throw Object.assign(new Error('Invalid assertion link classification'),{statusCode:400});const result=await client.query(`INSERT INTO assertion_source_relationships(assertion_id,source_id,relationship_type,proposition_source_class,classification_reason,discovery_only,class_assigned_by)
        SELECT assertion_id,$2,$3,$4,$5,false,'CALLER' FROM assertions WHERE assertion_id=$1 AND project_id=$6
        ON CONFLICT(assertion_id,source_id,relationship_type) DO UPDATE SET proposition_source_class=EXCLUDED.proposition_source_class,classification_reason=EXCLUDED.classification_reason,discovery_only=false,class_assigned_by='CALLER'`,[link.assertion_id,source.source_id,link.relationship_type,link.proposition_source_class,link.classification_reason.trim(),projectId]);if(!result.rowCount)throw Object.assign(new Error('assertion link does not belong to project'),{statusCode:404})}
      await client.query('COMMIT');return {source,linked_assertions:input.assertion_links.length};
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
  }

  async acquireRegisteredSource(projectId, sourceId, acquisition, storageRoot) {
    const { rows: [source] } = await this.pool.query(`SELECT s.* FROM sources s JOIN project_sources ps USING(source_id) WHERE s.source_id=$1 AND ps.project_id=$2`, [sourceId, projectId]);
    if (!source) return null;
    await this.pool.query(`UPDATE sources SET retrieval_status='ACQUIRING',updated_at=now() WHERE source_id=$1`, [sourceId]);
    try {
      const acquired = await acquisition(source.canonical_url, { storageRoot });
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [duplicate] } = await client.query('SELECT * FROM sources WHERE content_hash=$1 AND source_id<>$2 FOR UPDATE', [acquired.contentHash, sourceId]);
        let finalSourceId = sourceId;
        if (duplicate) {
          finalSourceId = duplicate.source_id;
          if (!duplicate.normalized_storage_path && acquired.normalizedStorageKey) {
            await client.query(`UPDATE sources SET normalized_storage_path=$2,retrieval_status='NORMALIZED',provenance=coalesce(provenance,'{}'::jsonb) || $3::jsonb,updated_at=now() WHERE source_id=$1`, [finalSourceId,acquired.normalizedStorageKey,{normalization_error:null,normalized_content_hash:acquired.normalizedHash||null}]);
          }
          await client.query(`INSERT INTO project_sources(project_id,source_id,membership_status) VALUES ($1,$2,'ACCEPTED') ON CONFLICT(project_id,source_id) DO UPDATE SET membership_status='ACCEPTED'`, [projectId, finalSourceId]);
          await client.query(`INSERT INTO assertion_source_relationships(assertion_id,source_id,relationship_type,proposition_source_class,classification_reason,discovery_only,class_assigned_by)
            SELECT assertion_id,$2,relationship_type,proposition_source_class,classification_reason,discovery_only,class_assigned_by FROM assertion_source_relationships WHERE source_id=$1
            ON CONFLICT DO NOTHING`, [sourceId, finalSourceId]);
          await client.query('DELETE FROM assertion_source_relationships WHERE source_id=$1', [sourceId]);
          // The source warehouse is shared: preserve every project's membership.
          await client.query(`INSERT INTO project_sources(project_id,source_id,membership_status)
            SELECT project_id,$2,membership_status FROM project_sources WHERE source_id=$1
            ON CONFLICT(project_id,source_id) DO NOTHING`, [sourceId, finalSourceId]);
          await client.query('DELETE FROM project_sources WHERE source_id=$1', [sourceId]);
          // Keep the historical source row: sealed versions and older reports may reference it.
          await client.query('UPDATE sources SET retrieval_status=$2,updated_at=now() WHERE source_id=$1', [sourceId,source.retrieval_status]);
        } else {
          await client.query(`UPDATE sources SET retrieval_status=$2,retrieved_at=now(),final_url=$3,http_status=$4,media_type=$5,byte_length=$6,content_hash=$7,original_storage_path=$8,normalized_storage_path=$9,provenance=$10,updated_at=now() WHERE source_id=$1`,
            [sourceId, acquired.normalizedPath ? 'NORMALIZED' : 'ACQUIRED', acquired.finalUrl, acquired.httpStatus, acquired.mediaType, acquired.byteLength, acquired.contentHash, acquired.originalStorageKey, acquired.normalizedStorageKey, { retrieval_method: 'HTTP_GET', requested_url: source.canonical_url, normalization_error: acquired.normalizationError || null, normalized_content_hash: acquired.normalizedHash || null }]);
          await client.query(`UPDATE project_sources SET membership_status='ACCEPTED' WHERE project_id=$1 AND source_id=$2`, [projectId, sourceId]);
        }
        await client.query(`INSERT INTO source_access_attempts(project_id,source_id,candidate_source,canonical_url,method,result,http_status,final_url) VALUES ($1,$2,$3,$4,'HTTP_GET','SUCCESS',$5,$6)`, [projectId, finalSourceId, source.title, source.canonical_url, acquired.httpStatus, acquired.finalUrl]);
        const { rows: [saved] } = await client.query('SELECT * FROM sources WHERE source_id=$1', [finalSourceId]);
        await client.query('COMMIT'); return { source: saved, deduplicated: Boolean(duplicate) };
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) {
      await this.pool.query(`UPDATE sources SET retrieval_status='FAILED',updated_at=now() WHERE source_id=$1`, [sourceId]).catch(() => {});
      await this.pool.query(`INSERT INTO source_access_attempts(project_id,source_id,candidate_source,canonical_url,method,result,failure_reason,http_status,final_url) VALUES ($1,$2,$3,$4,'HTTP_GET',$5,$6,$7,$8)`,
        [projectId, sourceId, source.title, source.canonical_url, /private network|allowed/.test(error.message) ? 'BLOCKED' : 'FAILED', error.message, error.httpStatus || null, error.finalUrl || null]).catch(() => {});
      throw error;
    }
  }

  async reviseArticle(projectId, articleVersionId, verificationRunId, instruction, orchestrator, modelName=null) {
    const conflict=message=>Object.assign(new Error(message),{statusCode:409});
    const {rows:[context]}=await this.pool.query(`SELECT av.*,vr.status AS verification_status,vr.mode AS verification_mode
      FROM article_versions av JOIN verification_runs vr ON vr.article_version_id=av.article_version_id
      WHERE av.project_id=$1 AND av.article_version_id=$2 AND vr.verification_run_id=$3 AND vr.project_id=$1`,[projectId,articleVersionId,verificationRunId]);
    if(!context)return null;
    if(context.verification_status!=='COMPLETE'||context.verification_mode!=='AUTHOR_CORPUS')throw conflict('Fix draft requires a completed author-corpus verification run.');
    const {rows:[latest]}=await this.pool.query('SELECT article_version_id FROM article_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1',[projectId]);
    if(latest?.article_version_id!==articleVersionId)throw conflict('The draft has changed. Verify the current version before fixing it.');
    const {rows:results}=await this.pool.query(`SELECT vr.*,COALESCE(sv.metadata->>'canonical_url',s.canonical_url) AS canonical_url,COALESCE(sv.metadata->>'title',s.title) AS source_title
      FROM verification_results vr LEFT JOIN sources s USING(source_id) LEFT JOIN evidence_passages ep USING(evidence_passage_id) LEFT JOIN source_versions sv ON sv.source_version_id=ep.source_version_id WHERE verification_run_id=$1 ORDER BY vr.created_at`,[verificationRunId]);
    const {rows:assertions}=await this.pool.query('SELECT * FROM assertions WHERE article_version_id=$1',[articleVersionId]);
    const actionable=revisionFindings(assertions,results);
    if(!actionable.length)throw conflict('There are no actionable verification findings to fix. A claim where nothing was compared is a gap in the check, not a finding, so it is left as written.');
    let run;
    try {
      ({rows:[run]}=await this.pool.query(`INSERT INTO revision_runs(project_id,source_article_version_id,verification_run_id,instruction,model_name,issues_total)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[projectId,articleVersionId,verificationRunId,instruction,modelName,actionable.length]));
    } catch(error) {
      if(error.code==='23505')throw conflict('Fix draft is already running for this project.');
      throw error;
    }
    try {
      const output=assertRevisionContract(await orchestrator.reviseArticle({
        article:{article_version_id:articleVersionId,title:context.title,content_markdown:context.content_markdown},
        verification_results:actionable,instruction,
      }),actionable.map(result=>result.verification_result_id));
      if(output.applied_verification_result_ids.length&&output.content_markdown===context.content_markdown)throw new Error('The model reported changes but returned an unchanged draft.');
      const byResult=new Map(actionable.map(result=>[result.verification_result_id,result]));
      const decisions=output.issue_resolutions.map(item=>({...item,
        original_assertion:byResult.get(item.verification_result_id).assertion_as_made,
        original_status:byResult.get(item.verification_result_id).status,
      }));
      const client=await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE',[projectId]);
        const {rows:[current]}=await client.query('SELECT article_version_id FROM article_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1',[projectId]);
        if(current?.article_version_id!==articleVersionId)throw conflict('The draft changed while revision was running. No revision was applied; verify the new version first.');
        const version=await this.saveCheckpoint(projectId,{title:output.title,content_markdown:output.content_markdown,created_by:'MODEL',research_brief:context.research_brief,change_summary:output.change_summary,import_metadata:context.import_metadata},client);
        const changed=output.applied_verification_result_ids.length;
        const {rows:[completed]}=await client.query(`UPDATE revision_runs SET status='COMPLETE',output_article_version_id=$2,
          applied_verification_result_ids=$3,provider_response_id=$4,issue_resolutions=$5::jsonb,change_summary=$6,
          issues_changed=$7,issues_unresolved=$8,completed_at=now() WHERE revision_run_id=$1 RETURNING *`,
        [run.revision_run_id,version.article_version_id,output.applied_verification_result_ids,output.provider_response_id||null,
          JSON.stringify(decisions),output.change_summary,changed,actionable.length-changed]);
        await client.query('COMMIT');
        return {run:completed,version};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }catch(error){
      await this.pool.query(`UPDATE revision_runs SET status='FAILED',error_message=$2,completed_at=now() WHERE revision_run_id=$1`,[run.revision_run_id,error.message]).catch(()=>{});
      throw error;
    }
  }
}
