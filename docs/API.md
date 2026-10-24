# HTTP API (version 0.1)

This is the JSON-over-HTTP contract the browser UI uses. A local client (for example a document
verification front end) can use it to submit a document, have its claims extracted and verified, and fetch
the results. Paths, field names and status codes below are the 0.1 contract; additive fields may appear in
later 0.x releases.

## Connection and trust boundary

- Base URL: `http://127.0.0.1:3080` (or `HOST`/`PORT`). There is **no authentication**. The API is for
  clients on the same machine only; never expose the port.
- Every request must carry a loopback `Host` header: `localhost`, `127.0.0.1` or `[::1]`, with any port.
  Other hosts get `403`. A client in another container must therefore reach the app through a published
  `127.0.0.1` port on the host and send `Host: 127.0.0.1:3080`; container service names such as `app:3080`
  are refused.
- If an `Origin` header is sent it must equal `http://<Host>`; a `Sec-Fetch-Site` of `cross-site` or
  `same-site` is refused. Non-browser clients normally send neither.
- JSON request bodies require `Content-Type: application/json`, must be a JSON object, and are limited to
  2 MB. File import bodies are raw bytes, limited to 25 MB.
- Responses are JSON (`application/json; charset=utf-8`) except file downloads.

## Long-running operations

Model-backed operations are **synchronous**: the response arrives when the work is finished, which can take
minutes (discovery up to `AI_DISCOVERY_TIMEOUT_MS`, default 45 minutes; other jobs `AI_JOB_TIMEOUT_MS`,
default 30 minutes). Use a client timeout longer than those limits.

These routes are AI operations and **require an `Idempotency-Key` header containing a UUID**:

| Route (POST) | Operation |
|---|---|
| `/api/projects/{id}/draft` | Draft an article from an instruction |
| `/api/projects/{id}/assertions` | Extract claims |
| `/api/projects/{id}/corpus-import` | Import a Get Files document |
| `/api/projects/{id}/discover` | Build the corpus (search + acquire) |
| `/api/projects/{id}/verify` | Verify claims |
| `/api/projects/{id}/adversarial` | Adversarial review |
| `/api/projects/{id}/revise` | Fix draft |
| `/api/projects/{id}/sources` | Register a source (may call the model to classify it) |

A key is recorded before any work starts and survives restarts. Re-sending an accepted key returns `409`
and does **not** run the operation again, even if the first attempt failed. If a response is lost (timeout,
disconnect), do not retry with a new key straight away: read the project (`GET /api/projects/{id}`) and
inspect the latest run's `status` (`RUNNING`, `COMPLETE`, `FAILED`). Use a new key only to start a new
operation deliberately.

Other limits:

- One mutating request per project at a time (`409` while one is running) and at most three projects at
  once (`429`).
- Daily and per-operation call/byte allowances (`AI_*` settings). Exhausted allowances fail with `429` or
  `503` and a message naming the limit; no model call is made.
- New mutations are refused with `503` when free storage is below `MIN_FREE_STORAGE_BYTES`.
- No automatic retries are made against the model provider.

## Errors

Every error response is `{"error": "<controlled message>", "request_id": "<uuid>"}` (`request_id` is
present for errors raised during processing). Raw exception, provider or database text is never returned.

| Status | Meaning |
|---|---|
| 400 | Missing/invalid field, malformed JSON, missing or malformed `Idempotency-Key` |
| 403 | Non-loopback `Host`, foreign `Origin`, cross-site request |
| 404 | Project, article version, source or artifact not found |
| 409 | Operation already running for the project; idempotency key already used; state conflict (for example claims already extracted with a different scope, or verification requested before extraction) |
| 413 | Body too large, or a single AI request exceeds the supported input size |
| 415 | Wrong content type, or unsupported import file type |
| 422 | Model output failed validation, or an import was rejected |
| 429 | Busy (three active projects) or an AI allowance is exhausted |
| 500 | Unexpected failure. Check the project's run records before retrying |
| 503 | Feature not configured (for example discovery or Get Files), provider unavailable, low storage |

