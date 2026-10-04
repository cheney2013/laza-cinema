"""Old takes of canvas nodes: find the files only they hold, then drop both.

A generation node keeps every clip it ever produced in `data.takes`. The one on
display is the node's `generatedUrl`; the rest are history. The asset library
counts any mention as a reference, so history could never be cleaned -- on the
TLOU scene-1 canvas that was 175 takes, most of them multi-GB latents.

A file is history, and may go, only when every mention of it in every project
canvas, cut-room timeline and sequence is a superseded take. One mention
anywhere else -- the displayed clip, a chain part, a reference wired into a
later shot, a clip on a timeline -- keeps it. Its take entries are removed from
every canvas that lists it, in the same pass, so no take picker is left pointing
at a missing file.

Kept takes: the one whose url is the node's generatedUrl, and takes[0] as well
when none matches (an adopted render), since takes[0] is what produced the clip
on display.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Optional

from artifact_pruner import _names_in, pair_names, project_of, scene_of

# A bible entry (and its replaced versions) holds its files the way a timeline does.
TIMELINE_GLOBS = ("timeline.json", "sequences/**/*.json", "bible.json")


def _basename(url: str) -> str:
    return os.path.basename((url or "").split("?")[0].replace("\\", "/"))


def _documents(workspaces: Path) -> tuple[list[tuple[Path, dict]], list[tuple[Path, dict]]]:
    """Every canvas and every timeline/sequence, parsed. An unreadable one is an error:
    unknown references must never read as "unreferenced"."""
    def load(paths):
        out = []
        for doc in sorted(paths):
            try:
                out.append((doc, json.loads(doc.read_text(encoding="utf-8"))))
            except Exception as exc:  # noqa: BLE001 -- any failure means unknown references
                raise RuntimeError(f"cannot read {doc}: {exc}") from exc
        return out

    canvases = load(workspaces.rglob("canvas.json"))
    timelines = load({p for pattern in TIMELINE_GLOBS for p in workspaces.rglob(pattern)})
    return canvases, timelines


def _current_takes(data: dict) -> set[int]:
    takes = data.get("takes") or []
    shown = _basename(data.get("generatedUrl") or "")
    current = {i for i, t in enumerate(takes) if isinstance(t, dict) and shown and _basename(t.get("url", "")) == shown}
    if not current and takes:
        current.add(0)
    return current


def _superseded_names(take: dict) -> set[str]:
    """What a superseded take mentions. A take's prompt quoting a filename is text,
    not a hold on the file, so only its url counts."""
    name = _basename(take.get("url") or "")
    return {name} if name else set()


def plan(workspaces: Path, project_id: str) -> dict:
    """Work out what cleaning `project_id`'s history would remove. No side effects."""
    canvases, timelines = _documents(workspaces)

    held: set[str] = set()                    # mentioned anywhere other than a superseded take
    # name -> [(project, scene, node id, take index)]; node ids are only unique within a scene
    history: dict[str, list[tuple[str, str, str, int]]] = {}
    labels: dict[tuple[str, str, str], str] = {}

    for doc, canvas in canvases:
        project, scene = project_of(doc), scene_of(doc)
        for node in canvas.get("nodes") or []:
            data = node.get("data") or {}
            takes = data.get("takes") if isinstance(data.get("takes"), list) else []
            rest = {k: v for k, v in data.items() if k != "takes"}
            held |= _names_in(rest) | _names_in({k: v for k, v in node.items() if k != "data"})
            current = _current_takes(data)
            for index, take in enumerate(takes):
                if not isinstance(take, dict):
                    continue
                if index in current:
                    held |= _names_in(take)
                    continue
                for name in _superseded_names(take):
                    history.setdefault(name, []).append((project, scene, node["id"], index))
                labels[(project, scene, node["id"])] = str(data.get("label") or data.get("title") or node["id"])
        held |= _names_in({k: v for k, v in canvas.items() if k != "nodes"})
    for _, timeline in timelines:
        held |= _names_in(timeline)

    deletable = {
        name for name, uses in history.items()
        if name not in held and any(use[0] == project_id for use in uses)
    }
    kept_in_use = sum(
        1 for name, uses in history.items()
        if name in held for use in uses if use[0] == project_id
    )

    nodes: dict[tuple[str, str, str], dict] = {}
    for name in sorted(deletable):
        for project, scene, node_id, index in history[name]:
            entry = nodes.setdefault((project, scene, node_id), {
                "project_id": project, "scene": scene, "node_id": node_id,
                "label": labels.get((project, scene, node_id), node_id),
                "take_indexes": [], "files": [],
            })
            if index not in entry["take_indexes"]:
                entry["take_indexes"].append(index)
            if name not in entry["files"]:
                entry["files"].append(name)

    return {
        "project_id": project_id,
        "files": sorted(deletable),
        # Latents ride with their clip, unless something else still holds the latent.
        "companions": sorted({c for n in deletable for c in pair_names(n)} - held - deletable),
        "nodes": sorted(nodes.values(), key=lambda e: (e["project_id"] != project_id, e["project_id"], e["label"])),
        "other_projects": sorted({e["project_id"] for e in nodes.values() if e["project_id"] != project_id}),
        "kept_in_use": kept_in_use,
    }


def prune_canvas(canvas: dict, node_takes: dict[str, set[int]]) -> dict:
    """The canvas with the named take indexes removed from the named nodes, revision bumped."""
    out = dict(canvas)
    nodes = []
    for node in canvas.get("nodes") or []:
        drop = node_takes.get(node.get("id"))
        data = node.get("data") or {}
        if drop and isinstance(data.get("takes"), list):
            data = dict(data)
            data["takes"] = [t for i, t in enumerate(data["takes"]) if i not in drop]
            node = {**node, "data": data}
        nodes.append(node)
    out["nodes"] = nodes
    out["revision"] = int(canvas.get("revision") or 0) + 1
    return out


def locate(name: str, roots: list[Path]) -> Optional[Path]:
    """The file for a basename, looked up only directly inside the known media roots."""
    for root in roots:
        candidate = root / name
        if candidate.is_file() and candidate.resolve().parent == root.resolve():
            return candidate
    return None


def apply(workspaces: Path, project_id: str, roots: list[Path],
          write_json: Callable[[Path, dict], None]) -> dict:
    """Remove the history `plan` finds: take entries first, then the files.

    Canvases go first so a failure between the two leaves unreferenced files the
    library can still clean, never takes pointing at nothing. The caller holds the
    project locks for every project in plan()["nodes"].
    """
    result = plan(workspaces, project_id)
    by_canvas: dict[tuple[str, str], dict[str, set[int]]] = {}
    for entry in result["nodes"]:
        by_canvas.setdefault((entry["project_id"], entry["scene"]), {})[entry["node_id"]] = set(entry["take_indexes"])

    canvases, _ = _documents(workspaces)
    for doc, canvas in canvases:
        changes = by_canvas.get((project_of(doc), scene_of(doc)))
        if changes:
            write_json(doc, prune_canvas(canvas, changes))

    deleted, freed = [], 0
    for name in result["files"] + result["companions"]:
        path = locate(name, roots)
        if path is None:
            continue
        size = path.stat().st_size
        path.unlink()
        deleted.append(name)
        freed += size
    return {**result, "deleted": deleted, "freed_bytes": freed}


def sizes(names: list[str], roots: list[Path]) -> int:
    total = 0
    for name in names:
        path = locate(name, roots)
        if path is not None:
            total += path.stat().st_size
    return total
