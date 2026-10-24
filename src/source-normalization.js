import { parserEnvironment } from './safety.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export async function extractPdfText(filename, python = process.env.ARTIFACT_PYTHON) {
  if (!python) throw new Error('PDF text extraction needs ARTIFACT_PYTHON with pypdf installed.');
  try {
    const {stdout} = await run(python, ['-X', 'utf8', fileURLToPath(new URL('../scripts/extract_article.py', import.meta.url)), filename, '.pdf'], {
      env: parserEnvironment(), encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (!stdout.trim()) throw new Error('Empty PDF text');
    return stdout.trim();
  } catch (error) {
    throw new Error('PDF text could not be extracted. Image-only pages need OCR; encrypted or damaged PDFs need a readable copy.', {cause: error});
  }
}

function resolveStored(root, key) {
  const base = path.resolve(root), target = path.resolve(base, key);
  if (!target.startsWith(base + path.sep)) throw new Error('Invalid source storage key');
  return target;
}

export async function prepareProjectPdfText(pool, root, projectId, extract = extractPdfText) {
  const {rows: sources} = await pool.query(`SELECT s.* FROM sources s JOIN project_sources ps USING(source_id)
    WHERE ps.project_id=$1 AND ps.membership_status='ACCEPTED' AND s.normalized_storage_path IS NULL
    AND s.original_storage_path IS NOT NULL AND s.media_type='application/pdf'`, [projectId]);
  const summary = {prepared: 0, needs_attention: 0, sources: []};
  for (const source of sources) {
    try {
      const original = resolveStored(root, source.original_storage_path);
      const hash = crypto.createHash('sha256').update(await fs.readFile(original)).digest('hex');
      if (hash !== source.content_hash) throw new Error('Stored source hash mismatch; original file was changed.');
      const text = await extract(original);
      const normalizedHash=crypto.createHash('sha256').update(text).digest('hex');
      const key = path.posix.join(path.posix.dirname(path.posix.dirname(source.original_storage_path)), 'normalized', normalizedHash+'.txt');
      const destination = resolveStored(root, key);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.writeFile(destination, text, {flag: 'wx'}).catch(error => {if (error.code !== 'EEXIST') throw error;});
      await pool.query(`UPDATE sources SET normalized_storage_path=$2,retrieval_status='NORMALIZED',
        provenance=coalesce(provenance,'{}'::jsonb) || $3::jsonb,updated_at=now() WHERE source_id=$1 AND normalized_storage_path IS NULL`,
      [source.source_id, key, JSON.stringify({text_extraction: 'PDF_TEXT', normalized_content_hash:normalizedHash, normalization_error: null})]);
      summary.prepared++;
      summary.sources.push({source_id: source.source_id, status: 'NORMALIZED'});
    } catch (error) {
      summary.needs_attention++;
      summary.sources.push({source_id: source.source_id, status: 'NEEDS_TEXT', reason: error.message});
      await pool.query(`UPDATE sources SET provenance=coalesce(provenance,'{}'::jsonb) || $2::jsonb WHERE source_id=$1`,
        [source.source_id, JSON.stringify({normalization_error: error.message})]);
    }
  }
  return summary;
}
