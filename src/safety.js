import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Parsers and exporters do not need database or model credentials.
export function parserEnvironment(extra = {}) {
  const allowed = /^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|HOME|USERPROFILE|LOCALAPPDATA)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), PYTHONIOENCODING: 'utf-8', ...extra };
}
export async function runParser(executable, args, extra = {}, options = {}) {
  try {
    return await promisify(execFile)(executable, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options, env: parserEnvironment(extra) });
  } catch {
    throw new Error('Document processor failed, timed out, or exceeded its output limit.');
  }
}

export async function readBounded(response, maxBytes = 16 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response exceeds the byte limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds the byte limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// A short controlled reason for operators. Never includes payloads, URLs, or raw provider text,
// except the fixed error vocabulary of a compatible gateway or host adapter.
const ADAPTER_REASONS = new Set(['adapter busy; retry later', 'adapter error', 'unauthorized', 'host not allowed', 'invalid request body', 'json required', 'not found',
  'client disconnected', 'deadline expired while queued',
  'subscription usage or rate limit reached',
  'model not supported on the subscription', 'discovery performed no web search', 'Unsupported operation',
  'Invalid gateway request', 'Invalid discovery request', 'Model is not allowed on the subscription adapter', 'Discovery is disabled on the subscription adapter']);
const knownAdapterReason = (value) => typeof value === 'string' && (ADAPTER_REASONS.has(value));
export function providerFailureReason(error, timeoutMs) {
  if (error?.providerReason) return error.providerReason;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `no response within ${Math.round(timeoutMs / 1000)} s`;
  if (error instanceof SyntaxError) return 'response was not valid JSON';
  if (/byte limit/.test(error?.message || '')) return 'response exceeded the byte limit';
  const code = error?.cause?.code || error?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code)) return `connection failed (${code})`;
  return 'request failed before a response';
}
async function rejectionReason(response) {
  let detail = '';
  try {
    const body = JSON.parse((await readBounded(response, 4096)).toString('utf8'));
    if (knownAdapterReason(body?.error)) detail = `: ${body.error}`;
  } catch { /* the body is not needed to report the status */ }
  return `HTTP ${response.status}${detail}`;
}

export async function fetchJson(fetchImpl, url, options, timeoutMs = 310000) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Object.assign(new Error('Provider rejected the request.'), { providerReason: await rejectionReason(response) });
    return JSON.parse((await readBounded(response)).toString('utf8'));
  } catch(error) {
    if(error.publicMessage&&error.statusCode)throw error;
    // Provider payloads, URLs, and raw exception details may contain private text.
    const reason = providerFailureReason(error, timeoutMs);
    throw Object.assign(new Error(`Provider request failed, timed out, or returned invalid data (${reason}). No automatic retry was attempted.`), { providerReason: reason });
  }
}
