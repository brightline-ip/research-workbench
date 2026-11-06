# Changelog

## 0.1.0 (quotes and named sources) - 2026-11-06

- A quotation in a claim is checked word for word in code against the qualifying sources. A quotation found in none of them is
  recorded as `QUOTE_NOT_IN_SOURCES`, and a model's `VERIFIED` becomes `MISCITED`.
- `VERIFIED` needs a quoted passage of at least 8 words or 40 characters.
- Fix draft leaves claims where nothing was compared as written. They are gaps in the check, not findings.
- `corpus-import` takes `local_source` for a file with no web address. Web discovery never reuses such a file.
- A provider rejection records the provider's error code (for example `HTTP 429: credit_balance_exhausted`), never its message.
- HTML sources decode more entities, including section signs and curly quotes.

## Unreleased

- Security review fixes: discovered URLs lose query strings/fragments unless the host is trusted, with an
  optional hold-for-review mode; optional `WORKBENCH_TOKEN` access token; private temporary directories for
  article import and report export; read-only container filesystem and database limits; encoding-aware DOCX
  entity guard (UTF-16/32 bypass); `npm run delete-project`.
- Provider failures reported honestly: outages stop verification and mark the run FAILED; older stored outages
  display as NOT_CHECKED; 503 for temporary and 500 for permanent failures; unreadable source text is left out of
  sealed snapshots; gzip without a header is decompressed on new downloads.
- **Statuses no longer claim what was not checked.** A claim with no eligible passage is now UNVERIFIABLE with a
  `not_checked_reason` and a gap beginning "Nothing was checked". It used to read UNSUPPORTED. UNSUPPORTED now comes
  only from a model that examined passages, and says how many. `assertions_attempted` counts only claims whose
  passages reached the model. Results record `candidate_passage_ids` and `candidate_passage_count`. Requires migration 016.
- Results from older runs read honestly: a claim saved as UNSUPPORTED or UNVERIFIABLE with nothing compared now shows as
  UNVERIFIABLE with `not_checked_reason` `OLDER_RUN` in the workspace API, page, exports and comparisons, and goes to
  Fix draft as nothing checked. Stored rows are unchanged. Older raw failure text is reduced to fixed wording on read.
- Storage works where hard links are unavailable (exFAT, FAT, some SMB and 9p mounts), through a checked rename.
- `npm run delete-project` keeps a source that another project's discovery candidate, access attempt or replacement
  source refers to. Source versions lose their trigger protection only for a source the named project refers to.
- Failed, blocked and held discovered sources are recorded: `source_failures` on the discover response,
  `discovery_failures` in the workspace, `evidence_gaps` on the verification run, and NOT USED in the page. Short pages
  with typical login or access wording are left out of the snapshot as suspected walls.
- A 200 reply that is empty, refused, incomplete or not JSON is a provider failure and stops the run. An invalid
  quotation in a valid reply stays per-claim.
- Direct mode now sends the "untrusted data" rule with extraction, verification, classification and review, and sends
  `scope.instruction` to the model. It was accepted and ignored before.
- Normalized text imported from Get Files is compared with its manifest hash at import and with its own hash at sealing.
- `npm run delete-project` now works on a verified project: it removes sealed evidence and any source no other project
  uses, with their files. Immutability triggers stay in force for every other project.
- Results and exports show whether PRIMARY or SECONDARY came from a model or a caller (`source_class_assigned_by`).
- Compose always uses the image's document runtime, and `.env.example` no longer blanks `ARTIFACT_PYTHON`.
- Storage writes are atomic and check an existing file's hash; a failed export leaves no partial file; cleanup errors
  no longer hide the real error; `scripts/corpus.mjs` sends `WORKBENCH_TOKEN`; launchers read the right port;
  a private model name was removed from the n8n extra's allowlist.
- Offline test suite: 157 tests (148 pass and 9 skip with no document runtime or test database; all 157 pass with both).

## 0.1.0 — 2026-10-23

First public preview.

- Article import (DOCX, PDF, Markdown, text) into immutable checkpoints; atomic claim extraction bound to
  exact article spans; claim scope review.
- Warehouse-first source discovery, controlled source acquisition with content-addressed storage, and
  passage-level verification against sealed corpus snapshots.
- Adversarial review (independent discovery, red team, reconciliation) and evidence-guided Fix draft with a
  complete issue audit.
- CSV, XLSX, DOCX and PDF reports.
- Direct OpenAI mode, including source discovery through OpenAI web search; optional n8n gateway mode
  (extras/n8n).
- Optional import from, and export to, a separately installed Get Files service over HTTP.
- Docker Compose setup (PostgreSQL + app, loopback-only) and a no-Docker path (`npm run migrate`, `npm start`).
- Startup refuses to run without a model credential or on a non-loopback address unless explicitly allowed.
- Offline test suite at that date: 103 tests (99 pass and 4 skip without a Python document runtime; all 103 pass with it).

## 0.1.0 (license) — 2026-11-02

- Licensed under the PolyForm Noncommercial License 1.0.0 instead of Apache-2.0. Noncommercial use is free;
  commercial use requires a license from Brightline IP.
