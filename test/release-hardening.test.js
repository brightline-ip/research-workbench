import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { startupProblems } from '../src/startup.js';
import { DiscoveryService } from '../src/discovery.js';
import { CorpusImportService } from '../src/corpus-import.js';
import { corpusSettings, corpusClient, projectSubmissions, main as corpusMain, UsageError } from '../scripts/corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'canary-test-credential-never-printed';

test('startup refuses openai mode without a key and names the setting, not a value', () => {
  const problems = startupProblems(loadConfig({}));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /OPENAI_API_KEY is not set/);
  assert.match(problems[0], /billed to your own key/);
  assert.deepEqual(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET })), []);
  for (const problem of startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, HOST: '0.0.0.0' }))) assert.ok(!problem.includes(SECRET));
});

test('startup validates n8n mode, unknown modes, port and half-configured Source Corpus', () => {
  const n8n = startupProblems(loadConfig({ ORCHESTRATION_MODE: 'n8n' }));
  assert.equal(n8n.length, 2); assert.match(n8n.join(' '), /N8N_DRAFT_WEBHOOK_URL/); assert.match(n8n.join(' '), /N8N_WEBHOOK_AUTH_HEADER/);
  assert.deepEqual(startupProblems(loadConfig({ ORCHESTRATION_MODE: 'n8n', N8N_DRAFT_WEBHOOK_URL: 'http://127.0.0.1:5678/webhook/x', N8N_WEBHOOK_AUTH_HEADER: 'Bearer x' })), []);
  assert.match(startupProblems(loadConfig({ ORCHESTRATION_MODE: 'other' }))[0], /ORCHESTRATION_MODE/);
  assert.match(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, PORT: '99999' }))[0], /PORT/);
  assert.match(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, SOURCE_CORPUS_URL: 'http://127.0.0.1:8766' }))[0], /SOURCE_CORPUS_TOKEN/);
  assert.deepEqual(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, GET_FILES_URL: 'http://127.0.0.1:8766', GET_FILES_TOKEN_FILE: '/tmp/token' })), []);
});

test('the server binds loopback by default and refuses other addresses unless explicitly allowed', () => {
  assert.equal(loadConfig({}).host, '127.0.0.1');
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.deepEqual(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, HOST: host })), []);
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) assert.match(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, HOST: host })).join(' '), /loopback/);
  assert.deepEqual(startupProblems(loadConfig({ OPENAI_API_KEY: SECRET, HOST: '0.0.0.0', ALLOW_NONLOOPBACK_BIND: '1' })), []);
});

test('server process exits with a clear message before contacting the database when no key is set', async () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', PGHOST: '192.0.2.1', PGCONNECT_TIMEOUT: '1' };
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { env, windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk); child.stdout.resume();
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /cannot start/); assert.match(stderr, /OPENAI_API_KEY is not set/);
  assert.doesNotMatch(stderr, /PostgreSQL/);
});

test('storage defaults stay inside the install folder and WORKBENCH_DATA_DIR moves both roots', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.sourceStorageRoot, path.join(root, 'storage', 'sources'));
  assert.equal(defaults.projectStorageRoot, path.join(root, 'storage', 'projects'));
  const data = path.join(os.tmpdir(), 'rw-data');
  const moved = loadConfig({ WORKBENCH_DATA_DIR: data, PROJECT_STORAGE_ROOT: path.join(data, 'reports') });
  assert.equal(moved.sourceStorageRoot, path.join(data, 'sources'));
  assert.equal(moved.projectStorageRoot, path.join(data, 'reports'));
});

const assertion = { assertion_id: 'a1', assertion_text: 'The rate was 42 percent in 2025.', normalized_proposition: 'rate 2025 = 42%', assertion_class: 'QUANTITATIVE', primary_source_required: true };

test('direct OpenAI discovery uses hosted web search with a strict schema and returns bounded candidates', async () => {
  let request;
  const candidate = { canonical_url: 'https://agency.example.gov/report', title: 'Report', issuing_authority: 'Agency', source_type: 'AGENCY_DOCUMENT', authority_tier: 'PRIMARY', relationship_type: 'SUPPORTS', reason: 'Official report.' };
  const service = new DiscoveryService(null, null, { openaiApiKey: SECRET, model: 'test-model', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return Response.json({ id: 'resp_1', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: Array(10).fill(candidate), coverage_notes: 'ok' }) }] }] });
  } });
  const result = await service.externalCandidates([assertion], { excluded_source_urls: ['https://excluded.example.com/'] });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(request.body.tools, [{ type: 'web_search' }]);
  assert.equal(request.body.text.format.type, 'json_schema'); assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.model, 'test-model');
  assert.match(request.body.input, /Untrusted request data/); assert.match(request.body.input, /excluded\.example\.com/);
  assert.equal(result.candidates.length, 8); assert.equal(result.provider, 'openai'); assert.equal(result.web_search_calls, 1); assert.equal(result.provider_response_id, 'resp_1');
});

test('direct OpenAI discovery fails closed when no web search ran or output is not JSON', async () => {
  const reply = output => new DiscoveryService(null, null, { openaiApiKey: SECRET, fetchImpl: async () => Response.json({ output }) });
  await assert.rejects(reply([{ type: 'message', content: [{ type: 'output_text', text: '{"candidates":[],"coverage_notes":""}' }] }]).externalCandidates([assertion]), /no web search/);
  await assert.rejects(reply([{ type: 'web_search_call', status: 'failed' }, { type: 'message', content: [{ type: 'output_text', text: '{"candidates":[],"coverage_notes":""}' }] }]).externalCandidates([assertion]), /no web search/);
  await assert.rejects(reply([{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'not json' }] }]).externalCandidates([assertion]), /not JSON/);
});