## Typical verification flow

```text
POST /api/projects                                  -> project_id
POST /api/projects/{id}/checkpoint   (or /import)   -> article_version_id
POST /api/projects/{id}/assertions   [Idempotency-Key]
POST /api/projects/{id}/assertions-review           (optional: correct or exclude claims)
POST /api/projects/{id}/discover     [Idempotency-Key]  and/or /sources, /corpus-import
POST /api/projects/{id}/verify       [Idempotency-Key]  -> verification_run_id, results
GET  /api/projects/{id}                             -> full workspace with results
POST /api/projects/{id}/exports                     -> artifact; GET .../artifacts/{artifact_id}/download
```

Claims are always extracted by the model from a checkpoint; there is no route that accepts a caller's own
claim list. A caller can correct the extracted claims, or exclude them from verification, with
`assertions-review` before discovery or verification.

## Readiness

`GET /api/readiness` returns
`{"status": "READY" | "SETUP_REQUIRED" | "BLOCKED", "checks": [{"name", "status", "detail"}], "usage": {...}, "timestamp"}`.
Check names: `database`, `source_storage`, `project_storage`, `draft_model`, `autonomous_discovery`,
`docx_pdf_exports`, `xlsx_exports`. `usage` reports today's model calls and input bytes against the limits.
No secret values are returned.

## Projects

`GET /api/projects` lists projects (array of project rows).

`POST /api/projects` with `{"title": "...", "topic": "..."}` (`title` required) returns `201` and the
project, including `project_id`.

`GET /api/projects/{id}` returns the workspace for the **latest** article version:

```json
{
  "project": {"project_id": "...", "title": "...", "status": "..."},
  "articles": [{"article_version_id": "...", "version_number": 2, "title": "...", "content_markdown": "...", "import_metadata": {}}],
  "assertions": [{"assertion_id": "...", "article_version_id": "...", "block_index": 0, "start_offset": 0, "end_offset": 42,
                  "evidence_span": "...", "assertion_text": "...", "normalized_proposition": "...", "assertion_class": "QUANTITATIVE",
                  "load_bearing": true, "citation_as_written": null, "source_required": true, "primary_source_required": true,
                  "verification_scope": "EXTERNAL"}],
  "assertion_extraction": {"extraction_run_id": "...", "status": "COMPLETE", "coverage_complete": true},
  "sources": [{"source_id": "...", "canonical_url": "...", "title": "...", "source_type": "...", "retrieval_status": "NORMALIZED",
               "content_hash": "<sha256>", "membership_status": "ACCEPTED"}],
  "discovery_run": null, "corpus_snapshot": null,
  "verification_run": {"verification_run_id": "...", "status": "COMPLETE", "mode": "AUTHOR_CORPUS", "corpus_snapshot_id": "..."},
  "verification_results": [{"verification_result_id": "...", "assertion_id": "...", "status": "VERIFIED",
                            "assertion_as_made": "...", "source_actually_establishes": "...", "material_gap": "...",
                            "extracted_passage": "...", "pin_cite": "...", "defect_codes": [], "confidence": 0.9,
                            "recommended_remediation": "...", "source_id": "...", "source_title": "...", "locator": "...", "passage_text": "..."}],
  "adversarial_run": null, "adversarial_comparisons": [], "red_team_run": null, "red_team_findings": [], "reconciliation_run": null,
  "revision_run": null,
  "artifacts": [{"artifact_id": "...", "artifact_type": "PDF_EXPORT", "title": "...", "mime_type": "application/pdf"}]
}
```

Rows carry additional columns (timestamps, provenance, run metadata); clients should ignore unknown fields.
`verification_results` holds the latest `AUTHOR_CORPUS` run for the latest article version.

