r"""Delete generated artifacts no canvas node references any more.

A node existing in a project's canvas.json IS the reference, as is a clip on a
cut-room timeline.json. Undo history lives only in the frontend's memory
(store.ts keeps 50 steps, never persisted), so an unreferenced file may still be
one Ctrl+Z away from being live again — which is why deletion is now something
the user asks for in the asset library, not something that happens on its own.

Only files ai-cinima itself produced are ever considered. The ComfyUI output
directory is shared with other projects -- harry potter's hp_* renders live there,
as do manual ComfyUI-UI runs -- and "not referenced by an ai-cinima canvas" says
nothing about those. Unknown ownership means do not touch.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# filename_prefix values hardcoded by this project's builders.
OWNED_PREFIXES = (
    "H3_Video_", "H3_Chunk_", "H3_Latent_", "H3_Upscale_Video", "H3_Upscale_Latent",
    # The edit nodes' outputs: 改原片 (edit window), 重拍一段, 重拍中间, 剪切.
    # Missing here, they never reached the cut room's bin (2026-09-22).
    "H3_EditWindow_", "H3_Reshot_", "H3_Bridge", "H3_Trim_",
    "H3_Cleanup_",  # 去水印 / 去字幕
    "cinema", "nlf_pose_3d", "openpose_full", "merged_scene",
)

MEDIA_EXT = {".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp", ".gif",
             ".safetensors", ".latent", ".ply", ".glb", ".wav", ".mp3", ".flac",
             ".m4a", ".aac", ".ogg"}

MEDIA_RE = re.compile(
    r"[\w./\-]+\.(?:mp4|webm|mov|png|jpg|jpeg|webp|gif|safetensors|latent|ply|glb|wav|mp3|flac|m4a|aac|ogg)",
    re.IGNORECASE)

DEFAULT_MIN_AGE_MINUTES = 30


def _names_in(document) -> set[str]:
    """Every media filename mentioned anywhere in a JSON document, by basename."""
    found: set[str] = set()
    stack = [document]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
        elif isinstance(o, str):
            for m in MEDIA_RE.findall(o):
                found.add(os.path.basename(m.replace("\\", "/")))
    return found


def project_of(doc: Path) -> str:
    """The project a canvas, timeline or sequence file belongs to.

    Layout: <workspace>/projects/<project>/..., where "..." may be canvas.json,
    sequences/<seq>.json, or scenes/<scene>/canvas.json for a film's other
    scenes. The folder right under projects/ is the project; the nearest folder
    would name a scene or a sequence folder instead.
    """
    parts = doc.parts
    if "projects" in parts:
        index = len(parts) - 1 - parts[::-1].index("projects")
        if index + 1 < len(parts) - 1:
            return parts[index + 1]
    return next((p.name for p in doc.parents if p.name not in ("sequences", ".trash", "scenes")), doc.parent.name)


def scene_of(doc: Path) -> str:
    """The scene a canvas file belongs to: "main" for the project's own canvas.json."""
    parts = doc.parts
    if "scenes" in parts:
        rest = [p for p in parts[parts.index("scenes") + 1:-1] if p != ".trash"]
        if rest:
            return rest[0]
    return "main"


def collect_references(workspaces: Path) -> dict[str, set[str]]:
    """
    Map filename -> the project ids that mention it.

    Both a canvas and a cut-room timeline count as a reference: a shot trimmed
    into an edit is in use even if its node was since deleted from the canvas.
    """
    by_name: dict[str, set[str]] = {}
    # Sequences live under <project>/sequences/, trashed ones under sequences/.trash/;
    # a trashed sequence still counts, since it can be restored by hand.
    sequences = sorted(p for p in workspaces.rglob("sequences/**/*.json"))
    for doc in sorted(workspaces.rglob("canvas.json")) + sorted(workspaces.rglob("timeline.json")) + sequences \
            + sorted(workspaces.rglob("bible.json")):  # the production bible: shared references and their old versions
        try:
            data = json.loads(doc.read_text(encoding="utf-8"))
        except Exception as e:
            # An unreadable document means unknown references. Refuse to guess:
            # deleting a live file is far worse than skipping a cleanup pass.
            raise RuntimeError(f"cannot read {doc}: {e}")
        project_id = project_of(doc)
        for name in _names_in(data):
            by_name.setdefault(name, set()).add(project_id)
    return by_name


def collect_referenced(workspaces: Path) -> set[str]:
    """Every filename mentioned anywhere in any canvas or timeline, by basename."""
    return set(collect_references(workspaces))


def pair_names(name: str) -> set[str]:
    """Companion files that must share the fate of `name`.

    A clip and its latent are matched by the tag both filenames carry, so keeping
    a video keeps its latent and dropping a video drops the latent with it.
    """
    stem = Path(name).stem
    out: set[str] = set()
    # A chunk (H3_Chunk_<tag>) saves its latent as H3_Latent_<tag> too
    # (comfyui_client), and those latents are the multi-GB part of a take.
    for a, b in (("H3_Video_", "H3_Latent_"), ("H3_Latent_", "H3_Video_"),
                 ("H3_Chunk_", "H3_Latent_"), ("H3_Latent_", "H3_Chunk_"),
                 ("H3_Upscale_Video_", "H3_Upscale_Latent_"),
                 ("H3_Upscale_Latent_", "H3_Upscale_Video_")):
        if stem.startswith(a):
            other = stem.replace(a, b, 1)
            out |= {other + ext for ext in (".safetensors", ".latent", ".mp4")}
    return out


def plan(workspaces: Path, targets: list[Path],
         min_age_minutes: int = DEFAULT_MIN_AGE_MINUTES) -> dict:
    """Work out what would be deleted. Pure inspection, no side effects."""
    refs = collect_referenced(workspaces)
    keep = set(refs)
    for r in refs:
        keep |= pair_names(r)

    cutoff = time.time() - min_age_minutes * 60
    doomed: list[Path] = []
    scanned = foreign = too_new = 0

    for d in targets:
        if not d.is_dir():
            continue
        owns_everything = d.name == "uploads"      # our own upload dir
        for f in d.rglob("*"):
            try:
                if not f.is_file() or f.suffix.lower() not in MEDIA_EXT:
                    continue
                if not owns_everything and not f.name.startswith(OWNED_PREFIXES):
                    foreign += 1
                    continue
                scanned += 1
                if f.name in keep:
                    continue
                if f.stat().st_mtime > cutoff:
                    too_new += 1
                    continue
                doomed.append(f)
            except OSError:
                continue

    return {
        "referenced": len(refs), "kept_with_pairs": len(keep),
        "scanned": scanned, "left_alone": foreign, "too_new": too_new,
        "doomed": doomed,
        "bytes": sum(f.stat().st_size for f in doomed if f.exists()),
    }


def prune(workspaces: Path, targets: list[Path],
          min_age_minutes: int = DEFAULT_MIN_AGE_MINUTES,
          apply: bool = False) -> dict:
    """Blocking: run it off the event loop (asyncio.to_thread)."""
    p = plan(workspaces, targets, min_age_minutes)
    if not apply:
        p["deleted"] = 0
        return p
    deleted = freed = 0
    for f in p["doomed"]:
        try:
            size = f.stat().st_size
            f.unlink()
            deleted += 1
            freed += size
        except OSError as e:
            logger.warning("prune: could not delete %s: %s", f.name, e)
    p["deleted"] = deleted
    p["bytes"] = freed
    return p
