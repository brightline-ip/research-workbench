// Runs only with TEST_DATABASE_URL pointing at an empty scratch PostgreSQL database whose name contains "test".
// Skipped otherwise, so `npm test` stays offline. It creates and removes its own rows and folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrations.js';
import { Repository } from '../src/repository.js';
import { EvidenceStore } from '../src/evidence-store.js';
import { VerificationService } from '../src/verification.js';
import { deleteProject } from '../scripts/delete-project.js';
import { AdversarialService } from '../src/adversarial.js';
import { ExportService } from '../src/exports.js';
import { revisionFindings } from '../src/revision-policy.js';
import { buildReport, coverageText } from '../public/report-model.js';

const url = process.env.TEST_DATABASE_URL;
const named = url && /test/i.test(new URL(url).pathname);
const options = { skip: named ? false : 'set TEST_DATABASE_URL to a scratch database whose name contains "test"' };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const MARK = 'ZQXMARKER';

async function world() {
  const pool = new pg.Pool({ connectionString: url });
  await migrate(pool);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-pg-'));
  const config = { sourceStorageRoot: path.join(dir, 'sources'), projectStorageRoot: path.join(dir, 'projects') };
  await fs.mkdir(config.sourceStorageRoot, { recursive: true });
  return { pool, dir, config, repo: new Repository(pool), store: new EvidenceStore(pool, config.sourceStorageRoot), close: async () => { await pool.end(); await fs.rm(dir, { recursive: true, force: true }); } };
}
async function addSource(w, label, text, hashInKey = true) {
  const original = Buffer.from(`${label} original ${crypto.randomUUID()}`), hash = sha(original), normalizedHash = sha(text);
  const originalKey = `${hash.slice(0, 2)}/${hash}/original/source.txt`, normalizedKey = `${hash.slice(0, 2)}/${hash}/normalized/${hashInKey ? normalizedHash : 'text'}.txt`;
  for (const [key, bytes] of [[originalKey, original], [normalizedKey, text]]) { const file = path.join(w.config.sourceStorageRoot, key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  const { rows: [source] } = await w.pool.query(`INSERT INTO sources(canonical_url,retrieval_status,content_hash,original_storage_path,normalized_storage_path,media_type,byte_length,title,provenance) VALUES($1,'NORMALIZED',$2,$3,$4,'text/plain',$5,$6,$7) RETURNING *`,
    [`https://example.test/${crypto.randomUUID()}`, hash, originalKey, normalizedKey, original.length, label, hashInKey ? {} : { normalized_content_hash: normalizedHash }]);
  return source;
}
async function project(w, title, text = `${MARK} The widget claim was obvious over Smith.`) {
  const p = await w.repo.createProject({ title });
  const version = await w.repo.saveCheckpoint(p.project_id, { title, content_markdown: text });
  const { rows: [run] } = await w.pool.query(`INSERT INTO assertion_extraction_runs(project_id,article_version_id,status,coverage_complete,coverage_notes,assertion_count) VALUES($1,$2,'COMPLETE',false,'Stopped early',1) RETURNING *`, [p.project_id, version.article_version_id]);
  const { rows: [assertion] } = await w.pool.query(`INSERT INTO assertions(project_id,article_version_id,extraction_run_id,block_index,start_offset,end_offset,evidence_span,assertion_text,normalized_proposition,assertion_class,load_bearing,source_required,primary_source_required,assertion_fingerprint)
    VALUES($1,$2,$3,0,0,$5,$4,$4,$4,'LEGAL_HOLDING',false,true,true,$6) RETURNING *`, [p.project_id, version.article_version_id, run.extraction_run_id, text, text.length, sha(text + crypto.randomUUID())]);
  return { id: p.project_id, version: version.article_version_id, assertion };
}
async function link(w, target, source, cls = 'PRIMARY') {
  await w.pool.query(`INSERT INTO project_sources(project_id,source_id,membership_status) VALUES($1,$2,'ACCEPTED') ON CONFLICT DO NOTHING`, [target.id, source.source_id]);
  await w.pool.query(`INSERT INTO assertion_source_relationships(assertion_id,source_id,relationship_type,proposition_source_class,classification_reason,discovery_only,class_assigned_by) VALUES($1,$2,'SUPPORTS',$3,'test',false,'CALLER')`, [target.assertion.assertion_id, source.source_id, cls]);
}
const orchestrator = { async verifyAssertion(input) { const c = input.candidate_passages[0]; return { source_id: c.source_id, passage_id: c.passage_id, assertion_as_made: 'x', source_actually_establishes: 'x', material_gap: '', extracted_passage: c.passage_text, status: 'VERIFIED', defect_codes: [], confidence: 0.9, recommended_remediation: 'none' }; } };
const verify = (w, target) => new VerificationService(w.pool, orchestrator, w.config.sourceStorageRoot, 'm', 1, w.store).run(target.id, target.version);

test('sealed evidence stays immutable outside a project delete', options, async () => {
  const w = await world();
  try {
    const a = await project(w, 'immutable'); await link(w, a, await addSource(w, 'S', Buffer.from('The widget claim was obvious over Smith.')));
    const { run } = await verify(w, a);
    await assert.rejects(w.pool.query('DELETE FROM corpus_snapshots WHERE corpus_snapshot_id=$1', [run.corpus_snapshot_id]), /immutable/);
    await assert.rejects(w.pool.query('DELETE FROM evidence_passages WHERE corpus_snapshot_id=$1', [run.corpus_snapshot_id]), /immutable/);
    await assert.rejects(w.pool.query("UPDATE evidence_passages SET passage_text='x' WHERE corpus_snapshot_id=$1", [run.corpus_snapshot_id]), /immutable/);
    await assert.rejects(w.pool.query('DELETE FROM source_versions'), /immutable/);
    // Naming a different project does not unlock this one, and the setting never unlocks an update.
    const client = await w.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('rw.deleting_project',$1,true)", [crypto.randomUUID()]);
      await assert.rejects(client.query('DELETE FROM corpus_snapshots WHERE corpus_snapshot_id=$1', [run.corpus_snapshot_id]), /immutable/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('rw.deleting_project',$1,true)", [a.id]);
      await assert.rejects(client.query("UPDATE evidence_passages SET passage_text='x' WHERE corpus_snapshot_id=$1", [run.corpus_snapshot_id]), /immutable/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await deleteProject(w.pool, w.config, a.id, { confirm: true });
  } finally { await w.close(); }
});

test('deleting a verified project removes all of it and leaves other projects working', options, async () => {
  const w = await world();
  try {
    const doomed = await project(w, `${MARK} doomed`), kept = await project(w, 'kept', 'The widget claim was obvious over Jones.');
    const shared = await addSource(w, 'shared source', Buffer.from('The widget claim was obvious over Smith and Jones.'));
    const privateSource = await addSource(w, `${MARK} private source`, Buffer.from(`${MARK} The widget claim was obvious in this private text.`));
    await link(w, doomed, shared); await link(w, doomed, privateSource); await link(w, kept, shared);
    const doomedRun = (await verify(w, doomed)).run, keptRun = (await verify(w, kept)).run;
    assert.equal(doomedRun.status, 'COMPLETE');

    // Deeper records that sit behind RESTRICT keys.
    const { rows: [adversarial] } = await w.pool.query("INSERT INTO adversarial_runs(project_id,article_version_id,author_verification_run_id,status) VALUES($1,$2,$3,'COMPLETE') RETURNING *", [doomed.id, doomed.version, doomedRun.verification_run_id]);
    const { rows: [red] } = await w.pool.query('INSERT INTO red_team_runs(adversarial_run_id) VALUES($1) RETURNING *', [adversarial.adversarial_run_id]);
    await w.pool.query('INSERT INTO reconciliation_runs(adversarial_run_id,red_team_run_id) VALUES($1,$2)', [adversarial.adversarial_run_id, red.red_team_run_id]);
    await w.pool.query("INSERT INTO revision_runs(project_id,source_article_version_id,verification_run_id,instruction,issues_total,status) VALUES($1,$2,$3,$4,0,'COMPLETE')", [doomed.id, doomed.version, doomedRun.verification_run_id, MARK]);
    const { rows: [dataset] } = await w.pool.query(`INSERT INTO datasets(project_id,title,schema_json,records_json,record_count,content_hash) VALUES($1,$2,'{}','[]',0,$3) RETURNING *`, [doomed.id, MARK, sha(crypto.randomUUID())]);
    await w.pool.query(`INSERT INTO analysis_runs(project_id,dataset_id,instruction,operation,code,code_hash,status) VALUES($1,$2,'i','DESCRIBE','c','h','COMPLETE')`, [doomed.id, dataset.dataset_id]);
    await w.pool.query(`INSERT INTO operation_requests(request_key,project_id,operation) VALUES($1,$2,'verify')`, [crypto.randomUUID(), doomed.id]);
    const report = path.join(w.config.projectStorageRoot, doomed.id, 'exports', 'r.csv');
    await fs.mkdir(path.dirname(report), { recursive: true }); await fs.writeFile(report, MARK);

    const preview = await deleteProject(w.pool, w.config, doomed.id);
    assert.equal(preview.deleted, false); assert.equal(preview.sources_only_in_this_project, 1);
    await fs.stat(report);

    const result = await deleteProject(w.pool, w.config, doomed.id, { confirm: true });
    assert.equal(result.deleted, true); assert.equal(result.sources_deleted, 1); assert.deepEqual(result.file_errors, []);

    // No row anywhere holds the project's id or its marker text.
    const { rows: tables } = await w.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    for (const { tablename } of tables) {
      const { rows } = await w.pool.query(`SELECT count(*)::int AS n FROM "${tablename}" t WHERE t::text LIKE $1 OR t::text LIKE $2`, [`%${MARK}%`, `%${doomed.id}%`]);
      assert.equal(rows[0].n, 0, `${tablename} still holds data of the deleted project`);
    }
    // No stored file holds it either.
    await assert.rejects(fs.stat(path.join(w.config.projectStorageRoot, doomed.id)));
    const walk = async folder => (await Promise.all((await fs.readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))).flat();
    for (const file of await walk(w.config.sourceStorageRoot)) assert.ok(!(await fs.readFile(file, 'utf8')).includes(MARK), file);

    // The other project is intact: same results, shared source and files still valid, can verify again.
    const { rows: [keptResult] } = await w.pool.query('SELECT status FROM verification_results WHERE verification_run_id=$1', [keptRun.verification_run_id]);
    assert.equal(keptResult.status, 'VERIFIED');
    const { rows: [sharedRow] } = await w.pool.query('SELECT * FROM sources WHERE source_id=$1', [shared.source_id]);
    assert.ok(sharedRow);
    await fs.stat(path.join(w.config.sourceStorageRoot, shared.original_storage_path));
    const again = await new VerificationService(w.pool, orchestrator, w.config.sourceStorageRoot, 'm', 1, w.store).run(kept.id, kept.version, 'AUTHOR_CORPUS', { corpusSnapshotId: keptRun.corpus_snapshot_id });
    assert.equal(again.run.status, 'COMPLETE');
    await deleteProject(w.pool, w.config, kept.id, { confirm: true });
    assert.equal((await w.pool.query('SELECT 1 FROM sources WHERE source_id=$1', [shared.source_id])).rowCount, 0, 'the last project using a source takes it along');
  } finally { await w.close(); }
});

test('a project with a running operation is not deleted', options, async () => {
  const w = await world();
  try {
    const a = await project(w, 'running');
    await w.pool.query(`INSERT INTO verification_runs(project_id,article_version_id,mode,status) VALUES($1,$2,'AUTHOR_CORPUS','RUNNING')`, [a.id, a.version]);
    await assert.rejects(deleteProject(w.pool, w.config, a.id, { confirm: true }), /still running/);
    assert.equal((await w.pool.query('SELECT 1 FROM projects WHERE project_id=$1', [a.id])).rowCount, 1);
    await w.pool.query(`UPDATE verification_runs SET status='FAILED' WHERE project_id=$1`, [a.id]);
    await deleteProject(w.pool, w.config, a.id, { confirm: true });
  } finally { await w.close(); }
});

test('sealing catches changed normalized text, with or without a recorded hash', options, async () => {
  const w = await world();
  try {
    for (const hashInKey of [true, false]) {
      const a = await project(w, 'tamper'), source = await addSource(w, 'S', Buffer.from('The widget claim was obvious over Smith.'), hashInKey);
      await link(w, a, source);
      await fs.appendFile(path.join(w.config.sourceStorageRoot, source.normalized_storage_path), ' tampered');
      await assert.rejects(w.store.seal(a.id, a.version), /integrity check failed/);
      await fs.writeFile(path.join(w.config.sourceStorageRoot, source.normalized_storage_path), 'The widget claim was obvious over Smith.');
      await deleteProject(w.pool, w.config, a.id, { confirm: true });
    }
  } finally { await w.close(); }
});

test('real rows: nothing-checked results, candidate ids, source class and run gaps are stored and returned', options, async () => {
  const w = await world();
  try {
    const none = await project(w, 'none'), checked = await project(w, 'checked'), wall = await project(w, 'wall');
    await verify(w, none);
    const workspace = await w.repo.getWorkspace(none.id);
    assert.equal(workspace.verification_results[0].status, 'UNVERIFIABLE');
    assert.equal(workspace.verification_results[0].not_checked_reason, 'NO_SOURCES');
    assert.equal(workspace.verification_run.assertions_attempted, 0);
    assert.equal(workspace.assertion_extraction.coverage_complete, false, 'coverage_complete reaches API callers');
    assert.equal(workspace.assertion_extraction.coverage_notes, 'Stopped early');

    await link(w, checked, await addSource(w, 'S', Buffer.from('The widget claim was obvious over Smith.')));
    await verify(w, checked);
    const result = (await w.repo.getWorkspace(checked.id)).verification_results[0];
    assert.equal(result.status, 'VERIFIED'); assert.equal(result.candidate_passage_count, 1); assert.equal(result.candidate_passage_ids.length, 1);
    assert.equal(result.source_class, 'PRIMARY'); assert.equal(result.source_class_assigned_by, 'CALLER');

    await link(w, wall, await addSource(w, 'W', Buffer.from('The widget page. Please enable JavaScript and sign in to continue.')));
    const { run } = await verify(w, wall);
    assert.equal(run.evidence_gaps.excluded_sources[0].reason, 'SUSPECTED_ACCESS_WALL');
    assert.equal((await w.repo.getWorkspace(wall.id)).verification_results[0].not_checked_reason, 'SOURCES_UNAVAILABLE');
    for (const target of [none, checked, wall]) await deleteProject(w.pool, w.config, target.id, { confirm: true });
  } finally { await w.close(); }
});

test('source versions lose protection only for a source the named project refers to', options, async () => {
  const w = await world();
  try {
    const a = await project(w, 'named'), b = await project(w, 'other');
    const mine = await addSource(w, 'A', Buffer.from('a text')), theirs = await addSource(w, 'B', Buffer.from('b text'));
    await link(w, a, mine); await link(w, b, theirs);
    const version = async source => (await w.pool.query(`INSERT INTO source_versions(source_id,identity_hash,content_hash,original_storage_path,metadata) VALUES($1,$2,$3,'k','{}') RETURNING source_version_id`, [source.source_id, crypto.randomUUID(), source.content_hash])).rows[0].source_version_id;
    const mineVersion = await version(mine), theirVersion = await version(theirs);
    const client = await w.pool.connect();
    const attempt = async (named, id) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('rw.deleting_project',$1,true)", [named]);
        return (await client.query('DELETE FROM source_versions WHERE source_version_id=$1', [id])).rowCount;
      } finally { await client.query('ROLLBACK'); }
    };
    try {
      await assert.rejects(attempt(a.id, theirVersion), /immutable/, 'another project keeps the protection during a delete');
      await assert.rejects(attempt('not-a-project', mineVersion), /immutable/);
      assert.equal(await attempt(a.id, mineVersion), 1);
    } finally { client.release(); }
    for (const target of [a, b]) await deleteProject(w.pool, w.config, target.id, { confirm: true });
  } finally { await w.close(); }
});

test('a source another project uses through discovery, an access attempt or a replacement link is kept', options, async () => {
  const w = await world();
  try {
    const a = await project(w, 'deleted'), b = await project(w, 'kept');
    const { rows: [run] } = await w.pool.query(`INSERT INTO discovery_runs(project_id,article_version_id,mode,status,policy,model_name,assertions_total) VALUES($1,$2,'AUTHOR_CORPUS','COMPLETE','{}','m',1) RETURNING discovery_run_id`, [b.id, b.version]);
    const uses = {
      candidate: async s => { await w.pool.query(`INSERT INTO discovery_candidates(discovery_run_id,assertion_id,source_id,candidate_url,disposition) VALUES($1,$2,$3,'https://example.test/c','ACCEPTED')`, [run.discovery_run_id, b.assertion.assertion_id, s.source_id]); return async () => (await w.pool.query('SELECT source_id FROM discovery_candidates WHERE discovery_run_id=$1 AND source_id=$2', [run.discovery_run_id, s.source_id])).rowCount; },
      attempt: async s => { await w.pool.query(`INSERT INTO source_access_attempts(project_id,source_id,canonical_url,method,result) VALUES($1,$2,'https://example.test/a','HTTP_GET','SUCCESS')`, [b.id, s.source_id]); return async () => (await w.pool.query('SELECT 1 FROM source_access_attempts WHERE project_id=$1 AND source_id=$2', [b.id, s.source_id])).rowCount; },
      replacement: async s => { const older = await addSource(w, 'older', Buffer.from('older text')); await w.pool.query('UPDATE sources SET superseded_by_source_id=$2 WHERE source_id=$1', [older.source_id, s.source_id]); return async () => (await w.pool.query('SELECT 1 FROM sources WHERE source_id=$1 AND superseded_by_source_id=$2', [older.source_id, s.source_id])).rowCount; },
    };
    const kept = {};
    for (const [kind, use] of Object.entries(uses)) {
      const source = await addSource(w, kind, Buffer.from(`${kind} text`));
      await link(w, a, source);
      kept[kind] = { source, stillLinked: await use(source) };
    }
    const alone = await addSource(w, 'alone', Buffer.from('alone text'));
    await link(w, a, alone);
    const outcome = await deleteProject(w.pool, w.config, a.id, { confirm: true });
    assert.equal(outcome.sources_deleted, 1, 'only the source nobody else uses');
    assert.equal((await w.pool.query('SELECT 1 FROM sources WHERE source_id=$1', [alone.source_id])).rowCount, 0);
    for (const [kind, { source, stillLinked }] of Object.entries(kept)) {
      assert.equal((await w.pool.query('SELECT 1 FROM sources WHERE source_id=$1', [source.source_id])).rowCount, 1, kind);
      assert.equal(await stillLinked(), 1, `${kind} keeps its link`);
      await fs.access(path.join(w.config.sourceStorageRoot, source.original_storage_path));
    }
    await deleteProject(w.pool, w.config, b.id, { confirm: true });
    await w.pool.query('DELETE FROM sources WHERE superseded_by_source_id=ANY($1::uuid[])', [Object.values(kept).map(k => k.source.source_id)]);
    await w.pool.query('DELETE FROM sources WHERE source_id=ANY($1::uuid[])', [Object.values(kept).map(k => k.source.source_id)]);
  } finally { await w.close(); }
});

test('a database at migration 15 upgrades; an old sealed project reads honestly and deletes cleanly', options, async t => {
  const admin = new pg.Pool({ connectionString: url });
  const name = `rw_test_upgrade_${crypto.randomUUID().replaceAll('-', '')}`;
  try { await admin.query(`CREATE DATABASE ${name}`); }
  catch (error) { await admin.end(); if (error.code === '42501') return t.skip('this role may not create a database'); throw error; }
  const address = new URL(url); address.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: address.href });
  pool.on('error', () => {}); // DROP DATABASE ... WITH (FORCE) below can end a connection that is still closing.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-upgrade-'));
  try {
    const packaged = new URL('../db/migrations/', import.meta.url), at15 = path.join(dir, 'at15');
    await fs.mkdir(at15);
    for (const file of (await fs.readdir(packaged)).filter(file => file < '016_')) await fs.copyFile(new URL(file, packaged), path.join(at15, file));
    await migrate(pool, pathToFileURL(at15 + path.sep));
    assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 15);

    const config = { sourceStorageRoot: path.join(dir, 'sources'), projectStorageRoot: path.join(dir, 'projects') };
    await fs.mkdir(config.sourceStorageRoot, { recursive: true });
    const w = { pool, config, repo: new Repository(pool) };
    const old = await project(w, 'old sealed project'), text = Buffer.from('Off topic words only.'), source = await addSource(w, 'Old', text);
    await pool.query(`INSERT INTO project_sources(project_id,source_id,membership_status) VALUES($1,$2,'ACCEPTED')`, [old.id, source.source_id]);
    await pool.query(`INSERT INTO assertion_source_relationships(assertion_id,source_id,relationship_type,proposition_source_class,classification_reason,discovery_only) VALUES($1,$2,'BACKGROUND','SECONDARY','old',false)`, [old.assertion.assertion_id, source.source_id]);
    const { rows: [version] } = await pool.query(`INSERT INTO source_versions(source_id,identity_hash,content_hash,normalized_content_hash,original_storage_path,normalized_storage_path,metadata) VALUES($1,$2,$3,$4,$5,$6,'{}') RETURNING *`, [source.source_id, crypto.randomUUID(), source.content_hash, sha(text), source.original_storage_path, source.normalized_storage_path]);
    const { rows: [snapshot] } = await pool.query(`INSERT INTO corpus_snapshots(project_id,article_version_id,status,policy,manifest_hash,source_count,evidence_schema_version,evidence_manifest) VALUES($1,$2,'BUILDING','{}','h',1,2,'{}') RETURNING *`, [old.id, old.version]);
    await pool.query(`INSERT INTO corpus_snapshot_sources(corpus_snapshot_id,source_id,source_content_hash,authority_tier,freshness_status,source_version_id) VALUES($1,$2,$3,'SECONDARY','UNKNOWN',$4)`, [snapshot.corpus_snapshot_id, source.source_id, source.content_hash, version.source_version_id]);
    await pool.query(`INSERT INTO evidence_passages(corpus_snapshot_id,source_version_id,source_id,sequence_number,normalized_start_offset,normalized_end_offset,locator,passage_text,passage_hash) VALUES($1,$2,$3,0,0,21,'normalized-text:0-21',$4,$5)`, [snapshot.corpus_snapshot_id, version.source_version_id, source.source_id, text.toString(), sha(text)]);
    await pool.query(`UPDATE corpus_snapshots SET status='SEALED',sealed_at=now() WHERE corpus_snapshot_id=$1`, [snapshot.corpus_snapshot_id]);
    const oldRun = async mode => (await pool.query(`INSERT INTO verification_runs(project_id,article_version_id,mode,status,assertions_extracted,assertions_attempted,status_counts,corpus_snapshot_id,completed_at) VALUES($1,$2,$3,'COMPLETE',1,1,'{"UNSUPPORTED":1}',$4,now()) RETURNING *`, [old.id, old.version, mode, snapshot.corpus_snapshot_id])).rows[0];
    const gap = 'Adequate support meeting the claim source requirements is absent from the approved corpus.';
    const oldResult = async run => (await pool.query(`INSERT INTO verification_results(verification_run_id,assertion_id,assertion_as_made,source_actually_establishes,material_gap,status,defect_codes,recommended_remediation) VALUES($1,$2,'Claim','No adequate passage meeting the source requirements in the approved corpus establishes this assertion.',$3,'UNSUPPORTED','{NON_PRIMARY_SUPPORT}','Locate adequate primary evidence, narrow the assertion, or delete it.') RETURNING *`, [run.verification_run_id, old.assertion.assertion_id, gap])).rows[0];
    const authorRun = await oldRun('AUTHOR_CORPUS'), independentRun = await oldRun('INDEPENDENT_DISCOVERY'), authorRow = await oldResult(authorRun), independentRow = await oldResult(independentRun);
    const { rows: [adversarial] } = await pool.query(`INSERT INTO adversarial_runs(project_id,article_version_id,author_verification_run_id,independent_verification_run_id,model_name,status) VALUES($1,$2,$3,$4,'m','COMPLETE') RETURNING *`, [old.id, old.version, authorRun.verification_run_id, independentRun.verification_run_id]);
    await pool.query(`INSERT INTO adversarial_comparisons(adversarial_run_id,assertion_id,author_result_id,independent_result_id,comparison_status,materiality,rationale) VALUES($1,$2,$3,$4,'BOTH_DEFECTIVE','CRITICAL','Both runs classified the assertion UNSUPPORTED.')`, [adversarial.adversarial_run_id, old.assertion.assertion_id, authorRow.verification_result_id, independentRow.verification_result_id]);
    const { rows: [discovery] } = await pool.query(`INSERT INTO discovery_runs(project_id,article_version_id,mode,status,policy,model_name,assertions_total) VALUES($1,$2,'AUTHOR_CORPUS','COMPLETE','{}','m',1) RETURNING *`, [old.id, old.version]);
    await pool.query(`INSERT INTO discovery_candidates(discovery_run_id,assertion_id,candidate_url,disposition,disposition_reason) VALUES($1,$2,'https://example.test/failed','ACQUISITION_FAILED','connect ECONNREFUSED 10.0.0.5:5432 at /private/path')`, [discovery.discovery_run_id, old.assertion.assertion_id]);

    await Promise.all([migrate(pool), migrate(pool)]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 16);

    const workspace = await w.repo.getWorkspace(old.id), [shown] = workspace.verification_results;
    assert.equal(shown.status, 'UNVERIFIABLE'); assert.equal(shown.not_checked_reason, 'OLDER_RUN'); assert.equal(shown.original_status, 'UNSUPPORTED'); assert.match(shown.material_gap, /^Nothing was checked/);
    const { rows: [stored] } = await pool.query('SELECT status,material_gap,not_checked_reason,candidate_passage_count FROM verification_results WHERE verification_result_id=$1', [authorRow.verification_result_id]);
    assert.deepEqual(stored, { status: 'UNSUPPORTED', material_gap: gap, not_checked_reason: null, candidate_passage_count: null }, 'the stored row is unchanged');
    assert.equal(workspace.adversarial_comparisons[0].comparison_status, 'MATERIAL_DISAGREEMENT'); assert.equal(workspace.adversarial_comparisons[0].stored_comparison_status, 'BOTH_DEFECTIVE');
    const context = await new AdversarialService(pool, {}).context(adversarial.adversarial_run_id);
    assert.equal(context.author_results[0].not_checked_reason, 'OLDER_RUN'); assert.equal(context.comparisons[0].comparison_status, 'MATERIAL_DISAGREEMENT');
    assert.equal(workspace.discovery_failures[0].reason, 'The source could not be downloaded.');
    assert.match(coverageText(workspace.verification_run, workspace.verification_results), /^Older run/);
    assert.equal(buildReport(workspace.assertions, workspace.verification_results).counts.older_not_checked, 1);
    assert.deepEqual(revisionFindings(workspace.assertions, [authorRow]), [], 'a gap in the check is not a finding to fix');
    const exported = await new ExportService(pool, config).generate(old.id, { article_version_id: old.version, verification_run_id: authorRun.verification_run_id, format: 'csv', scope: 'all' });
    const csv = await fs.readFile(exported.output_path, 'utf8');
    assert.match(csv, /"UNSUPPORTED","OLDER_RUN"/); assert.doesNotMatch(csv, /absent from the approved corpus/);
    await assert.rejects(pool.query('DELETE FROM source_versions'), /immutable/, 'protection stands after the upgrade');

    const outcome = await deleteProject(pool, config, old.id, { confirm: true });
    assert.equal(outcome.sources_deleted, 1); assert.deepEqual(outcome.file_errors, []);
    for (const table of ['projects', 'corpus_snapshots', 'evidence_passages', 'source_versions', 'sources', 'verification_results', 'discovery_candidates', 'adversarial_comparisons']) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
    await assert.rejects(fs.access(path.join(config.sourceStorageRoot, source.original_storage_path)));
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
