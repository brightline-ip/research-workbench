import { prepareProjectPdfText } from './source-normalization.js';
import http from 'node:http';
import pg from 'pg';
import { loadConfig } from './config.js';
import { Repository } from './repository.js';
import { createOrchestrator } from './orchestrator.js';
import { createHandler } from './app.js';
import { acquireSource } from './source-acquisition.js';
import { VerificationService } from './verification.js';
import { AnalysisService } from './analysis.js';
import { ExportService } from './exports.js';
import { readiness } from './readiness.js';
import { DiscoveryService } from './discovery.js';
import { ArticleImportService } from './article-import.js';
import { AdversarialService } from './adversarial.js';
import { OperationLimits } from './operation-limits.js';
import { acquireWorker, recoverInterrupted } from './recovery.js';
import { CorpusImportService } from './corpus-import.js';
import { startupProblems } from './startup.js';

const config = loadConfig();
const problems = startupProblems(config);
if (problems.length) {
  console.error('Research Workbench cannot start:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const pool = new pg.Pool({...(config.databaseUrl ? { connectionString: config.databaseUrl } : config.pg),connectionTimeoutMillis:5000});
pool.on('error',()=>{console.error('Database connection failed. Workbench is stopping.');process.exit(1)});
try { await pool.query('SELECT 1'); }
catch { console.error('Research Workbench cannot reach PostgreSQL. Check DATABASE_URL (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) and that the server is running, then run `npm run migrate`.'); process.exit(1); }
const worker=await acquireWorker(pool);
worker.on('error',()=>{console.error('Worker lock connection lost. Workbench is stopping.');process.exit(1)});
await recoverInterrupted(worker);
const operationLimits=new OperationLimits(pool,{...config.operationLimits,storageRoots:[config.sourceStorageRoot,config.projectStorageRoot]});
const guardedFetch=operationLimits.fetch();
const orchestrator = createOrchestrator(config,guardedFetch);
const verificationService = new VerificationService(pool, orchestrator, config.sourceStorageRoot, config.verificationModel, config.verificationConcurrency);
const repository=new Repository(pool);
const discoveryService=new DiscoveryService(pool,repository,{gatewayUrl:config.n8nDiscoveryWebhookUrl,authHeader:config.n8nWebhookAuthHeader,acquireSource,sourceStorageRoot:config.sourceStorageRoot,openaiApiKey:config.orchestrationMode==='openai'?config.openaiApiKey:null,model:config.discoveryModel,fetchImpl:guardedFetch,trustedHosts:config.discoveryTrustedHosts,requireAcceptance:config.discoveryRequireAcceptance});
const corpusImportService=config.sourceCorpusUrl&&(config.sourceCorpusToken||config.sourceCorpusTokenFile)?new CorpusImportService(repository,{baseUrl:config.sourceCorpusUrl,token:config.sourceCorpusToken,tokenFile:config.sourceCorpusTokenFile,storageRoot:config.sourceStorageRoot}):null;
const adversarialService=new AdversarialService(pool,{discoveryService,verificationService,orchestrator,modelName:config.verificationModel});
const server = http.createServer({ requestTimeout: 120000, headersTimeout: 30000, maxHeaderSize: 16384 }, createHandler(repository, orchestrator, { operationLimits, preparePdfText: id => prepareProjectPdfText(pool,config.sourceStorageRoot,id), acquireSource, sourceStorageRoot: config.sourceStorageRoot, verificationService, discoveryService, corpusImportService, adversarialService, articleImportService:new ArticleImportService(repository,config), analysisService:new AnalysisService(pool), exportService:new ExportService(pool,config), readiness:async()=>({...await readiness(pool,config),usage:await operationLimits.usage()}), config }));
server.listen(config.port, config.host, () => console.log(`Research Workbench: http://${config.host}:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();
  server.close(() => {worker.release();pool.end().finally(() => process.exit(0));});
});
