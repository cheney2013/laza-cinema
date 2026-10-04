/**
 * Where a clip's picture lands inside the finished frame.
 *
 * The monitor draws it, the crop handles sit on it and ffmpeg reproduces it, so
 * the arithmetic lives in exactly one place. Three things reshape a clip, and
 * they are applied in this order everywhere:
 *
 *   1. rotate   — 90° steps; 90 and 270 swap the picture's width and height
 *   2. crop     — a rectangle of what is left, in fractions of the ROTATED
 *                 picture, because that is the picture the user is looking at
 *   3. fit      — contain (pad) or cover (crop) into the frame
 *   4. zoom/offset — the corner points' free placement, on top of that fit
 *
 * Mirroring is deliberately outside this: it is a reflection of the whole frame
 * about its centre and changes no geometry, so it never enters the maths.
 */

import type { Clip } from './types';

export interface CropRect {
  /** All four in 0..1, of the rotated picture. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export const cropOf = (clip: Clip): CropRect => clip.crop ?? FULL_CROP;

export const isFullCrop = (crop: CropRect): boolean =>
  crop.x <= 0.0005 && crop.y <= 0.0005 && crop.w >= 0.9995 && crop.h >= 0.9995;

/** Quarter turns swap the picture's dimensions; half turns do not. */
export function rotatedSize(width: number, height: number, rotate = 0): { width: number; height: number } {
  return Math.abs(rotate % 180) === 90 ? { width: height, height: width } : { width, height };
}

export interface Placement {
  /** The rotated picture's size, before cropping. */
  rotatedW: number;
  rotatedH: number;
  /** The cropped picture's size, still in source pixels. */
  contentW: number;
  contentH: number;
  /** Frame pixels per source pixel, zoom included. */
  scale: number;
  /** The same at zoom 1 — what a corner drag measures its new zoom against. */
  baseScale: number;
  /** Where the cropped picture is drawn, in frame coordinates. */
  destX: number;
  destY: number;
  destW: number;
  destH: number;
}

export function placeClip(
  sourceW: number,
  sourceH: number,
  clip: Clip,
  frameW: number,
  frameH: number
): Placement | null {
  if (!sourceW || !sourceH || !frameW || !frameH) return null;
  const rotated = rotatedSize(sourceW, sourceH, clip.rotate ?? 0);
  const crop = cropOf(clip);
  const contentW = Math.max(1, rotated.width * crop.w);
  const contentH = Math.max(1, rotated.height * crop.h);
  const baseScale =
    clip.fit === 'cover'
      ? Math.max(frameW / contentW, frameH / contentH)
      : Math.min(frameW / contentW, frameH / contentH);
  const scale = baseScale * (clip.zoom && clip.zoom > 0 ? clip.zoom : 1);
  const destW = contentW * scale;
  const destH = contentH * scale;
  // Offsets are fractions of the frame, so the same numbers mean the same
  // placement after the film is reshaped from 16:9 to 9:16.
  const shiftX = (clip.offsetX ?? 0) * frameW;
  const shiftY = (clip.offsetY ?? 0) * frameH;
  return {
    rotatedW: rotated.width,
    rotatedH: rotated.height,
    contentW,
    contentH,
    scale,
    baseScale,
    destX: (frameW - destW) / 2 + shiftX,
    destY: (frameH - destH) / 2 + shiftY,
    destW,
    destH,
  };
}

/** Keep a crop rectangle inside the picture and never smaller than a sliver. */
export function clampCrop(crop: CropRect): CropRect {
  const min = 0.05;
  const w = Math.min(1, Math.max(min, crop.w));
  const h = Math.min(1, Math.max(min, crop.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, crop.x)),
    y: Math.min(1 - h, Math.max(0, crop.y)),
  };
}
