import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
// libuv reports EISDIR for ERROR_INVALID_FUNCTION, which Windows can return for a hard link on FAT.
const NO_HARD_LINKS=new Set(['EPERM','ENOSYS','EXDEV','ENOTSUP','EISDIR']);
async function requireSameBytes(target,bytes){
  if(sha256(await fs.readFile(target))!==sha256(bytes)){
    const message='Stored evidence file conflicts with its content hash. Inspect the storage folder.';
    throw Object.assign(new Error(message),{statusCode:409,publicMessage:message});
  }
}
// For exFAT, FAT and some SMB and 9p mounts. Rename keeps readers seeing a complete file or none, but unlike link() it can
// replace a file that appears between the check and the rename. Keys hold a content hash, so that file should hold the
// same bytes; the read afterwards reports a conflict if not. A create-in-place could leave a truncated file at the final name.
async function publishWithoutHardLink(temporary,target,bytes){
  const exists=await fs.access(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error});
  if(!exists)await fs.rename(temporary,target);
  await requireSameBytes(target,bytes);
}
// Content-addressed storage. Readers see a complete file or none: the bytes go to a temporary name first, and link()
// refuses to replace an existing file. An existing file must hold the same bytes; a different one is never accepted.
export async function writeStoredFile(target,bytes){
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=`${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary,bytes,{flag:'wx'});
  try{await fs.link(temporary,target)}
  catch(error){
    if(NO_HARD_LINKS.has(error.code))await publishWithoutHardLink(temporary,target,bytes);
    else if(error.code==='EEXIST')await requireSameBytes(target,bytes);
    else throw error;
  }finally{await fs.rm(temporary,{force:true,maxRetries:3}).catch(()=>{})}
}
