import type { Node, Edge } from '@xyflow/react';
import { DEFAULT_NODE_DIMENSIONS } from './types';
import { getChromeFloor, getMaxWidth, resolveMediaRatio, MEDIA_MIN_H, AUDIO_CONTENT_H } from './nodeSizing';

/**
 * Turn nodes of the removed FLUX image (`scene`) and style-capsule (`style`)
 * types into asset nodes.
 *
 * Both were taken out on 2026-09-17: stills come from H3 renders and frame
 * grabs, and nothing consumed a style capsule any more. What a canvas holds is
 * kept: a generated or uploaded picture stays on the canvas as an ordinary
 * asset node (with its prompt and label), wired to what it fed. Edges into the
 * old node's own inputs (prompt, style, reference image, pose) go, because an
 * asset node has none.
 */
export function migrateRemovedImageNodes(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[]; migrated: number } {
  const removed = new Set(nodes.filter((n) => n.type === 'scene' || n.type === 'style').map((n) => n.id));
  if (removed.size === 0) return { nodes, edges, migrated: 0 };
  const nextNodes = nodes.map((n) => {
    if (!removed.has(n.id)) return n;
    const d = (n.data as Record<string, unknown>) || {};
    const url = (n.type === 'scene' ? d.generatedUrl : d.previewUrl) as string | null | undefined;
    const data: Record<string, unknown> = { url: url || null, mediaType: 'image' };
    for (const key of ['width', 'height', 'alias', 'userWidth']) if (d[key] !== undefined) data[key] = d[key];
    const label = (d.label as string) || (d.prompt ? String(d.prompt).slice(0, 60) : '');
    if (label && label !== 'Style') data.label = label;
    if (d.prompt) data.prompt = d.prompt;
    return { ...n, type: 'image', data };
  });
  const nextEdges = edges
    .filter((e) => !removed.has(e.target))
    .map((e) => (removed.has(e.source) ? { ...e, sourceHandle: 'out-image' } : e));
  return { nodes: nextNodes, edges: nextEdges, migrated: removed.size };
}

/**
 * Turn nodes of the retired recast, motion-transfer and performer-mask types into
 * asset nodes, and send `videoEdit` nodes left in those modes back to a plain edit.
 *
 * SCAIL-2 recast, motion transfer and SAM3 performer masking were taken out on
 * 2026-09-19 (their weights are gone from the workstation). As with
 * `migrateRemovedImageNodes`, what a canvas holds is kept: a rendered clip (or a
 * mask preview) stays on the canvas as an ordinary video asset node with its label
 * and prompt, wired to what it fed. Edges into the old node's own inputs go,
 * because an asset node has none.
 */
const RETIRED_GENERATORS = new Set(['recast', 'motionTransfer', 'performerMask']);
const RETIRED_EDIT_MODES = new Set(['recast', 'motion_transfer']);

export function migrateRetiredGenerators(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[]; migrated: number } {
  const removed = new Set(nodes.filter((n) => RETIRED_GENERATORS.has(n.type as string)).map((n) => n.id));
  let migrated = removed.size;
  const nextNodes = nodes.map((n) => {
    const d = (n.data as Record<string, unknown>) || {};
    if (n.type === 'videoEdit' && RETIRED_EDIT_MODES.has(d.editMode as string)) {
      migrated += 1;
      return { ...n, data: { ...d, editMode: 'edit' } };
    }
    if (!removed.has(n.id)) return n;
    const url = (d.generatedUrl || d.previewUrl) as string | null | undefined;
    const data: Record<string, unknown> = { url: url || null, mediaType: 'video' };
    for (const key of ['width', 'height', 'alias', 'userWidth']) if (d[key] !== undefined) data[key] = d[key];
    const label = (d.label as string) || (d.prompt ? String(d.prompt).slice(0, 60) : '');
    if (label) data.label = label;
    if (d.prompt) data.prompt = d.prompt;
    return { ...n, type: 'image', data };
  });
  if (migrated === 0) return { nodes, edges, migrated: 0 };
  const nextEdges = removed.size === 0 ? edges : edges
    .filter((e) => !removed.has(e.target))
    .map((e) => (removed.has(e.source) ? { ...e, sourceHandle: 'out-video' } : e));
  return { nodes: nextNodes, edges: nextEdges, migrated };
}

/** The H3 edit operations, one node type each (VideoEditNode.tsx). */
export const EDIT_FAMILY = new Set(['videoEdit', 'videoReshot', 'videoBridge', 'videoContinue', 'videoFrames']);

const EDIT_MODE_TYPES: Record<string, string> = {
  temporal_reshot: 'videoReshot',
  av_bridge: 'videoBridge',
  continuation: 'videoContinue',
  fl2va: 'videoFrames',
};

