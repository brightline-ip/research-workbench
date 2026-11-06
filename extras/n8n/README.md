# Optional: n8n gateway mode

By default the workbench calls the OpenAI API directly with `OPENAI_API_KEY`. As an alternative you can
route all model calls through two webhooks on your own [n8n](https://n8n.io/) instance, so that the OpenAI
credential lives in n8n's encrypted credential store instead of the workbench environment.

`research-workbench-ai-gateway.json` is an importable n8n workflow (prepared for n8n 2.37) with:

- `POST /webhook/research-workbench-ai`: structured model calls (extraction, classification, verification,
  revision, red team, reconciliation). The Code node accepts only those operations, a fixed model allowlist (`gpt-5.4`, `gpt-5.4-mini`; edit it to match the models your account offers) and
  bodies under 1.8 MB.
- `POST /webhook/research-workbench-discovery`: primary-source discovery with OpenAI web search.
- Header authentication on both webhooks, no automatic retries, and execution data retention disabled for
  successful, failed and manual runs.
- A disabled paid fallback: an unreachable Fireworks node is kept for reference; every OpenAI failure fails
  closed.

The workflow has no credentials. After importing it:

1. Create an **OpenAI** credential in n8n with your API key and select it on the two OpenAI nodes.
2. Create a **Header Auth** credential (name `Authorization`, value for example `Bearer <long random value>`)
   and select it on both webhook nodes.
3. Review the model allowlist in the "Validate Gateway Request" Code node, then activate the workflow.
4. Set in the workbench `.env`:

   ```sh
   ORCHESTRATION_MODE=n8n
   N8N_DRAFT_WEBHOOK_URL=http://127.0.0.1:5678/webhook/research-workbench-ai
   N8N_DISCOVERY_WEBHOOK_URL=http://127.0.0.1:5678/webhook/research-workbench-discovery
   N8N_WEBHOOK_AUTH_HEADER=Bearer <the same long random value>
   ```

   From the Docker Compose app container, use `http://host.docker.internal:5678/...` instead.

Limits of this mode: the header is a static, replayable credential sent over plain HTTP, so keep n8n bound to
your own machine. The workbench's daily allowances do not restrict someone who calls the n8n webhook directly
with a stolen header. Costs are still billed to the OpenAI account behind the n8n credential.

The workflow's own tests run with `npm test` (`test/workflow-security.test.js`,
`test/gateway-fireworks.test.js`). The workflow was not imported into n8n for this release.
