"""
Who made a file, recorded when it is made.

The asset library used to answer "whose is this?" by asking who still points at
it — every project's canvas.json is scanned for references. That works for
living assets and fails for the rest: delete the node that produced a clip and
the clip becomes an orphan belonging to no one, so it surfaces in every
project's library at once. Nothing on this machine remembered that it came from
somewhere.

This is that missing record: one line per file, written at the moment the file
appears, naming the project the request came from. It is deliberately separate
from `provenance.py`, which recovers *how* a clip was made by reading the graph
embedded in the file itself. Origin cannot be recovered that way — a project id
is not part of the render — so it has to be written down or it is gone.

Append-only, one JSON object per line: a corrupt or half-written tail costs the
newest entries and never the ledger. Missing lines are normal (everything made
before this existed, anything dropped in by hand), and a file with no origin
keeps the old behaviour of belonging to no one.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import unquote, urlparse

logger = logging.getLogger(__name__)

LEDGER = Path(__file__).parent / "workspaces" / "asset_origins.jsonl"

# The prefixes we serve our own files under. A URL outside them names something
# we did not make and must not claim.
_OWNED_PREFIXES = ("/uploads/", "/comfy_output/")


def _basename(url: str) -> Optional[str]:
    """The filename an owned URL points at, or None for anything else."""
    if not isinstance(url, str) or not url:
        return None
    path = urlparse(url).path
    if not path.startswith(_OWNED_PREFIXES):
        return None
    name = unquote(path.rsplit("/", 1)[-1])
    return name or None


def harvest_urls(payload: Any, depth: int = 0) -> list[str]:
    """
    Every owned filename anywhere in a job result or upload response.

    Result shapes differ per job type and have changed more than once — `url`,
    `urls`, `image_url`, a list of segment paths — so this walks the whole
    structure instead of naming keys. A key that stops existing costs nothing.
    """
    if depth > 6:
        return []
    found: list[str] = []
    if isinstance(payload, str):
        name = _basename(payload)
        if name:
            found.append(name)
    elif isinstance(payload, dict):
        for value in payload.values():
            found.extend(harvest_urls(value, depth + 1))
    elif isinstance(payload, (list, tuple)):
        for value in payload:
            found.extend(harvest_urls(value, depth + 1))
    # Order matters no more than duplicates do; the ledger is keyed by name.
    return list(dict.fromkeys(found))


def record(project_id: Optional[str], names: Iterable[str], **context: Any) -> None:
    """
    Note that `project_id` produced these files. No project, no record.

    Writing origin is never worth failing a job over: a generation that
    succeeded stays succeeded even if the ledger cannot be written.
    """
    if not project_id:
        return
    names = [n for n in dict.fromkeys(names) if n]
    if not names:
        return
    line = json.dumps({
        "project_id": project_id,
        "names": names,
        "at": datetime.now(timezone.utc).isoformat(),
        **context,
    }, ensure_ascii=False)
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError as exc:
        logger.warning("Could not record asset origin for %s: %s", names, exc)


def load() -> dict[str, dict]:
    """
    Filename -> the origin entry for it, latest line winning.

    Later wins because a name can be reused: the ComfyUI output directory is
    flat and a re-run under the same prefix replaces the file, at which point
    the newer run is the truth about what is on disk.
    """
    origins: dict[str, dict] = {}
    try:
        text = LEDGER.read_text(encoding="utf-8")
    except OSError:
        return origins
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue  # a torn tail line; the rest of the ledger still stands
        project_id = entry.get("project_id")
        if not project_id:
            continue
        for name in entry.get("names") or []:
            if isinstance(name, str) and name:
                origins[name] = {
                    "project_id": project_id,
                    "at": entry.get("at"),
                    "job_type": entry.get("job_type"),
                }
    return origins


def seed_from_references(workspaces: Path) -> int:
    """
    One-time backfill: a file that exactly one project references today almost
    certainly came from that project, so write that down before the reference
    disappears. Files referenced by several projects, or by none, are left
    alone — the first has no single origin and the second has no evidence at all.

    Safe to re-run: already-recorded names are skipped, and the ledger is only
    ever appended to.
    """
    import artifact_pruner

    known = set(load())
    seeded: dict[str, list[str]] = {}
    for name, projects in artifact_pruner.collect_references(workspaces).items():
        if name in known or len(projects) != 1:
            continue
        seeded.setdefault(next(iter(projects)), []).append(name)
    for project_id, names in seeded.items():
        record(project_id, names, job_type="backfill:references")
    return sum(len(n) for n in seeded.values())


if __name__ == "__main__":
    count = seed_from_references(Path(__file__).parent / "workspaces")
    print(f"seeded {count} asset origins from existing references")
