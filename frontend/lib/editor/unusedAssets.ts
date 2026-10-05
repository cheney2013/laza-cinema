import { basenameOf, namesIn } from '../assetUsage';
import type { EditorAsset, Timeline } from './types';

/**
 * Library files that no film uses.
 *
 * "Used" means a clip on some sequence's timeline points at the file: through the
 * asset it plays, the trimmed output a chained shot was opened out from, or the
 * rough cut an HD version replaced (换回粗版 would bring that back). A film's cover
 * counts too. An asset that sits in a timeline's asset table with no clip on it is
 * not used -- that table remembers every import, which is exactly the clutter.
 */
export function namesUsedByTimelines(timelines: Timeline[]): Set<string> {
  const used = new Set<string>();
  const add = (url?: string) => {
    if (url) used.add(basenameOf(url.split('?')[0]));
  };
  const addAsset = (asset: EditorAsset | undefined) => {
    if (!asset) return;
    add(asset.url);
    add(asset.chainHead?.trimmedUrl);
    add(asset.roughUrl);
    add(asset.roughChainHead?.trimmedUrl);
  };
  for (const timeline of timelines) {
    add(timeline.cover?.url);
    for (const clip of timeline.clips) {
      if (clip.assetId) addAsset(timeline.assets[clip.assetId]);
    }
  }
  return used;
}

/**
 * The files canvas nodes point at now: what a node shows or takes as input, not the takes and submitted
 * resources it only remembers (see NameHit.live). Pass the nodes of every scene.
 */
export function namesLiveOnCanvases(nodes: Array<{ data?: unknown }>): Set<string> {
  const live = new Set<string>();
  for (const node of nodes) {
    for (const [name, hit] of namesIn(node.data)) if (hit.live) live.add(basenameOf(name));
  }
  return live;
}

/**
 * Is this library file the project's own, and nobody else's? Made here, or (when nobody recorded where it
 * was made) referenced here and by no other project. A file another project made or references, and one
 * that belongs to no one on record, is not this project's to delete. Mirrors the backend's
 * `_belongs_to_project_only`, which enforces it again when the delete is asked for.
 */
export function ownedByProject(
  asset: { origin_project?: string | null; projects?: Array<{ id: string }> },
  projectId: string
): boolean {
  const referencing = new Set((asset.projects ?? []).map((p) => p.id));
  for (const id of referencing) if (id !== projectId) return false;
  if (asset.origin_project) return asset.origin_project === projectId;
  return referencing.has(projectId);
}

/** The library files, by name, that none of the timelines use and that `keep` does not name. */
export function unusedLibraryItems<T extends { name: string }>(
  library: T[],
  timelines: Timeline[],
  keep: Set<string> = new Set()
): T[] {
  const used = namesUsedByTimelines(timelines);
  return library.filter((item) => {
    const name = basenameOf(item.name);
    return !used.has(name) && !keep.has(name);
  });
}

/**
 * The timeline without the asset-table entries whose files were deleted from the library.
 *
 * Only entries no clip is on go: a clip's asset stays, marked offline by the cut room, so the clip keeps its
 * place and trims. Returns the same object when nothing changed, so callers can tell whether to save.
 */
export function withoutDeletedAssets(timeline: Timeline, deleted: Set<string>): Timeline {
  if (deleted.size === 0) return timeline;
  const onClip = new Set(timeline.clips.map((c) => c.assetId).filter(Boolean));
  const gone = (asset: EditorAsset) =>
    [asset.url, asset.chainHead?.trimmedUrl, asset.roughUrl, asset.roughChainHead?.trimmedUrl].some(
      (url) => !!url && deleted.has(basenameOf(url.split('?')[0]))
    );
  const kept = Object.entries(timeline.assets).filter(([id, asset]) => onClip.has(id) || !gone(asset));
  if (kept.length === Object.keys(timeline.assets).length) return timeline;
  return { ...timeline, assets: Object.fromEntries(kept) };
}
