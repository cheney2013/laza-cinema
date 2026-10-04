import { clipEnd, type Clip, type Track } from './types';

/**
 * Where each clip of a dragged group lands when the group is carried `laneDelta` lanes up or down:
 * every clip keeps its distance from the others, so a group spread over three tracks stays spread
 * over three tracks. A delta that would push any clip off the track list or onto a locked track is
 * shrunk toward 0 until the whole group fits; the result is the lane delta actually used.
 */
export function groupLanes(
  members: Array<{ id: string; trackId: string }>,
  tracks: Track[],
  laneDelta: number,
): { delta: number; tracks: Record<string, string> } {
  const lanes = members.map((m) => ({ id: m.id, lane: tracks.findIndex((t) => t.id === m.trackId) }));
  if (lanes.some((m) => m.lane < 0)) return { delta: 0, tracks: {} };
  const step = laneDelta > 0 ? -1 : 1;
  for (let delta = laneDelta; ; delta += step) {
    const fits = lanes.every((m) => {
      const target = tracks[m.lane + delta];
      return Boolean(target) && (delta === 0 || !target.locked);
    });
    if (fits || delta === 0) {
      return {
        delta,
        tracks: Object.fromEntries(lanes.map((m) => [m.id, tracks[m.lane + delta].id])),
      };
    }
  }
}

/**
 * The frame edges of a group taken as ONE block -- the earliest start and the latest end -- shifted by
 * `shift`. Only these are offered to the snapper: lining the block up is what the user means, and
 * every clip's own edge in the middle of it would pull the whole group onto frames that mean nothing.
 */
export function groupEdges(clips: Clip[], shift: number): number[] {
  if (clips.length === 0) return [];
  return [
    Math.min(...clips.map((c) => c.start)) + shift,
    Math.max(...clips.map((c) => clipEnd(c))) + shift,
  ];
}
