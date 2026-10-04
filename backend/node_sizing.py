"""Canvas node size floors, enforced wherever a canvas is written.

A node whose box is smaller than its own controls cuts them off. The studio lifts
old sizes when it opens a canvas (frontend/lib/migrations.ts migrateNodeSizes),
but a node created any other way -- the canvas MCP, a script, a copied project --
never passes through that, and the studio then shows it clipped until someone
opens the right canvas. The floors are therefore applied here, in the one place
every writer goes through (PUT /projects/{id}/canvas), with the same numbers the
studio uses: both read frontend/lib/nodeFloors.json.

Raise only. A node the user made larger is left alone, and nothing here narrows a
box; the studio's own migration still applies its width cap and audio strip when
the canvas is opened.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_FLOORS_PATH = Path(__file__).resolve().parent.parent / "frontend" / "lib" / "nodeFloors.json"
_FLOORS = json.loads(_FLOORS_PATH.read_text(encoding="utf-8"))

DEFAULT_DIMS: dict[str, tuple[int, int]] = {
    t: (int(d["width"]), int(d["height"])) for t, d in _FLOORS["defaultDims"].items()}
_FLOOR_DEFAULT = _FLOORS["chromeFloorDefault"]
_FLOOR_BY_TYPE = _FLOORS["chromeFloorByType"]
_MEDIA_MIN_H = float(_FLOORS["mediaMinH"])
_AUDIO_CONTENT_H = float(_FLOORS["audioContentH"])
_FALLBACK_RATIO = float(_FLOORS["fallbackRatio"])


def _num(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _js_round(x: float) -> int:
    """Math.round: halves go up (Python's round() sends them to the even neighbour)."""
    return int(x + 0.5)


def node_floor(node: dict[str, Any]) -> tuple[int, int]:
    """The smallest (width, height) at which this node still shows all its controls."""
    ntype = node.get("type") or ""
    data = node.get("data") or {}
    floor = _FLOOR_BY_TYPE.get(ntype) or _FLOOR_DEFAULT
    min_w = float(floor["minW"])

    w, h = _num(data.get("width")), _num(data.get("height"))
    ratio = w / h if w and h else _FALLBACK_RATIO

    width = max(_num(node.get("width")) or float(DEFAULT_DIMS.get(ntype, (0, 0))[0] or min_w), min_w)
    label_extra = 0 if ntype in ("image", "preview") else (
        (36 if len(str(data.get("label"))) > 30 else 20) if data.get("label") else 0)
    chrome_h = float(floor["chromeH"]) + label_extra

    if data.get("mediaType") == "audio":
        height = float(floor["chromeH"]) + _AUDIO_CONTENT_H
    elif data.get("url") or data.get("generatedUrl"):
        height = chrome_h + max(width / ratio, _MEDIA_MIN_H)
    else:
        height = chrome_h + max(min_w / ratio, _MEDIA_MIN_H)
    return _js_round(width), _js_round(height)


def enforce_node_floors(nodes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Lift every node that is smaller than its floor. Returns (nodes, how many changed)."""
    changed = 0
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") in (None, "group"):
            continue
        min_w, min_h = node_floor(node)
        cur_w, cur_h = _num(node.get("width")), _num(node.get("height"))
        new_w = max(cur_w or 0, min_w)
        new_h = max(cur_h or 0, min_h)
        if cur_w == new_w and cur_h == new_h:
            continue
        node["width"], node["height"] = _js_round(new_w), _js_round(new_h)
        # React Flow reads style.width/height first when they are set; keep them in step.
        style = node.get("style")
        if isinstance(style, dict):
            if _num(style.get("width")) is not None:
                style["width"] = max(_num(style["width"]) or 0, _js_round(new_w))
            if _num(style.get("height")) is not None:
                style["height"] = max(_num(style["height"]) or 0, _js_round(new_h))
        changed += 1
    return nodes, changed
