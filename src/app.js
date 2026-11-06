import { isPermanentProviderFailure } from './safety.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON content type required'), {statusCode:415});
  const chunks = []; let size=0; for await (const chunk of req) {size+=chunk.length;if(size>2*1024*1024)throw Object.assign(new Error('request body exceeds 2 MB'),{statusCode:413});chunks.push(chunk)}
  if (!chunks.length) return {};
  try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('Invalid JSON object'), {statusCode:400}); }
}
async function readBinary(req,maxBytes=25*1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('article file exceeds 25 MB'),{statusCode:413});chunks.push(chunk)}return Buffer.concat(chunks)}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'" });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function sendStoredFile(res, root, storagePath, mimeType, downloadName = null) {
  if (!storagePath) return send(res, 404, { error: 'stored file is unavailable' });
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, storagePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) return send(res, 400, { error: 'invalid storage path' });
  const actualRoot=await fs.realpath(resolvedRoot), actualFile=await fs.realpath(resolvedFile);
  if (!actualFile.startsWith(actualRoot+path.sep)) return send(res,400,{error:'invalid storage path'});
  const data = await fs.readFile(actualFile);
  const headers = { 'content-type': mimeType || 'application/octet-stream', 'content-length': data.length, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' };
  headers['content-security-policy'] = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";
  headers['referrer-policy']='no-referrer';
  headers['cross-origin-resource-policy']='same-origin';
  const filename=(downloadName || path.basename(resolvedFile)).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180);
  headers['content-disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(200, headers); res.end(data);
}

// Reason fields for the request_failed log line. Raw exception messages are never logged: only
// controlled public messages, the provider reason vocabulary from safety.js, database error
// codes and constraint names (never row values), and system error codes.
export function failureLogFields(req,error){
  const route=String(req.url||'').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,':id').slice(0,120);
  const project_id=String(req.url||'').match(/^\/api\/projects\/([0-9a-f-]{36})/i)?.[1]||null;
  const code=typeof error?.code==='string'&&/^[0-9A-Z_]{3,40}$/.test(error.code)?error.code:null;
  const reason=error?.publicMessage?String(error.publicMessage).slice(0,300)
    :error?.providerReason?`provider: ${error.providerReason}`
    :code&&error.severity?`database error ${code}${error.constraint?` (${String(error.constraint).replace(/[^\w.-]/g,'').slice(0,80)})`:''}`
    :`${error?.name||'Error'}${code?` ${code}`:''} (details stay in the project's run record, if any)`;
  return {method:req.method,route,project_id,reason};
}


// Optional WORKBENCH_TOKEN: when set, every /api/ route needs it, either as "Authorization: Bearer <token>"
// or as the HttpOnly SameSite=Strict cookie that POST /api/session sets after checking the bearer token.
// Static files carry no data and stay open so the page can load and ask for the token.
const digest=value=>crypto.createHash('sha256').update(String(value)).digest();
function tokenMatches(expected,given){return Boolean(given)&&crypto.timingSafeEqual(digest(expected),digest(given))}
function presentedToken(req){
  const bearer=/^Bearer (.+)$/i.exec(req.headers.authorization||'')?.[1];
  if(bearer)return bearer.trim();
  return /(?:^|;\s*)rw_token=([^;]+)/.exec(req.headers.cookie||'')?.[1]||null;
}

