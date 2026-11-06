import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runParser } from './safety.js';
import { fileURLToPath } from 'node:url';

const supported = new Set(['.docx','.pdf','.md','.markdown','.txt']);
const run = async(exe,args) => (await runParser(exe,args)).stdout;

export class ArticleImportService {
  constructor(repository,{artifactPython}) { this.repository=repository;this.artifactPython=artifactPython; }
  async import(projectId,{filename,data}) {
    const safeName=path.basename(filename||'').replace(/[\u0000-\u001f]/g,'');
    const extension=path.extname(safeName).toLowerCase();
    if(!supported.has(extension))throw Object.assign(new Error('supported article formats are .docx, .pdf, .md, .markdown, and .txt'),{statusCode:415});
    let content; let extraction={warnings:[],coverage:{method:'PLAIN_TEXT',original_document_complete:false}};
    if(['.md','.markdown','.txt'].includes(extension))content=data.toString('utf8').replace(/^\uFEFF/,'');
    else {
      if(!this.artifactPython)throw new Error('ARTIFACT_PYTHON is required for DOCX/PDF import');
      // Confidential input: private (0700) directory, 0600 file, always removed.
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rw-import-'));
      const temporary=path.join(directory,`article${extension}`);
      try {
        await fs.writeFile(temporary,data,{mode:0o600});
        extraction=JSON.parse(await run(this.artifactPython,['-X','utf8',fileURLToPath(new URL('../scripts/extract_article.py',import.meta.url)),temporary,extension,'--json'])); content=extraction.text;
      }
      catch(error){throw Object.assign(new Error(`Could not extract readable text from ${safeName}. The file may be damaged, encrypted, image-only, or use unsupported Word structures.`),{statusCode:422,cause:error})}
      finally { await fs.rm(directory,{recursive:true,force:true,maxRetries:3}).catch(()=>console.error(JSON.stringify({event:'temp_cleanup_failed',area:'article_import'}))); }
    }
    if(!content.trim())throw new Error('no extractable article text was found');
    const title=path.basename(safeName,extension).trim()||'Imported article';
    const version=await this.repository.saveCheckpoint(projectId,{title,content_markdown:content.trim(),change_summary:`Imported from ${safeName}`,import_metadata:{filename:safeName,warnings:extraction.warnings,coverage:extraction.coverage}});
    return {version,import:{filename:safeName,format:extension.slice(1),byte_length:data.length,content_hash:crypto.createHash('sha256').update(data).digest('hex')}};
  }
}
