// Startup checks that run before the workbench connects to anything. Messages name settings,
// never their values.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase());
}

export function startupProblems(config) {
  const problems = [];
  if (!['openai', 'n8n'].includes(config.orchestrationMode)) {
    problems.push(`ORCHESTRATION_MODE must be "openai" or "n8n" (got an unsupported value).`);
  } else if (config.orchestrationMode === 'openai' && !config.openaiApiKey) {
    problems.push('OPENAI_API_KEY is not set. The workbench sends article text and source passages to the OpenAI API, billed to your own key. Create a key at https://platform.openai.com/api-keys and set it in .env (see .env.example).');
  } else if (config.orchestrationMode === 'n8n') {
    if (!config.n8nWebhookUrl) problems.push('ORCHESTRATION_MODE=n8n requires N8N_DRAFT_WEBHOOK_URL (see extras/n8n/README.md).');
    if (!config.n8nWebhookAuthHeader) problems.push('ORCHESTRATION_MODE=n8n requires N8N_WEBHOOK_AUTH_HEADER.');
  }
  if (!isLoopbackHost(config.host) && !config.allowNonLoopbackBind) {
    problems.push('HOST is not a loopback address. The workbench has no user login, so it must listen on 127.0.0.1 only. Inside a container whose published port is restricted to 127.0.0.1, set ALLOW_NONLOOPBACK_BIND=1.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push('PORT must be an integer between 1 and 65535.');
  if (Boolean(config.sourceCorpusUrl) !== Boolean(config.sourceCorpusToken || config.sourceCorpusTokenFile)) {
    problems.push('Source Corpus import needs both SOURCE_CORPUS_URL and SOURCE_CORPUS_TOKEN (or SOURCE_CORPUS_TOKEN_FILE). Leave all of them empty to disable it.');
  }
  if (config.workbenchToken && config.workbenchToken.length < 16) problems.push('WORKBENCH_TOKEN must be at least 16 characters (for example 48 random hex characters).');
  return problems;
}
