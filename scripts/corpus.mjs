// Optional command-line bridge to a separately installed Source Corpus / Get Files service.
// It talks to that service over HTTP only (SOURCE_CORPUS_URL + SOURCE_CORPUS_TOKEN or
// SOURCE_CORPUS_TOKEN_FILE; the Get Files names GET_FILES_URL / GET_FILES_TOKEN_FILE also work).
// It does not rewrite historical verification records.
//
//   node scripts/corpus.mjs search "query" [collection]
//   node scripts/corpus.mjs export-project PROJECT_UUID [collection]
//
// export-project submits each acquired source's canonical URL with its recorded SHA-256, so the
// corpus service downloads it itself and rejects it if the bytes differ. Submitting sources is an
// outbound write to that service; nothing is sent unless you run this command.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sourceCorpusOrigin } from '../src/corpus-import.js';

export class UsageError extends Error {}

export async function corpusSettings(env = process.env) {
  const url = env.SOURCE_CORPUS_URL || env.GET_FILES_URL;
  if (!url) throw new UsageError('Source Corpus integration is not configured. Set SOURCE_CORPUS_URL and SOURCE_CORPUS_TOKEN (or SOURCE_CORPUS_TOKEN_FILE). The Get Files service is installed separately.');
  const baseUrl = sourceCorpusOrigin(url);
  let token = env.SOURCE_CORPUS_TOKEN || env.GET_FILES_TOKEN || null;
  const tokenFile = env.SOURCE_CORPUS_TOKEN_FILE || env.GET_FILES_TOKEN_FILE;
  if (!token && tokenFile) token = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new UsageError('SOURCE_CORPUS_TOKEN (or a non-empty SOURCE_CORPUS_TOKEN_FILE) is required.');
  const workbenchUrl = new URL(env.WORKBENCH_URL || `http://127.0.0.1:${env.PORT || 3080}`).origin;
  return { baseUrl, token, workbenchUrl, workbenchToken: env.WORKBENCH_TOKEN || null };
}

async function readJson(response, limit) {
  if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error('Response was not JSON'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Response exceeds the size limit'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function corpusClient({ baseUrl, token }, fetchImpl = fetch) {
  const request = async (route, body) => {
    const response = await fetchImpl(baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Source Corpus returned HTTP ${response.status}`); }
    return readJson(response, 8 * 1024 * 1024);
  };
  return {
    search: (collection, q, limit = 5) => request('/v1/search?' + new URLSearchParams({ collection, q, limit: String(limit) })),
    ingest: (collection, items) => request('/v1/ingest', { collection, items }),
  };
}

export function projectSubmissions(projectId, workspace) {
  return (workspace.sources || []).filter(s => s.canonical_url && /^https?:\/\//i.test(s.canonical_url) && /^[a-f0-9]{64}$/.test(s.content_hash || '')).map(s => ({
    url: s.canonical_url, title: s.title || undefined, source_system: 'research-workbench', source_id: s.source_id, project_id: projectId,
    source_retrieved_at: s.retrieved_at || undefined, expected_sha256: s.content_hash,
    idempotency_key: `research:${s.source_id}:${s.content_hash}`,
  }));
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, out = console.log) {
  const [command, value, collection = 'legal'] = argv;
  if (!['search', 'export-project'].includes(command)) throw new UsageError('Usage: node scripts/corpus.mjs search "query" [collection] OR export-project PROJECT_UUID [collection]');
  const settings = await corpusSettings(env), client = corpusClient(settings, fetchImpl);
  if (command === 'search') { if (!value) throw new UsageError('Supply a search query'); return out(JSON.stringify(await client.search(collection, value), null, 2)); }
  if (!/^[a-f0-9-]{36}$/i.test(value || '')) throw new UsageError('Supply the research project UUID');
  const response = await fetchImpl(`${settings.workbenchUrl}/api/projects/${value}`, { headers: settings.workbenchToken ? { authorization: `Bearer ${settings.workbenchToken}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Research project could not be read from the workbench'); }
  const items = projectSubmissions(value, await readJson(response, 64 * 1024 * 1024));
  const batches = []; for (let start = 0; start < items.length; start += 100) batches.push(await client.ingest(collection, items.slice(start, start + 100)));
  out(JSON.stringify({ collection, submitted: items.length, batches }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await main(); }
  catch (error) { console.error(error instanceof UsageError ? error.message : `Source Corpus command failed: ${error.message}`); process.exitCode = error instanceof UsageError ? 2 : 1; }
}