Verification `status` values: `VERIFIED`, `OVERSTATED`, `MISCITED`, `UNSUPPORTED`, `CONTRADICTED`, `STALE`,
`UNVERIFIABLE`, `FABRICATED`, `NOT_APPLICABLE`. `NOT_APPLICABLE` means no external check was requested for
that claim; it is neither a defect nor proof of truth.

## Article versions

`POST /api/projects/{id}/checkpoint` with
`{"title": "...", "content_markdown": "...", "change_summary": "...", "source_content_sha256": "<optional sha256 of content_markdown>"}`
returns `201` and the new article version (`article_version_id`, `version_number`). Versions are immutable.
An optional `Idempotency-Key` (UUID v1-v5) makes the save replay-safe: the same key with the same content
returns the original version; the same key with different content returns `409`.

`POST /api/projects/{id}/import?filename=<name>` with the raw file bytes as the body (any content type)
imports `.docx`, `.pdf`, `.md`, `.markdown` or `.txt` and returns `201`
`{"version": {...article version...}, "import": {"filename", "format", "byte_length", "content_hash"}}`. DOCX/PDF need the
Python document runtime. Extraction warnings (for example image-only pages, notes) are kept in the
version's `import_metadata`.

## Claims

`POST /api/projects/{id}/assertions` `[Idempotency-Key]` with
`{"article_version_id": "...", "scope": {"instruction": "...", "include_sections": [], "exclude_sections": [], "include_block_indexes": [], "exclude_block_indexes": []}}`
(`scope` optional) returns `201` `{"run": {...}, "assertions": [...], "reused": false}`. Extraction runs once
per article version; repeating it with the same scope returns the stored result with `"reused": true`, a
different scope returns `409` (save a new checkpoint instead).

`POST /api/projects/{id}/assertions-review` with
`{"article_version_id": "...", "decisions": [{"assertion_id": "...", "verification_scope": "EXTERNAL" | "EXCLUDED", "reason": "...", "assertion_text": "...", "normalized_proposition": "...", "assertion_class": "...", "citation_as_written": "...", "source_required": true, "primary_source_required": false}]}`
(`assertion_id`, `verification_scope` and `reason` required; the rest are optional corrections) returns
`200`. `EXCLUDED` claims are skipped by discovery and recorded as `NOT_APPLICABLE` by verification. Review is
refused once a corpus snapshot or verification run exists for that version. Every decision is kept with its
before/after values.

## Sources and corpus

`POST /api/projects/{id}/discovery-estimate` with `{"article_version_id": "...", "policy": {...}}` returns
`200` with the planned query count and runtime estimate, without calling a model.

`POST /api/projects/{id}/discover` `[Idempotency-Key]` with `{"article_version_id": "...", "policy": {"mode": "AUTHOR_CORPUS", "max_external_queries": 40, "excluded_source_urls": []}}`
searches the local warehouse first, then the web (OpenAI web search, or the n8n discovery gateway), acquires
candidates and seals a corpus snapshot. Returns `201` with the discovery run and snapshot. External queries are
capped at 40. Returns `503` when discovery is not configured.

`POST /api/projects/{id}/sources` `[Idempotency-Key]` registers a source:
`{"canonical_url": "https://...", "title": "...", "source_type": "WEB_PAGE", "issuing_authority": "...", "jurisdiction": "...", "publication_date": "...", "version_label": "...", "assertion_id": "...", "relationship_type": "SUPPORTS" | "QUALIFIES" | "CONTRADICTS" | "BACKGROUND", "proposition_source_class": "PRIMARY" | "SECONDARY" | ..., "classification_reason": "..."}`.
Only `canonical_url` is required. With `assertion_id` and no `proposition_source_class`, the model classifies
the source for that claim. `source_type` is one of `STATUTE`, `REGULATION`, `JUDICIAL_OPINION`,
`AGENCY_DOCUMENT`, `GOVERNMENT_DATASET`, `PATENT`, `SEC_FILING`, `ACADEMIC`, `NEWS`, `WEB_PAGE`, `OTHER`.

`POST /api/projects/{id}/sources/{source_id}/acquire` downloads a registered source (public addresses
only, size/time limited) and returns `201`.

