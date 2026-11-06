# Generic launcher for Research Verification Workbench (Windows PowerShell 5.1+ or PowerShell 7).
#   .\scripts\start.ps1           # Node.js + your own PostgreSQL (DATABASE_URL or PG* in .env)
#   .\scripts\start.ps1 -Docker   # docker compose: bundled PostgreSQL + app
# Secrets stay in .env; this script never prints or passes them on a command line.
[CmdletBinding()]
param([switch]$Docker, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath '.env' -PathType Leaf)) {
  throw 'No .env file. Copy .env.example to .env and set OPENAI_API_KEY (and POSTGRES_PASSWORD for -Docker, or DATABASE_URL without Docker).'
}
$port = 3080
# Compose publishes WORKBENCH_PORT on the host; without Docker the server listens on PORT.
$portName = if ($Docker) { 'WORKBENCH_PORT' } else { 'PORT' }
$line = Select-String -LiteralPath '.env' -Pattern "^\s*$portName\s*=\s*(\d+)\s*$" | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$url = "http://127.0.0.1:$port"

if ($Docker) {
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { throw 'docker compose failed. Is Docker running?' }
  for ($i = 0; $i -lt 60; $i++) {
    try { $null = Invoke-RestMethod -TimeoutSec 2 "$url/api/readiness"; break } catch { Start-Sleep -Seconds 2 }
  }
  Write-Host "Research Workbench: $url  (logs: docker compose logs -f app; stop: docker compose down)"
  if (-not $NoBrowser) { Start-Process $url }
  return
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22.9 or later is required: https://nodejs.org/' }
if (-not (Test-Path -LiteralPath 'node_modules' -PathType Container)) { npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } }
npm run migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed. Check DATABASE_URL / PG* settings in .env.' }
if (-not $NoBrowser) { Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 3; Start-Process $u } -ArgumentList $url | Out-Null }
npm start
