# Restart only the LAZA CINEMA STUDIO backend. ComfyUI and the frontend are untouched.
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$python = Join-Path $backend '.venv\Scripts\python.exe'
$runtime = Join-Path $root '.runtime'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Backend environment is missing: $python`nRun .\start.ps1 once to create it."
}

$comfyUrl = $env:COMFYUI_URL
if (-not $comfyUrl -and (Test-Path -LiteralPath (Join-Path $root '.env'))) {
    foreach ($line in Get-Content -LiteralPath (Join-Path $root '.env')) {
        if ($line -match '^\s*COMFYUI_URL\s*=\s*(.+)$') {
            $comfyUrl = $matches[1].Trim().Trim('"').Trim("'")
            break
        }
    }
}
if (-not $comfyUrl) { $comfyUrl = 'http://127.0.0.1:8188' }

# Running ComfyUI jobs survive a backend restart: the job record is recovered
# and the node picks the result up when it finishes (confirmed by the owner
# 2026-09-18). So a busy queue is reported, not a reason to refuse. -Force is
# kept so existing callers still work.
$comfyUrls = @($comfyUrl.TrimEnd('/'), 'http://127.0.0.1:8188', 'http://127.0.0.1:8189') | Select-Object -Unique
foreach ($url in $comfyUrls) {
    $port = ([Uri]$url).Port
    $isLocal = ([Uri]$url).Host -in @('127.0.0.1', 'localhost')
    if ($isLocal -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        continue
    }
    try {
        $queue = Invoke-RestMethod -Uri "$url/queue" -TimeoutSec 3
        $running = @($queue.queue_running).Count
        $pending = @($queue.queue_pending).Count
        if ($running + $pending -gt 0) {
            Write-Host "ComfyUI at $url has $running running and $pending queued task(s); they keep running." -ForegroundColor Yellow
        }
    } catch { }
}

$listeners = Get-NetTCPConnection -LocalPort 8003 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$env:COMFYUI_URL = $comfyUrl
$stdout = Join-Path $runtime 'backend.stdout.log'
$stderr = Join-Path $runtime 'backend.stderr.log'
Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8003') `
    -WorkingDirectory $backend -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8003/health' -TimeoutSec 1
        if ($health.status -eq 'ok') {
            Write-Host 'Backend restarted: http://127.0.0.1:8003' -ForegroundColor Green
            exit 0
        }
    } catch { }
}
throw "Backend did not become healthy. See $stderr"
