# Restart only the LAZA CINEMA STUDIO frontend. The backend and ComfyUI are untouched.
param([switch]$Dev)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$frontend = Join-Path $root 'frontend'
$runtime = Join-Path $root '.runtime'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules'))) {
    Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
    & $npm install --prefix $frontend
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed; existing frontend was left running.' }
}

if (-not $Dev) {
    Write-Host 'Building frontend before restart...' -ForegroundColor Cyan
    Push-Location $frontend
    try { & $npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed; existing frontend was left running.' }
}

$listeners = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'
$stdout = Join-Path $runtime 'frontend.stdout.log'
$stderr = Join-Path $runtime 'frontend.stderr.log'
$script = if ($Dev) { 'dev' } else { 'start' }
$arguments = if ($Dev) { @('run', $script) } else { @('run', $script, '--', '-p', '4000', '--hostname', '0.0.0.0') }
Start-Process -FilePath $npm -ArgumentList $arguments `
    -WorkingDirectory $frontend -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4000' -TimeoutSec 1 -UseBasicParsing
        if ($response.StatusCode -lt 500) {
            $mode = if ($Dev) { 'development' } else { 'production' }
            Write-Host "Frontend restarted ($mode): http://127.0.0.1:4000" -ForegroundColor Green
            exit 0
        }
    } catch { }
}
throw "Frontend did not become ready. See $stderr"
