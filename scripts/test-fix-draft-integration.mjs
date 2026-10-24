// Database integration test. All generated rows are rolled back; no model request is made.
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/repository.js';

const config=loadConfig(),pool=new pg.Pool(config.databaseUrl?{connectionString:config.databaseUrl}:config.pg);
const projectId=process.argv[2];
if(!projectId)throw new Error('Supply a project with a completed verification run');
const client=await pool.connect();
try {
  await client.query('BEGIN');
  const tx={query:async(sql,values)=>['BEGIN','COMMIT','ROLLBACK'].includes(sql)?{rows:[]}:client.query(sql,values),release(){}};
  const repository=new Repository({query:tx.query,connect:async()=>tx});
  const before=await repository.getWorkspace(projectId);
  const article=before.articles[0],run=before.verification_run;
  assert.equal(run.status,'COMPLETE');
  const stub={async reviseArticle(input){
    const issues=input.verification_results.map(result=>({verification_result_id:result.verification_result_id,action:'NEEDS_EVIDENCE',reason:'Synthetic rollback-only test; no factual revision performed.',revised_excerpt:`[EVIDENCE NEEDED: integration fixture ${result.verification_result_id}]`}));
    return {title:input.article.title,content_markdown:input.article.content_markdown+'\n\n'+issues.map(item=>item.revised_excerpt).join('\n'),change_summary:'Integration fixture, rolled back.',applied_verification_result_ids:[],issue_resolutions:issues};
  }};
  const result=await repository.reviseArticle(projectId,article.article_version_id,run.verification_run_id,'Integration fixture',stub,'TEST_STUB');
  assert.equal(result.version.parent_version_id,article.article_version_id);
  assert.equal(result.version.version_number,article.version_number+1);
  assert.equal(result.run.issue_resolutions.length,result.run.issues_total);
  const after=await repository.getWorkspace(projectId);
  assert.equal(after.revision_run.output_article_version_id,result.version.article_version_id);
  assert.equal(after.revision_run.original_content_markdown,article.content_markdown);
  assert.equal(after.verification_run,null,'Revised draft must not inherit verified status');
  assert.equal(after.assertions.length,0);
  console.log(JSON.stringify({issues_accounted_for:result.run.issues_total,new_version_created:true,correct_parent:true,audit_persisted:true,reverification_required:true,rollback:true}));
}finally{
  await client.query('ROLLBACK');client.release();await pool.end();
}