`POST /api/projects/{id}/normalize-sources` extracts text from stored PDFs that have none yet (no refetch).

`POST /api/projects/{id}/corpus-import` `[Idempotency-Key]` imports an exact document from a configured Get
Files service: `{"collection": "legal", "document_id": "<64-hex sha256 of the original>", "source_type": "JUDICIAL_OPINION", "assertion_links": [{"assertion_id": "...", "relationship_type": "SUPPORTS", "proposition_source_class": "PRIMARY", "classification_reason": "..."}], "allow_incomplete": false}`.
The server fetches the original and normalized text itself, checks the original's hash against
`document_id`, and accepts no file paths. 1-500 explicit links are required. Documents not marked `ready` are
refused unless `allow_incomplete` is true. Returns `503` when Get Files is not configured.

`GET /api/projects/{id}/sources/{source_id}/original` and `.../normalized` download the stored original or
normalized text as a sandboxed attachment.

## Verification

`POST /api/projects/{id}/verify` `[Idempotency-Key]` with
`{"article_version_id": "...", "mode": "AUTHOR_CORPUS", "corpus_snapshot_id": "<optional>"}`
seals (or reuses) a corpus snapshot, checks every evidence file's hash, then verifies each claim against
retrieved passages. Returns `201` `{"run": {...}, "results": [...]}` with the fields shown above. Returns
`409` if claims were not extracted first. Evidence that changed or disappeared fails the run before any model
call. `mode` is `AUTHOR_CORPUS` (default) or `INDEPENDENT_DISCOVERY`.

`POST /api/projects/{id}/adversarial` `[Idempotency-Key]` with
`{"article_version_id": "...", "author_verification_run_id": "..."}` runs independent discovery and
verification, compares the runs, adds a red-team challenge and a reconciliation. Resume an interrupted run
with `{"adversarial_run_id": "..."}`. Results appear in the workspace (`adversarial_*`, `red_team_*`,
`reconciliation_run`).

`POST /api/projects/{id}/revise` `[Idempotency-Key]` with
`{"article_version_id": "...", "verification_run_id": "...", "instruction": "<optional>"}` creates a revised
article version with an issue-by-issue audit and returns `201` `{"run": {...}, "version": {...}}`. The new
version must be extracted and verified again.

## Reports

`POST /api/projects/{id}/exports` with
`{"article_version_id": "...", "verification_run_id": "...", "format": "csv" | "xlsx" | "docx" | "pdf", "scope": "attention" | "all"}`
returns `201` with the artifact record (`artifact_id`). `attention` (default) includes only findings that need
action; DOCX/PDF `attention` reports list at most 20 findings and record how many were omitted. XLSX/DOCX/PDF
need the Python document runtime. CSV cells that begin with a formula character are prefixed with `'`.

`GET /api/projects/{id}/artifacts/{artifact_id}/download` downloads the file as an attachment.

## Datasets (deterministic analysis)

`POST /api/projects/{id}/datasets` with `{"title": "...", "records": [...]}` stores a dataset;
`POST /api/projects/{id}/datasets/{dataset_id}/analysis` runs a deterministic analysis on it. No model is
called.

## Example (curl)

```sh
B=http://127.0.0.1:3080
P=$(curl -s -H 'content-type: application/json' -d '{"title":"Demo"}' $B/api/projects | jq -r .project_id)
V=$(curl -s -X POST --data-binary @article.md "$B/api/projects/$P/import?filename=article.md" | jq -r .version.article_version_id)
curl -s -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" -d "{\"article_version_id\":\"$V\"}" $B/api/projects/$P/assertions >/dev/null
curl -s -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" -d "{\"article_version_id\":\"$V\"}" $B/api/projects/$P/discover >/dev/null
curl -s -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" -d "{\"article_version_id\":\"$V\"}" $B/api/projects/$P/verify | jq '.results[] | {status, assertion_as_made, pin_cite}'
```
