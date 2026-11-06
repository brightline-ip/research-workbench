import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkNormalizedText, isUnreadableText, looksLikeAccessWall } from './passages.js';
import { writeStoredFile } from './stored-files.js';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const evidenceHash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex');
const conflict=message=>Object.assign(new Error(message),{statusCode:409,publicMessage:message});
// Discovered sources that never became evidence for a claim, per discovery run.
export const DISCOVERY_FAILURES_SQL=`SELECT candidate_url,candidate_title,disposition,disposition_reason AS reason,array_agg(DISTINCT assertion_id) AS assertion_ids FROM discovery_candidates
  WHERE discovery_run_id=$1 AND disposition IN('ACQUISITION_FAILED','HUMAN_REVIEW') GROUP BY candidate_url,candidate_title,disposition,disposition_reason ORDER BY candidate_url NULLS LAST,candidate_title`;
// Every writer stores normalized text under its own hash, so older rows without a recorded hash can still be checked.
export const expectedNormalizedHash=source=>source.provenance?.normalized_content_hash||/\/([a-f0-9]{64})\.txt$/.exec(source.normalized_storage_path||'')?.[1]||null;
const claimFields=['assertion_id','assertion_text','normalized_proposition','assertion_class','citation_as_written','source_required','primary_source_required','evidence_span','start_offset','end_offset'];
export const claimSeal=assertions=>evidenceHash(assertions.map(a=>Object.fromEntries(claimFields.map(k=>[k,a[k]??null]))).sort((a,b)=>a.assertion_id.localeCompare(b.assertion_id)));

export async function readEvidenceFile(root,key,expectedHash){
  if(!key)throw conflict('Evidence file is missing. Reacquire the source before verification.');
  const base=await fs.realpath(root),target=await fs.realpath(path.resolve(root,key));
  if(!target.startsWith(base+path.sep))throw conflict('Evidence path is outside source storage.');
  const stat=await fs.stat(target);
  if(stat.size>25*1024*1024)throw conflict('Evidence exceeds the supported size.');
  const bytes=await fs.readFile(target);
  if(expectedHash&&evidenceHash(bytes)!==expectedHash)throw conflict('Evidence integrity check failed. The stored source changed; no verification was performed.');
  return bytes;
}
async function preserve(root,bytes,kind){
  const hash=evidenceHash(bytes),key=`sealed/${kind}/${hash.slice(0,2)}/${hash}`;
  await writeStoredFile(path.join(root,key),bytes);
  return {hash,key};
}

