# LAZA CINEMA STUDIO — one-click shutdown
# Kills backend (port 8003) and frontend (port 4000), including uvicorn reload-watcher parents.

$root = $PSScriptRoot

# Read central configuration from root .env if present
$comfyPort = "8188"
if ($env:COMFYUI_URL -match ':(\d+)') {
    $comfyPort = $matches[1]
} elseif (Test-Path "$root\.env") {
    $envContent = Get-Content "$root\.env"
    foreach ($line in $envContent) {
        if ($line -match '^\s*COMFYUI_URL\s*=\s*.*:(\d+)') {
            $comfyPort = $matches[1]
            break
        }
    }
}

function Stop-Port {
    param([int]$Port, [string]$Label)
    $connections = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    if (-not $connections) { return $false }
    $pids = $connections | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($p in $pids) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    return $true
}

function Stop-UvicornWatchers {
    # Kill uvicorn --reload parent/watcher processes that don't own a port listener.
    # They spawn new workers when their child dies, so they must be killed too.
    Get-WmiObject Win32_Process | Where-Object {
        ($_.CommandLine -like "*uvicorn*main:app*" -or $_.CommandLine -like "*uvicorn*8003*") -and
        ($_.ExecutablePath -notlike "*ComfyUI*")
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # Also kill multiprocessing workers that were spawned by those watchers
    Get-WmiObject Win32_Process | Where-Object {
        $_.CommandLine -like "*spawn_main*" -and $_.CommandLine -like "*pythoncore*"
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Stopping LAZA CINEMA STUDIO services..." -ForegroundColor Cyan

$backendWasRunning = Stop-Port -Port 8003 -Label "Backend"
Stop-UvicornWatchers
Start-Sleep -Milliseconds 400

# Verify port 8003 is free
$stillUp = netstat -ano | Select-String ":8003\s+.*LISTENING"
if ($stillUp) {
    Write-Host "  Backend (port 8003): stopped" -ForegroundColor Green
}
elseif ($backendWasRunning) {
    Write-Host "  Backend (port 8003): stopped" -ForegroundColor Green
}
else {
    Write-Host "  Backend (port 8003): was not running" -ForegroundColor DarkGray
}

$frontendWasRunning4000 = Stop-Port -Port 4000 -Label "Frontend"
$frontendWasRunning3000 = Stop-Port -Port 3000 -Label "Frontend"
if ($frontendWasRunning4000 -or $frontendWasRunning3000) {
    Write-Host "  Frontend (port 4000/3000): stopped" -ForegroundColor Green
}
else {
    Write-Host "  Frontend (port 4000): was not running" -ForegroundColor DarkGray
}

# Also kill any remaining node processes that might be holding the port
Write-Host ""
Write-Host "Cleaning up Node.js processes..." -ForegroundColor Cyan
Get-WmiObject Win32_Process | Where-Object {
    $_.ProcessName -eq "node" -and
    ($_.CommandLine -like "*next dev*" -or $_.CommandLine -like "*vite*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. ComfyUI (port $comfyPort) is still running." -ForegroundColor Yellow
Write-Host ""
