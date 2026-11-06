import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
// Content-addressed storage. Readers see a complete file or none: the bytes go to a temporary name first, and link()
// refuses to replace an existing file. An existing file must hold the same bytes; a different one is never accepted.
export async function writeStoredFile(target,bytes){
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=`${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary,bytes,{flag:'wx'});
  try{await fs.link(temporary,target)}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    if(sha256(await fs.readFile(target))!==sha256(bytes)){
      const message='Stored evidence file conflicts with its content hash. Inspect the storage folder.';
      throw Object.assign(new Error(message),{statusCode:409,publicMessage:message});
    }
  }finally{await fs.rm(temporary,{force:true,maxRetries:3}).catch(()=>{})}
}
