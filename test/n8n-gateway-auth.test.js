import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/orchestrator.js';
import { DiscoveryService } from '../src/discovery.js';

test('n8n draft orchestration fails closed when its authentication header is absent', async () => {
  let called = false;
  const orchestrator = createOrchestrator({
    orchestrationMode: 'n8n',
    n8nWebhookUrl: 'http://gateway.invalid/draft',
    openaiModel: 'test-model',
  }, async () => { called = true; });
  await assert.rejects(() => orchestrator.draft({ topic: 't', instruction: 'i' }), /N8N_WEBHOOK_AUTH_HEADER/);
  assert.equal(called, false);
});

test('n8n draft orchestration sends the configured authentication header', async () => {
  let request;
  const orchestrator = createOrchestrator({
    orchestrationMode: 'n8n',
    n8nWebhookUrl: 'http://gateway.invalid/draft',
    n8nWebhookAuthHeader: 'Bearer test-only-value',
    openaiModel: 'test-model',
  }, async (url, options) => {
    request = { url, options };
    return Response.json({ result: null });
  });
  await assert.rejects(() => orchestrator.draft({ topic: 't', instruction: 'i' }));
  assert.equal(request.options.headers.authorization, 'Bearer test-only-value');
});

test('n8n discovery fails closed without authentication and sends it when configured', async () => {
  const assertion = { assertion_text: 'a', normalized_proposition: 'a' };
  const missing = new DiscoveryService(null, null, {
    gatewayUrl: 'http://gateway.invalid/discovery',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(() => missing.externalCandidates([assertion]), /N8N_WEBHOOK_AUTH_HEADER/);

  let sentHeader;
  const configured = new DiscoveryService(null, null, {
    gatewayUrl: 'http://gateway.invalid/discovery',
    authHeader: 'Bearer test-only-value',
    fetchImpl: async (_url, options) => {
      sentHeader = options.headers.authorization;
      return Response.json({ result: { candidates: [], coverage_notes: '' } });
    },
  });
  await configured.externalCandidates([assertion]);
  assert.equal(sentHeader, 'Bearer test-only-value');
});