test('discovery prefers a configured gateway and explains when nothing is configured', async () => {
  let called;
  const gateway = new DiscoveryService(null, null, { gatewayUrl: 'http://127.0.0.1:5678/webhook/d', authHeader: 'Bearer g', openaiApiKey: SECRET, fetchImpl: async url => { called = url; return Response.json({ result: { candidates: [], coverage_notes: '' } }); } });
  await gateway.externalCandidates([assertion]);
  assert.equal(called, 'http://127.0.0.1:5678/webhook/d');
  const none = new DiscoveryService(null, null, { fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(none.externalCandidates([assertion]), error => error.statusCode === 503 && /OPENAI_API_KEY/.test(error.publicMessage));
});

test('Source Corpus import accepts a token value as well as a token file', () => {
  const service = new CorpusImportService({}, { baseUrl: 'http://127.0.0.1:8766', token: 'synthetic', storageRoot: os.tmpdir() });
  assert.equal(service.configured, true);
  assert.throws(() => new CorpusImportService({}, { baseUrl: 'http://corpus.example.com', token: 'x', storageRoot: os.tmpdir() }), /HTTPS/);
});

test('corpus CLI is optional, HTTP-only and sends the bearer only to the configured origin', async () => {
  await assert.rejects(corpusSettings({}), UsageError);
  await assert.rejects(corpusSettings({ SOURCE_CORPUS_URL: 'http://127.0.0.1:8766' }), /SOURCE_CORPUS_TOKEN/);
  await assert.rejects(corpusSettings({ SOURCE_CORPUS_URL: 'http://corpus.example.com', SOURCE_CORPUS_TOKEN: 'x' }), /HTTPS/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-corpus-cli-'));
  try {
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'synthetic-file-token\n');
    const settings = await corpusSettings({ GET_FILES_URL: 'http://127.0.0.1:8766', GET_FILES_TOKEN_FILE: tokenFile });
    assert.equal(settings.token, 'synthetic-file-token'); assert.equal(settings.workbenchUrl, 'http://127.0.0.1:3080');
    const seen = [];
    const fetchImpl = async (url, options) => { seen.push({ url, auth: options.headers?.authorization }); return Response.json({ results: [] }); };
    await corpusClient(settings, fetchImpl).search('legal', 'double patenting');
    assert.equal(seen[0].url, 'http://127.0.0.1:8766/v1/search?collection=legal&q=double+patenting&limit=5');
    assert.equal(seen[0].auth, 'Bearer synthetic-file-token');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('corpus export submits URLs with expected hashes and never sends the token to the workbench', async () => {
  const hash = 'a'.repeat(64), id = '11111111-1111-4111-8111-111111111111';
  const items = projectSubmissions(id, { sources: [
    { source_id: 's1', canonical_url: 'https://court.example.gov/op.pdf', content_hash: hash, title: 'Opinion' },
    { source_id: 's2', canonical_url: 'file:///etc/passwd', content_hash: hash },
    { source_id: 's3', canonical_url: 'https://x.example.com/', content_hash: null },
  ] });
  assert.deepEqual(items.map(item => item.source_id), ['s1']);
  assert.equal(items[0].expected_sha256, hash); assert.equal(items[0].idempotency_key, `research:s1:${hash}`);
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, auth: options.headers?.authorization, body: options.body }); return url.includes('/api/projects/') ? Response.json({ sources: [{ source_id: 's1', canonical_url: 'https://court.example.gov/op.pdf', content_hash: hash }] }) : Response.json({ jobs: [] }); };
  const out = []; await corpusMain(['export-project', id], { SOURCE_CORPUS_URL: 'http://127.0.0.1:8766', SOURCE_CORPUS_TOKEN: 'synthetic' }, fetchImpl, line => out.push(line));
  assert.equal(calls[0].url, `http://127.0.0.1:3080/api/projects/${id}`); assert.equal(calls[0].auth, undefined);
  assert.equal(calls[1].url, 'http://127.0.0.1:8766/v1/ingest'); assert.equal(JSON.parse(calls[1].body).items.length, 1);
  assert.equal(JSON.parse(out[0]).submitted, 1);
});

test('release layout: compose publishes the app on loopback only, pins images, and no code reaches outside the install folder', async () => {
  const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const ports = [...compose.matchAll(/^\s*-\s*"([^"]+:\d+)"\s*$/gm)].map(match => match[1]);
  assert.deepEqual(ports, ['127.0.0.1:${WORKBENCH_PORT:-3080}:3080']);
  for (const image of compose.matchAll(/^\s*image:\s*(\S+)/gm)) if (!image[1].startsWith('research-workbench:')) assert.match(image[1], /@sha256:[a-f0-9]{64}$/);
  assert.match(await fs.readFile(path.join(root, 'Dockerfile'), 'utf8'), /^FROM [^\s]+@sha256:[a-f0-9]{64}/m);
  for (const dir of ['src', 'scripts', 'public', 'test']) for (const name of await fs.readdir(path.join(root, dir))) {
    if (!/\.(m?js|py|ps1|sh)$/.test(name)) continue;
    const text = await fs.readFile(path.join(root, dir, name), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]\.\.\/\.\.\//, `${dir}/${name} imports outside the install folder`);
    if (dir !== 'test') assert.doesNotMatch(text, /['"`][A-Za-z]:[\\/]|brightline[-]postgres|n8n[-]email-triage/i, `${dir}/${name} contains an absolute or owner-specific path`);
  }
});