/**
 * Give each H3 edit operation its own node type.
 *
 * `videoEdit` used to carry five operations behind a mode list, and each needs
 * different inputs and a different way of choosing what changes (a window on
 * the source for the two repairs, the source's end for a continuation, two
 * frames for a transition). The node keeps its id, data and edges; only its
 * type changes, and the handle ids are the same on the new node. A node that
 * never chose a mode was an edit unless both frame inputs were wired, which is
 * the rule the old node applied at render time.
 */
export function migrateEditModeNodes(nodes: Node[], edges: Edge[]): { nodes: Node[]; migrated: number } {
  let migrated = 0;
  const next = nodes.map((n) => {
    if (n.type !== 'videoEdit') return n;
    const data = (n.data as Record<string, unknown>) || {};
    let mode = data.editMode as string | undefined;
    if (!mode) {
      const handles = new Set(edges.filter((e) => e.target === n.id).map((e) => e.targetHandle));
      mode = handles.has('in-first-frame') && handles.has('in-last-frame') ? 'fl2va' : 'edit';
    }
    const type = EDIT_MODE_TYPES[mode];
    if (!type) return n;
    migrated += 1;
    const { editMode: _mode, ...rest } = data;
    const dims = DEFAULT_NODE_DIMENSIONS[type];
    return {
      ...n,
      type,
      data: rest,
      width: Math.max(n.width ?? 0, dims.width),
      height: Math.max(n.height ?? 0, dims.height),
    };
  });
  return { nodes: migrated ? next : nodes, migrated };
}

/**
 * Mark pre-console H3 nodes as hand-written.
 *
 * The console compiles `prompt` from `directorSpec` while `promptSource` is
 * `'director'`. A saved node has neither field, and an absent `promptSource` has
 * to keep meaning "the text in `prompt` is authoritative" — otherwise opening the
 * console on an old node would compile an empty spec over work someone wrote by
 * hand. Stamping it explicitly makes that intent survive future defaults.
 */
export function migrateDirectorPromptSource(nodes: Node[]): { nodes: Node[]; migrated: number } {
  let migrated = 0;
  const next = nodes.map((n) => {
    if (n.type !== 'video' && !EDIT_FAMILY.has(n.type as string)) return n;
    const data = (n.data as Record<string, unknown>) || {};
    if (data.promptSource || data.directorSpec) return n;
    migrated += 1;
    return { ...n, data: { ...data, promptSource: 'manual' } };
  });
  return { nodes: migrated ? next : nodes, migrated };
}

/**
 * 把旧工程的节点尺寸抬到新的下限。
 *
 * 旧尺寸是各节点手写常量算出来的，普遍偏小 —— 最典型的是竖屏视频节点被算成 200px 宽，
 * 而标题栏那排按钮要 400 多。挂载后 `useAutoFitNode` 会各自纠正，但那要等到节点真的
 * 渲染；先在这里过一遍，画布一打开位置与包围盒就是对的，自动排版也不会拿旧尺寸去算。
 *
 * **只抬不降**：用户拖大过的节点保持原样。这里用的是每个类型的兜底功能区尺寸，
 * 不是实测标定值 —— 迁移发生在任何节点渲染之前，那会儿还没量过。宁可保守。
 */
export function migrateNodeSizes(nodes: Node[]): { nodes: Node[]; migrated: number } {
  let migrated = 0;
  const next = nodes.map((n) => {
    const floor = getChromeFloor(n.type);
    const data = (n.data as Record<string, unknown>) || {};
    const ratio = resolveMediaRatio({
      width: data.width as number | undefined,
      height: data.height as number | undefined,
    });

    const minW = floor.minW;
    const maxW = Math.max(getMaxWidth(n.type), minW);
    const width = Math.min(Math.max(n.width ?? DEFAULT_NODE_DIMENSIONS[n.type || '']?.width ?? minW, minW), maxW);
    const hasMedia = Boolean(data.url || data.generatedUrl);
    const labelExtra = n.type === 'image' || n.type === 'preview' ? 0 : (data.label ? (String(data.label).length > 30 ? 36 : 20) : 0);
    const chromeH = floor.chromeH + labelExtra;
    const expectedH = Math.round(chromeH + Math.max(width / ratio, MEDIA_MIN_H));
    const minH = Math.round(chromeH + Math.max(minW / ratio, MEDIA_MIN_H));
    // An audio clip has no picture: it is a strip (header + player row), and one
    // saved as a media card is shrunk to that, not held at a picture's height.
    const isAudio = data.mediaType === 'audio';
    const height = isAudio
      ? Math.round(floor.chromeH + AUDIO_CONTENT_H)
      : hasMedia ? Math.max(n.height ?? 0, expectedH) : Math.max(n.height ?? 0, minH);

    if (n.width === width && n.height === height) return n;
    migrated += 1;
    return { ...n, width, height };
  });
  return { nodes: migrated ? next : nodes, migrated };
}


