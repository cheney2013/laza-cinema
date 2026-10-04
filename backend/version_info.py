"""The studio's name and version: one place, read by the backend and shown in the UI.

The version is the first line of the repository's VERSION file (bump it there). The commit is whatever
`git rev-parse` says for the checkout the backend runs from, so a build can always be pinned down;
without git (a copied folder) it is simply absent.
"""
from __future__ import annotations

import subprocess
from functools import lru_cache
from pathlib import Path

NAME = "LAZA CINEMA STUDIO"
_ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def version() -> str:
    try:
        return (_ROOT / "VERSION").read_text(encoding="utf-8").splitlines()[0].strip() or "0.0.0"
    except (OSError, IndexError):
        return "0.0.0"


@lru_cache(maxsize=1)
def commit() -> str:
    try:
        done = subprocess.run(["git", "-C", str(_ROOT), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, timeout=5)
        return done.stdout.strip() if done.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def info() -> dict:
    return {"name": NAME, "version": version(), "commit": commit()}
