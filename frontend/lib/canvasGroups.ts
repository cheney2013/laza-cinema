import { type Node, type NodeChange, type NodePositionChange } from '@xyflow/react';
import { getNodeBounds } from './layoutEngine';
import { t } from './i18n';

/**
 * ComfyUI-style canvas groups: a titled frame drawn behind the nodes, that
 * carries whatever sits inside it when you drag its header, and folds away when
 * you collapse it.
 *
 * Membership is SPATIAL, recomputed from geometry every time it is needed --
 * not React Flow's `parentId`. Parenting is the obvious implementation and it
 * is the wrong one here: React Flow stores a child's `position` relative to its
 * parent, and every other consumer of this canvas reads positions as absolute
 * -- `stageLayout.ts`, its Python twin `arrange_canvas`, and every MCP write.
 * Adopting a node into a group would silently change what its stored position
 * means, in a file that agents edit without going through this component.
 * Spatial membership costs one bounding-box test per node and changes nothing
 * on disk except the group's own frame.
 *
 * A node belongs to a group when its CENTRE is inside the group's body. Centres
 * rather than full containment so that a node poking over the edge still moves
 * with the frame it visually sits in, and so that two overlapping groups divide
 * their nodes predictably instead of both claiming the overlap.
 */

export const GROUP_TYPE = 'group';

/** Height of the title bar. The body starts below it; nodes live in the body. */
export const GROUP_HEADER_H = 34;

/** Slack left around the members when a group is fitted to a selection. */
export const GROUP_PADDING = 32;

export const GROUP_MIN_WIDTH = 220;
export const GROUP_MIN_HEIGHT = GROUP_HEADER_H + 80;

/** Frame colours offered in the header menu. Kept muted: the frame sits behind
 *  the work and must never compete with a clip for attention. */
export const GROUP_COLORS = [
  '#3f4756', '#4a3f56', '#3f5648', '#564a3f', '#563f45', '#3f5056',
] as const;

export const DEFAULT_GROUP_COLOR = GROUP_COLORS[0];

