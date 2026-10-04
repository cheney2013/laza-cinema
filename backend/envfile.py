"""Settings that may live in the environment or in the repository's root .env.

start.ps1 reads .env for the few values it needs itself (ComfyUI URL, machine profile). The
backend, the canvas MCP server and the workflow builders run as their own processes and are
restarted on their own, so each reads the same file here instead of depending on which shell
started it. A real environment variable always wins over the file.
"""
from __future__ import annotations

import os
from pathlib import Path

_ENV_FILES = (Path(__file__).resolve().parent.parent / ".env", Path(__file__).resolve().parent / ".env")


def env_value(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    for path in _ENV_FILES:
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(f"{name}=") and not line.startswith("#"):
                    found = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if found:
                        return found
        except OSError:
            continue
    return default


#: Where the original author's ComfyUI lives. Used only when nothing is configured and the folder
#: exists, so that machine keeps working without a .env entry; no other machine has this folder.
_LEGACY_COMFYUI = Path(r"D:\ComfyUI-sage3\ComfyUI")


def comfyui_dir(var: str) -> str:
    """ComfyUI's output or input folder (`COMFYUI_OUTPUT_DIR` / `COMFYUI_INPUT_DIR`): environment,
    then .env, then the author's own install if present. Empty when it cannot be determined."""
    configured = env_value(var)
    if configured:
        return configured
    legacy = _LEGACY_COMFYUI / ("output" if var.endswith("OUTPUT_DIR") else "input")
    return str(legacy) if legacy.is_dir() else ""
