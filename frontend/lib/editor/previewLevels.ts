/**
 * Preview quality levels for the cut room's monitor: the pure part (which level, when to step down,
 * which file to play). The state and the network live in previewQuality.ts.
 *
 * A level is a proxy height. The standard proxy (the backend's PROXY_HEIGHT, 1080) is sharp but an
 * all-keyframe HD file is a heavy thing to decode and read; lower levels are built on demand. Export
 * never uses any of them.
 */

/** Highest first. The first one is the standard proxy every video already has. */
export const QUALITY_LEVELS = [1080, 720, 540, 360] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];
export type QualityChoice = 'auto' | QualityLevel;

export const TOP_LEVEL: QualityLevel = QUALITY_LEVELS[0];

export const isQualityChoice = (value: unknown): value is QualityChoice =>
  value === 'auto' || (QUALITY_LEVELS as readonly unknown[]).includes(value);

/**
 * The lowest level that still has about one source pixel per screen pixel: a monitor 540 pixels tall
 * gains nothing from a 1080 proxy. A little slack (90%) so a 560-pixel monitor takes the 540 level.
 */
export function levelForDisplay(displayHeightPx: number): QualityLevel {
  const ascending = [...QUALITY_LEVELS].reverse();
  return ascending.find((level) => level >= displayHeightPx * 0.9) ?? TOP_LEVEL;
}

/** The next level down, or the same one at the bottom. */
export function stepDown(level: number): QualityLevel {
  const lower = QUALITY_LEVELS.filter((l) => l < level);
  return lower.length ? lower[0] : QUALITY_LEVELS[QUALITY_LEVELS.length - 1];
}

/** Frames dropped / shown between two samples of the video elements' counters; null when too few frames to say. */
export function dropRate(
  before: { total: number; dropped: number },
  now: { total: number; dropped: number },
  minFrames = 30
): number | null {
  const total = now.total - before.total;
  const dropped = now.dropped - before.dropped;
  // A counter that went down belongs to an element that was replaced: start over.
  if (total < minFrames || dropped < 0) return null;
  return dropped / total;
}

/** More than this share of frames dropped over a sample means the machine is not keeping up. */
export const DROP_LIMIT = 0.12;

/** The level playing now: what the menu says, or for auto the display's level held down by drops. */
export function effectiveLevel(choice: QualityChoice, displayHeightPx: number, autoCap: QualityLevel): QualityLevel {
  if (choice !== 'auto') return choice;
  const wanted = levelForDisplay(displayHeightPx);
  return wanted < autoCap ? wanted : autoCap;
}

/** Key of a built proxy: the master it is made from and the level. */
export const proxyKey = (assetUrl: string, level: number) => `${assetUrl}@${level}`;

/**
 * The file the monitor plays for a video: the standard proxy, or the lower level's proxy once it is
 * built. A source no taller than the level is already at it, and a level still being built falls back
 * to the standard proxy, so the picture never goes black while it waits.
 */
export function previewUrlFor(
  asset: { url: string; proxyUrl?: string; height: number },
  level: number,
  built: Record<string, string>
): string {
  const standard = asset.proxyUrl || asset.url;
  if (level >= TOP_LEVEL || !asset.height || asset.height <= level) return standard;
  return built[proxyKey(asset.url, level)] ?? standard;
}
