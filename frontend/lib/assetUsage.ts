import { type Timeline, clipLength, formatTimecode } from './editor/types';
import { t } from './i18n';

/**
 * Who, inside THIS project, is actually pointing at a given file.
 *
 * The backend already reports whether an asset is referenced, but it reads
 * canvas.json and timeline.json off disk, and both are saved on a debounce. A
 * node dragged in two seconds ago, or deleted two seconds ago, is not in those
 * files yet. Navigation cannot be built on that: the failure it produces — a
 * "定位" that lands nowhere, or a row for a node that is already gone — is the
 * hardest kind to explain. So the index is built from what is in memory, which
 * is by definition the current project and by definition up to date.
 *
 * This deliberately duplicates the backend's `_names_in` walk rather than
 * sharing a list of URL fields. Node data spells its media out under a dozen
 * different keys (`url`, `generatedUrl`, `imageUrl`, `plyUrl`, first/last
 * frame…), and any enumeration of them silently rots as nodes are added.
 */

/** Mirrors backend `artifact_pruner.MEDIA_RE`. */
const MEDIA_RE =
  /[\w./\-]+\.(?:mp4|webm|mov|png|jpg|jpeg|webp|gif|safetensors|latent|ply|glb|wav|mp3|flac|m4a|aac|ogg)/gi;

/** Long strings are prompts and base64 payloads, never paths. */
const MAX_SCANNED_STRING = 2048;

export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export interface NameHit {
  /**
   * Whether the node is pointing at this file NOW, as opposed to remembering
   * that it once did.
   *
   * A generation node keeps its own past: `takes[]` holds every clip it has ever
   * produced, `submittedResources` holds the inputs of the run that made them.
   * A file named there is genuinely mentioned by the node — the pruner is right
   * to refuse to delete it — but the node's current output is something else,
   * and sending someone there to "see where this asset is used" shows them a
   * shot that is not the one they clicked.
   *
   * The split is structural, not a list of field names: a node's live state sits
   * in `data`'s own string fields, while records of the past are nested inside
   * containers. A field the rule misclassifies still shows up — just in the
   * wrong group — whereas an enumeration that falls behind loses the reference
   * altogether.
   */
  live: boolean;
  /** Top-level `data` keys the name was found under, e.g. `takes`. */
  fields: Set<string>;
}

/** Every media filename mentioned anywhere inside `data`, by basename. */
export function namesIn(data: unknown): Map<string, NameHit> {
  const found = new Map<string, NameHit>();
  if (!data || typeof data !== 'object') return found;

  const record = (raw: string, field: string, live: boolean) => {
    const name = basenameOf(raw);
    const hit = found.get(name);
    if (hit) {
      hit.live ||= live;
      hit.fields.add(field);
    } else {
      found.set(name, { live, fields: new Set([field]) });
    }
  };

  const seen = new Set<object>();
  // depth 1 is a direct value of `data` — the node's own live state.
  const stack: Array<{ value: unknown; field: string; depth: number }> = Object.entries(
    data as Record<string, unknown>
  ).map(([field, value]) => ({ value, field, depth: 1 }));

  while (stack.length > 0) {
    const { value, field, depth } = stack.pop()!;
    if (typeof value === 'string') {
      if (value.length > MAX_SCANNED_STRING) continue;
      for (const match of value.match(MEDIA_RE) ?? []) record(match, field, depth === 1);
    } else if (Array.isArray(value)) {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const item of value) stack.push({ value: item, field, depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const item of Object.values(value)) {
        stack.push({ value: item, field, depth: depth + 1 });
      }
    }
  }
  return found;
}

export interface AssetUsage {
  /** Where it is used: a node on the canvas, or a clip in the cut. */
  kind: 'node' | 'clip';
  /** Node id, or clip id. */
  id: string;
  /** For a clip: the film (sequence) it sits in. */
  seqId?: string;
  /** What to call it in a list: an alias if the user set one, else its type. */
  label: string;
  /** Second line — the clip's position in the cut, or what the node holds. */
  detail?: string;
  /** False when the node only remembers this file; see `NameHit.live`. */
  live: boolean;
  /** Cut-room clips only: where the playhead should land. */
  start?: number;
}

