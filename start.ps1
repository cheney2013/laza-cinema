# LAZA CINEMA STUDIO — one-click startup
#   .\start.ps1        production build of the studio (next build + next start): the daily mode
#   .\start.ps1 -Dev   next dev with hot reload, only while editing the UI
# 2026-09-05: on a 55-node canvas dragging a card cost 50-120 ms per frame under
# next dev (StrictMode double render, no minification) and 6-26 ms under the
# production build -- the "lag" was the dev server, not the canvas.
param([switch]$Dev)
$root = $PSScriptRoot

# Read central configuration from root .env if present
$comfyUrl = $env:COMFYUI_URL
if (-not $comfyUrl -and (Test-Path "$root\.env")) {
    $envContent = Get-Content "$root\.env"
    foreach ($line in $envContent) {
        if ($line -match '^\s*COMFYUI_URL\s*=\s*(.+)$') {
            $comfyUrl = $matches[1].Trim().Trim('"').Trim("'")
            break
        }
    }
}
if (-not $comfyUrl) {
    $comfyUrl = "http://127.0.0.1:8188"
}

# H3 machine profile (backend/machine_profile.py): auto | workstation | lowvram.
# auto (the default) reads ComfyUI's total VRAM when the backend starts.
$machineProfile = $env:H3_MACHINE_PROFILE
if (-not $machineProfile -and (Test-Path "$root\.env")) {
    foreach ($line in (Get-Content "$root\.env")) {
        if ($line -match '^\s*H3_MACHINE_PROFILE\s*=\s*(.+)$') {
            $machineProfile = $matches[1].Trim().Trim('"').Trim("'")
            break
        }
    }
}
if (-not $machineProfile) {
    $machineProfile = "auto"
}

# Values the Next.js server reads from its own environment (it does not read this root .env):
# the optional local LLM behind prompt translation / optimisation, and the NVIDIA NIM key.
function Get-DotEnvValue([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not $value -and (Test-Path "$root\.env")) {
        foreach ($line in (Get-Content "$root\.env")) {
            if ($line -match "^\s*$name\s*=\s*(.+)$") { $value = $matches[1].Trim().Trim('"').Trim("'"); break }
        }
    }
    return $value
}
$frontendEnvLines = ''
foreach ($name in 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'NV_API_KEY') {
    $value = Get-DotEnvValue $name
    if ($value -and $value -ne 'your_nvidia_api_key_here') {
        $frontendEnvLines += "`$env:$name = '" + $value.Replace("'", "''") + "'`n"
    }
}

# Write helper launch scripts to temp so quoting stays simple
$backendPs1 = "$env:TEMP\ai-cinema-backend.ps1"
$frontendPs1 = "$env:TEMP\ai-cinema-frontend.ps1"

Set-Content $backendPs1 -Value @"
Set-Location '$root\backend'
if (-not (Test-Path '.venv')) {
    Write-Host 'Creating Python venv...' -ForegroundColor Cyan
    # 3.12 is what the backend was developed on; any 3.10+ is tried before giving up.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3.12 -m venv .venv
        if (-not (Test-Path '.venv')) { py -3 -m venv .venv }
    } else {
        python -m venv .venv
    }
    if (-not (Test-Path '.venv')) { Write-Host 'Could not create the Python venv: install Python 3.12 from python.org and rerun.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
    .\.venv\Scripts\pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        # A venv left behind would make the next start skip this step and run a backend with missing packages.
        Remove-Item -Recurse -Force .venv
        Write-Host 'pip install failed; the venv was removed. Fix the error above and rerun start.ps1.' -ForegroundColor Red
        Read-Host 'Press Enter to close'; exit 1
    }
}
`$env:COMFYUI_URL = '$comfyUrl'
`$env:H3_MACHINE_PROFILE = '$machineProfile'
Write-Host '>> Backend  http://localhost:8003  (H3 profile: $machineProfile)' -ForegroundColor Green
Write-Host '>> ComfyUI  $comfyUrl' -ForegroundColor DarkGray
# A backend left running from an earlier start holds the port, and the new one
# would fail to bind while the old code keeps serving.
foreach (`$old in (Get-NetTCPConnection -LocalPort 8003 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique) {
    Stop-Process -Id `$old -Force -ErrorAction SilentlyContinue
}
.\.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8003
"@

