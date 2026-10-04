# Restart only the Canvas MCP server on :8004. Backend, ComfyUI and frontend are
# untouched. Needed after any change to backend/canvas_mcp_server.py: the running
# server keeps the code it was started with.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$runtime = Join-Path $root '.runtime'

# Same interpreter rule as start.ps1: AI_CINEMA_MCP_PYTHON from the environment
# or .env, a Python with the mcp package (the backend venv pins an older pydantic).
$mcpPython = $env:AI_CINEMA_MCP_PYTHON
if (-not $mcpPython -and (Test-Path -LiteralPath (Join-Path $root '.env'))) {
    foreach ($line in Get-Content -LiteralPath (Join-Path $root '.env')) {
        if ($line -match '^\s*AI_CINEMA_MCP_PYTHON\s*=\s*(.+)$') {
            $mcpPython = $matches[1].Trim().Trim('"').Trim("'")
            break
        }
    }
}
if (-not $mcpPython) { $mcpPython = Join-Path $backend '.venv-mcp\Scripts\python.exe' }

$listeners = Get-NetTCPConnection -LocalPort 8004 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$env:AI_CINEMA_BACKEND_URL = 'http://127.0.0.1:8003'
$stdout = Join-Path $runtime 'mcp.stdout.log'
$stderr = Join-Path $runtime 'mcp.stderr.log'
Start-Process -FilePath $mcpPython `
    -ArgumentList @('canvas_mcp_server.py', '--http', '8004') `
    -WorkingDirectory $backend -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 300
    if (Get-NetTCPConnection -LocalPort 8004 -State Listen -ErrorAction SilentlyContinue) {
        Write-Host 'Canvas MCP restarted: http://0.0.0.0:8004/mcp' -ForegroundColor Green
        Write-Host "Logs: $stderr"
        exit 0
    }
}
throw "Canvas MCP did not start listening on 8004. See $stderr"
