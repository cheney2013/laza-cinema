/**
 * Copy and paste between films.
 *
 * Both halves are pure so they can be tested without a store: `buildClipboard`
 * reads a timeline, `pasteInto` produces the clips and assets to add to another
 * one. Everything hard about this is in the second function — the target film
 * may run at a different frame rate, be a different shape, and have a different
 * set of lanes with different ids, and all three have to be reconciled or the
 * paste lands silently wrong.
 */
import { type Clip, type EditorAsset, type Timeline, type Track, expandGroups } from './types';

/**
 * What Ctrl+C put aside. The assets travel with the clips: the target film's
 * asset map has never heard of them, and re-probing on paste would cost a round
 * trip per shot for records that are already in hand.
 */
export interface ClipboardPayload {
  clips: Clip[];
  assets: EditorAsset[];
  /** The lanes the clips came off, to map by kind and ordinal on the way in. */
  tracks: Track[];
  fps: number;
  width: number;
  height: number;
}

/** Null when the selection holds nothing to copy. */
export function buildClipboard(timeline: Timeline, selection: string[]): ClipboardPayload | null {
  // Whole groups, the same widening every other path uses: copying half of a
  // shot and the sound detached from it would paste something out of sync.
  const ids = expandGroups(timeline.clips, selection);
  const clips = timeline.clips.filter((c) => ids.includes(c.id));
  if (clips.length === 0) return null;
  const assetIds = new Set(clips.map((c) => c.assetId).filter(Boolean));
  return {
    // Deep-copied: the film they came from keeps being edited, and a trim there
    // must not reach into what was copied.
    clips: clips.map((c) => structuredClone(c)),
    assets: [...assetIds].map((id) => timeline.assets[id]).filter(Boolean),
    tracks: timeline.tracks.map((tr) => ({ ...tr })),
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
  };
}

export interface PasteResult {
  /** The target's asset map with anything new merged in. */
  assets: Record<string, EditorAsset>;
  /** The clips to append. Empty when nothing could be placed. */
  clips: Clip[];
}

/**
 * `newId(prefix)` mints ids the same way the store does, and is passed in so
 * this stays pure and a test can make the output predictable.
 */
export function pasteInto(
  timeline: Timeline,
  clipboard: ClipboardPayload,
  playhead: number,
  newId: (prefix: string) => string
): PasteResult {
  const empty: PasteResult = { assets: timeline.assets, clips: [] };
  if (clipboard.clips.length === 0) return empty;
  const ratio = (timeline.fps || 24) / (clipboard.fps || 24);
  const rescale = (frames: number) => Math.round(frames * ratio);

  // Assets first: an identical url is the same media, so a film that already
  // uses a shot keeps one record for it instead of collecting a copy on every
  // paste.
  const assets = { ...timeline.assets };
  const assetIdMap = new Map<string, string>();
  for (const asset of clipboard.assets) {
    const existing = Object.values(assets).find((a) => a.url === asset.url);
    if (existing) {
      assetIdMap.set(asset.id, existing.id);
      continue;
    }
    const id = newId('asset');
    assetIdMap.set(asset.id, id);
    // `timelineFrames` is the asset's length expressed on the GRID, so it is the
    // one asset field a different frame rate invalidates.
    assets[id] = { ...asset, id, timelineFrames: Math.max(1, rescale(asset.timelineFrames)) };
  }

  // Lanes are per-film ids, so they are matched by kind and position within that
  // kind. A film with fewer lanes than the one copied from stacks the overflow
  // onto its last lane of that kind rather than dropping those clips.
  const trackFor = (sourceTrackId: string): Track | null => {
    const source = clipboard.tracks.find((x) => x.id === sourceTrackId);
    const kind = source?.kind ?? 'video';
    const sameKind = timeline.tracks.filter((x) => x.kind === kind);
    if (sameKind.length === 0) return null;
    const wanted = source ? clipboard.tracks.filter((x) => x.kind === kind).indexOf(source) : 0;
    const target = sameKind[Math.min(wanted, sameKind.length - 1)];
    // A locked lane refuses clips everywhere else too; fall back to any lane of
    // the right kind that will take them.
    return target.locked ? sameKind.find((x) => !x.locked) ?? null : target;
  };

  const origin = Math.min(...clipboard.clips.map((c) => c.start));
  const at = Math.max(0, Math.round(playhead));
  // One fresh group id per copied group, so pasting twice does not weld the two
  // pastes into one group.
  const groupIdMap = new Map<string, string>();
  const clips: Clip[] = [];
  for (const source of clipboard.clips) {
    const track = trackFor(source.trackId);
    if (!track) continue;
    const asset = source.assetId ? assets[assetIdMap.get(source.assetId) ?? ''] : undefined;
    const inFrame = rescale(source.inFrame);
    let outFrame = Math.max(inFrame + 1, rescale(source.outFrame));
    // Stills stretch to any length; anything with real frames cannot be asked
    // for more than it has.
    if (asset && asset.kind !== 'image') outFrame = Math.min(outFrame, asset.timelineFrames);
    if (outFrame <= inFrame) continue;
    const clip: Clip = {
      ...structuredClone(source),
      id: newId('clip'),
      trackId: track.id,
      assetId: source.assetId ? assetIdMap.get(source.assetId) ?? source.assetId : '',
      start: at + rescale(source.start - origin),
      inFrame,
      outFrame,
      fadeIn: rescale(source.fadeIn),
      fadeOut: rescale(source.fadeOut),
    };
    if (source.transitionIn) {
      clip.transitionIn = {
        ...source.transitionIn,
        frames: Math.max(1, rescale(source.transitionIn.frames)),
      };
    }
    if (source.groupId) {
      if (!groupIdMap.has(source.groupId)) groupIdMap.set(source.groupId, newId('grp'));
      clip.groupId = groupIdMap.get(source.groupId);
    }
    // Type is px at the film's own resolution: the same number in a taller frame
    // is a smaller title.
    if (clip.text && clipboard.height > 0) {
      const scale = timeline.height / clipboard.height;
      clip.text = {
        ...clip.text,
        size: Math.max(1, Math.round(clip.text.size * scale)),
        // The outline is in the same unit as the type, and has to grow with it
        // or a title pasted into a 4K film comes out hairline.
        strokeWidth: Math.max(1, Math.round(clip.text.strokeWidth * scale)),
      };
    }
    clips.push(clip);
  }
  if (clips.length === 0) return empty;
  return { assets, clips };
}
