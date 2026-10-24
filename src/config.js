import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRUSTED_HOSTS, parseTrustedHosts } from './discovery-urls.js';

const installRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = env => path.resolve(env.WORKBENCH_DATA_DIR || path.join(installRoot, 'storage'));

export function loadConfig(env = process.env) {
  return {
    operationLimits:{dailyCalls:Number(env.AI_DAILY_CALL_LIMIT||500),dailyInputBytes:Number(env.AI_DAILY_INPUT_BYTES||33554432),jobCalls:Number(env.AI_JOB_CALL_LIMIT||400),jobMilliseconds:Number(env.AI_JOB_TIMEOUT_MS||1800000),operationMilliseconds:{discover:Number(env.AI_DISCOVERY_TIMEOUT_MS||2700000)},minFreeBytes:Number(env.MIN_FREE_STORAGE_BYTES||536870912)},
    host: env.HOST || '127.0.0.1',
    allowNonLoopbackBind: env.ALLOW_NONLOOPBACK_BIND === '1',
    port: Number(env.PORT || 3080),
    databaseUrl: env.DATABASE_URL || null,
    pg: env.DATABASE_URL ? undefined : {
      host: env.PGHOST,
      port: env.PGPORT ? Number(env.PGPORT) : 5432,
      database: env.PGDATABASE || 'research_workbench',
      user: env.PGUSER,
      password: env.PGPASSWORD,
    },
    orchestrationMode: (env.ORCHESTRATION_MODE || 'openai').trim().toLowerCase(),
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || 'gpt-5.4',
    claimExtractionModel: env.CLAIM_EXTRACTION_MODEL || env.OPENAI_MODEL || 'gpt-5.4',
    verificationConcurrency: Math.max(1, Math.min(8, Math.floor(Number(env.VERIFICATION_CONCURRENCY) || 3))),
    verificationModel: env.VERIFICATION_MODEL || env.OPENAI_MODEL || 'gpt-5.4',
    discoveryModel: env.DISCOVERY_MODEL || 'gpt-5.4-mini',
    revisionModel: env.REVISION_MODEL || env.OPENAI_MODEL || 'gpt-5.4',
    n8nWebhookUrl: env.N8N_DRAFT_WEBHOOK_URL,
    n8nDiscoveryWebhookUrl: env.N8N_DISCOVERY_WEBHOOK_URL,
    n8nWebhookAuthHeader: env.N8N_WEBHOOK_AUTH_HEADER,
    // Optional Get Files service. GET_FILES_* names (used by the Get Files client) are accepted as aliases.
    sourceCorpusUrl: env.SOURCE_CORPUS_URL || env.GET_FILES_URL || null,
    sourceCorpusToken: env.SOURCE_CORPUS_TOKEN || env.GET_FILES_TOKEN || null,
    sourceCorpusTokenFile: env.SOURCE_CORPUS_TOKEN_FILE || env.GET_FILES_TOKEN_FILE || null,
    // WORKBENCH_DATA_DIR sets both storage roots at once; the specific settings override it.
    sourceStorageRoot: env.SOURCE_STORAGE_ROOT || path.join(dataDir(env), 'sources'),
    projectStorageRoot: env.PROJECT_STORAGE_ROOT || path.join(dataDir(env), 'projects'),
    artifactPython: env.ARTIFACT_PYTHON || null,
    // Discovery hardening: model-proposed URLs lose query strings/fragments unless the host is trusted.
    discoveryTrustedHosts: [...DEFAULT_TRUSTED_HOSTS, ...parseTrustedHosts(env.DISCOVERY_TRUSTED_HOSTS)],
    discoveryRequireAcceptance: env.DISCOVERY_REQUIRE_ACCEPTANCE === '1',
    workbenchToken: env.WORKBENCH_TOKEN || null,
  };
}
