"""Where a node created over MCP goes.

An agent adding nodes should not have to pick coordinates. A new node is put where a
person would put it: to the right of what feeds it, to the left of what it feeds,
stacked with its siblings in the same column, and never on top of anything. A node
with no wiring yet goes in a row below everything, so it is easy to find.

Pure functions over the canvas dicts (`nodes`, `edges`); `size_of(node) -> (w, h)` is
passed in because the studio and the MCP server know node sizes by type.

Placement is a local search: the preferred spot comes from the wiring, then the
nearest free spot (down before up, and only in the direction the wiring allows) is
taken. Nodes are placed in the order given, each seeing those placed before it, and a
node whose wired neighbour is itself still waiting is placed after that neighbour.
"""

from __future__ import annotations

from typing import Any, Callable

GAP = 60        # between a node and the column it is wired to
MARGIN = 24     # kept clear around every node
STEP = 40       # search grid
ROW_WIDTH = 2600  # unwired nodes wrap after this much width

Rect = tuple[float, float, float, float]  # x, y, w, h


def _overlaps(a: Rect, b: Rect, margin: float) -> bool:
    return not (a[0] + a[2] + margin <= b[0] or b[0] + b[2] + margin <= a[0]
                or a[1] + a[3] + margin <= b[1] or b[1] + b[3] + margin <= a[1])


def _candidates(direction: int) -> list[tuple[int, int]]:
    """Offsets from the preferred spot, nearest first. direction: +1 right only,
    -1 left only, 0 either way. Down is preferred to up."""
    out = []
    for dx_steps in range(0, 61):
        for dy_steps in range(-15, 81):
            dx, dy = dx_steps * STEP, dy_steps * STEP
            cost = abs(dx) * 3.0 + (dy if dy >= 0 else -dy * 1.4)
            out.append((cost, dx, dy))
    out.sort()
    result = []
    for _, dx, dy in out:
        if direction >= 0:
            result.append((dx, dy))
        if direction <= 0 and (dx or direction < 0):
            result.append((-dx, dy))
    return result


_CAND = {d: _candidates(d) for d in (-1, 0, 1)}


def place_nodes(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], new_ids: list[str],
                size_of: Callable[[dict[str, Any]], tuple[int, int]]) -> dict[str, dict[str, int]]:
    """Positions for new_ids ({id: {"x", "y"}}). Writes nothing."""
    by_id = {n["id"]: n for n in nodes}
    pending = [i for i in new_ids if i in by_id]
    rects: dict[str, Rect] = {}
    for n in nodes:
        if n["id"] in pending:
            continue
        p = n.get("position") or {}
        w, h = size_of(n)
        rects[n["id"]] = (float(p.get("x", 0)), float(p.get("y", 0)), float(w), float(h))

    def neighbours(node_id: str) -> tuple[list[str], list[str]]:
        ins = [e["source"] for e in edges if e.get("target") == node_id and e.get("source") in by_id]
        outs = [e["target"] for e in edges if e.get("source") == node_id and e.get("target") in by_id]
        return ins, outs

    positions: dict[str, dict[str, int]] = {}
    cursor: list[float] | None = None   # where the next unwired node goes

    def free_spot(w: float, h: float) -> tuple[float, float]:
        nonlocal cursor
        if cursor is None:
            if rects:
                left = min(r[0] for r in rects.values())
                bottom = max(r[1] + r[3] for r in rects.values())
                cursor = [left, bottom + 2 * GAP, left]
            else:
                cursor = [0.0, 0.0, 0.0]
        if cursor[0] - cursor[2] + w > ROW_WIDTH:
            cursor[0] = cursor[2]
            cursor[1] = max([r[1] + r[3] for r in rects.values() if r[1] >= cursor[1] - 1] or [cursor[1]]) + GAP
        return cursor[0], cursor[1]

    def settle(node: dict[str, Any], want_x: float, want_y: float, direction: int,
               limit: Callable[[float, float], bool], w: float, h: float) -> tuple[float, float]:
        for dx, dy in _CAND[direction]:
            x, y = want_x + dx, want_y + dy
            if not limit(x, y):
                continue
            cand = (x, y, w, h)
            if not any(_overlaps(cand, r, MARGIN) for r in rects.values()):
                return x, y
        # nothing free in reach: below everything
        return want_x, max([r[1] + r[3] for r in rects.values()] + [want_y]) + GAP

    while pending:
        # Upstream first, so a chain added in one batch runs left to right: an anchored node
        # (a placed neighbour, no pending input), then one with no pending neighbour, then a
        # root of new nodes (no pending input), then whatever is first.
        def pending_in(i: str) -> bool:
            return any(j in pending and j != i for j in neighbours(i)[0])

        def has_placed(i: str) -> bool:
            return any(j in rects for j in neighbours(i)[0] + neighbours(i)[1])

        def lone(i: str) -> bool:
            return not any(j in pending and j != i for j in neighbours(i)[0] + neighbours(i)[1])

        node_id = (next((i for i in pending if has_placed(i) and not pending_in(i)), None)
                   or next((i for i in pending if lone(i)), None)
                   or next((i for i in pending if not pending_in(i)), None)
                   or pending[0])
        ins, outs = neighbours(node_id)
        node = by_id[node_id]
        w, h = size_of(node)
        placed_in = [i for i in ins if i in rects]
        placed_out = [i for i in outs if i in rects]
        if placed_in:
            right = max(rects[i][0] + rects[i][2] for i in placed_in)
            primary = rects[placed_in[0]]
            x, y = settle(node, right + GAP, primary[1], 1, lambda px, py, r=right: px >= r + GAP / 2, w, h)
        elif placed_out:
            target = rects[placed_out[0]]
            siblings = [rects[e["source"]] for e in edges
                        if e.get("target") == placed_out[0] and e.get("source") in rects
                        and e.get("source") != node_id
                        and rects[e["source"]][0] + rects[e["source"]][2] <= target[0]
                        # a sibling far away (inputs wired in from all over a big canvas)
                        # is not the column this one belongs to
                        and target[0] - (rects[e["source"]][0] + rects[e["source"]][2]) <= 3 * (w + GAP)]
            col = min(s_[0] for s_ in siblings) if siblings else target[0] - w - GAP
            left_edge = min(rects[i][0] for i in placed_out)
            x, y = settle(node, col, target[1], 0 if siblings else -1,
                          lambda px, py, le=left_edge, ww=w: px + ww <= le - GAP / 2, w, h)
        else:
            fx, fy = free_spot(w, h)
            x, y = settle(node, fx, fy, 1, lambda px, py: True, w, h)
            cursor[0] = x + w + GAP  # type: ignore[index]
            cursor[1] = y            # type: ignore[index]
        rects[node_id] = (x, y, float(w), float(h))
        positions[node_id] = {"x": int(round(x)), "y": int(round(y))}
        pending.remove(node_id)
    return positions
