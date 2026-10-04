import type { CharswapRequest } from './api';

/**
 * What the swap node sends. `swapMode` is "person" (换人: the whole person, clothes included), "head"
 * (换头: the face, hair colour and bangs; the clip's hair length and clothes stay) or "reference" (the
 * picture is already the reference: it goes to Viggle as it is). Person and head repaint one frame of the
 * clip with the photo's person and use that as the reference. A frame time of -1 means the clip's most
 * frontal face.
 *
 * `swapTargets` are points on the frame at `faceFrameSeconds`, in the order of the photos wired in: point
 * i is replaced with photo i, and everyone not pointed at stays. Only person mode takes them.
 */
export interface CharswapNodeSettings {
  length?: number;
  megapixels?: number;
  swapMode?: unknown;
  faceFrameSeconds?: unknown;
  facePrompt?: unknown;
  swapTargets?: unknown;
  swapEngine?: unknown;
  h3Accel?: unknown;
  h3Size?: unknown;
  swapPose?: unknown;
}

export const MAX_SWAP_TARGETS = 4;

export function swapEngine(value: unknown): 'viggle' | 'h3' {
  return value === 'h3' ? 'h3' : 'viggle';
}

/** The H3 engine's speed LoRA: the standard one (8 steps) unless the node asks for TaoMate (3 steps), which adds people
 *  that are not in the clip when the Character-Swap LoRA is on (docs/CHARSWAP.md). */
export function h3Accel(value: unknown): 'taomate3' | 'turbo8' {
  return value === 'taomate3' ? 'taomate3' : 'turbo8';
}

/** The H3 engine's size: the clip's own unless the node asks for the small one. */
export function h3Size(value: unknown): 'source' | 'small' {
  return value === 'small' ? 'small' : 'source';
}

/** The pose of a person put where an animal moved on four legs (H3 engine): "auto" decides from the clip and the photo. */
export function swapPose(value: unknown): 'auto' | 'follow' | 'upright' {
  return value === 'follow' || value === 'upright' ? value : 'auto';
}

export function swapMode(value: unknown): 'person' | 'head' | 'reference' {
  return value === 'head' || value === 'reference' ? value : 'person';
}

/** The usable points of a node: x and y between 0 and 1, at most MAX_SWAP_TARGETS. */
export function swapTargets(value: unknown): { x: number; y: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is { x: number; y: number } =>
      !!p && typeof p.x === 'number' && typeof p.y === 'number'
      && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
    .slice(0, MAX_SWAP_TARGETS);
}

export function charswapRequest(
  driveUrl: string,
  refUrls: string | string[],
  seed: number,
  data: CharswapNodeSettings,
): CharswapRequest {
  const photos = (Array.isArray(refUrls) ? refUrls : [refUrls]).filter(Boolean);
  const h3 = swapEngine(data.swapEngine) === 'h3';
  // The H3 engine swaps whole people only: no head mode, no ready-made reference. It takes the points like
  // Viggle (the frame they were made on, one photo each); without points the frame is never used.
  const mode = h3 ? 'person' : swapMode(data.swapMode);
  const at = data.faceFrameSeconds;
  const frame = typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : -1;
  // Point i goes with photo i; a point with no photo, or a photo with no point, is left out.
  const points = mode === 'person' ? swapTargets(data.swapTargets) : [];
  const targets = points.slice(0, photos.length).map((p, i) => ({ x: p.x, y: p.y, image_url: photos[i] }));
  return {
    video_url: driveUrl,
    character_image_url: photos[0] ?? '',
    // 0 lets the backend read the clip's own length; a cap above it mosaics.
    length: data.length || 0,
    seed,
    megapixels: data.megapixels ?? 0.8,
    mode,
    // The points mean something only on the frame they were made on: with points the frame is never automatic.
    face_frame_seconds: targets.length > 0 ? (frame < 0 ? 0 : frame) : h3 ? -1 : frame,
    face_prompt: typeof data.facePrompt === 'string' ? data.facePrompt.trim() : '',
    ...(targets.length > 0 ? { targets } : {}),
    ...(h3 ? { engine: 'h3' as const, h3_accel: h3Accel(data.h3Accel), h3_size: h3Size(data.h3Size), pose: swapPose(data.swapPose) } : {}),
  };
}
