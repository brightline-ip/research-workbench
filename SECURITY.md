# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (public preview) | Yes |

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub private security advisories** on this repository
("Security" tab, "Report a vulnerability"). Do not open a public issue for a suspected vulnerability. Include
the version, your configuration (without secret values), steps to reproduce and the impact you observed.

## What the tool trusts

- **The local machine and its users.** There is no login unless you set the optional `WORKBENCH_TOKEN` (a shared bearer token, also accepted as an HttpOnly cookie after `POST /api/session`); use it on shared machines. Anyone or any process that can reach the listening
  port can read all projects, start paid model operations and download stored files. The server binds to
  127.0.0.1 by default and refuses a non-loopback address unless `ALLOW_NONLOOPBACK_BIND=1`; Docker Compose
  publishes the port on 127.0.0.1 only. Exposing the port to a network is unsupported.
- **The PostgreSQL server and the storage folder.** Their contents are not encrypted by the tool.
- **The configured model provider (OpenAI, or your n8n gateway)** receives article text, claims and source
  passages. Model output is treated as untrusted data: it is schema-validated, quotations must match stored
  source text verbatim, and it is never executed.

## What the tool does not trust

- **Web pages, documents and source files.** Downloads are restricted to public addresses (private, loopback,
  link-local, shared, multicast and IPv4-mapped addresses are rejected, also after redirects and DNS
  changes), are size- and time-bounded, and stored originals are served back as sandboxed attachments.
  Document parsers run as subprocesses with time and output limits and without database or model credentials.
- **Browsers visiting other sites.** Requests need a loopback `Host` header, a same-origin or absent
  `Origin`, and `application/json` for JSON routes, which blocks cross-site request forgery and DNS
  rebinding against the local port.

- **URLs returned by the discovery model.** Query strings and fragments are stripped before fetching unless
  the host is on the trusted list (government, court, patent-office and a few publisher domains, extendable
  with `DISCOVERY_TRUSTED_HOSTS`). `DISCOVERY_REQUIRE_ACCEPTANCE=1` stops all automatic fetching of
  discovered URLs. This reduces, but does not remove, the chance that a prompt-injected passage causes a
  request carrying claim text to a host of the model's choosing (host and path are still model-chosen).
- **Operating-system temporary files.** Uploaded articles and report data are written to a private 0700
  directory with 0600 files for the duration of one parse or export, then removed.

## Local data

All projects, sources, reports and usage counters stay in your PostgreSQL database and storage folder. The
tool makes outbound requests only to the model provider you configure, to source websites during
acquisition and discovery, and, if you configure it, to a Get Files service. It sends no telemetry.

## Known limitations

- The n8n gateway option (extras/n8n) authenticates with a static, replayable header over plain HTTP on
  your local network. Keep n8n local.
- Prompt injection inside a source can influence model findings. Read the quoted evidence before relying on
  a result.
- Usage limits bound the number and size of model calls, not cost.