export class EvidenceStore {
  constructor(pool,root){this.pool=pool;this.root=root;}
  async seal(projectId,articleVersionId,discoveryRunId=null,policy={}){
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const {rows:[article]}=await client.query('SELECT * FROM article_versions WHERE project_id=$1 AND article_version_id=$2',[projectId,articleVersionId]);
      if(!article)throw conflict('Article version does not belong to this project.');
      if(discoveryRunId){const found=await client.query('SELECT 1 FROM discovery_runs WHERE discovery_run_id=$1 AND project_id=$2 AND article_version_id=$3',[discoveryRunId,projectId,articleVersionId]);if(!found.rowCount)throw conflict('Discovery run does not belong to this article.');}
      const {rows:assertions}=await client.query('SELECT * FROM assertions WHERE project_id=$1 AND article_version_id=$2 ORDER BY assertion_id',[projectId,articleVersionId]);
      const {rows:links}=await client.query(`SELECT r.assertion_id,r.source_id,r.proposition_source_class,r.relationship_type,r.class_assigned_by,ps.membership_status,s.retrieval_status
        FROM assertion_source_relationships r JOIN assertions a USING(assertion_id) JOIN sources s USING(source_id)
        JOIN project_sources ps ON ps.source_id=s.source_id AND ps.project_id=a.project_id
        WHERE a.project_id=$1 AND a.article_version_id=$2
        AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM discovery_candidates d WHERE d.discovery_run_id=$3 AND d.assertion_id=a.assertion_id AND d.source_id=s.source_id AND d.disposition='ACCEPTED'))
        ORDER BY r.assertion_id,r.source_id,r.relationship_type`,[projectId,articleVersionId,discoveryRunId]);
      const {rows:sources}=await client.query('SELECT * FROM sources WHERE source_id=ANY($1::uuid[]) ORDER BY source_id',[[...new Set(links.filter(l=>l.membership_status==='ACCEPTED').map(l=>l.source_id))]]);
      const {rows:discoveryFailures}=await client.query(`SELECT DISTINCT ON (d.assertion_id,d.candidate_url,d.candidate_title) d.assertion_id,d.candidate_url,d.candidate_title,d.disposition,d.disposition_reason AS reason
        FROM discovery_candidates d JOIN assertions a USING(assertion_id)
        WHERE a.project_id=$1 AND a.article_version_id=$2 AND d.disposition IN('ACQUISITION_FAILED','HUMAN_REVIEW') AND ($3::uuid IS NULL OR d.discovery_run_id=$3)
        AND NOT EXISTS(SELECT 1 FROM discovery_candidates later WHERE later.assertion_id=d.assertion_id AND later.candidate_url=d.candidate_url AND later.disposition='ACCEPTED' AND later.created_at>d.created_at)
        ORDER BY d.assertion_id,d.candidate_url,d.candidate_title,d.created_at DESC`,[projectId,articleVersionId,discoveryRunId]);
      const versions=[],texts=new Map(),excluded=[];
      const exclude=(source,reason)=>excluded.push({source_id:source.source_id,canonical_url:source.canonical_url,title:source.title||null,reason});
      for(const source of sources){
        if(!source.content_hash||!source.original_storage_path){exclude(source,'NOT_ACQUIRED');continue;}
        const native=await preserve(this.root,await readEvidenceFile(this.root,source.original_storage_path,source.content_hash),'original');
        let normalized=null;
        if(source.normalized_storage_path){
          const bytes=await readEvidenceFile(this.root,source.normalized_storage_path,expectedNormalizedHash(source));
          const text=bytes.toString('utf8');
          // Unusable text is left out of the snapshot, so its claims report evidence as unavailable, never unsupported by garbage.
          if(isUnreadableText(text))exclude(source,'UNREADABLE_TEXT');
          else if(looksLikeAccessWall(text))exclude(source,'SUSPECTED_ACCESS_WALL');
          else{normalized=await preserve(this.root,bytes,'normalized');texts.set(source.source_id,text);}
        }else exclude(source,'NO_TEXT');
        const metadata={title:source.title,canonical_url:source.canonical_url,issuing_authority:source.issuing_authority,media_type:source.media_type,source_type:source.source_type,authority_tier:source.authority_tier,freshness_status:source.freshness_status};
        const identity=evidenceHash({source_id:source.source_id,native:native.hash,normalized:normalized?.hash||null,metadata});
        await client.query(`INSERT INTO source_versions(source_id,identity_hash,content_hash,normalized_content_hash,original_storage_path,normalized_storage_path,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(identity_hash) DO NOTHING`,[source.source_id,identity,native.hash,normalized?.hash||null,native.key,normalized?.key||null,metadata]);
        const {rows:[version]}=await client.query('SELECT * FROM source_versions WHERE identity_hash=$1',[identity]);versions.push(version);
      }
      const manifest={schema_version:2,passage_format:1,project_id:projectId,article_version_id:articleVersionId,article_content_hash:evidenceHash(article.content_markdown),claim_hash:claimSeal(assertions),discovery_run_id:discoveryRunId,policy,links,versions:versions.map(({created_at,...v})=>v),discovery_failures:discoveryFailures,excluded_sources:excluded};
      const {rows:[snapshot]}=await client.query(`INSERT INTO corpus_snapshots(project_id,article_version_id,discovery_run_id,status,policy,manifest_hash,source_count,sealed_at,evidence_schema_version,evidence_manifest)
        VALUES($1,$2,$3,'BUILDING',$4,$5,$6,NULL,2,$7) RETURNING *`,[projectId,articleVersionId,discoveryRunId,policy,evidenceHash(manifest),versions.length,manifest]);
      for(const v of versions){
        await client.query(`INSERT INTO corpus_snapshot_sources(corpus_snapshot_id,source_id,source_content_hash,normalized_content_hash,authority_tier,freshness_status,proposition_scope,source_version_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[snapshot.corpus_snapshot_id,v.source_id,v.content_hash,v.normalized_content_hash,v.metadata.authority_tier,v.metadata.freshness_status,JSON.stringify(links.filter(l=>l.source_id===v.source_id).map(l=>l.assertion_id)),v.source_version_id]);
        for(const c of chunkNormalizedText(texts.get(v.source_id)||''))await client.query(`INSERT INTO evidence_passages(corpus_snapshot_id,source_version_id,source_id,sequence_number,normalized_start_offset,normalized_end_offset,locator,passage_text,passage_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[snapshot.corpus_snapshot_id,v.source_version_id,v.source_id,c.sequence_number,c.normalized_start_offset,c.normalized_end_offset,c.locator,c.passage_text,c.passage_hash]);
      }
      await client.query("UPDATE corpus_snapshots SET status='SEALED',sealed_at=now() WHERE corpus_snapshot_id=$1",[snapshot.corpus_snapshot_id]);
      await client.query('COMMIT');return {...snapshot,status:'SEALED'};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async load(projectId,articleVersionId,snapshotId,assertions,discoveryRunId=null){
    const {rows:[snapshot]}=await this.pool.query(`SELECT cs.*,av.content_markdown FROM corpus_snapshots cs JOIN article_versions av USING(article_version_id)
      WHERE cs.corpus_snapshot_id=$1 AND cs.project_id=$2 AND cs.article_version_id=$3`,[snapshotId,projectId,articleVersionId]);
    const manifest=snapshot?.evidence_manifest;
    if(snapshot?.status!=='SEALED'||snapshot.evidence_schema_version!==2||!manifest||evidenceHash(manifest)!==snapshot.manifest_hash)throw conflict('A valid sealed evidence snapshot is required.');
    if(manifest.claim_hash!==claimSeal(assertions)||manifest.article_content_hash!==evidenceHash(snapshot.content_markdown)||(discoveryRunId&&manifest.discovery_run_id!==discoveryRunId))throw conflict('The snapshot does not match this article, claim ledger, or discovery run.');
    const texts=new Map();
    for(const v of manifest.versions){
      await readEvidenceFile(this.root,v.original_storage_path,v.content_hash);
      if(v.normalized_content_hash)texts.set(v.source_version_id,(await readEvidenceFile(this.root,v.normalized_storage_path,v.normalized_content_hash)).toString('utf8'));
    }
    const {rows:passages}=await this.pool.query('SELECT *,evidence_passage_id AS passage_id FROM evidence_passages WHERE corpus_snapshot_id=$1 ORDER BY source_version_id,sequence_number',[snapshotId]);
    if(manifest.project_id!==projectId||manifest.article_version_id!==articleVersionId||manifest.passage_format!==1)throw conflict('Snapshot identity or passage format is invalid.');
    const expectedChunks=new Map(manifest.versions.map(v=>[v.source_version_id,chunkNormalizedText(texts.get(v.source_version_id)||'')]));
    const expected=[...expectedChunks.values()].reduce((n,chunks)=>n+chunks.length,0);
    if(passages.length!==expected)throw conflict('Snapshot passage coverage failed its integrity check.');
    for(const p of passages){
      const version=manifest.versions.find(v=>v.source_version_id===p.source_version_id);
      const expectedChunk=expectedChunks.get(p.source_version_id)?.[p.sequence_number];
      if(!version||version.source_id!==p.source_id||!expectedChunk||Object.entries(expectedChunk).some(([key,value])=>p[key]!==value))throw conflict('Snapshot passage integrity check failed.');
    }
    return {snapshot,manifest,passages};
  }
}
