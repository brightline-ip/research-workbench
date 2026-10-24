import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/repository.js';

const config = loadConfig();
const pool = new pg.Pool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg);
const repository = new Repository(pool);
let project;
try {
  project = await repository.createProject({ title: 'Atomic assertion integration test', topic: 'Controlled test' });
  const markdown = '# Result\n\nThe measured rate rose from 10% to 15% in 2025.';
  const version = await repository.saveCheckpoint(project.project_id, { title: 'Controlled article', content_markdown: markdown });
  const orchestrator = { extractAssertions: async () => ({
    coverage_complete: true, coverage_notes: 'Every controlled block examined.', assertions: [
      { block_index: 1, evidence_span: 'The measured rate rose from 10% to 15% in 2025.', assertion_text: 'The initial measured rate was 10%.', normalized_proposition: 'initial measured rate = 10%', assertion_class: 'QUANTITATIVE', load_bearing: false, load_bearing_reason: null, citation_as_written: null, source_required: true, primary_source_required: true },
      { block_index: 1, evidence_span: 'The measured rate rose from 10% to 15% in 2025.', assertion_text: 'The measured rate was 15% in 2025.', normalized_proposition: 'measured rate in 2025 = 15%', assertion_class: 'QUANTITATIVE', load_bearing: true, load_bearing_reason: 'The change is the article’s central result.', citation_as_written: null, source_required: true, primary_source_required: true }
    ]
  }) };
  const first = await repository.extractAssertions(project.project_id, version.article_version_id, orchestrator, 'CONTROLLED_TEST');
  const second = await repository.extractAssertions(project.project_id, version.article_version_id, { extractAssertions: async () => { throw new Error('Idempotency failed'); } }, 'CONTROLLED_TEST');
  const workspace = await repository.getWorkspace(project.project_id);
  const valid = first.assertions.length === 2 && first.assertions.every(a => markdown.slice(a.start_offset, a.end_offset) === a.evidence_span && a.verification_state === 'UNVERIFIABLE') && second.reused && second.assertions.length === 2 && workspace.assertions.length === 2 && workspace.assertion_extraction.coverage_complete;
  if (!valid) throw new Error('Assertion integration invariants failed');
  console.log(JSON.stringify({ status: 'ASSERTION_LEDGER_OK', assertion_count: first.assertions.length, all_fail_closed: true, exact_locations: true, idempotent_reuse: true, workspace_reload: true }));
} finally {
  if (project) await pool.query('DELETE FROM projects WHERE project_id=$1', [project.project_id]);
  await pool.end();
}
