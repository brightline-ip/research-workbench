import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../src/app.js';
import { DiscoveryService } from '../src/discovery.js';
import { sanitizeDiscoveredUrl, DEFAULT_TRUSTED_HOSTS, parseTrustedHosts } from '../src/discovery-urls.js';
import { loadConfig } from '../src/config.js';
import { startupProblems } from '../src/startup.js';
import { deleteProject } from '../scripts/delete-project.js';

// RW-A: model-chosen URLs
test('untrusted hosts lose query strings and fragments; trusted hosts keep them', () => {
  assert.equal(sanitizeDiscoveredUrl('https://attacker.example/p?q=secret+claim#frag'), 'https://attacker.example/p');
  assert.equal(sanitizeDiscoveredUrl('https://notgov.example/?q=1'), 'https://notgov.example/');
  assert.equal(sanitizeDiscoveredUrl('https://evilgov/?q=1'), 'https://evilgov/');
  assert.equal(sanitizeDiscoveredUrl('https://www.sec.gov/cgi-bin/browse?action=getcompany'), 'https://www.sec.gov/cgi-bin/browse?action=getcompany');
  assert.equal(sanitizeDiscoveredUrl('https://x.example/a?b=1', [...DEFAULT_TRUSTED_HOSTS, ...parseTrustedHosts(' *.x.example ,')]), 'https://x.example/a?b=1');
  assert.throws(() => sanitizeDiscoveredUrl('ftp://a.gov/x'));
  assert.throws(() => sanitizeDiscoveredUrl('https://user:pw' + '@a.gov/x'));
});

function discoveryHarness(options = {}) {
  const registered = [], inserts = [];
  const repository = {
    registerSource: async (_p, body) => (registered.push(body.canonical_url), { source_id: 's1', retrieval_status: 'NEW' }),
    acquireRegisteredSource: async () => ({ source: { source_id: 's1' } })
  };
  const pool = { query: async (sql, params) => (inserts.push({ sql, params }), { rows: [] }) };
  const service = new DiscoveryService(pool, repository, { acquireSource: async () => ({}), ...options });
  return { service, registered, inserts };
}
const candidate = url => ({ canonical_url: url, title: 't', issuing_authority: 'a', source_type: 'OTHER', authority_tier: 'PRIMARY', relationship_type: 'SUPPORTS', reason: 'r' });

test('discovery acquires a stripped URL for an untrusted host', async () => {
  const { service, registered } = discoveryHarness();
  await service.acquireCandidateForGroup('p', 'r', 'q', [{ assertion_id: 'a1' }], candidate('https://attacker.example/x?q=claim#h'));
  assert.deepEqual(registered, ['https://attacker.example/x']);
});

test('DISCOVERY_REQUIRE_ACCEPTANCE holds candidates without fetching', async () => {
  const { service, registered, inserts } = discoveryHarness({ requireAcceptance: true });
  const accepted = await service.acquireCandidateForGroup('p', 'r', 'q', [{ assertion_id: 'a1' }], candidate('https://attacker.example/x?q=claim'));
  assert.equal(accepted, false);
  assert.deepEqual(registered, []);
  assert.match(inserts[0].sql, /HUMAN_REVIEW/);
  assert.equal(inserts[0].params[3], 'https://attacker.example/x');
});

test('config exposes the new settings with safe defaults', () => {
  const config = loadConfig({});
  assert.equal(config.discoveryRequireAcceptance, false);
  assert.equal(config.workbenchToken, null);
  assert.ok(config.discoveryTrustedHosts.includes('gov'));
  assert.ok(loadConfig({ DISCOVERY_TRUSTED_HOSTS: 'example.org', DISCOVERY_REQUIRE_ACCEPTANCE: '1' }).discoveryTrustedHosts.includes('example.org'));
  assert.match(startupProblems({ orchestrationMode: 'n8n', n8nWebhookUrl: 'x', n8nWebhookAuthHeader: 'y', host: '127.0.0.1', port: 3080, workbenchToken: 'short' }).join(), /WORKBENCH_TOKEN/);
});

// RW-B: token
async function withTokenServer(token, fn) {
  const repo = { listProjects: async () => [{ project_id: '1' }] };
  const server = http.createServer(createHandler(repo, {}, { config: { workbenchToken: token } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const TOKEN = 'a'.repeat(32);

test('WORKBENCH_TOKEN protects API routes but not the static page', () => withTokenServer(TOKEN, async base => {
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 200);
}));

test('POST /api/session sets an HttpOnly SameSite=Strict cookie that authenticates later requests', () => withTokenServer(TOKEN, async base => {
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
}));

test('without WORKBENCH_TOKEN the API stays open (loopback-only model)', () => withTokenServer(null, async base => {
  assert.equal((await fetch(`${base}/api/projects`)).status, 200);
}));

// RW-F: delete-project
const ID = '11111111-2222-4333-8444-555555555555';
function fakePool({ found = true, failAt = null } = {}) {
  const log = [];
  const client = {
    query: async sql => { log.push(sql.replace(/\s+/g, ' ').slice(0, 40)); if (failAt && sql.includes(failAt)) throw new Error('boom'); return { rows: [] }; },
    release: () => log.push('release')
  };
  return { log, query: async () => ({ rows: found ? [{ project_id: ID, title: 'T' }] : [] }), connect: async () => client };
}

test('delete-project removes rows in one transaction, then the project folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-del-'));
  try {
    const dir = path.join(root, ID); await fs.mkdir(path.join(dir, 'exports'), { recursive: true }); await fs.writeFile(path.join(dir, 'exports', 'a.csv'), 'x');
    const pool = fakePool();
    assert.equal((await deleteProject(pool, { projectStorageRoot: root }, ID)).deleted, false);
    await fs.stat(dir);
    assert.equal((await deleteProject(pool, { projectStorageRoot: root }, ID, { confirm: true })).deleted, true);
    assert.deepEqual(pool.log.filter(l => l !== 'release').map(l => l.split(' ')[0]), ['BEGIN', 'DELETE', 'DELETE', 'DELETE', 'COMMIT']);
    await assert.rejects(fs.stat(dir));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('delete-project rolls back and keeps files when the database fails; rejects bad ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-del-'));
  try {
    const dir = path.join(root, ID); await fs.mkdir(dir, { recursive: true });
    const pool = fakePool({ failAt: 'DELETE FROM projects' });
    await assert.rejects(deleteProject(pool, { projectStorageRoot: root }, ID, { confirm: true }), /boom/);
    assert.ok(pool.log.includes('ROLLBACK'));
    await fs.stat(dir);
    await assert.rejects(deleteProject(pool, { projectStorageRoot: root }, '../../etc', { confirm: true }), /UUID/);
    await assert.rejects(deleteProject(fakePool({ found: false }), { projectStorageRoot: root }, ID, { confirm: true }), /not found/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
