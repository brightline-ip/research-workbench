#!/bin/sh
# Generic launcher for Research Verification Workbench (macOS / Linux).
#   scripts/start.sh            # Node.js + your own PostgreSQL (DATABASE_URL or PG* in .env)
#   scripts/start.sh --docker   # docker compose: bundled PostgreSQL + app
# Secrets stay in .env; this script never prints them.
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "No .env file. Copy .env.example to .env and set OPENAI_API_KEY (and POSTGRES_PASSWORD for --docker, or DATABASE_URL without Docker)." >&2
  exit 1
fi
if [ "${1:-}" = "--docker" ]; then
  docker compose up -d --build
  port=$(tr -d '\r' < .env | sed -n 's/^[[:space:]]*WORKBENCH_PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' | head -n 1)
  echo "Research Workbench: http://127.0.0.1:${port:-3080}  (logs: docker compose logs -f app; stop: docker compose down)"
  exit 0
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 22.9 or later is required: https://nodejs.org/" >&2; exit 1; }
[ -d node_modules ] || npm ci --omit=dev
npm run migrate
exec npm start
