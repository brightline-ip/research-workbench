import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireSource, canonicalizeUrl, normalizeText } from '../src/source-acquisition.js';

test('canonical URLs remove fragments and tracking parameters', () => {
  assert.equal(canonicalizeUrl('HTTPS://Example.COM/doc?utm_source=x&id=4#part'), 'https://example.com/doc?id=4');
  assert.throws(() => canonicalizeUrl('file:///etc/passwd'), /HTTP/);
});

test('HTML normalization removes active content and preserves text structure', () => {
  const text = normalizeText(Buffer.from('<h1>Official</h1><script>bad()</script><p>A &amp; B</p>'), 'text/html');
  assert.match(text, /Official/); assert.match(text, /A & B/); assert.doesNotMatch(text, /bad/);
});

test('acquisition preserves native bytes and normalized text with content-addressed keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-source-'));
  try {
    const html = '<article><h1>Official report</h1><p>The value is 42.</p></article>';
    const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const result = await acquireSource('https://example.gov/report?utm_campaign=x', { fetchImpl, lookup: async () => [{ address: '203.0.113.10', family: 4 }], storageRoot: root });
    assert.equal(result.finalUrl, 'https://example.gov/report');
    assert.match(await fs.readFile(result.originalPath, 'utf8'), /<article>/);
    assert.match(await fs.readFile(result.normalizedPath, 'utf8'), /The value is 42/);
    assert.ok(!path.isAbsolute(result.originalStorageKey));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('acquisition blocks private-network targets before fetch', async () => {
  let fetched = false;
  await assert.rejects(acquireSource('http://internal.example/source', { fetchImpl: async () => { fetched=true; }, lookup: async () => [{ address: '127.0.0.1', family: 4 }], storageRoot: os.tmpdir() }), /private network/);
  assert.equal(fetched, false);
});

