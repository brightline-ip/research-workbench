import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
// The optional Source Corpus / Get Files service. Plain HTTP is accepted only for local origins.
export function sourceCorpusOrigin(baseUrl){
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(!['https:'].includes(url.protocol)&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]','host.docker.internal'].includes(url.hostname))))throw new Error('Source Corpus URL must be a trusted local HTTP origin or HTTPS origin');
  return url.origin;
}
const controlled=(message,statusCode=422)=>Object.assign(new Error(message),{statusCode,publicMessage:message});

export class CorpusImportService {
  constructor(repository,{baseUrl,token=null,tokenFile,storageRoot,fetchImpl=fetch,maxBytes=25*1024*1024,binaryTimeoutMs=120000}={}){
    if(baseUrl)this.baseUrl=sourceCorpusOrigin(baseUrl);
    Object.assign(this,{repository,tokenValue:token,tokenFile,storageRoot,fetchImpl,maxBytes,binaryTimeoutMs});
  }
  get configured(){return Boolean(this.baseUrl&&(this.tokenValue||this.tokenFile)&&this.storageRoot)}
  async #token(){const value=(this.tokenValue??await fs.readFile(this.tokenFile,'utf8')).trim();if(!value)throw new Error('Source Corpus credential is empty');return value}
  async #request(route,{binary=false}={}){
    // The timeout covers the whole body, so originals (multi-megabyte PDFs through the Docker host proxy) get longer.
    const part=route.match(/\/(original|normalized)\?/)?.[1]||'metadata',timeoutMs=binary?this.binaryTimeoutMs:30000;
    let response,bytes;
    try{
      response=await this.fetchImpl(this.baseUrl+route,{headers:{authorization:`Bearer ${await this.#token()}`},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok){await response.body?.cancel();throw controlled(`Source Corpus returned HTTP ${response.status} for the ${part}`,response.status===404?404:503)}
      const chunks=[];let size=0,limit=binary?this.maxBytes:2*1024*1024;for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body?.cancel();throw controlled(binary?'Source Corpus document exceeds the 25 MB import limit':'Source Corpus metadata exceeds the 2 MB limit',413)}chunks.push(chunk)}
      bytes=Buffer.concat(chunks);
    }catch(error){
      if(error.publicMessage)throw error;
      if(error.name==='TimeoutError'||error.name==='AbortError')throw controlled(`Source Corpus ${part} request timed out after ${Math.round(timeoutMs/1000)} s`,503);
      const code=error?.cause?.code||error?.code;
      throw controlled(`Source Corpus ${part} request failed${typeof code==='string'&&/^[A-Z_]{3,40}$/.test(code)?` (${code})`:''}`,503);
    }
    if(binary)return bytes;
    if(!response.headers.get('content-type')?.includes('application/json'))throw controlled('Source Corpus metadata was not JSON',503);
    try{return JSON.parse(bytes.toString('utf8'))}catch{throw controlled('Source Corpus metadata was invalid JSON',503)}
  }
  async import(projectId,input){
    if(!this.configured)throw controlled('Source Corpus import is unavailable',503);
    const collection=String(input.collection||'');const documentId=String(input.document_id||'').toLowerCase();
    if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(collection)||!/^[a-f0-9]{64}$/.test(documentId))throw controlled('A valid collection and 64-character document_id are required',400);
    if(!Array.isArray(input.assertion_links)||!input.assertion_links.length||input.assertion_links.length>500)throw controlled('assertion_links must contain 1 to 500 explicit links',400);
    const query='?'+new URLSearchParams({collection});
    const metadata=await this.#request(`/v1/documents/${documentId}${query}`);
    const status=String(metadata.status||'').toLowerCase();
    if(status!=='ready'&&!input.allow_incomplete)throw controlled(`Source Corpus document is ${status||'not ready'}; set allow_incomplete only after reviewing extraction warnings`,409);
    const original=await this.#request(`/v1/documents/${documentId}/original${query}`,{binary:true});
    if(sha256(original)!==documentId)throw controlled('Source Corpus original hash does not match document_id',409);
    let normalized=null;try{normalized=await this.#request(`/v1/documents/${documentId}/normalized${query}`,{binary:true})}catch(error){if(!input.allow_incomplete)throw error}
    if(!normalized?.length&&!input.allow_incomplete)throw controlled('Source Corpus document has no normalized text',409);
    const originalKey=`corpus/${documentId.slice(0,2)}/${documentId}/original`;
    const normalizedHash=normalized?.length?sha256(normalized):null;
    const normalizedKey=normalizedHash?`corpus/${documentId.slice(0,2)}/${documentId}/normalized/${normalizedHash}.txt`:null;
    await this.#write(originalKey,original);if(normalizedKey)await this.#write(normalizedKey,normalized);
    const origin=Array.isArray(metadata.origins)?metadata.origins.find(item=>item?.source_url||item?.url):null;
    const canonicalUrl=origin?.source_url||origin?.url;
    if(!canonicalUrl)throw controlled('Source Corpus metadata has no canonical source URL',409);
    return this.repository.importCorpusSource(projectId,{
      canonical_url:canonicalUrl,title:input.title||metadata.title||null,source_type:input.source_type||'OTHER',issuing_authority:input.issuing_authority||null,
      jurisdiction:input.jurisdiction||null,publication_date:input.publication_date||null,version_label:input.version_label||null,
      content_hash:documentId,normalized_content_hash:normalizedHash,original_storage_path:originalKey,normalized_storage_path:normalizedKey,
      media_type:metadata.media_type||metadata.mime_type||'application/octet-stream',byte_length:original.length,retrieval_status:normalizedKey?'NORMALIZED':'ACQUIRED',
      provenance:{retrieval_method:'SOURCE_CORPUS',collection,document_id:documentId,corpus_status:metadata.status||null,normalization_manifest:metadata.manifest||null,extraction_warnings:metadata.manifest?.warnings||metadata.warnings||[]},
      assertion_links:input.assertion_links,
    });
  }
  async #write(key,bytes){const root=path.resolve(this.storageRoot),target=path.resolve(root,key);if(!target.startsWith(root+path.sep))throw new Error('Invalid corpus storage key');await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.writeFile(target,bytes,{flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error;if(sha256(await fs.readFile(target))!==sha256(bytes))throw controlled('Stored corpus file conflicts with imported hash',409)}}
}
