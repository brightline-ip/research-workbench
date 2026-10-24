import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
const context=new AsyncLocalStorage();
const controlled=(message,statusCode=429)=>Object.assign(new Error(message),{statusCode,publicMessage:message});
export class OperationLimits {
  // operationMilliseconds overrides jobMilliseconds per operation (for example discovery).
  constructor(pool,{dailyCalls=500,dailyInputBytes=32*1024*1024,jobCalls=400,jobMilliseconds=30*60*1000,operationMilliseconds={},minFreeBytes=512*1024*1024,storageRoots=[]}={}){
    Object.assign(this,{pool,dailyCalls,dailyInputBytes,jobCalls,jobMilliseconds,operationMilliseconds,minFreeBytes,storageRoots});
    for(const value of [dailyCalls,dailyInputBytes,jobCalls,jobMilliseconds,minFreeBytes,...Object.values(operationMilliseconds)])if(!Number.isSafeInteger(value)||value<=0)throw new Error('Operation limits must be positive integers.');
  }
  timeLimitFor(operation){return this.operationMilliseconds[operation]??this.jobMilliseconds;}
  async checkStorage(){
    for(const root of this.storageRoots){await fs.mkdir(root,{recursive:true});const stat=await fs.statfs(root);if(stat.bavail*stat.bsize<this.minFreeBytes)throw controlled('Storage is low. Free space or move storage before starting more work.',503);}
  }
  async reserve(projectId,operation,key){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key||''))throw controlled('A UUID Idempotency-Key is required for AI operations.',400);
    const result=await this.pool.query('INSERT INTO operation_requests(request_key,project_id,operation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_key',[key,projectId,operation]);
    if(!result.rowCount)throw controlled('This request was already accepted. Reload the project to inspect its result; it will not run again.',409);
  }
  run(task,operation=null){return context.run({started:Date.now(),calls:0,operation},task);}
  async charge(inputBytes){
    const job=context.getStore();
    if(!job)throw controlled('AI work requires an active operation context.',503);
    const limit=this.timeLimitFor(job.operation),elapsed=Date.now()-job.started,name=job.operation?`This ${job.operation} operation`:'This operation';
    if(elapsed>=limit)throw controlled(`${name} reached its time limit of ${Math.round(limit/60000)} minutes after ${job.calls} AI calls (${Math.round(elapsed/60000)} minutes elapsed). Inspect partial results before starting a new operation.`);
    if(job.calls>=this.jobCalls)throw controlled(`${name} reached its limit of ${this.jobCalls} AI calls. Inspect partial results before starting a new operation.`);
    if(inputBytes>1800000)throw controlled('AI request exceeds the supported input size.',413);
    job.calls++;
    let result;
    // A database stall here is not a provider failure; without this it was reported as one.
    try{result=await this.pool.query(`INSERT INTO provider_daily_usage(usage_day,calls,input_bytes)
      SELECT (now() AT TIME ZONE 'UTC')::date,1,$1::bigint WHERE $1::bigint<=$3::bigint AND $2::integer>=1
      ON CONFLICT(usage_day) DO UPDATE SET calls=provider_daily_usage.calls+1,input_bytes=provider_daily_usage.input_bytes+EXCLUDED.input_bytes
      WHERE provider_daily_usage.calls<$2::integer AND provider_daily_usage.input_bytes+EXCLUDED.input_bytes<=$3::bigint RETURNING calls`,[inputBytes,this.dailyCalls,this.dailyInputBytes]);}
    catch{job.calls--;throw controlled('The workbench database did not respond while recording AI usage, so no AI call was made. Retry after the database recovers.',503);}
    if(!result.rowCount)throw controlled('The workbench daily AI allowance is exhausted. Inspect usage and wait for the next UTC day or adjust the configured limit.');
  }
  fetch(fetchImpl=fetch){return async(url,options)=>{await this.charge(Buffer.byteLength(options.body||''));return fetchImpl(url,options);};}
  async usage(){const {rows:[row]}=await this.pool.query("SELECT calls,input_bytes FROM provider_daily_usage WHERE usage_day=(now() AT TIME ZONE 'UTC')::date");return {calls:row?.calls||0,input_bytes:Number(row?.input_bytes||0),daily_call_limit:this.dailyCalls,daily_input_byte_limit:this.dailyInputBytes};}
}
