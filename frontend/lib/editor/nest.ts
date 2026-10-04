import { type Clip, type Timeline, type Track, clipInSpan, timelineDuration } from './types';

/**
 * Expanding referenced films.
 *
 * A clip with `seqRef` stands for a stretch of another film in the project. The
 * compositor and the export only understand plain clips, so before either sees
 * the timeline every reference is replaced by the clips of the film it points
 * at, cut to the reference's trim and moved to where it sits. The referenced
 * film is edited in its own tab; nothing of it is copied into this one.
 *
 * Tracks: the referenced film's video lanes are inserted directly above the lane
 * the reference sits on, so anything the host stacks higher (a title on V2)
 * still lands on top. Its audio lanes are added after the host's. Two
 * references on the same lane share those inserted lanes -- they cannot overlap
 * in time, so neither can their contents.
 */

export type ResolveSequence = (seqId: string) => Timeline | null | undefined;

const MAX_DEPTH = 8;

/**
 * Why another film cannot be referenced from this one, or null when it can.
 *
 * Only the frame rate has to match: both films count in frames, so a different rate means the
 * same frame number is a different moment. The resolution does not: a referenced film is expanded
 * into this one's frame and fitted like any other picture, so a film of any size can be placed.
 */
export function referenceMismatch(host: Timeline, nested: Timeline): { hostFps: number; nestedFps: number } | null {
  return host.fps === nested.fps ? null : { hostFps: host.fps, nestedFps: nested.fps };
}

export const hasSequenceRefs = (timeline: Timeline): boolean => timeline.clips.some((c) => c.seqRef);

/** Length of a referenced film, fully expanded; 0 when it cannot be read. */
export function sequenceLength(seqId: string, resolve: ResolveSequence): number {
  const nested = resolve(seqId);
  return nested ? timelineDuration(flattenTimeline(nested, resolve, new Set([seqId]))) : 0;
}

/** Does `seqId`, directly or through films it references, contain `target`? */
export function referencesSequence(
  seqId: string,
  target: string,
  resolve: ResolveSequence,
  seen: Set<string> = new Set()
): boolean {
  if (seqId === target) return true;
  if (seen.has(seqId)) return false;
  seen.add(seqId);
  const timeline = resolve(seqId);
  if (!timeline) return false;
  return timeline.clips.some((c) => c.seqRef && referencesSequence(c.seqRef, target, resolve, seen));
}

/**
 * The timeline with every reference expanded. Returns the input untouched when
 * it holds none, so the common case costs nothing and keeps its identity.
 *
 * `seen` holds the films already being expanded above this one; a reference
 * back into one of them (which the insert refuses, but a file edited by hand
 * could hold) is dropped instead of recursing forever.
 */
export function flattenTimeline(
  host: Timeline,
  resolve: ResolveSequence,
  seen: Set<string> = new Set(),
  depth = 0
): Timeline {
  if (!hasSequenceRefs(host)) return host;

  const tracks: Track[] = [];
  const extraAudio: Track[] = [];
  const clips: Clip[] = [];
  const assets = { ...host.assets };
  const added = new Set<string>();

  const addTrack = (list: Track[], track: Track) => {
    if (added.has(track.id)) return;
    added.add(track.id);
    list.push(track);
  };

  for (const hostTrack of host.tracks) {
    tracks.push(hostTrack);
    const refs = host.clips.filter((c) => c.trackId === hostTrack.id && c.seqRef);
    const nestedVideo: Track[] = [];

    for (const ref of refs) {
      const seqId = ref.seqRef as string;
      const source = depth < MAX_DEPTH && !seen.has(seqId) ? resolve(seqId) : null;
      if (!source) continue;
      const nested = flattenTimeline(source, resolve, new Set([...seen, seqId]), depth + 1);
      // Titles are sized in pixels of their own film's frame. In a frame of another height they
      // scale by the ratio, to look the size they were made; everything else is a fraction of the frame.
      const scale = nested.height > 0 && host.height > 0 ? host.height / nested.height : 1;
      Object.entries(nested.assets).forEach(([id, asset]) => {
        if (!assets[id]) assets[id] = asset;
      });

      for (const track of nested.tracks) {
        // An audio lane has no picture, so a reference placed there brings in
        // only the other film's sound.
        if (hostTrack.kind === 'audio' && track.kind !== 'audio') continue;
        const id = `${hostTrack.id}/${track.id}`;
        const lane: Track = {
          ...track,
          id,
          muted: track.muted || hostTrack.muted,
          locked: true,
          bypassed: track.bypassed || hostTrack.bypassed,
        };
        addTrack(track.kind === 'video' ? nestedVideo : extraAudio, lane);

        for (const clip of nested.clips) {
          if (clip.trackId !== track.id) continue;
          const cut = clipInSpan(clip, ref.inFrame, ref.outFrame);
          if (!cut) continue;
          const headCut = clip.start < ref.inFrame;
          clips.push({
            ...cut,
            id: `${ref.id}/${clip.id}`,
            trackId: id,
            start: cut.start + ref.start,
            // A dissolve whose head was trimmed away has nothing left to dissolve from.
            transitionIn: headCut ? undefined : cut.transitionIn,
            volume: cut.volume * (ref.volume ?? 1),
            muted: cut.muted || ref.muted,
            bypassed: cut.bypassed || ref.bypassed,
            groupId: undefined,
            ...(cut.text && scale !== 1
              ? {
                  text: {
                    ...cut.text,
                    size: Math.max(8, Math.round(cut.text.size * scale)),
                    strokeWidth: Math.round(cut.text.strokeWidth * scale),
                  },
                }
              : {}),
          });
        }
      }
    }
    nestedVideo.forEach((track) => tracks.push(track));
  }

  return {
    ...host,
    tracks: [...tracks, ...extraAudio],
    clips: [...host.clips.filter((c) => !c.seqRef), ...clips],
    assets,
  };
}