export function createHandler(repository, orchestrator, sourceServices = {}) {
  const activeProjects = new Set();
  const handler=async (req, res) => {
    let operationKey;
    const requestId=crypto.randomUUID();
    try {
      const host=req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return send(res,403,{error:'Local workbench host required'});
      const origin=req.headers.origin;
      if ((origin && origin!==`http://${host}`) || ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) return send(res,403,{error:'Same-origin workbench request required'});
      const url = new URL(req.url, 'http://localhost');
      const token=sourceServices.config?.workbenchToken;
      if (token && url.pathname.startsWith('/api/')) {
        let given=presentedToken(req);
        try { given=given&&given.includes('%')?decodeURIComponent(given):given } catch {}
        if (!tokenMatches(token,given)) return send(res,401,{error:'Workbench access token required',auth_required:true});
        if (req.method==='POST' && url.pathname==='/api/session') {
          res.setHeader('set-cookie',`rw_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
          return send(res,200,{ok:true});
        }
      }
      if (req.method==='POST' && url.pathname.startsWith('/api/')) {
        operationKey=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)/i)?.[1]?.toLowerCase() || 'projects';
        if (activeProjects.has(operationKey)) { operationKey=null; return send(res,409,{error:'A project operation is already running. Wait for its result before retrying.'}); }
        if (activeProjects.size>=3) { operationKey=null; return send(res,429,{error:'Workbench is busy. Try again after an active operation finishes.'}); }
        activeProjects.add(operationKey);
      }
      const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/(draft|checkpoint|import|assertions|assertions-review|corpus-import|discovery-estimate|discover|verify|adversarial|revise|datasets|exports|normalize-sources))?$/i);
      if(req.method==='POST'&&sourceServices.operationLimits){
        await sourceServices.operationLimits.checkStorage();
        const paid=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/(draft|assertions|corpus-import|discover|verify|adversarial|revise|sources)$/i);
        if(paid)await sourceServices.operationLimits.reserve(paid[1],paid[2],req.headers['idempotency-key']);
      }
      const sourceMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/sources(?:\/([0-9a-f-]+)\/acquire)?$/i);
      const sourceFileMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/sources\/([0-9a-f-]+)\/(original|normalized)$/i);
      const artifactMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)\/download$/i);
      const analysisMatch=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/datasets\/([0-9a-f-]+)\/analysis$/i);
      if(req.method==='GET'&&url.pathname==='/api/readiness')return send(res,200,await sourceServices.readiness());
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, await repository.listProjects());
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const body = await readJson(req);
        if (!body.title?.trim()) return send(res, 400, { error: 'title is required' });
        return send(res, 201, await repository.createProject(body));
      }
      if (match && req.method === 'GET' && !match[2]) {
        const workspace = await repository.getWorkspace(match[1]);
        return workspace ? send(res, 200, workspace) : send(res, 404, { error: 'project not found' });
      }
      if (match && req.method === 'POST' && match[2] === 'draft') {
        const body = await readJson(req);
        if (!body.instruction?.trim()) return send(res, 400, { error: 'instruction is required' });
        const result = await repository.createDraft(match[1], body.instruction, orchestrator);
        return result ? send(res, 201, result) : send(res, 404, { error: 'project not found' });
      }
      if (match && req.method === 'POST' && match[2] === 'checkpoint') {
        const body = await readJson(req);
        if (!body.title?.trim() || !body.content_markdown?.trim()) return send(res, 400, { error: 'title and content_markdown are required' });
        const version = await repository.saveCheckpoint(match[1], body, null, req.headers['idempotency-key']??null);
        return version ? send(res, 201, version) : send(res, 404, { error: 'project not found' });
      }
      if(match&&req.method==='POST'&&match[2]==='import'){
        if(!sourceServices.articleImportService)return send(res,503,{error:'article file import is unavailable'});
        const filename=url.searchParams.get('filename');if(!filename)return send(res,400,{error:'filename is required'});
        return send(res,201,await sourceServices.articleImportService.import(match[1],{filename,data:await readBinary(req)}));
      }
      if (match && req.method === 'POST' && match[2] === 'assertions') {
        const body = await readJson(req);
        if (!body.article_version_id) return send(res, 400, { error: 'article_version_id is required' });
        const result = await repository.extractAssertions(match[1], body.article_version_id, orchestrator, process.env.CLAIM_EXTRACTION_MODEL || process.env.OPENAI_MODEL || null,body.scope||{});
        return result ? send(res, 201, result) : send(res, 404, { error: 'article version not found' });
      }
      if(match&&req.method==='POST'&&match[2]==='assertions-review'){
        const body=await readJson(req);if(!body.article_version_id||!Array.isArray(body.decisions))return send(res,400,{error:'article_version_id and decisions are required'});
        const result=await repository.reviewAssertions(match[1],body.article_version_id,body.decisions);return result?send(res,200,result):send(res,404,{error:'article version not found'});
      }
      if(match&&req.method==='POST'&&match[2]==='corpus-import'){
        if(!sourceServices.corpusImportService)return send(res,503,{error:'Source Corpus import is unavailable'});
        return send(res,201,await sourceServices.corpusImportService.import(match[1],await readJson(req)));
      }
      if (match && req.method === 'POST' && match[2] === 'verify') {
        const body = await readJson(req);
        if (!body.article_version_id) return send(res, 400, { error: 'article_version_id is required' });
        if (!sourceServices.verificationService) return send(res, 503, { error: 'verification is unavailable' });
        const result = await sourceServices.verificationService.run(match[1], body.article_version_id, body.mode || 'AUTHOR_CORPUS',{corpusSnapshotId:body.corpus_snapshot_id||null});
        return result ? send(res, 201, result) : send(res, 409, { error: 'extract assertions before verification' });
      }
      if(match&&req.method==='POST'&&match[2]==='discover'){
        if(!sourceServices.discoveryService)return send(res,503,{error:'autonomous discovery is unavailable'});const body=await readJson(req);if(!body.article_version_id)return send(res,400,{error:'article_version_id is required'});return send(res,201,await sourceServices.discoveryService.run(match[1],body.article_version_id,body.policy||{}));
      }
      if(match&&req.method==='POST'&&match[2]==='discovery-estimate'){
        if(!sourceServices.discoveryService)return send(res,503,{error:'autonomous discovery is unavailable'});const body=await readJson(req);if(!body.article_version_id)return send(res,400,{error:'article_version_id is required'});return send(res,200,await sourceServices.discoveryService.estimate(match[1],body.article_version_id,body.policy||{}));
      }
      if(match&&req.method==='POST'&&match[2]==='adversarial'){
        if(!sourceServices.adversarialService)return send(res,503,{error:'adversarial validation is unavailable'});const body=await readJson(req);if(body.adversarial_run_id)return send(res,201,await sourceServices.adversarialService.resume(match[1],body.adversarial_run_id));if(!body.article_version_id||!body.author_verification_run_id)return send(res,400,{error:'article_version_id and author_verification_run_id are required'});return send(res,201,await sourceServices.adversarialService.run(match[1],body.article_version_id,body.author_verification_run_id));
      }
      if(match&&req.method==='POST'&&match[2]==='revise'){
        const body=await readJson(req);if(!body.article_version_id||!body.verification_run_id)return send(res,400,{error:'article_version_id and verification_run_id are required'});
        const result=await repository.reviseArticle(match[1],body.article_version_id,body.verification_run_id,body.instruction||'Address every actionable finding while preserving the draft. Mark issues that still need evidence or review.',orchestrator,process.env.REVISION_MODEL||process.env.OPENAI_MODEL||null);return result?send(res,201,result):send(res,404,{error:'revision context not found'});
      }
      if(match&&req.method==='POST'&&match[2]==='datasets'){
        if(!sourceServices.analysisService)return send(res,503,{error:'analysis is unavailable'});const body=await readJson(req);if(!body.title||!Array.isArray(body.records))return send(res,400,{error:'title and records are required'});return send(res,201,await sourceServices.analysisService.createDataset(match[1],body));
      }
      if(analysisMatch&&req.method==='POST'){
        if(!sourceServices.analysisService)return send(res,503,{error:'analysis is unavailable'});const body=await readJson(req);const result=await sourceServices.analysisService.run(analysisMatch[1],analysisMatch[2],body);return result?send(res,201,result):send(res,404,{error:'dataset not found'});
      }
      if(match&&req.method==='POST'&&match[2]==='normalize-sources'){
        if(!sourceServices.preparePdfText)return send(res,503,{error:'PDF text extraction is unavailable'});
        return send(res,200,await sourceServices.preparePdfText(match[1]));
      }
      if(match&&req.method==='POST'&&match[2]==='exports'){
        if(!sourceServices.exportService)return send(res,503,{error:'exports are unavailable'});const body=await readJson(req);if(!body.article_version_id||!body.verification_run_id||!body.format)return send(res,400,{error:'article_version_id, verification_run_id, and format are required'});const result=await sourceServices.exportService.generate(match[1],body);return result?send(res,201,result):send(res,404,{error:'export context not found'});
      }
      if (sourceMatch && req.method === 'POST' && !sourceMatch[2]) {
        let body = await readJson(req);
        if (!body.canonical_url) return send(res, 400, { error: 'canonical_url is required' });
        if (body.assertion_id) {
          const assertion = await repository.getAssertion(sourceMatch[1], body.assertion_id);
          if (!assertion) return send(res, 404, { error: 'assertion not found' });
          if (!body.proposition_source_class) {
          const classification = await orchestrator.classifySource({ assertion_text: assertion.assertion_text, normalized_proposition: assertion.normalized_proposition, candidate_source: { canonical_url: body.canonical_url, title: body.title || null, issuing_authority: body.issuing_authority || null } });
          body = { ...body, ...classification };
          }
        }
        return send(res, 201, await repository.registerSource(sourceMatch[1], body));
      }
      if (sourceMatch && req.method === 'POST' && sourceMatch[2]) {
        if (!sourceServices.acquireSource) return send(res, 503, { error: 'source acquisition is unavailable' });
        const result = await repository.acquireRegisteredSource(sourceMatch[1], sourceMatch[2], sourceServices.acquireSource, sourceServices.sourceStorageRoot);
        return result ? send(res, 201, result) : send(res, 404, { error: 'source not found' });
      }
      if (sourceFileMatch && req.method === 'GET') {
        const source = await repository.getSource(sourceFileMatch[1], sourceFileMatch[2]);
        if (!source) return send(res, 404, { error: 'source not found' });
        const normalized = sourceFileMatch[3] === 'normalized';
        return sendStoredFile(res, sourceServices.sourceStorageRoot, normalized ? source.normalized_storage_path : source.original_storage_path, normalized ? 'text/plain; charset=utf-8' : source.media_type, null);
      }
      if (artifactMatch && req.method === 'GET') {
        const artifact = await repository.getArtifact(artifactMatch[1], artifactMatch[2]);
        if (!artifact) return send(res, 404, { error: 'artifact not found' });
        const extension = path.extname(artifact.storage_path || '');
        return sendStoredFile(res, sourceServices.config.projectStorageRoot, artifact.storage_path, artifact.mime_type, `${artifact.title || 'export'}${extension}`);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/styles.css' || url.pathname === '/report-model.js')) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
        return send(res, 200, await fs.readFile(path.join(publicDir, file), 'utf8'), types[path.extname(file)]);
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      const status=[400,404,409,413,415,422,429,503].includes(error.statusCode)?error.statusCode:error.providerReason&&!isPermanentProviderFailure(error.providerReason)?503:500;
      const logFields=failureLogFields(req,error);
      console.error(JSON.stringify({event:'request_failed',request_id:requestId,status,...logFields}));
      // Only the controlled vocabulary from failureLogFields reaches the caller, so retries can tell a provider outage from a permanent error.
      const publicError=error.publicMessage||(error.providerReason?`The AI provider failed (${error.providerReason}). Retry when it is available.`:status===500?'Operation failed. Check the project status before retrying.':'Request could not be completed. Check the input and project status.');
      if (!res.headersSent) send(res,status,{error:publicError,...(status===500&&error.severity?{reason:logFields.reason}:{}),request_id:requestId});
      else res.destroy();
    } finally { if(operationKey)activeProjects.delete(operationKey); }
  };
  const operationOf=req=>String(req.url||'').match(/^\/api\/projects\/[0-9a-f-]+\/([a-z-]+)/i)?.[1]?.toLowerCase()||null;
  return (req,res)=>sourceServices.operationLimits?sourceServices.operationLimits.run(()=>handler(req,res),operationOf(req)):handler(req,res);
}
