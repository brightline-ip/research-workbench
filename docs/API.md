# HTTP API (version 0.1)

This is the JSON-over-HTTP contract the browser UI uses. A local client (for example a document
verification front end) can use it to submit a document, have its claims extracted and verified, and fetch
the results. Paths, field names and status codes below are the 0.1 contract; additive fields may appear in
later 0.x releases.

## Connection and trust boundary

- Base URL: `http://127.0.0.1:3080` (or `HOST`/`PORT`). The API is for clients on the same machine only; never
  expose the port. There is no authentication unless `WORKBENCH_TOKEN` is set. Then every `/api/` route needs
  `Authorization: Bearer <token>` (or the cookie `POST /api/session` sets for the page), and a request without it
  gets `401` with `{"error": "...", "auth_required": true}`.
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
present for errors raised during processing). Error bodies never carry raw exception, provider or database text.
Run records hold more: `error_message` on a run in the workspace is that run's failure message (a controlled
provider reason or a validation message, but an unexpected internal error keeps its exception text), and the
`material_gap` of an `INVALID_MODEL_REPLY` result names the validation that failed. No model reply text is stored
in either.

| Status | Meaning |
|---|---|
| 400 | Missing/invalid field, malformed JSON, missing or malformed `Idempotency-Key` |
| 403 | Non-loopback `Host`, foreign `Origin`, cross-site request |
| 404 | Project, article version, source or artifact not found |
| 409 | Operation already running for the project; idempotency key already used; state conflict (for example claims already extracted with a different scope, or verification requested before extraction) |
| 413 | Body too large, or a single AI request exceeds the supported input size |
| 415 | Wrong content type, or unsupported import file type |
| 422 | An import was rejected (no readable text, or the Get Files document was refused) |
| 429 | Busy (three active projects) or an AI allowance is exhausted |
| 500 | Unexpected failure, a provider rejection retrying cannot fix (bad key, missing model), or model output that failed validation during extraction (for example a claim span not found in the article; see `assertion_extraction.status` and `error_message`). Check the project's run records before retrying |
| 503 | Feature not configured (for example discovery or Get Files), provider unavailable or its reply unusable (empty, refused, incomplete or not JSON), low storage |

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
  "assertion_extraction": {"extraction_run_id": "...", "status": "COMPLETE", "coverage_complete": true, "coverage_notes": "..."},
  "sources": [{"source_id": "...", "canonical_url": "...", "title": "...", "source_type": "...", "retrieval_status": "NORMALIZED",
               "content_hash": "<sha256>", "membership_status": "ACCEPTED"}],
  "discovery_run": {"discovery_run_id": "...", "status": "COMPLETE", "source_failures": 1},
  "discovery_failures": [{"candidate_url": "https://...", "candidate_title": "...", "disposition": "ACQUISITION_FAILED", "reason": "Source returned HTTP 403", "assertion_ids": ["..."]}],
  "corpus_snapshot": null,
  "verification_run": {"verification_run_id": "...", "status": "COMPLETE", "mode": "AUTHOR_CORPUS", "corpus_snapshot_id": "...",
                       "assertions_attempted": 3, "assertions_not_attempted": 1, "source_acquisition_failures": 1,
                       "evidence_gaps": {"discovery_failures": [], "excluded_sources": [{"source_id": "...", "canonical_url": "...", "title": "...", "reason": "SUSPECTED_ACCESS_WALL"}], "not_checked": {"SOURCES_UNAVAILABLE": 1}}},
  "verification_results": [{"verification_result_id": "...", "assertion_id": "...", "status": "VERIFIED",
                            "assertion_as_made": "...", "source_actually_establishes": "...", "material_gap": "...",
                            "extracted_passage": "...", "pin_cite": "...", "defect_codes": [], "confidence": 0.9,
                            "recommended_remediation": "...", "source_id": "...", "source_title": "...", "locator": "...", "passage_text": "...",
                            "candidate_passage_ids": ["..."], "candidate_passage_count": 3, "not_checked_reason": null,
                            "source_class": "PRIMARY", "source_class_assigned_by": "MODEL"}],
  "adversarial_run": null, "adversarial_comparisons": [], "red_team_run": null, "red_team_findings": [], "reconciliation_run": null,
  "revision_run": null,
  "artifacts": [{"artifact_id": "...", "artifact_type": "PDF_EXPORT", "title": "...", "mime_type": "application/pdf"}]
}
```

Rows carry additional columns (timestamps, provenance, run metadata); clients should ignore unknown fields.
`verification_results` holds the latest `AUTHOR_CORPUS` run for the latest article version.

Verification `status` values: `VERIFIED`, `OVERSTATED`, `MISCITED`, `UNSUPPORTED`, `CONTRADICTED`, `STALE`,
`UNVERIFIABLE`, `FABRICATED`, `NOT_APPLICABLE`. `NOT_APPLICABLE` means no external check was requested for
that claim; it is neither a defect nor proof of truth. The README section "What each status means" defines them.

- A run being `COMPLETE` does not mean anything was compared. `assertions_attempted` counts only claims whose
  passages went to the model.
- `candidate_passage_ids` and `candidate_passage_count` record what was sent to the model for this claim; `null`
  on results from before migration 016.
- `not_checked_reason` is `null` when the model's verdict stands, otherwise `NO_SOURCES`, `NO_ELIGIBLE_SOURCE`,
  `SOURCES_UNAVAILABLE`, `NO_MATCHING_PASSAGE` (status `UNVERIFIABLE`, count 0: nothing was compared) or
  `INVALID_MODEL_REPLY` (status `UNVERIFIABLE`, count above 0: passages were sent but the reply failed validation).
- `UNSUPPORTED` now only comes from a model that examined passages, and its `material_gap` begins
  `Not found in the N passages retrieved`.
- Older runs saved a claim with nothing to compare as `UNSUPPORTED` or `UNVERIFIABLE` in fixed wording. The workspace
  returns those rows as `UNVERIFIABLE` with `not_checked_reason` `OLDER_RUN` and `original_status`, and older provider
  outages as `NOT_CHECKED`. A comparison that relied on such a row is worked out again and keeps the saved value in
  `stored_comparison_status`. Stored rows are unchanged, and `status_counts`, `assertions_attempted` and
  `assertions.verification_state` stay as saved. On a run whose results have a `null` `candidate_passage_count`,
  `assertions_attempted` counted every claim that needed a source, not claims that reached the model.
- `discovery_failures` and `source_failures` give each `reason` in fixed wording, including for rows that hold older
  raw error text. An `excluded_sources` entry with `SUSPECTED_ACCESS_WALL` lists the `matched_phrases`.
- `source_class` and `source_class_assigned_by` (`MODEL`, `CALLER`, `DEFAULT`, `UNKNOWN`) describe the source of the
  passage the result relies on; both are `null` when there is none.
- `coverage_complete` is the extraction model's own statement. When `false`, claims may be missing from the ledger;
  `coverage_notes` holds its reason. A caller should report it.

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
(`scope` optional) returns `201` `{"run": {...}, "assertions": [...], "reused": false}`.
`scope.instruction` (at most 2000 characters) and the section names are sent to the model as the caller's
direction, in both provider modes, so they guide extraction but are not a mechanical filter. Only
`include_block_indexes` and `exclude_block_indexes` select text mechanically: those blocks alone are sent. Extraction runs once
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
candidates and seals a corpus snapshot. Returns `201` `{"run": {...}, "snapshot": {...}, "source_failures": [...]}`.
`source_failures` lists each candidate not used, with `candidate_url` (`null` if the address failed screening),
`candidate_title`, `disposition` (`ACQUISITION_FAILED` or `HUMAN_REVIEW`), a fixed-wording `reason` and
`assertion_ids`. A failed source does not fail the run; claims that depended on it become `UNVERIFIABLE`. External
queries are capped at 40; groups beyond the cap are noted in the run's `coverage_notes`. Returns `503` when
discovery is not configured.

`POST /api/projects/{id}/sources` `[Idempotency-Key]` registers a source:
`{"canonical_url": "https://...", "title": "...", "source_type": "WEB_PAGE", "issuing_authority": "...", "jurisdiction": "...", "publication_date": "...", "version_label": "...", "assertion_id": "...", "relationship_type": "SUPPORTS" | "QUALIFIES" | "CONTRADICTS" | "BACKGROUND", "proposition_source_class": "PRIMARY" | "SECONDARY" | ..., "classification_reason": "..."}`.
Only `canonical_url` is required. With `assertion_id` and no `proposition_source_class`, the model classifies
the source for that claim and the link is recorded as assigned by `MODEL`; a class you supply is recorded as `CALLER`. `source_type` is one of `STATUTE`, `REGULATION`, `JUDICIAL_OPINION`,
`AGENCY_DOCUMENT`, `GOVERNMENT_DATASET`, `PATENT`, `SEC_FILING`, `ACADEMIC`, `NEWS`, `WEB_PAGE`, `OTHER`.

`POST /api/projects/{id}/sources/{source_id}/acquire` downloads a registered source (public addresses
only, size/time limited) and returns `201`.

`POST /api/projects/{id}/normalize-sources` extracts text from stored PDFs that have none yet (no refetch).

`POST /api/projects/{id}/corpus-import` `[Idempotency-Key]` imports an exact document from a configured Get
Files service: `{"collection": "legal", "document_id": "<64-hex sha256 of the original>", "source_type": "JUDICIAL_OPINION", "assertion_links": [{"assertion_id": "...", "relationship_type": "SUPPORTS", "proposition_source_class": "PRIMARY", "classification_reason": "..."}], "allow_incomplete": false}`.
The server fetches the original and normalized text itself, checks the original's hash against `document_id`
and the normalized text's hash against `manifest.normalized_sha256` when the service supplies it (a mismatch is
`409`, even with `allow_incomplete`), and accepts no file paths. Links are recorded as assigned by `CALLER`. 1-500 explicit links are required. Documents not marked `ready` are
refused unless `allow_incomplete` is true. Returns `503` when Get Files is not configured.

`GET /api/projects/{id}/sources/{source_id}/original` and `.../normalized` download the stored original or
normalized text as a sandboxed attachment.

## Verification

`POST /api/projects/{id}/verify` `[Idempotency-Key]` with
`{"article_version_id": "...", "mode": "AUTHOR_CORPUS", "corpus_snapshot_id": "<optional>"}`
seals (or reuses) a corpus snapshot, checks every evidence file's hash, then verifies each claim against
retrieved passages. Returns `201` `{"run": {...}, "results": [...]}` with the fields shown above. Returns
`409` if claims were not extracted first. Stored originals or normalized text that changed fail with `409` before
any model call, and files that disappeared fail with `500`, also before any model call. `mode` is `AUTHOR_CORPUS` (default) or `INDEPENDENT_DISCOVERY`.

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
action; DOCX/PDF `attention` reports list at most 20 findings and record how many were omitted. CSV and XLSX carry
`not_checked_reason`, the passage count, `source_class` and who assigned it; DOCX/PDF full ledgers name the class
and its origin and note incomplete extraction coverage and unused sources. XLSX/DOCX/PDF
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
