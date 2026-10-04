# Agent Relay -- start the web console (and say how the agents connect to it).
#
#   .\start_relay.ps1            start the console on 127.0.0.1:8777 in its own window
#   .\start_relay.ps1 -Status    just report what is running
#
# What "the relay" is, in three parts, because only one of them is a process:
#
#   1. The bus itself is a file: ~/.agent-relay/messages.jsonl. Nothing has to be
#      running for agents to append to it or read it.
#   2. The MCP servers (backend/relay_mcp_server.py) are started *by each agent's
#      client* over stdio -- Claude Code from .mcp.json, Antigravity from its own
#      config. They are not started here; restarting the client reconnects them.
#   3. The web console (tools/relay_ui/server.py) is the only long-running
#      process: it serves http://127.0.0.1:8777, holds the Ed25519 signing key that
#      marks a message as genuinely typed by the human, and is what they watch. When it
#      is down the agents still talk to each other, but he cannot talk to them.
#      That is the process this script starts.
#
# The console runs on the same system Python that .mcp.json names for the MCP
# servers (it has fastapi/uvicorn); the backend venv is not used so the two never
# disagree about the relay directory or the auth module.

param(
    [switch]$Status
)

$root = $PSScriptRoot
$python = if ($env:AGENT_RELAY_PYTHON) { $env:AGENT_RELAY_PYTHON } else { (Get-Command python -ErrorAction Stop).Source }
$server = Join-Path $root "tools\relay_ui\server.py"
$port = 8777
$relayDir = Join-Path $env:USERPROFILE ".agent-relay"

function Get-ConsolePid {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

$existing = Get-ConsolePid
if ($Status) {
    if ($existing) {
        Write-Host "Console  : running (pid $existing) -> http://127.0.0.1:$port" -ForegroundColor Green
    } else {
        Write-Host "Console  : not running" -ForegroundColor Yellow
    }
    Write-Host "Bus file : $relayDir\messages.jsonl"
    Write-Host "Token    : $relayDir\ui_token.txt"
    if (Test-Path "$relayDir\status.json") {
        Write-Host "Agents   :" -ForegroundColor Cyan
        Get-Content "$relayDir\status.json" -Raw | Write-Host
    }
    exit 0
}

if ($existing) {
    Write-Host "Console already listening on :$port (pid $existing). Nothing to do." -ForegroundColor Green
    Write-Host "  http://127.0.0.1:$port   token in $relayDir\ui_token.txt"
    exit 0
}

if (-not (Test-Path $python)) { Write-Error "Python not found at $python"; exit 1 }
if (-not (Test-Path $server)) { Write-Error "Console server not found at $server"; exit 1 }

# Helper script in temp, same pattern as start.ps1, so quoting stays simple.
# PYTHONUTF8=1 matters: the console prints Chinese and the default console code
# page on this machine is cp932, which killed the process once on the first
# non-ASCII character it logged.
$helper = "$env:TEMP\agent-relay-console.ps1"
Set-Content $helper -Encoding utf8 -Value @"
Set-Location '$root\tools\relay_ui'
`$env:PYTHONUTF8 = '1'
`$env:RELAY_UI_PORT = '$port'
Write-Host '>> Agent Relay console  http://127.0.0.1:$port' -ForegroundColor Green
Write-Host '>> login token: $relayDir\ui_token.txt' -ForegroundColor DarkGray
& '$python' '$server'
"@
# No `2>&1 | Tee-Object` here on purpose: Windows PowerShell 5.1 wraps every stderr
# line of a native process in a NativeCommandError record, so uvicorn's ordinary
# "INFO: Started server process" came out as a red exception. uvicorn logs to the
# window; server.py keeps its own server.log.

Start-Process powershell -ArgumentList "-NoExit", "-File", $helper

# Wait for the port, then report. Silence here would look like success.
$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 500
    $pidNow = Get-ConsolePid
} until ($pidNow -or (Get-Date) -gt $deadline)

if ($pidNow) {
    Write-Host ""
    Write-Host "  Relay console -> http://127.0.0.1:$port  (pid $pidNow)" -ForegroundColor Green
    Write-Host "  Token         -> $relayDir\ui_token.txt" -ForegroundColor DarkGray
    Write-Host "  MCP servers are started by each agent's client, not here; Claude Code re-arms"
    Write-Host "  its bus watcher at session start (CLAUDE.md section 8)."
} else {
    Write-Host "  Console did not come up on :$port within 15 s -- read tools\relay_ui\server.log" -ForegroundColor Red
    exit 1
}
