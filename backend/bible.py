"""A film's production bible: the references every scene draws on.

A cast sheet, an environment plate, a voice reference or a key prop is made once
and used in many scenes. The bible keeps one entry for each, in
`projects/<id>/bible.json`, and scene canvases link to it with `data.bibleId`.

A linked node still carries the file itself (`url`, `mediaType`, size, duration)
so a canvas stays self-describing: the graph builder, the asset scan and every
agent reading a canvas see an ordinary image node. Those fields mirror the
entry, and updating an entry rewrites them on every linked node in every scene
(`propagate`). A local edit to a mirrored field lasts until the next update.

A replaced file is never overwritten in place -- ComfyUI short-circuits on the
filename -- so a new version is a new url, and the old one goes to `history`.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Callable, Iterable, Optional

KINDS = ("cast", "environment", "prop", "voice", "other")
# Fields of an entry that a linked node mirrors. The node's label is its own.
MIRRORED = ("url", "mediaType", "width", "height", "duration")
MAX_HISTORY = 30

# Label prefixes used on canvases so far, as a first guess when collecting a node.
_KIND_GUESS = (
    ("cast", ("定妆", "人物", "角色", "服装")),
    ("environment", ("环境", "场景板", "母板")),
    ("voice", ("语音", "音色", "声音")),
    ("prop", ("道具",)),
)


def path(proj_dir: Path) -> Path:
    return proj_dir / "bible.json"


def load(proj_dir: Path) -> dict:
    p = path(proj_dir)
    if not p.exists():
        return {"revision": 0, "entries": []}
    data = json.loads(p.read_text(encoding="utf-8"))
    data.setdefault("revision", 0)
    data.setdefault("entries", [])
    return data


def guess_kind(label: str, media_type: str = "") -> str:
    head = (label or "").split("·")[0]
    for kind, words in _KIND_GUESS:
        if any(w in head for w in words):
            return kind
    return "voice" if media_type == "audio" else "other"


def guess_name(label: str) -> str:
    """"定妆板 · 主角 v5（备注）" -> "主角 v5"."""
    text = (label or "").strip()
    if "·" in text:
        text = text.split("·", 1)[1]
    text = re.split(r"[（(]", text, maxsplit=1)[0]
    return text.strip()[:60] or (label or "").strip()[:60]


def new_entry(fields: dict) -> dict:
    now = time.time()
    entry = {
        "id": "bib_" + uuid.uuid4().hex[:10],
        "kind": fields.get("kind") if fields.get("kind") in KINDS else "other",
        "name": (fields.get("name") or "").strip() or "未命名",
        "notes": fields.get("notes") or "",
        "history": [],
        "created_at": now,
        "updated_at": now,
    }
    for key in MIRRORED:
        if fields.get(key) not in (None, ""):
            entry[key] = fields[key]
    if not entry.get("url"):
        raise ValueError("an entry needs a file url")
    return entry


def apply_patch(entry: dict, patch: dict) -> bool:
    """Update an entry in place. Returns True when the file changed (so nodes must follow)."""
    if patch.get("kind") is not None:
        if patch["kind"] not in KINDS:
            raise ValueError(f"unknown kind: {patch['kind']}")
        entry["kind"] = patch["kind"]
    if patch.get("name") is not None and patch["name"].strip():
        entry["name"] = patch["name"].strip()
    if patch.get("notes") is not None:
        entry["notes"] = patch["notes"]
    file_changed = bool(patch.get("url")) and patch["url"] != entry.get("url")
    if file_changed:
        entry["history"] = ([{**{k: entry[k] for k in MIRRORED if k in entry}, "replaced_at": time.time()}]
                            + entry.get("history", []))[:MAX_HISTORY]
        for key in MIRRORED:
            entry.pop(key, None)
            if patch.get(key) not in (None, ""):
                entry[key] = patch[key]
    entry["updated_at"] = time.time()
    return file_changed


def mirror(entry: dict) -> dict:
    return {k: entry[k] for k in MIRRORED if k in entry}


def usage(canvases: Iterable[tuple[str, dict]]) -> dict[str, dict]:
    """entry id -> {"scenes": [scene ids], "nodes": count} over the given (scene, canvas) pairs."""
    out: dict[str, dict] = {}
    for scene, canvas in canvases:
        for node in canvas.get("nodes") or []:
            bid = (node.get("data") or {}).get("bibleId")
            if not bid:
                continue
            u = out.setdefault(bid, {"scenes": [], "nodes": 0})
            u["nodes"] += 1
            if scene not in u["scenes"]:
                u["scenes"].append(scene)
    return out


def affected(canvases: Iterable[tuple[str, dict]], entry_id: str) -> list[str]:
    return [scene for scene, canvas in canvases
            if any((n.get("data") or {}).get("bibleId") == entry_id for n in canvas.get("nodes") or [])]


def propagate(canvases: Iterable[tuple[str, Path, dict]], entry: Optional[dict], entry_id: str,
              write: Callable[[Path, dict], None]) -> list[dict]:
    """Bring every node linked to `entry_id` in line with the entry, one write per changed canvas.

    `entry=None` unlinks: the nodes keep their file and lose `bibleId`.
    Returns [{"scene", "node_ids"}] for the canvases that changed.
    """
    changed = []
    for scene, canvas_path, canvas in canvases:
        ids = []
        for node in canvas.get("nodes") or []:
            data = node.get("data") or {}
            if data.get("bibleId") != entry_id:
                continue
            if entry is None:
                data.pop("bibleId", None)
            else:
                for key in MIRRORED:
                    data.pop(key, None)
                data.update(mirror(entry))
                # The node's box is what the picture is drawn into: keep its width,
                # fit its height to the new file (same rule as the asset library).
                box_w = node.get("width")
                if (entry.get("mediaType", "image") == "image" and isinstance(box_w, (int, float))
                        and entry.get("width") and entry.get("height")):
                    node["height"] = 32 + min(round(box_w * entry["height"] / entry["width"]), 480)
            node["data"] = data
            ids.append(node.get("id"))
        if ids:
            canvas["revision"] = int(canvas.get("revision", 0)) + 1
            write(canvas_path, canvas)
            changed.append({"scene": scene, "node_ids": ids})
    return changed


def link(canvas: dict, node_ids: Iterable[str], entry: dict) -> list[str]:
    """Mark nodes of one canvas as this entry. Their file fields are left as they are."""
    wanted = set(node_ids)
    done = []
    for node in canvas.get("nodes") or []:
        if node.get("id") in wanted:
            node.setdefault("data", {})["bibleId"] = entry["id"]
            done.append(node["id"])
    return done