/**
 * Strip the host from asset URLs saved into node data.
 *
 * Everything in this app stores backend-relative paths (`/uploads/...`) and
 * resolves them at render time through `resolveAssetUrl`, so one canvas works
 * over localhost, a LAN address and Tailscale alike. One writer — 抽帧 on the H3
 * video node — used to persist `${API_BASE}${url}` instead, and API_BASE is
 * whatever host the page happened to be opened on. A frame captured on the
 * machine itself therefore saved `http://localhost:8003/...`, which resolves to
 * nothing from any other device: the node renders empty and the file cannot be
 * used as a reference either.
 *
 * Only our own paths are rewritten. An external image someone pasted keeps its
 * host, because for that one the host is the address.
 */
const BACKEND_PATHS = ['/uploads/', '/comfy_output/'];

function stripHost(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const { pathname, search } = new URL(value);
    return BACKEND_PATHS.some((prefix) => pathname.startsWith(prefix))
      ? `${pathname}${search}`
      : value;
  } catch {
    return value;
  }
}

function stripHostDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripHost(value);
  if (Array.isArray(value)) return value.map(stripHostDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripHostDeep(v)])
    );
  }
  return value;
}

export function migrateAbsoluteAssetUrls(nodes: Node[]): { nodes: Node[]; migrated: number } {
  let migrated = 0;
  const next = nodes.map((n) => {
    const data = (n.data as Record<string, unknown>) || {};
    const cleaned = stripHostDeep(data) as Record<string, unknown>;
    if (JSON.stringify(cleaned) === JSON.stringify(data)) return n;
    migrated += 1;
    return { ...n, data: cleaned };
  });
  return { nodes: migrated ? next : nodes, migrated };
}

/**
 * Drop the dead `comfyFilename` from saved `image` nodes.
 *
 * It duplicated the node's own URL and was never revised, so replacing a node's
 * picture (an upscale, a re-upload) left the old file's name behind — and the
 * reference resolver used to prefer that name, quietly sending the model the
 * previous picture with nothing anywhere reporting a problem. The URL is now the
 * only handle, so the leftover field is removed rather than left to be read again.
 *
 * Only `image` nodes are touched: on style, upload, gaussian and video nodes the
 * same field is live data and is kept in sync by whatever writes it.
 */
export function migrateImageComfyFilename(nodes: Node[]): { nodes: Node[]; migrated: number } {
  let migrated = 0;
  const next = nodes.map((n) => {
    if (n.type !== 'image') return n;
    const data = (n.data as Record<string, unknown>) || {};
    if (!('comfyFilename' in data)) return n;
    const { comfyFilename: _dropped, ...rest } = data;
    migrated += 1;
    return { ...n, data: rest };
  });
  return { nodes: migrated ? next : nodes, migrated };
}

/**
 * Point an edge at the handle its source node actually renders.
 *
 * An asset node declares image/video/audio output ports but renders only the one its
 * current media calls for, so an old edge saved as `out-image` from a node now holding a
 * video has nothing to attach to: React Flow logs error 008 and simply does not draw the
 * wire. The connection itself is read from the edge list, so this only ever restored a
 * missing line - no data moved.
 */
export function migrateAssetSourceHandles(
  nodes: Node[],
  edges: Edge[],
): { edges: Edge[]; migrated: number } {
  const media = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === 'image') media.set(n.id, ((n.data as any)?.mediaType as string) || 'image');
  }
  let migrated = 0;
  const next = edges.map((e) => {
    const kind = media.get(e.source);
    if (!kind) return e;
    const want = `out-${kind}`;
    if (e.sourceHandle === want) return e;
    migrated += 1;
    return { ...e, sourceHandle: want };
  });
  return { edges: migrated ? next : edges, migrated };
}

/**
 * The 高斯模型 node has two outputs now: `out-image` (the screenshot of the current view) and
 * `out-gaussian` (the point cloud). It used to have only `out-gaussian`, which also stood for the image,
 * so a wire from it to anything but a 高斯查看 node was really the screenshot: move those to `out-image`.
 */
export function migrateGaussianSourceHandles(
  nodes: Node[],
  edges: Edge[],
): { edges: Edge[]; migrated: number } {
  const type = new Map(nodes.map((n) => [n.id, n.type]));
  let migrated = 0;
  const next = edges.map((e) => {
    if (type.get(e.source) !== 'gaussian') return e;
    const want = type.get(e.target) === 'gaussianViewer' ? 'out-gaussian' : 'out-image';
    if (e.sourceHandle === want) return e;
    // an explicit out-image stays whatever it feeds
    if (e.sourceHandle === 'out-image') return e;
    migrated += 1;
    return { ...e, sourceHandle: want };
  });
  return { edges: migrated ? next : edges, migrated };
}
