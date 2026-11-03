# Changelog

## Unreleased

- Security review fixes: discovered URLs lose query strings/fragments unless the host is trusted, with an
  optional hold-for-review mode; optional `WORKBENCH_TOKEN` access token; private temporary directories for
  article import and report export; read-only container filesystem and database limits; encoding-aware DOCX
  entity guard (UTF-16/32 bypass); `npm run delete-project`.

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
- Offline test suite: 103 tests (99 pass and 4 skip without a Python document runtime; all 103 pass with it).

## 0.1.0 (license) — 2026-11-02

- Licensed under the PolyForm Noncommercial License 1.0.0 instead of Apache-2.0. Noncommercial use is free;
  commercial use requires a license from Brightline IP.
