import fs from'node:fs/promises';
import { runParser } from './safety.js';
// A configured URL is not a working provider: in n8n mode ask the gateway whether it is answering (n8n serves /healthz).
// Direct OpenAI mode has no free probe, so it still reports the credential only.
async function probeGateway(url,fetchImpl){
 let origin;try{origin=new URL(url).origin}catch{return{ok:false,detail:'The AI gateway URL is invalid.'}}
 try{const response=await fetchImpl(`${origin}/healthz`,{redirect:'error',signal:AbortSignal.timeout(3000)});return response.ok?{ok:true,detail:'Authenticated n8n gateway is answering.'}:{ok:false,detail:`The AI gateway answered HTTP ${response.status}.`}}
 catch{return{ok:false,detail:'The AI gateway is not answering.'}}
}
export async function readiness(pool,config,fetchImpl=fetch){const checks=[];const add=(name,status,detail)=>checks.push({name,status,detail});
 try{const expected=(await fs.readdir(new URL('../db/migrations/',import.meta.url))).filter(name=>/^\d+_.+\.sql$/.test(name)).map(name=>name.slice(0,-4)).sort();const{rows}=await pool.query('SELECT version FROM schema_migrations ORDER BY version');const applied=new Set(rows.map(row=>row.version));const{rows:[privileges]}=await pool.query("SELECT has_table_privilege(current_user,'checkpoint_requests','SELECT') AS can_select, has_table_privilege(current_user,'checkpoint_requests','INSERT') AS can_insert");const ready=expected.length>0&&expected.every(version=>applied.has(version))&&privileges?.can_select===true&&privileges?.can_insert===true;add('database',ready?'READY':'BLOCKED',ready?`Connected; ${expected.length} packaged migrations and checkpoint privileges verified.`:'Database migrations or checkpoint privileges are incomplete.')}catch(e){add('database','BLOCKED','Database check failed.')}
 for(const[name,dir]of[['source_storage',config.sourceStorageRoot],['project_storage',config.projectStorageRoot]])try{await fs.mkdir(dir,{recursive:true});await fs.access(dir);const disk=await fs.statfs(dir);const free=disk.bavail*disk.bsize;add(name,free<(config.operationLimits?.minFreeBytes||536870912)?'BLOCKED':'READY',`${Math.floor(free/1048576)} MB available`)}catch(e){add(name,'BLOCKED','Storage check failed.')}
 const n8nAuthReady=Boolean(config.n8nWebhookAuthHeader);
 const draftReady=Boolean(config.openaiApiKey)||(config.orchestrationMode==='n8n'&&Boolean(config.n8nWebhookUrl)&&n8nAuthReady);
 const gateway=config.orchestrationMode==='n8n'&&draftReady?await probeGateway(config.n8nWebhookUrl,fetchImpl):null;
 if(gateway)add('draft_model',gateway.ok?'READY':'BLOCKED',gateway.detail);
 else add('draft_model',draftReady?'READY':'NEEDS_CREDENTIAL',config.orchestrationMode==='n8n'?'Set N8N_DRAFT_WEBHOOK_URL and N8N_WEBHOOK_AUTH_HEADER.':(draftReady?'Direct OpenAI credential configured.':'Set OPENAI_API_KEY in the launch environment.'));
 const gatewayDiscovery=Boolean(config.n8nDiscoveryWebhookUrl)&&n8nAuthReady,directDiscovery=!config.n8nDiscoveryWebhookUrl&&config.orchestrationMode==='openai'&&Boolean(config.openaiApiKey);
 add('autonomous_discovery',gatewayDiscovery&&gateway&&!gateway.ok?'BLOCKED':gatewayDiscovery||directDiscovery?'READY':'NEEDS_CONFIG',gatewayDiscovery?(gateway&&!gateway.ok?gateway.detail:'Authenticated primary-source discovery gateway configured.'):directDiscovery?'OpenAI web search discovery configured (billed to your key).':'Set OPENAI_API_KEY (direct mode) or N8N_DISCOVERY_WEBHOOK_URL and N8N_WEBHOOK_AUTH_HEADER.');
 add('docx_pdf_exports',config.artifactPython?'READY':'NEEDS_CONFIG',config.artifactPython?'Python document runtime configured.':'Set ARTIFACT_PYTHON to Python with python-docx and reportlab.');
 let xlsxReady=false;if(config.artifactPython)try{await runParser(config.artifactPython,['-I','-c',"import xlsxwriter; assert xlsxwriter.__version__ == '3.2.9'"],{},{timeout:5000});xlsxReady=true}catch{}
 add('xlsx_exports',xlsxReady?'READY':'NEEDS_CONFIG',xlsxReady?'Pinned Python XLSX runtime verified.':'Python XLSX runtime is unavailable or does not contain the pinned XlsxWriter release.');
 return{status:checks.some(c=>c.status==='BLOCKED')?'BLOCKED':checks.some(c=>c.status.startsWith('NEEDS_'))?'SETUP_REQUIRED':'READY',checks,timestamp:new Date().toISOString()}}
