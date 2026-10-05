"""Width and height of library files, remembered so the asset library can lay out cards before any
picture has loaded.

Images are read from the file header (PIL does not decode the pixels), inline. Videos need ffprobe, which is
too slow to run for thousands of files inside one request, so a background thread fills them in and the
library gets them on a later listing. Entries are keyed by file name and invalidated by size and mtime.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

_lock = threading.Lock()
_cache: dict[str, list] = {}          # name -> [size, mtime_ns, width, height]
_pending: set[str] = set()
_loaded = False
_file: Path | None = None


def configure(cache_file: Path) -> None:
    global _file
    _file = cache_file


def _load() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    if _file and _file.is_file():
        try:
            _cache.update(json.loads(_file.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass


def _save() -> None:
    if not _file:
        return
    tmp = _file.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(_cache), encoding="utf-8")
        os.replace(tmp, _file)
    except OSError:
        pass


def _read_image(path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image
        with Image.open(path) as img:
            return img.size
    except Exception:
        return None


def _read_video(path: Path) -> tuple[int, int] | None:
    try:
        out = subprocess.run(
            [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
        w, h = out.split(",")[:2]
        return int(w), int(h)
    except Exception:
        return None


def _fill(jobs: list[tuple[str, Path, int, int]]) -> None:
    done = 0
    for name, path, size, mtime in jobs:
        dims = _read_video(path)
        with _lock:
            _cache[name] = [size, mtime, *(dims or (0, 0))]
            _pending.discard(name)
        done += 1
        if done % 50 == 0:
            with _lock:
                _save()
    with _lock:
        _save()


def lookup(entries: list[tuple[str, str, Path, int, int]]) -> dict[str, tuple[int, int]]:
    """(name, kind, path, size, mtime_ns) for every file; returns the dimensions known right now.

    Unknown images are read here. Unknown videos are queued for a background pass."""
    found: dict[str, tuple[int, int]] = {}
    queue: list[tuple[str, Path, int, int]] = []
    changed = False
    with _lock:
        _load()
        for name, kind, path, size, mtime in entries:
            if kind not in ("image", "video"):
                continue
            hit = _cache.get(name)
            if hit and hit[0] == size and hit[1] == mtime:
                if hit[2] and hit[3]:
                    found[name] = (hit[2], hit[3])
                continue
            if kind == "image":
                dims = _read_image(path)
                _cache[name] = [size, mtime, *(dims or (0, 0))]
                changed = True
                if dims:
                    found[name] = dims
            elif name not in _pending:
                _pending.add(name)
                queue.append((name, path, size, mtime))
        if changed:
            _save()
    if queue:
        threading.Thread(target=_fill, args=(queue,), daemon=True, name="asset-dims").start()
    return found
