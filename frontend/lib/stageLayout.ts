import { type Node, type Edge } from '@xyflow/react';
import { getNodeBounds } from './layoutEngine';
import { collapsedMemberIds, frameAround, isGroupNode, transitiveMemberIds } from './canvasGroups';

/**
 * Production-stage layout: columns by what a node *does* in the pipeline, rows
 * by which segment it serves.
 *
 * The DAG-lane engine (`calculateCinemaLayout`) layers by graph depth per
 * connected component. On a film canvas every segment shares the cast sheets
 * and the scene plates, so the whole project is one component, every shared
 * reference lands in layer 0 next to the grey boxes, and the result reads as a
 * tangle. This engine instead assigns a fixed column per role and orders each
 * column by the segments the node feeds, so the picture matches how the film is
 * made: inputs -> plate generation -> extracted frames -> references -> segments
 * -> comparisons.
 *
 * Roles are decided from node type and wiring only, never from label text, so a
 * node added over the MCP and wired up sorts itself. The Python twin lives in
 * backend/canvas_mcp_server.py (`arrange_canvas`); keep the two rules identical.
 *
 * Stages (decide role and order, not position):
 *   0 notes        prompt nodes
 *   1 inputs       images with no inbound edge that feed only plate generators
 *   2 plates       generators (video/scene) with an outbound edge into an image node
 *   3 frames       images fed by a generator (extracted plate frames)
 *   4 references   images with no inbound edge that feed segment nodes
 *   5 segments     remaining generators with inbound reference edges
 *   6 dock         derivatives (upscale, interpolate, compare...), unwired videos, unwired images
 *
 * Placement is one ROW per segment, so the canvas grows sideways as well as down
 * (one column per stage made a 1:5 strip once a scene had 30+ references):
 *   notes band      -- across the top
 *   shared band     -- nodes reaching SHARED_MIN_LANES or more segments (cast sheets, voices)
 *   segment rows    -- [its own inputs/frames/references, LEFT_COLS grid] [segment]
 *                      [its derivatives, RIGHT_COLS grid]; the segment column is aligned
 *   loose band      -- nodes that reach no segment
 * A node reaching one or two segments lives in the row of the first. A derivative
 * lives with its id-prefix segment, else with the row of its source. Order within
 * a block: stage, then the barycentre of the lanes reached downstream; segments
 * sort by natural key (seg01 < seg01b < seg02 ...).
 */

export interface StageLayoutOptions {
  colGap?: number;
  rowGap?: number;
  startX?: number;
  startY?: number;
}

const GENERATOR_TYPES = new Set(['video', 'videoEdit', 'videoReshot', 'videoBridge', 'videoContinue', 'videoFrames',
  'charswap', 'videoReangle', 'audioRefine']);
const IMAGE_TYPES = new Set(['image']);
const NOTE_TYPES = new Set(['prompt']);

export const STAGE_NAMES = ['notes', 'inputs', 'plates', 'frames', 'references', 'segments', 'dock'] as const;

/** A reference that reaches this many segments goes to the shared band on top. */
const SHARED_MIN_LANES = 3;
/** Private references beside a segment wrap after this many columns. */
const LEFT_COLS = 3;
/** Derivatives (upscale, compare...) beside their source wrap after this many. */
const RIGHT_COLS = 2;
/** Bands never wrap narrower than this, so a canvas with few segments stays wide. */
const MIN_BAND_WIDTH = 1600;
/** Segment rows wrap into side-by-side blocks whose overall width/height is nearest this. */
const TARGET_ASPECT = 1.6;

