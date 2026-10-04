/**
 * The thumbnail strip behind a clip.
 *
 * The backend builds ONE sprite sheet per asset: `thumbCount` frames sampled
 * evenly across the whole file, side by side. A clip shows a *part* of that
 * file, so the strip has to be sliced by the clip's trim — tiling the whole
 * sheet (what this did before) meant a trimmed clip kept showing the frames it
 * no longer contains, and the two halves of a split clip looked identical.
 *
 * Each tile keeps the picture's own aspect rather than being stretched to fit
 * the clip: a squashed frame is harder to recognise than a strip that ends a
 * little early, and recognising the shot is the whole job.
 */
export interface FilmstripTile {
  /** Offset inside the clip, in px. */
  left: number;
  width: number;
  /** Where the sheet sits behind this tile, as a CSS percentage. */
  positionX: string;
}

export function filmstripTiles(options: {
  /** Clip trim, on the timeline grid. */
  inFrame: number;
  outFrame: number;
  /** The asset's whole length on the same grid. */
  sourceFrames: number;
  /** Frames in the sprite sheet. */
  thumbCount: number;
  /** The clip's width on screen, px. */
  width: number;
  /** Lane height the tile is drawn at, px. */
  height: number;
  /** The picture's own aspect, to keep the tile undistorted. */
  aspect: number;
}): FilmstripTile[] {
  const { inFrame, outFrame, sourceFrames, thumbCount, width, height, aspect } = options;
  if (thumbCount < 1 || sourceFrames <= 0 || width <= 0 || height <= 0) return [];
  const span = outFrame - inFrame;
  if (span <= 0) return [];

  const tileWidth = Math.max(8, Math.round(height * (aspect > 0 ? aspect : 16 / 9)));
  // At least one tile: a clip narrower than a single frame still says more with
  // a cropped thumbnail than with an empty block.
  const count = Math.max(1, Math.floor(width / tileWidth));
  const tiles: FilmstripTile[] = [];
  for (let i = 0; i < count; i += 1) {
    // Where this tile STARTS, as a position in the source file: a strip whose
    // first frame is the clip's first frame is the one you can match against the
    // monitor. Sampling the middle instead shifts every clip half a tile.
    const through = i / count;
    const sourceFraction = Math.min(1, Math.max(0, (inFrame + through * span) / sourceFrames));
    const index = Math.min(thumbCount - 1, Math.max(0, Math.round(sourceFraction * thumbCount - 0.5)));
    // Percentage background positions are a fraction of (element - image), so
    // with a sheet `thumbCount` elements wide, tile N sits at N/(count-1).
    tiles.push({
      left: i * tileWidth,
      width: tileWidth,
      positionX: thumbCount > 1 ? `${(index / (thumbCount - 1)) * 100}%` : '0%',
    });
  }
  return tiles;
}
