# Starts comfy-api-proxy in front of the local ComfyUI, for COMFY_TRANSPORT=sdk.
# Port 8290, not the proxy's default 8189: ComfyUI Desktop can come back on 8189 and the backend
# fails over to it. Set COMFY_TRANSPORT=sdk (and COMFY_SDK_URL if you change the port) in .env.
param(
    [string]$ComfyUI = "http://127.0.0.1:8188",
    [int]$Port = 8290
)
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "backend\.venv\Scripts\comfy-api-proxy.exe"
if (-not (Test-Path $exe)) { throw "comfy-api-proxy is not installed: pip install -r backend/requirements.txt" }
$state = Join-Path $root "backend\workspaces\comfy_proxy_state"
New-Item -ItemType Directory -Force $state | Out-Null
& $exe run --comfyui $ComfyUI --port $Port --state-dir $state