# Canvas MCP over HTTP, shared by every machine on the tailnet:
#   claude mcp add --transport http ai-cinema-canvas http://<this machine>:8004/mcp
# It runs on AI_CINEMA_MCP_PYTHON from .env, a Python with the mcp package (the
# backend venv pins an older pydantic than mcp needs).
$mcpPython = $env:AI_CINEMA_MCP_PYTHON
if (-not $mcpPython -and (Test-Path "$root\.env")) {
    foreach ($line in (Get-Content "$root\.env")) {
        if ($line -match '^\s*AI_CINEMA_MCP_PYTHON\s*=\s*(.+)$') { $mcpPython = $matches[1].Trim().Trim('"').Trim("'"); break }
    }
}
if (-not $mcpPython) { $mcpPython = "$root\backend\.venv-mcp\Scripts\python.exe" }
$mcpPs1 = "$env:TEMP\ai-cinema-mcp.ps1"
Set-Content $mcpPs1 -Value @"
Set-Location '$root\backend'
`$env:AI_CINEMA_BACKEND_URL = 'http://127.0.0.1:8003'
# Bearer token for the MCP (see canvas_mcp_server.py); read from the user environment so a
# token set with setx takes effect without reopening the shell that ran start.ps1.
if (-not `$env:AI_CINEMA_MCP_TOKEN) { `$env:AI_CINEMA_MCP_TOKEN = [Environment]::GetEnvironmentVariable('AI_CINEMA_MCP_TOKEN', 'User') }
foreach (`$old in (Get-NetTCPConnection -LocalPort 8004 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique) {
    Stop-Process -Id `$old -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path '$mcpPython')) {
    Write-Host 'Creating the MCP venv (.venv-mcp)...' -ForegroundColor Cyan
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3.12 -m venv .venv-mcp; if (-not (Test-Path '.venv-mcp')) { py -3 -m venv .venv-mcp } } else { python -m venv .venv-mcp }
    if (Test-Path '.venv-mcp') { .\.venv-mcp\Scripts\pip install -r requirements-mcp.txt }
}
Write-Host '>> Canvas MCP http://0.0.0.0:8004/mcp' -ForegroundColor Magenta
& '$mcpPython' canvas_mcp_server.py --http 8004
"@

$devFlag = if ($Dev) { '1' } else { '0' }
Set-Content $frontendPs1 -Value @"
Set-Location '$root\frontend'
`$env:AI_CINEMA_DEV = '$devFlag'

if (-not (Test-Path 'node_modules')) {
    Write-Host 'Installing frontend dependencies (npm install)...' -ForegroundColor Cyan
    npm install
}

# Use NODE_OPTIONS to configure the Node.js server
`$env:NODE_OPTIONS = '--dns-result-order=ipv4first'
`$env:NEXT_PUBLIC_COMFYUI_URL = '$comfyUrl'
$frontendEnvLines
Write-Host '>> Frontend http://0.0.0.0:4000' -ForegroundColor Cyan

# Check if port 4000 is in use by any process
`$tcpPort = 4000
`$processId = (Get-NetTCPConnection -LocalPort `$tcpPort -ErrorAction SilentlyContinue).OwningProcess
if (`$processId) {
    Write-Host 'Warning: Port `$tcpPort may be in use. Attempting to stop existing process...' -ForegroundColor Yellow
    Stop-Process -Id `$processId -Force -ErrorAction SilentlyContinue
}

if (`$env:AI_CINEMA_DEV -eq '1') {
    Write-Host '>> dev mode (hot reload, slow on big canvases)' -ForegroundColor Yellow
    npx next dev -p 4000 --hostname 0.0.0.0
} else {
    Write-Host '>> production build...' -ForegroundColor Cyan
    npx next build
    if (`$LASTEXITCODE -ne 0) { Write-Host 'next build failed' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
    npx next start -p 4000 --hostname 0.0.0.0
}
"@

# Launch backend and frontend in separate PowerShell windows.
# (wt.exe tab-launching was dropped: on this machine `wt` resolves to a stale/broken
# App Execution Alias that accepts the new-tab command but silently fails to spawn
# the child process, leaving empty error panes with no backend/frontend running.)
Start-Process powershell -ArgumentList "-NoExit", "-File", $backendPs1
Start-Sleep -Milliseconds 300
Start-Process powershell -ArgumentList "-NoExit", "-File", $frontendPs1
Start-Process powershell -ArgumentList "-NoExit", "-File", $mcpPs1

Write-Host ""
$versionFile = Join-Path $root "VERSION"
$studioVersion = if (Test-Path $versionFile) { (Get-Content $versionFile -TotalCount 1).Trim() } else { "?" }
Write-Host "  LAZA CINEMA STUDIO v$studioVersion" -ForegroundColor White
Write-Host "  Backend   -> http://localhost:8003" -ForegroundColor Green
Write-Host "  MCP       -> http://localhost:8004/mcp (see docs/DEPLOY.md for the token)" -ForegroundColor Magenta
Write-Host "  Frontend  -> http://localhost:4000" -ForegroundColor Cyan
Write-Host "  ComfyUI   -> $comfyUrl (already running)" -ForegroundColor Yellow
Write-Host ""