const NODE_TITLES: Record<string, string> = {
  video: '视频镜头',
  image: '素材',
  videoUpscale: '高清视频',
  videoCompare: '视频对比',
  videoEdit: '改原片 · 动作不变',
  characterSheet: '定妆照',
  videoReshot: '重拍一段 · 前后不动',
  videoBridge: '重做中间',
  videoContinue: '往后续拍',
  videoFrames: '首尾帧补中间',
  videoInterpolate: '补帧视频',
  imageUpscale: '图片超清',
  titleBlock: '标题块',
  videoTrim: '剪切视频',
  depthVideo: '深度视频',
  audioGen: '配音',
  inpaint: '局部重绘',
  charswap: '换人 · Viggle',
  videoReangle: '换机位 · CrossView',
  audioRefine: '声音精修',
  gaussian: '3D高斯',
  gaussianViewer: '高斯查看',
  pose: '姿态',
  preview: '预览',
};

/** What a nested field means, said in the words the UI uses elsewhere. */
const FIELD_TITLES: Record<string, string> = {
  takes: '这个节点的历史版本',
  submittedResources: '生成时提交的素材',
};

interface UsageNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

/**
 * basename -> everything referencing it: live references first, then the nodes
 * that merely remember it.
 *
 * `timeline` may be null when the cut room has never been opened; the cut's own
 * references are then simply unknown, which the caller has to say out loud
 * rather than report as "used nowhere".
 */
export interface UsageSequence {
  seqId: string;
  name: string;
  timeline: Timeline;
}

export function buildUsageIndex(
  nodes: UsageNode[],
  cut: Timeline | UsageSequence[] | null
): Map<string, AssetUsage[]> {
  const index = new Map<string, AssetUsage[]>();
  const add = (name: string, usage: AssetUsage) => {
    const list = index.get(name);
    if (list) list.push(usage);
    else index.set(name, [usage]);
  };

  for (const node of nodes) {
    const alias = typeof node.data?.alias === 'string' ? node.data.alias.trim() : '';
    const title = t(NODE_TITLES[node.type ?? ''] ?? '') || node.type || t('节点');
    for (const [name, hit] of namesIn(node.data)) {
      const fields = [...hit.fields];
      add(name, {
        kind: 'node',
        id: node.id,
        label: alias || title,
        detail: hit.live
          ? alias
            ? title
            : undefined
          : fields.map((f) => FIELD_TITLES[f] ?? f).join(' · '),
        live: hit.live,
      });
    }
  }

  // One project can hold several films; a bare timeline is the one-film case.
  const films: (UsageSequence | { seqId?: undefined; name?: undefined; timeline: Timeline })[] =
    cut === null ? [] : Array.isArray(cut) ? cut : [{ timeline: cut }];
  const named = films.length > 1;
  for (const { seqId, name, timeline } of films) {
    // A clip points at its asset by id, so the cut's references are exact — no
    // string walking, no ambiguity about whether it is current: a clip that
    // holds an asset is playing it.
    const clips = [...timeline.clips].sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      const asset = timeline.assets[clip.assetId];
      if (!asset?.url) continue;
      const track = timeline.tracks.find((t) => t.id === clip.trackId);
      const where = t('{v1} · {v2} · {v3} 帧', { v1: track?.name ?? t('轨道'), v2: formatTimecode(clip.start, timeline.fps), v3: clipLength(clip) });
      add(basenameOf(asset.url), {
        kind: 'clip',
        id: clip.id,
        seqId,
        label: asset.title || t('时间线片段'),
        detail: named && name ? `${name} · ${where}` : where,
        live: true,
        start: clip.start,
      });
    }
  }

  // Live first, order otherwise preserved: the list is read top-down, and what
  // is on the canvas right now is what the reader came for.
  for (const list of index.values()) {
    list.sort((a, b) => Number(b.live) - Number(a.live));
  }
  return index;
}

/** How many of these are references to the file as it is now. */
export function liveCount(usages: AssetUsage[]): number {
  return usages.reduce((total, usage) => total + (usage.live ? 1 : 0), 0);
}
