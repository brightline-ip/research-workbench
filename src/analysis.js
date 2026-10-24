import crypto from 'node:crypto';

const stable=value=>JSON.stringify(value,Object.keys(value).sort());
export class AnalysisService{
  constructor(pool){this.pool=pool}
  async createDataset(projectId,{title,records,source_ids=[]}){
    if(!Array.isArray(records)||!records.every(r=>r&&typeof r==='object'&&!Array.isArray(r)))throw new Error('records must be an array of objects');
    const fields=[...new Set(records.flatMap(Object.keys))].map(name=>({name,type:inferType(records.map(r=>r[name]).filter(v=>v!=null))}));
    const contentHash=crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
    const {rows:[dataset]}=await this.pool.query(`INSERT INTO datasets(project_id,title,schema_json,records_json,record_count,source_ids,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,content_hash) DO UPDATE SET title=EXCLUDED.title RETURNING *`,[projectId,title,JSON.stringify({fields}),JSON.stringify(records),records.length,source_ids,contentHash]);return dataset;
  }
  async run(projectId,datasetId,{instruction,operation,parameters={}}){
    const {rows:[dataset]}=await this.pool.query('SELECT * FROM datasets WHERE project_id=$1 AND dataset_id=$2',[projectId,datasetId]);if(!dataset)return null;
    const code=`${operation}:${stable(parameters)}`;const codeHash=crypto.createHash('sha256').update(code).digest('hex');
    const {rows:[run]}=await this.pool.query(`INSERT INTO analysis_runs(project_id,dataset_id,instruction,operation,parameters,code,code_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[projectId,datasetId,instruction,operation,JSON.stringify(parameters),code,codeHash]);
    try{const result=execute(dataset.records_json,operation,parameters);const {rows:[completed]}=await this.pool.query(`UPDATE analysis_runs SET status='COMPLETE',result_data=$2,result_summary=$3,completed_at=now() WHERE analysis_run_id=$1 RETURNING *`,[run.analysis_run_id,JSON.stringify(result.data),result.summary]);return completed}catch(error){await this.pool.query(`UPDATE analysis_runs SET status='FAILED',error_message=$2,completed_at=now() WHERE analysis_run_id=$1`,[run.analysis_run_id,error.message]);throw error}
  }
}
function inferType(values){if(values.every(v=>typeof v==='number'))return'number';if(values.every(v=>typeof v==='boolean'))return'boolean';return'string'}
function execute(records,operation,p){
  if(operation==='DESCRIBE'){const numeric=Object.keys(records[0]||{}).filter(k=>records.every(r=>r[k]==null||typeof r[k]==='number'));const stats={record_count:records.length,numeric:Object.fromEntries(numeric.map(k=>{const v=records.map(r=>r[k]).filter(Number.isFinite);return[k,{count:v.length,mean:v.length?v.reduce((a,b)=>a+b,0)/v.length:null,min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null}]}))};return{data:stats,summary:`Described ${records.length} records.`}}
  if(!p.field)throw new Error('field is required');
  if(operation==='GROUP_COUNT'||operation==='GROUP_MEAN'){const groups=new Map();for(const row of records){const key=String(row[p.field]??'NULL');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}const data=[...groups].map(([group,rows])=>operation==='GROUP_COUNT'?{group,count:rows.length}:{group,count:rows.length,mean:mean(rows.map(r=>r[p.value_field]))});return{data,summary:`Computed ${operation} across ${data.length} groups.`}}
  if(operation==='PERCENTAGE'){const matches=records.filter(r=>r[p.field]===p.equals).length;return{data:{matches,total:records.length,percentage:records.length?matches/records.length:null},summary:`${matches} of ${records.length} records matched.`}}
  throw new Error('Unsupported analysis operation');
}
const mean=values=>{const v=values.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null};