export interface GroupData {
  title: string;
  color: string;
  collapsed: boolean;
  [key: string]: unknown;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isGroupNode(node: Node): boolean {
  return node.type === GROUP_TYPE;
}

export function groupData(node: Node): GroupData {
  const data = (node.data || {}) as Partial<GroupData>;
  return {
    title: typeof data.title === 'string' ? data.title : t('分组'),
    color: typeof data.color === 'string' ? data.color : DEFAULT_GROUP_COLOR,
    collapsed: data.collapsed === true,
  };
}

/** A node's absolute rectangle, using the same size rules as the layout engine. */
export function nodeRect(node: Node): Rect {
  const { width, height } = getNodeBounds(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

/** A group's own frame, including its title bar. */
export function groupRect(group: Node): Rect {
  return {
    x: group.position.x,
    y: group.position.y,
    width: Math.max(group.width ?? GROUP_MIN_WIDTH, GROUP_MIN_WIDTH),
    height: Math.max(group.height ?? GROUP_MIN_HEIGHT, GROUP_MIN_HEIGHT),
  };
}

/** The part of a group that holds nodes: the frame minus its title bar. */
export function groupBody(group: Node): Rect {
  const rect = groupRect(group);
  return {
    x: rect.x,
    y: rect.y + GROUP_HEADER_H,
    width: rect.width,
    height: Math.max(rect.height - GROUP_HEADER_H, 0),
  };
}

function centreInside(rect: Rect, body: Rect): boolean {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return cx >= body.x && cx <= body.x + body.width
    && cy >= body.y && cy <= body.y + body.height;
}

/**
 * Ids of the nodes a group carries: everything whose centre is in its body,
 * itself excluded. Other groups count, so groups nest.
 *
 * Once collapsed, the ids recorded at collapse time are what the group keeps:
 * its members are hidden and its own frame has shrunk to the title bar, so
 * geometry can no longer answer the question. Before those ids exist -- the
 * instant the flag is set -- geometry still answers it, which is how the
 * recording gets made.
 */
export function memberIds(group: Node, nodes: Node[]): string[] {
  const data = group.data as Partial<GroupData> | undefined;
  const kept = (data as { collapsedMemberIds?: unknown } | undefined)?.collapsedMemberIds;
  if (data?.collapsed && Array.isArray(kept)) {
    return kept.filter((id): id is string => typeof id === 'string');
  }
  const body = groupBody(group);
  return nodes
    .filter((n) => n.id !== group.id && centreInside(nodeRect(n), body))
    .map((n) => n.id);
}

/**
 * Every node a drag of `group` should carry, following nesting: the members,
 * plus the members of any group among them, and so on. Cycles (two groups each
 * containing the other's centre) terminate on the visited set.
 */
export function transitiveMemberIds(group: Node, nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([group.id]);
  const out: string[] = [];
  const queue = [group];
  while (queue.length) {
    const current = queue.shift()!;
    for (const id of memberIds(current, nodes)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      const child = byId.get(id);
      if (child && isGroupNode(child)) queue.push(child);
    }
  }
  return out;
}

/** The frame that would hold `nodes`, with room for the title bar and padding. */
export function frameAround(nodes: Node[], padding = GROUP_PADDING): Rect {
  if (nodes.length === 0) {
    return { x: 0, y: 0, width: GROUP_MIN_WIDTH, height: GROUP_MIN_HEIGHT };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const rect = nodeRect(node);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return {
    x: minX - padding,
    y: minY - padding - GROUP_HEADER_H,
    width: Math.max(maxX - minX + padding * 2, GROUP_MIN_WIDTH),
    height: Math.max(maxY - minY + padding * 2 + GROUP_HEADER_H, GROUP_MIN_HEIGHT),
  };
}

/** A new group node fitted around `members`. */
export function createGroupNode(members: Node[], title = t('分组'), id?: string): Node {
  const rect = frameAround(members);
  return {
    id: id ?? `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type: GROUP_TYPE,
    position: { x: rect.x, y: rect.y },
    width: rect.width,
    height: rect.height,
    data: { title, color: DEFAULT_GROUP_COLOR, collapsed: false } satisfies GroupData,
    selected: false,
    // Only the header drags the frame; the body is click-through so the nodes
    // inside stay reachable.
    dragHandle: '.canvas-group-handle',
  } as Node;
}

/**
 * Groups paint behind the nodes they hold. React Flow draws in array order and
 * has no z-index of its own for nodes, so ordering the array IS the z-order.
 * Nested groups keep their relative order, outermost first, by area.
 */
export function groupsFirst(nodes: Node[]): Node[] {
  if (!nodes.some(isGroupNode)) return nodes;
  const groups: Node[] = [];
  const rest: Node[] = [];
  for (const node of nodes) (isGroupNode(node) ? groups : rest).push(node);
  groups.sort((a, b) => {
    const ra = groupRect(a);
    const rb = groupRect(b);
    return rb.width * rb.height - ra.width * ra.height;
  });
  return [...groups, ...rest];
}

/**
 * Settle a group's frame and recorded members against its `collapsed` flag.
 *
 * Collapsing is expressed as one boolean, and this pass does everything that
 * follows from it: record the members while geometry can still name them, keep
 * the expanded height so expanding restores the frame the user drew, and shrink
 * the frame to its title bar. Expanding undoes exactly that.
 *
 * It runs over the whole node array rather than inside the group component, so
 * that a `collapsed` flag written by the canvas MCP behaves the same as one
 * clicked in the studio. Returns the same array when there is nothing to do.
 */
export function reconcileGroups(nodes: Node[]): Node[] {
  if (!nodes.some(isGroupNode)) return nodes;
  let changed = false;
  const out = nodes.map((node) => {
    if (!isGroupNode(node)) return node;
    const data = (node.data || {}) as Record<string, unknown>;
    const collapsed = data.collapsed === true;
    const recorded = Array.isArray(data.collapsedMemberIds);
    if (collapsed && !recorded) {
      changed = true;
      return {
        ...node,
        height: GROUP_HEADER_H,
        data: {
          ...data,
          collapsedMemberIds: transitiveMemberIds(node, nodes),
          expandedHeight: node.height ?? GROUP_MIN_HEIGHT,
        },
      };
    }
    if (!collapsed && recorded) {
      changed = true;
      const { collapsedMemberIds: _drop, expandedHeight, ...rest } = data;
      return {
        ...node,
        height: typeof expandedHeight === 'number' ? expandedHeight : GROUP_MIN_HEIGHT,
        data: rest,
      };
    }
    return node;
  });
  return changed ? out : nodes;
}

/**
 * Add the position changes that a group drag implies for what it carries.
 *
 * A node that is moving on its own in the same batch is left alone -- dragging
 * a multi-selection that includes both a group and one of its members must not
 * move that member twice.
 */
export function withGroupMemberMoves(changes: NodeChange[], nodes: Node[]): NodeChange[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moves = changes.filter(
    (c): c is NodePositionChange =>
      c.type === 'position' && !!(c as NodePositionChange).position,
  );
  const dragged = moves.filter((c) => {
    const node = byId.get(c.id);
    return !!node && isGroupNode(node);
  });
  if (dragged.length === 0) return changes;

  const movingOnItsOwn = new Set(moves.map((c) => c.id));
  const carried = new Set<string>();
  const extra: NodeChange[] = [];
  for (const change of dragged) {
    const group = byId.get(change.id)!;
    const dx = change.position!.x - group.position.x;
    const dy = change.position!.y - group.position.y;
    if (dx === 0 && dy === 0) continue;
    for (const id of transitiveMemberIds(group, nodes)) {
      if (movingOnItsOwn.has(id) || carried.has(id)) continue;
      const member = byId.get(id);
      if (!member) continue;
      carried.add(id);
      extra.push({
        id,
        type: 'position',
        position: { x: member.position.x + dx, y: member.position.y + dy },
        dragging: change.dragging,
      });
    }
  }
  return extra.length ? [...changes, ...extra] : changes;
}

/** Ids hidden by every collapsed group on the canvas. */
export function collapsedMemberIds(nodes: Node[]): Set<string> {
  const hidden = new Set<string>();
  for (const node of nodes) {
    if (!isGroupNode(node)) continue;
    if (!groupData(node).collapsed) continue;
    for (const id of transitiveMemberIds(node, nodes)) hidden.add(id);
  }
  return hidden;
}
