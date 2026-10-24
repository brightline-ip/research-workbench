# Operations: limits, backup and restore

## AI usage limits

The server checks these admission limits before every model call:

| Variable | Default | Meaning |
|---|---:|---|
| `AI_DAILY_CALL_LIMIT` | 500 | Model requests accepted per UTC day across the workbench |
| `AI_DAILY_INPUT_BYTES` | 33554432 | Total serialized request bytes per UTC day |
| `AI_JOB_CALL_LIMIT` | 400 | Model requests per HTTP operation, including nested discovery/review |
| `AI_JOB_TIMEOUT_MS` | 1800000 | Stop dispatching new calls after 30 minutes |
| `AI_DISCOVERY_TIMEOUT_MS` | 2700000 | The same, for discovery |
| `MIN_FREE_STORAGE_BYTES` | 536870912 | Refuse new mutations below 512 MB free in either storage root |

A call is charged in PostgreSQL before it is sent. A failed, cancelled or uncertain request stays charged,
and no automatic retry is made. The counters survive restarts. A request already in flight may finish after
the operation deadline (each provider request has a 310-second timeout). These limits bound volume, not
money: set a budget with your model provider as well.

AI routes require a UUID `Idempotency-Key`; the browser handles this. Replaying an accepted key returns 409
and does not execute again. After an interrupted operation, reload the project and inspect the run status.
At startup the app marks runs that were left `RUNNING` as `FAILED` and keeps their partial records.

## Backup

Database and files must be backed up together: verification records reference stored source files by hash
and path. `scripts/backup_restore.py` takes a consistent backup of both. It needs Python 3 and the
PostgreSQL 16 client tools (`pg_dump`, `pg_restore`, `psql`); `extras/backup/Dockerfile.operations` builds
a small image with them:

```sh
docker build -f extras/backup/Dockerfile.operations -t research-workbench-ops:0.1.0 .
```

Supply the connection through libpq variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` or `PGPASSFILE`) in the environment; never put passwords in command arguments.

Stop the app first: the utility refuses to run while the app's worker lock or the migration lock is held.
Then:

```text
python3 scripts/backup_restore.py backup --sources <data>/sources --projects <data>/projects --directory <new-backup-folder>
python3 scripts/backup_restore.py validate --directory <new-backup-folder>
```

The destination must be new and must not overlap the storage roots. A custom-format `pg_dump` and both file
trees are covered by a SHA-256 manifest written last; a missing manifest, a hash mismatch, an extra or missing
file, or a symlink makes validation fail. A manifest detects corruption, not deliberate replacement of both
files and hashes, so keep backups in trusted custody.

Backups contain your research and are **not encrypted** by this utility. Store them on an encrypted,
access-controlled disk and keep an independent copy. Your `.env` and API keys are not included.

With Docker Compose, the data is in the `pgdata` and `workbench-data` volumes. Stop the app
(`docker compose stop app`), run the utility in a container attached to the `backend` network with the
`workbench-data` volume mounted read-only and a backup folder mounted read-write.

## Restore

Restore goes into a **new, empty** database whose name starts with `rw_restore_`, and into new storage
folders:

```text
createdb rw_restore_20261023
PGDATABASE=rw_restore_20261023 python3 scripts/backup_restore.py restore --directory <backup-folder> --sources <new>/sources --projects <new>/projects
```

Every backup hash is checked before anything is written. Restore refuses other database names, non-empty
databases, existing storage folders, overlapping roots and a running app, uses a single database
transaction, and re-checks restored file hashes. It never overwrites existing data. Point a test instance of
the app at the restored database and folders, check projects, sources and report downloads, and only then
switch over.

## Retention

Nothing is deleted automatically: originals, evidence versions and audit records are kept so old reports
stay reproducible. Watch database size and free disk space yourself.

## Deleting a project

`npm run delete-project -- <project-id>` shows which project and storage folder would be removed;
add `--yes` to delete permanently (inside Docker: `docker compose exec app node scripts/delete-project.js <project-id> --yes`).
Rows are removed in one transaction (articles, claims, runs, results, exports, usage and idempotency records
for that project); the project's report folder under the projects storage root is removed after the commit.
Make a backup first (see above), and do not run it while an operation on that project is active.

Acquired sources live in a shared, content-addressed warehouse and may be used by other projects, so they are
kept. To reclaim them, remove sources no remaining project references (`sources` rows without a
`project_sources` row, and their folders under the sources storage root) after reviewing them by hand.

## Database roles

The Compose setup uses one database role that owns the schema and runs both migrations and the app. For
tighter separation on your own PostgreSQL, run `npm run migrate` as the owning role and run the app as a
second role with only `SELECT, INSERT, UPDATE, DELETE` on the tables (plus sequence usage). The readiness
check reports missing privileges on `checkpoint_requests`.
