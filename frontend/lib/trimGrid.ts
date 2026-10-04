/**
 * Where a clip can be cut so the cut keeps its latent.
 *
 * An H3 chain latent holds 5n+2 time steps for 17n+5 frames, so it can be cut exactly
 * only at those lengths (backend/latent_slice.py; checked against the decoded clip). A
 * chained clip's latent also holds the shot's context frames at its head, which the
 * served clip does not show, so the grid is counted from the head of the latent:
 * `context + end` must be 17n+5. A cut at any other frame is still fine, it just has no
 * latent and the shot that follows it re-encodes the pictures.
 */

export const GRID_STEP = 17;
export const GRID_OFFSET = 5;

export const onGrid = (frames: number) => frames >= GRID_OFFSET && (frames - GRID_OFFSET) % GRID_STEP === 0;

/** End frames (exclusive, in served-clip frames) where the cut keeps its latent. */
export function gridEnds(totalFrames: number, contextFrames = 0): number[] {
  const ends: number[] = [];
  for (let end = 1; end <= totalFrames; end++) {
    if (onGrid(contextFrames + end)) ends.push(end);
  }
  return ends;
}

/** The nearest grid end within `threshold` frames of `frame`, else `frame` itself. */
export function snapEnd(frame: number, ends: number[], threshold: number): number {
  let best = frame;
  let bestDistance = threshold + 1;
  for (const end of ends) {
    const distance = Math.abs(end - frame);
    if (distance < bestDistance) {
      best = end;
      bestDistance = distance;
    }
  }
  return best;
}

export interface LatentCut {
  ok: boolean;
  /** Short reason when it is not ok, for a tooltip. */
  reason: 'ok' | 'no-latent' | 'start' | 'grid' | 'to-end-off-grid';
  /** The grid end just before / after the chosen end, to offer as a fix. */
  before: number | null;
  after: number | null;
}

export function latentCut(args: {
  start: number;
  end: number;
  totalFrames: number;
  contextFrames: number;
  hasLatent: boolean;
}): LatentCut {
  const { start, end, totalFrames, contextFrames, hasLatent } = args;
  const ends = gridEnds(totalFrames, contextFrames);
  const before = [...ends].reverse().find((e) => e < end) ?? null;
  const after = ends.find((e) => e > end) ?? null;
  if (!hasLatent) return { ok: false, reason: 'no-latent', before, after };
  if (start !== 0) return { ok: false, reason: 'start', before, after };
  if (!onGrid(contextFrames + end)) {
    return { ok: false, reason: end >= totalFrames ? 'to-end-off-grid' : 'grid', before, after };
  }
  return { ok: true, reason: 'ok', before, after };
}