function naturalKey(text: string): (string | number)[] {
  return text
    .toLowerCase()
    .split(/(\d+)/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

/** The segment a node names by id prefix ("seg01-new" -> "seg01"), or null. */
function segmentPrefix(id: string, segmentIds: string[]): string | null {
  let best: string | null = null;
  for (const seg of segmentIds) {
    if (id === seg || id.startsWith(seg + '-') || id.startsWith(seg + '_')) {
      if (!best || seg.length > best.length) best = seg;
    }
  }
  return best;
}

/**
 * Segments in chain order. Ids alone put a studio-made node ("video-1789...")
 * after every "s2-c*" one although it sits mid-chain, so the rows follow the
 * motion-context edges instead: each chain from its root, a segment right after
 * the one it continues. Where a segment has several continuations (takes, tests),
 * the side branches come first and the one that carries the chain furthest comes
 * last, so the main line reads on unbroken. `sorted` is the natural-key order,
 * used for roots and ties.
 */
function chainOrder(sorted: Node[], edges: Edge[]): Node[] {
  const ids = new Set(sorted.map((n) => n.id));
  const rank = new Map(sorted.map((n, i) => [n.id, i]));
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  edges.forEach((e) => {
    if (e.targetHandle !== 'in-motion-context') return;
    if (!ids.has(e.source) || !ids.has(e.target) || parent.has(e.target)) return;
    parent.set(e.target, e.source);
    children.set(e.source, [...(children.get(e.source) || []), e.target]);
  });
  const depth = new Map<string, number>();
  const reach = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = 1 + Math.max(0, ...(children.get(id) || []).map((c) => reach(c, seen)));
    depth.set(id, d);
    return d;
  };
  const byId = new Map(sorted.map((n) => [n.id, n]));
  const outList: Node[] = [];
  const placed = new Set<string>();
  const walk = (id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    outList.push(byId.get(id)!);
    [...(children.get(id) || [])]
      .sort((a, b) => reach(a, new Set()) - reach(b, new Set()) || rank.get(a)! - rank.get(b)!)
      .forEach(walk);
  };
  sorted.forEach((n) => {
    if (!parent.has(n.id)) walk(n.id);
  });
  sorted.forEach((n) => walk(n.id)); // cycles
  return outList;
}

export function assignStages(nodes: Node[], edges: Edge[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  nodes.forEach((n) => {
    out.set(n.id, []);
    inn.set(n.id, []);
  });
  edges.forEach((e) => {
    if (byId.has(e.source) && byId.has(e.target)) {
      out.get(e.source)!.push(e.target);
      inn.get(e.target)!.push(e.source);
    }
  });

  const stage = new Map<string, number>();
  const typeOf = (id: string) => byId.get(id)?.type || '';

  // pass 1: plate generators -- a generator whose output is consumed as an image
  nodes.forEach((n) => {
    if (GENERATOR_TYPES.has(n.type || '')) {
      const feedsImage = (out.get(n.id) || []).some((t) => IMAGE_TYPES.has(typeOf(t)));
      if (feedsImage) stage.set(n.id, 2);
    }
  });
  // pass 2: everything else
  nodes.forEach((n) => {
    if (stage.has(n.id)) return;
    const t = n.type || '';
    const ins = inn.get(n.id) || [];
    const outs = out.get(n.id) || [];
    if (NOTE_TYPES.has(t)) {
      stage.set(n.id, 0);
    } else if (IMAGE_TYPES.has(t)) {
      if (ins.some((s) => GENERATOR_TYPES.has(typeOf(s)))) stage.set(n.id, 3);
      else if (outs.length > 0 && outs.every((o) => stage.get(o) === 2)) stage.set(n.id, 1);
      else if (outs.length > 0) stage.set(n.id, 4);
      else stage.set(n.id, 6);
    } else if (GENERATOR_TYPES.has(t)) {
      stage.set(n.id, ins.length > 0 ? 5 : 6);
    } else {
      stage.set(n.id, 6);
    }
  });
  return stage;
}

/**
 * Tidy, with groups respected.
 *
 * Two things are left alone. A group frame is never staged -- it has no role in
 * the pipeline -- and is instead refitted afterwards around wherever its members
 * landed, so the frame still holds what it held. And a COLLAPSED group's members
 * are not moved at all: folding a stretch of work away is how it gets archived,
 * and a tidy that quietly scattered the archive across the columns would undo
 * that the moment anyone expanded it.
 */
export function calculateStageLayout(
  nodes: Node[],
  edges: Edge[],
  options: StageLayoutOptions = {}
): Node[] {
  if (nodes.length === 0) return nodes;
  if (!nodes.some(isGroupNode)) return layoutStages(nodes, edges, options);

  const groups = nodes.filter(isGroupNode);
  const membersBefore = new Map(groups.map((g) => [g.id, transitiveMemberIds(g, nodes)]));
  const archived = collapsedMemberIds(nodes);

  const staged = layoutStages(
    nodes.filter((n) => !isGroupNode(n) && !archived.has(n.id)),
    edges,
    options,
  );
  const moved = new Map(staged.map((n) => [n.id, n]));

  return nodes.map((node) => {
    const placed = moved.get(node.id);
    if (placed) return placed;
    if (!isGroupNode(node)) return node;
    // Refit around the members that are still loose. A frame whose contents are
    // all archived, or all other frames, keeps the size and place it had.
    const members = (membersBefore.get(node.id) || [])
      .map((id) => moved.get(id))
      .filter((n): n is Node => !!n);
    if (members.length === 0) return node;
    const rect = frameAround(members);
    return { ...node, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height };
  });
}

function layoutStages(
  nodes: Node[],
  edges: Edge[],
  options: StageLayoutOptions = {}
): Node[] {
  if (nodes.length === 0) return nodes;
  const { colGap = 120, rowGap = 60, startX = 80, startY = 80 } = options;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  nodes.forEach((n) => out.set(n.id, []));
  edges.forEach((e) => {
    if (byId.has(e.source) && byId.has(e.target)) out.get(e.source)!.push(e.target);
  });

  const stage = assignStages(nodes, edges);

  // segment lanes, in natural order of their id (ids are what agents name them by)
  const segments = chainOrder(
    nodes
      .filter((n) => stage.get(n.id) === 5)
      .sort((a, b) => compareNatural(a.id, b.id) || compareNatural(String(a.data?.label || ''), String(b.data?.label || ''))),
    edges,
  );
  const laneIndex = new Map<string, number>();
  segments.forEach((n, i) => laneIndex.set(n.id, i));
  const segmentIds = segments.map((n) => n.id);

  const inn = new Map<string, string[]>();
  nodes.forEach((n) => inn.set(n.id, []));
  edges.forEach((e) => {
    if (byId.has(e.source) && byId.has(e.target)) inn.get(e.target)!.push(e.source);
  });

  // segment lanes reachable downstream (<= 4 hops), one entry per path
  const reachedLanes = (id: string): number[] => {
    const seen = new Set<string>([id]);
    let frontier = [id];
    const lanes: number[] = [];
    for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
      const next: string[] = [];
      frontier.forEach((cur) => {
        (out.get(cur) || []).forEach((t) => {
          if (seen.has(t)) return;
          seen.add(t);
          if (laneIndex.has(t)) lanes.push(laneIndex.get(t)!);
          else next.push(t);
        });
      });
      frontier = next;
    }
    return lanes;
  };
  // barycentre of those lanes
  const laneKey = (id: string): number | null => {
    const lanes = reachedLanes(id);
    if (lanes.length === 0) return null;
    return lanes.reduce((s, v) => s + v, 0) / lanes.length;
  };

  const sortKey = (n: Node): [number, number, string] => {
    const s = stage.get(n.id) || 0;
    if (s === 5) return [laneIndex.get(n.id) || 0, 0, n.id];
    if (s === 6) {
      const seg = segmentPrefix(n.id, segmentIds);
      if (seg) return [laneIndex.get(seg) || 0, 1, n.id];
      const k = laneKey(n.id);
      return [k === null ? 1e6 + n.position.y : k, 2, n.id];
    }
    const k = laneKey(n.id);
    return [k === null ? 1e6 + n.position.y : k, 0, n.id];
  };

  const byKey = (a: Node, b: Node) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || compareNatural(ka[2], kb[2]);
  };

  // Every node gets a home: one segment's row, the shared band on top (used by
  // SHARED_MIN_LANES or more segments), or the loose band at the bottom.
  const notes: Node[] = [];
  const shared: Node[] = [];
  const loose: Node[] = [];
  const home = new Map<string, number>();
  const derivative = new Set<string>();
  const placeByReach = (n: Node) => {
    const uniq = [...new Set(reachedLanes(n.id))];
    if (uniq.length === 0) loose.push(n);
    else if (uniq.length >= SHARED_MIN_LANES) shared.push(n);
    else home.set(n.id, Math.min(...uniq));
  };
  nodes.forEach((n) => {
    const s = stage.get(n.id) || 0;
    if (s === 0) notes.push(n);
    else if (s >= 1 && s <= 4) placeByReach(n);
  });
  nodes.forEach((n) => {
    if ((stage.get(n.id) || 0) !== 6) return;
    const seg = segmentPrefix(n.id, segmentIds);
    let lane = seg ? laneIndex.get(seg) : undefined;
    if (lane === undefined) {
      for (const src of inn.get(n.id) || []) {
        const l = laneIndex.get(src) ?? home.get(src);
        if (l !== undefined) {
          lane = l;
          break;
        }
      }
    }
    if (lane !== undefined) {
      home.set(n.id, lane);
      derivative.add(n.id);
    } else {
      placeByReach(n);
    }
  });

  const left: Node[][] = segments.map(() => []);
  const right: Node[][] = segments.map(() => []);
  nodes.forEach((n) => {
    const lane = home.get(n.id);
    if (lane === undefined) return;
    (derivative.has(n.id) ? right : left)[lane].push(n);
  });
  left.forEach((items) =>
    items.sort((a, b) => (stage.get(a.id) || 0) - (stage.get(b.id) || 0) || byKey(a, b))
  );
  right.forEach((items) => items.sort(byKey));
  shared.sort(byKey);
  loose.sort(byKey);

  const pos = new Map<string, { x: number; y: number }>();
  const cellGap = colGap / 2;

  const gridWidth = (items: Node[], cols: number) => {
    if (items.length === 0) return 0;
    const cellW = Math.max(...items.map((n) => getNodeBounds(n).width));
    const used = Math.min(cols, items.length);
    return used * cellW + (used - 1) * cellGap;
  };
  // items in a grid of `cols` columns from (x0, y0); returns the height used
  const grid = (items: Node[], x0: number, y0: number, cols: number) => {
    if (items.length === 0) return 0;
    const cellW = Math.max(...items.map((n) => getNodeBounds(n).width));
    let y = y0;
    let rowH = 0;
    items.forEach((n, i) => {
      const c = i % cols;
      if (c === 0 && i > 0) {
        y += rowH + rowGap;
        rowH = 0;
      }
      pos.set(n.id, { x: Math.round(x0 + c * (cellW + cellGap)), y: Math.round(y) });
      rowH = Math.max(rowH, getNodeBounds(n).height);
    });
    return y + rowH - y0;
  };
  // items left to right from startX, wrapping at maxW; returns the height used
  const band = (items: Node[], y0: number, maxW: number) => {
    if (items.length === 0) return 0;
    let x = startX;
    let y = y0;
    let rowH = 0;
    items.forEach((n) => {
      const b = getNodeBounds(n);
      if (x > startX && x + b.width > startX + maxW) {
        x = startX;
        y += rowH + rowGap;
        rowH = 0;
      }
      pos.set(n.id, { x: Math.round(x), y: Math.round(y) });
      x += b.width + cellGap;
      rowH = Math.max(rowH, b.height);
    });
    return y + rowH - y0;
  };

  // column x positions shared by every segment row
  const leftW = Math.max(0, ...left.map((items) => gridWidth(items, LEFT_COLS)));
  const segW = Math.max(0, ...segments.map((n) => getNodeBounds(n).width));
  const rightW = Math.max(0, ...right.map((items) => gridWidth(items, RIGHT_COLS)));
  const segX = startX + (leftW > 0 ? leftW + colGap : 0);
  const rightX = segX + segW + colGap;
  const rowW = rightX + rightW - startX;

  // lay every segment row out at y = 0; it is shifted into place below
  const rows = segments.map((seg, i) => {
    // private references sit right-aligned against their segment
    const lh = grid(left[i], segX - colGap - gridWidth(left[i], LEFT_COLS), 0, LEFT_COLS);
    pos.set(seg.id, { x: Math.round(segX), y: 0 });
    const rh = grid(right[i], rightX, 0, RIGHT_COLS);
    return { members: [...left[i], seg, ...right[i]], h: Math.max(lh, getNodeBounds(seg).height, rh) };
  });

  // Wrap the rows into k side-by-side blocks, in lane order down each block,
  // choosing the k whose overall shape is nearest TARGET_ASPECT.
  const blockGap = colGap * 3;
  const packHeights = (k: number) => {
    const per = Math.ceil(rows.length / k);
    const heights: number[] = [];
    for (let c = 0; c < k; c++) {
      const block = rows.slice(c * per, (c + 1) * per);
      if (block.length) heights.push(block.reduce((s, r) => s + r.h, 0) + (block.length - 1) * rowGap * 2);
    }
    return { per, width: heights.length * rowW + (heights.length - 1) * blockGap, height: Math.max(0, ...heights) };
  };
  let packed = packHeights(1);
  for (let k = 2; k <= rows.length; k++) {
    const p = packHeights(k);
    const off = (q: { width: number; height: number }) => Math.abs(Math.log(q.width / Math.max(q.height, 1) / TARGET_ASPECT));
    if (off(p) < off(packed)) packed = p;
  }
  const totalW = Math.max(MIN_BAND_WIDTH, rows.length ? packed.width : 0);

  // notes: one row across the top
  let y = startY;
  const notesH = band(notes, y, totalW);
  if (notesH > 0) y += notesH + rowGap * 2;

  const sharedH = band(shared, y, totalW);
  if (sharedH > 0) y += sharedH + rowGap * 3;

  let bottom = y;
  const colY: number[] = [];
  rows.forEach((row, i) => {
    const c = Math.floor(i / packed.per);
    const rowY = colY[c] ?? y;
    const dx = c * (rowW + blockGap);
    row.members.forEach((n) => {
      const p = pos.get(n.id)!;
      pos.set(n.id, { x: Math.round(p.x + dx), y: Math.round(p.y + rowY) });
    });
    colY[c] = rowY + row.h + rowGap * 2;
    bottom = Math.max(bottom, colY[c]);
  });

  band(loose, bottom + rowGap, totalW);

  return nodes.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n));
}
