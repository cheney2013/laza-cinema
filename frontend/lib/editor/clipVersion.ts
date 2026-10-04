import type { EditorAsset, Timeline } from './types';

/**
 * Point ONE clip at another version of the node it came from.
 *
 * Clips cut from the same shot share an asset, so changing the asset changes
 * all of them. When other clips use it, this clip moves to the new version's own
 * asset (an existing one for the same file, else `newAssetId`) and the rest stay
 * on the version they had. A clip that is the asset's only user keeps the
 * in-place behaviour: the asset itself becomes the new version.
 *
 * The overlap kept at a chained file's head moves the cut by the head
 * difference, so what shows stays put; a shorter version cannot be cut past its
 * end.
 */
export function repointClipVersion(
  timeline: Timeline,
  clipId: string,
  next: EditorAsset,
  newAssetId: string,
): Timeline {
  const clip = timeline.clips.find((c) => c.id === clipId);
  const old = clip ? timeline.assets[clip.assetId] : undefined;
  if (!clip || !old) return timeline;

  const shared = timeline.clips.some((c) => c.id !== clipId && c.assetId === old.id);
  let target: EditorAsset;
  if (!shared) {
    target = { ...next, id: old.id };
  } else {
    const same = Object.values(timeline.assets).find(
      (a) => a.id !== old.id && a.nodeId === next.nodeId && a.url === next.url,
    );
    target = same ?? { ...next, id: newAssetId };
  }

  const by = (target.chainHead?.frames ?? 0) - (old.chainHead?.frames ?? 0);
  const limit = target.timelineFrames || Infinity;
  return {
    ...timeline,
    assets: { ...timeline.assets, [target.id]: target },
    clips: timeline.clips.map((c) => {
      if (c.id !== clipId) return c;
      const inFrame = Math.max(0, c.inFrame + by);
      const outFrame = Math.min(Math.max(inFrame + 1, c.outFrame + by), limit);
      return { ...c, assetId: target.id, inFrame: Math.min(inFrame, outFrame - 1), outFrame };
    }),
  };
}
