import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExportService } from '../src/exports.js';
import { readiness } from '../src/readiness.js';

const execute = promisify(execFile);
const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const fixturePath = path.join(root, 'test', 'fixtures', 'export-payload.json');
const exporterPath = path.join(root, 'scripts', 'artifact_export.py');
// Default to the project's pinned document runtime; the version assertions below still guard it.
const projectPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.ARTIFACT_PYTHON || (await fs.access(projectPython).then(() => projectPython, () => null));

// Without a document runtime these four tests are skipped with this reason instead of failing.
const needsPython = { skip: python ? false : 'no Python document runtime: set ARTIFACT_PYTHON or create .venv (see README, "Document runtime")' };

function requiredPython() {
  assert.ok(python, 'ARTIFACT_PYTHON must identify the reviewed Python document runtime');
  return python;
}

async function inspectWorkbook(filename) {
  const source = String.raw`import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 names=set(z.namelist())
 workbook=z.read('xl/workbook.xml').decode('utf-8')
 xml=''.join(z.read(n).decode('utf-8') for n in names if n.endswith('.xml'))
 print(json.dumps({'names':sorted(names),'workbook':workbook,'xml':xml}))`;
  const { stdout } = await execute(requiredPython(), ['-I', '-c', source, filename], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

test('real pinned Python runtime creates a safe three-sheet XLSX report', needsPython, async () => {
  await execute(requiredPython(), ['-I', '-c', "import xlsxwriter; assert xlsxwriter.__version__ == '3.2.9'"]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-xlsx-'));
  try {
    const payload = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    payload.assertions[0].assertion_text = '=2+2 unsafe assertion';
    payload.verification_results[0].assertion_as_made = '=2+2 unsafe assertion';
    payload.verification_results[0].canonical_url = 'https://example.invalid/untrusted';
    payload.sources[0].title = '@unsafe source title';
    payload.report = { scope: 'all', total: 1, attention: 0, verified: 1, not_applicable: 0, pending: 0 };
    const input = path.join(directory, 'payload.json');
    const output = path.join(directory, 'report.xlsx');
    await fs.writeFile(input, JSON.stringify(payload));
    await execute(requiredPython(), ['-I', exporterPath, 'xlsx', input, output]);
    const workbook = await inspectWorkbook(output);
    assert.match(workbook.workbook, /name="Summary"/);
    assert.match(workbook.workbook, /name="Verification Ledger"/);
    assert.match(workbook.workbook, /name="Sources"/);
    assert.ok(workbook.names.includes('xl/tables/table1.xml'));
    assert.match(workbook.xml, /Verification report/);
    assert.match(workbook.xml, /=2\+2 unsafe assertion/);
    assert.match(workbook.xml, /@unsafe source title/);
    assert.match(workbook.xml, /<pane[^>]+state="frozen"/);
    assert.doesNotMatch(workbook.xml, /<f(?:\s|>)/);
    assert.doesNotMatch(workbook.xml, /<hyperlink(?:\s|>)/);
    assert.equal(workbook.names.some(name => name.startsWith('xl/externalLinks/')), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('XLSX service registers only a successfully generated workbook', needsPython, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-xlsx-service-'));
  const payload = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const inserts = [];
  const pool = { query: async (sql, values) => {
    if (!sql.startsWith('INSERT INTO project_artifacts')) throw new Error('unexpected query');
    inserts.push(values);
    return { rows: [{ artifact_id: 'artifact-1', mime_type: values[3], storage_path: values[4] }] };
  } };
  try {
    const service = new ExportService(pool, { projectStorageRoot: directory, artifactPython: requiredPython() });
    service.payload = async () => structuredClone(payload);
    const result = await service.generate(payload.project.project_id, { article_version_id: payload.article.article_version_id,
      verification_run_id: 'run-1', format: 'xlsx', scope: 'all' });
    assert.equal(inserts.length, 1);
    assert.equal(result.artifact.mime_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok((await fs.stat(result.output_path)).size > 1000);

    const failed = new ExportService(pool, { projectStorageRoot: directory, artifactPython: process.execPath });
    failed.payload = async () => structuredClone(payload);
    await assert.rejects(() => failed.generate(payload.project.project_id, { article_version_id: payload.article.article_version_id,
      verification_run_id: 'run-2', format: 'xlsx', scope: 'all' }), /Document processor failed/);
    assert.equal(inserts.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('readiness probes the pinned XLSX dependency instead of trusting a configured path', needsPython, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-xlsx-ready-'));
  const pool = { query: async () => ({ rows: [{ version: '012_operation_limits' }] }) };
  const base = { sourceStorageRoot: path.join(directory, 'sources'), projectStorageRoot: path.join(directory, 'projects'),
    operationLimits: { minFreeBytes: 1 }, orchestrationMode: 'openai' };
  try {
    const ready = await readiness(pool, { ...base, artifactPython: requiredPython() });
    assert.equal(ready.checks.find(check => check.name === 'xlsx_exports').status, 'READY');
    const missing = await readiness(pool, { ...base, artifactPython: process.execPath });
    const check = missing.checks.find(item => item.name === 'xlsx_exports');
    assert.equal(check.status, 'NEEDS_CONFIG');
    assert.equal(check.detail, 'Python XLSX runtime is unavailable or does not contain the pinned XlsxWriter release.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('database readiness requires every packaged migration and separate checkpoint privileges', needsPython, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-db-ready-'));
  const versions = (await fs.readdir(path.join(root, 'db', 'migrations'))).filter(name => /^\d+_.+\.sql$/.test(name)).map(name => name.slice(0, -4)).sort();
  assert.equal(versions.length, 16);
  const base = { sourceStorageRoot: path.join(directory, 'sources'), projectStorageRoot: path.join(directory, 'projects'),
    operationLimits: { minFreeBytes: 1 }, orchestrationMode: 'openai', artifactPython: requiredPython() };
  const pool = (applied, canSelect, canInsert) => ({ query: async sql => sql.startsWith('SELECT version')
    ? { rows: applied.map(version => ({ version })) }
    : { rows: [{ can_select: canSelect, can_insert: canInsert }] } });
  try {
    const missingMigrations = await readiness(pool(versions.slice(0, 12), true, true), base);
    assert.equal(missingMigrations.checks.find(check => check.name === 'database').status, 'BLOCKED');
    const missingGrant = await readiness(pool(versions, true, false), base);
    assert.equal(missingGrant.checks.find(check => check.name === 'database').status, 'BLOCKED');
    const ready = await readiness(pool(versions, true, true), base);
    const check = ready.checks.find(item => item.name === 'database');
    assert.equal(check.status, 'READY');
    assert.equal(check.detail, 'Connected; 16 packaged migrations and checkpoint privileges verified.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
