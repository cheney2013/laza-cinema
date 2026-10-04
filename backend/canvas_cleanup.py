"""Which nodes on a canvas are leftovers nobody uses.

Repairing a plate or a frame with Qwen leaves a trail: the grabbed still, each edit
pass, the variants that lost. Most of it is dead weight on the canvas, but some of it
(a clean prop board, a corrected plate) is worth keeping for later. This finds the
dead ends so they can be sorted: kept in the library (the bible) or removed.

A node is *in use* when something still depends on it:
- it is linked to a bible entry (the library already holds it);
- an edge leads from it to a node that is not itself an intermediate (a shot, an
  enhancement, a trim, an audio node ...), or to an intermediate that is in use;
- another node's data holds its id as a value (an audio lock's node, a guide); a label or
  prompt that only mentions it in text does not count.

Only intermediates are ever candidates: Qwen edits and plain image nodes (stills,
uploads, frame grabs). A node that carries audio or video, a shot, or a group is
never listed. Pure; writes nothing.
"""

from __future__ import annotations

import json
from typing import Any

#: Node types that are steps on the way to something, not the something.
INTERMEDIATE_TYPES = ("qwenImage", "image")


def _is_intermediate(node: dict[str, Any]) -> bool:
    if node.get("type") not in INTERMEDIATE_TYPES:
        return False
    # an "image" node also carries audio and video files (voice refs, imported clips)
    media = (node.get("data") or {}).get("mediaType")
    return media in (None, "", "image")


def _url_of(node: dict[str, Any]) -> str | None:
    data = node.get("data") or {}
    return data.get("generatedUrl") or data.get("url") or None


def find_unused(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Intermediate nodes nothing depends on, each with why and what it feeds."""
    by_id = {n["id"]: n for n in nodes}
    inter = {i for i, n in by_id.items() if _is_intermediate(n)}
    out: dict[str, list[str]] = {i: [] for i in by_id}
    inn: dict[str, list[str]] = {i: [] for i in by_id}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s in by_id and t in by_id:
            out[s].append(t)
            inn[t].append(s)

    # named in another node's data (an audio lock's "node", a guide ...): a string that IS the
    # id, anywhere in the data. A label or a prompt that merely mentions it does not count.
    named: set[str] = set()

    def walk(value: Any, owner: str) -> None:
        if isinstance(value, str):
            if value in inter and value != owner:
                named.add(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v, owner)
        elif isinstance(value, list):
            for v in value:
                walk(v, owner)

    for n in nodes:
        walk(n.get("data") or {}, n["id"])

    # a node that is rendering right now is in use whatever is wired to it
    busy = {i for i in inter if (by_id[i].get("data") or {}).get("status") in ("generating", "queued", "loading")}
    used = {i for i in inter
            if (by_id[i].get("data") or {}).get("bibleId") or i in named or i in busy}
    changed = True
    while changed:
        changed = False
        for i in inter - used:
            if any(t not in inter or t in used for t in out[i]):
                used.add(i)
                changed = True

    result = []
    for i in sorted(inter - used):
        n = by_id[i]
        data = n.get("data") or {}
        feeds = out[i]
        result.append({
            "id": i,
            "type": n.get("type"),
            "label": str(data.get("label") or "")[:100],
            "url": _url_of(n),
            "why": "feeds only other unused nodes" if feeds else "dead end: nothing is wired from it",
            "feeds": feeds,
            "fed_by": inn[i],
            "deprecated": any(w in str(data.get("label") or "") for w in ("弃用", "已弃", "unused", "废")),
        })
    return result
