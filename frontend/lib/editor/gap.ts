import { type Clip, type Track, clipEnd, expandGroups } from './types';

/** The lane automatic subtitles are written to; a rerun replaces its clips. */
export const SUBTITLE_TRACK_PREFIX = 'SUB_';

const isSubtitleLane = (track: Track) => track.id.startsWith(SUBTITLE_TRACK_PREFIX);

function holes(spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = 0;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (from > cursor) out.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  return out;
}

/**
 * The ruler's gaps: stretches, from the start of the film to its last shot, where no VIDEO clip
 * is on any picture lane. Subtitles (their lane or any text clip) and sound are not shots, so
 * they neither fill a gap nor make one. A bypassed clip still holds its place: switching it off
 * is not deleting it.
 */
export function rulerGaps(clips: Clip[], tracks: Track[]): Array<[number, number]> {
  const lanes = new Set(tracks.filter((t) => t.kind === 'video' && !isSubtitleLane(t)).map((t) => t.id));
  return holes(clips.filter((c) => lanes.has(c.trackId) && !c.text).map((c) => [c.start, clipEnd(c)]));
}

/** The same holes per picture lane, for the trash button drawn in the lane. No subtitle lane, no audio lane. */
export function laneGapsOf(clips: Clip[], tracks: Track[]): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  for (const track of tracks) {
    if (track.kind !== 'video' || isSubtitleLane(track)) continue;
    out.set(track.id, holes(clips.filter((c) => c.trackId === track.id && !c.text).map((c) => [c.start, clipEnd(c)])));
  }
  return out;
}

/**
 * Take a gap out of the timeline: everything that starts at or after its end
 * moves left by its width.
 *
 * With no `trackId` the gap is the ruler's: no picture on any video lane. EVERY lane closes up,
 * sound and subtitle lanes included, with whatever is grouped to the moved clips (a shot and
 * the sound detached from it move as one): a stretch of the film with nothing in it is
 * removed from all of it, not only from the picture.
 * With a `trackId` it is a hole in that lane only, and only that lane closes up,
 * again with its groups. The other lanes keep their timing, unless the ripple
 * switch is on 'all' and the gap is a lane's own, which asks every lane to follow.
 *
 * A locked lane never moves. A group is never pulled past frame 0: the shift is
 * cut short so the earliest clip it moves lands on 0, and the rest keep their
 * spacing to it.
 */
export function closeGap(
  clips: Clip[],
  tracks: Track[],
  from: number,
  to: number,
  trackId: string | undefined,
  ripple: 'off' | 'track' | 'all',
): Clip[] {
  const width = Math.round(to - from);
  if (width <= 0) return clips;
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));

  if (trackId && ripple === 'all') {
    return clips.map((c) =>
      !locked.has(c.trackId) && c.start >= to ? { ...c, start: Math.max(0, c.start - width) } : c
    );
  }
  const lanes = trackId ? new Set([trackId]) : new Set(tracks.map((t) => t.id));

  const seeds = clips
    .filter((c) => lanes.has(c.trackId) && !locked.has(c.trackId) && c.start >= to)
    .map((c) => c.id);
  if (seeds.length === 0) return clips;
  const moving = new Set(
    expandGroups(clips, seeds).filter((id) => {
      const c = clips.find((x) => x.id === id);
      return c !== undefined && !locked.has(c.trackId);
    })
  );
  const earliest = Math.min(...clips.filter((c) => moving.has(c.id)).map((c) => c.start));
  const shift = Math.min(width, earliest);
  if (shift <= 0) return clips;
  return clips.map((c) => (moving.has(c.id) ? { ...c, start: c.start - shift } : c));
}
