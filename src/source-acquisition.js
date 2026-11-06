import { extractPdfText } from './source-normalization.js';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { readBounded } from './safety.js';
import { writeStoredFile } from './stored-files.js';

const MAX_BYTES = 25 * 1024 * 1024;

const NAMED_ENTITIES={nbsp:' ',lt:'<',gt:'>',quot:'"',apos:"'",rsquo:'\u2019',lsquo:'\u2018',rdquo:'\u201d',ldquo:'\u201c',ndash:'\u2013',mdash:'\u2014',hellip:'\u2026',sect:'\u00a7',para:'\u00b6',copy:'\u00a9',reg:'\u00ae',trade:'\u2122',shy:''};
// One pass, with &amp; decided here too, so "&amp;lt;" stays the text "&lt;".
export function decodeHtmlEntities(text){
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi,(whole,decimal,hex,name)=>{
    if(name)return name.toLowerCase()==='amp'?'&':NAMED_ENTITIES[name.toLowerCase()]??whole;
    const code=decimal?Number(decimal):parseInt(hex,16);
    return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):whole;
  });
}

export function canonicalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) source URLs are allowed');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url.toString();
}

export function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a,b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a>=224 || (a===100 && b>=64 && b<=127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a===198 && [18,19].includes(b));
  }
  const v = address.toLowerCase();
  // Only native global unicast; reject mapped/translated IPv4 and tunnels.
  return !net.isIPv6(v) || !/^[23][0-9a-f]{3}:/.test(v) || v.startsWith('2002:') || /^2001:(?:0*0:|db8:)/.test(v);
}

async function assertPublicUrl(url, lookup = dns.lookup) {
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  const records = net.isIP(hostname) ? [{address:hostname,family:net.isIP(hostname)}] : await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(r => privateAddress(r.address))) throw new Error('Source URL resolves to a local or private network address');
  return records[0];
}

export function pinnedRequest(url, record, signal, requestImpl = url.protocol==='https:' ? https.request : http.request) {
  return new Promise((resolve,reject)=>{
    const request=requestImpl(url, {signal,agent:false,headers:{'user-agent':'ResearchVerificationWorkbench/0.1'},lookup:(_host,options,callback)=>options.all?callback(null,[record]):callback(null,record.address,record.family)}, incoming=>{
      try {
        const headers=new Headers();
        for(const [name,value] of Object.entries(incoming.headers)) if(value!==undefined) headers.set(name,Array.isArray(value)?value.join(', '):value);
        const noBody=[204,205,304].includes(incoming.statusCode);
        const response=new Response(noBody?null:Readable.toWeb(incoming),{status:incoming.statusCode,headers});
        if(noBody)incoming.resume();
        resolve(response);
      } catch { incoming.destroy();reject(new Error('Source returned an invalid HTTP response.')); }
    });
    request.on('error',reject);request.end();
  });
}

function extension(mediaType) {
  if (mediaType.includes('html')) return '.html';
  if (mediaType.includes('pdf')) return '.pdf';
  if (mediaType.includes('json')) return '.json';
  if (mediaType.includes('xml')) return '.xml';
  return '.txt';
}

export function normalizeText(buffer, mediaType) {
  // Some servers send gzip without a Content-Encoding header, so fetch leaves it compressed.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { buffer = zlib.gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }); } catch { return null; }
  }
  const raw = buffer.toString('utf8');
  if (mediaType.includes('html')) return decodeHtmlEntities(raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  if (/^(text\/|application\/(json|xml))/i.test(mediaType)) return raw.replace(/\r\n/g, '\n').trim();
  return null;
}

export async function acquireSource(urlValue, { fetchImpl, lookup = dns.lookup, storageRoot, allowPrivate = false, extractPdf = extractPdfText } = {}) {
  let current = new URL(canonicalizeUrl(urlValue));
  const signal=AbortSignal.timeout(30000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const record = !allowPrivate ? await assertPublicUrl(current, lookup) : null;
    const response = fetchImpl || allowPrivate ? await (fetchImpl||fetch)(current, { redirect: 'manual', signal, headers: { 'user-agent': 'ResearchVerificationWorkbench/0.1' } }) : await pinnedRequest(current,record,signal);
    if ([301,302,303,307,308].includes(response.status)) {
      const target = response.headers.get('location'); await response.body?.cancel();
      if (!target) throw new Error('Redirect response omitted Location');
      current = new URL(canonicalizeUrl(new URL(target, current).toString())); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Source returned HTTP ${response.status}`), { httpStatus: response.status, finalUrl: current.toString() }); }
    const buffer = await readBounded(response,MAX_BYTES);
    let mediaType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') mediaType = 'application/pdf';
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const directory = path.join(storageRoot, contentHash.slice(0, 2), contentHash);
    await fs.mkdir(path.join(directory, 'original'), { recursive: true });
    await fs.mkdir(path.join(directory, 'normalized'), { recursive: true });
    const originalPath = path.join(directory, 'original', `source${extension(mediaType)}`);
    await writeStoredFile(originalPath, buffer);
    let normalized = normalizeText(buffer, mediaType), normalizationError = null;
    if (mediaType === 'application/pdf') {
      try { normalized = await extractPdf(originalPath); }
      catch (error) { normalizationError = error.message; }
    }
    let normalizedPath = null;
    if (normalized !== null) { normalizedPath = path.join(directory, 'normalized', crypto.createHash('sha256').update(normalized).digest('hex')+'.txt'); await writeStoredFile(normalizedPath, normalized); }
    return { finalUrl: current.toString(), httpStatus: response.status, mediaType, byteLength: buffer.length, contentHash, originalPath, normalizedPath, originalStorageKey: path.relative(storageRoot, originalPath).replaceAll('\\','/'), normalizedStorageKey: normalizedPath ? path.relative(storageRoot, normalizedPath).replaceAll('\\','/') : null, normalized, normalizationError, normalizedHash:normalized===null?null:crypto.createHash('sha256').update(normalized).digest('hex') };
  }
  throw new Error('Source exceeded redirect limit');
}
