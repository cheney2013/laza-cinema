import { api } from '../api';
import {
  type Clip,
  type Timeline,
  clipLength,
  timelineDuration,
} from './types';

/**
 * Turn a timeline into the export request.
 *
 * Text is the one thing that cannot simply be described to ffmpeg. `drawtext`
 * needs a font file on the server and lays lines out with its own metrics, so a
 * title would land in a different place than the monitor showed. Instead each
 * text clip is rasterised here with the very canvas code the monitor uses, and
 * shipped as a transparent PNG overlay — what you approved is literally what
 * gets composited.
 */

export interface ExportClipPayload {
  url: string;
  kind: 'video' | 'image' | 'audio';
  start: number;
  duration: number;
  src_in_s: number;
  src_out_s: number;
  speed: number;
  volume: number;
  muted: boolean;
  fade_in: number;
  fade_out: number;
  alpha: boolean;
  /** 'cover' crops to fill the frame; 'contain' pads it with black. */
  fit: 'contain' | 'cover';
  /** Free placement on top of the fit: zoom multiplier and frame-fraction offsets. */
  zoom: number;
  offset_x: number;
  offset_y: number;
  /** Quarter turns clockwise. */
  rotate: number;
  /** [x, y, w, h] of the rotated picture, or null for all of it. */
  crop: [number, number, number, number] | null;
  /** Mirror the picture horizontally / vertically. */
  flip_h: boolean;
  flip_v: boolean;
  transition: { type: string; frames: number } | null;
  /** Head frames [from, to) whose sound is not used: the automatic seam rule. */
  seam_mute: [number, number] | null;
  filters: { brightness: number; contrast: number; saturation: number; temperature: number } | null;
}

export interface ExportPayload {
  tracks: Array<{ kind: 'video' | 'audio'; clips: ExportClipPayload[] }>;
  fps: number;
  width: number;
  height: number;
  duration: number;
  name: string;
  /** Nothing but sound on the grid: the backend writes a wav, not a black mp4. */
  audio_only: boolean;
  /** The file's own frame rate when a lone shot is exported at its real rate; absent means `fps`. */
  out_fps?: number;
  /** The film is for the user to download, not an asset in the library. */
  download?: boolean;
}

/**
 * Frame rate a shot is really played at once its speed is applied: 24 fps at
 * 0.5x is 12. Undefined when the speed is 1 (the grid rate already is the
 * real rate) or the result is outside what an encoder takes.
 */
export function nativeExportFps(gridFps: number, speed: number | undefined): number | undefined {
  if (!speed || !(speed > 0) || Math.abs(speed - 1) < 0.001) return undefined;
  const fps = Math.round(gridFps * speed * 1000) / 1000;
  return fps >= 1 && fps <= 240 ? fps : undefined;
}

/** Draw one text clip onto a transparent frame-sized canvas and upload it. */
async function rasteriseText(timeline: Timeline, clip: Clip): Promise<string | null> {
  const text = clip.text;
  if (!text || !text.content.trim()) return null;

  const canvas = document.createElement('canvas');
  canvas.width = timeline.width;
  canvas.height = timeline.height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.font = `${text.fontWeight} ${text.size}px "Noto Sans SC", system-ui, sans-serif`;
  context.textAlign = text.align;
  context.textBaseline = 'middle';
  const x = text.x * timeline.width;
  const lines = text.content.split('\n');
  const lineHeight = text.size * 1.3;
  const top = text.y * timeline.height - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    const y = top + index * lineHeight;
    if (text.strokeWidth > 0) {
      context.lineWidth = text.strokeWidth;
      context.strokeStyle = text.strokeColor;
      context.lineJoin = 'round';
      context.strokeText(line, x, y);
    }
    context.fillStyle = text.color;
    context.fillText(line, x, y);
  });

  const { url } = await api.uploadImageBase64(canvas.toDataURL('image/png'), 'title');
  return url;
}

/** One frame of a picture filling the frame, for frame 0. */
export function coverClip(url: string): ExportClipPayload {
  return {
    url, kind: 'image', start: 0, duration: 1, src_in_s: 0, src_out_s: 0, speed: 1, volume: 1, muted: true,
    fade_in: 0, fade_out: 0, alpha: false, fit: 'cover', zoom: 1, offset_x: 0, offset_y: 0, rotate: 0,
    crop: null, flip_h: false, flip_v: false, transition: null, filters: null, seam_mute: null,
  };
}

export async function buildExportPayload(
  timeline: Timeline,
  name: string,
  options: { cover?: { url: string } } = {},
): Promise<ExportPayload> {
  const tracks: ExportPayload['tracks'] = [];

  for (const track of timeline.tracks) {
    if (track.bypassed) continue;
    const clips: ExportClipPayload[] = [];
    const ordered = timeline.clips
      // Bypassed clips are left out of the render entirely — what the monitor
      // skips, the export skips.
      .filter((c) => c.trackId === track.id && !c.bypassed)
      .sort((a, b) => a.start - b.start);

    for (const clip of ordered) {
      const asset = timeline.assets[clip.assetId];
      let url = asset?.url;
      let kind: ExportClipPayload['kind'] = 'video';
      let alpha = false;

      // A title on an audio lane has nothing to be drawn on; the monitor skips it too.
      if (clip.text && track.kind === 'audio') continue;
      if (clip.text) {
        const rendered = await rasteriseText(timeline, clip);
        if (!rendered) continue;
        url = rendered;
        kind = 'image';
        alpha = true;
      } else {
        if (!asset || asset.offline) continue;
        kind = asset.kind;
      }
      if (!url) continue;

      clips.push({
        url,
        kind,
        start: clip.start,
        duration: clipLength(clip),
        // Trim points are on the timeline grid, so seconds are exact whatever
        // rate the source itself runs at.
        src_in_s: clip.inFrame / timeline.fps,
        src_out_s: clip.outFrame / timeline.fps,
        speed: clip.speed || 1,
        volume: clip.volume,
        muted: clip.muted || track.muted,
        fade_in: clip.fadeIn,
        fade_out: clip.fadeOut,
        alpha,
        fit: clip.fit === 'cover' ? 'cover' : 'contain',
        zoom: clip.zoom && clip.zoom > 0 ? clip.zoom : 1,
        offset_x: clip.offsetX ?? 0,
        offset_y: clip.offsetY ?? 0,
        rotate: clip.rotate ?? 0,
        crop: clip.crop ? [clip.crop.x, clip.crop.y, clip.crop.w, clip.crop.h] : null,
        flip_h: Boolean(clip.flipH),
        flip_v: Boolean(clip.flipV),
        transition: clip.transitionIn ? { type: clip.transitionIn.type, frames: clip.transitionIn.frames } : null,
        seam_mute: clip.seamMute ? [clip.seamMute.from, clip.seamMute.to] : null,
        filters: clip.filters ? { ...clip.filters } : null,
      });
    }

    // A sound file placed on a video lane has no picture to composite; the
    // render takes it as a lane of sound, the way the monitor plays it.
    const picture = track.kind === 'video' ? clips.filter((c) => c.kind !== 'audio') : clips;
    const sound = track.kind === 'video' ? clips.filter((c) => c.kind === 'audio') : [];
    if (picture.length > 0) tracks.push({ kind: track.kind, clips: picture });
    if (sound.length > 0) tracks.push({ kind: 'audio', clips: sound });
  }

  // The cover is frame 0 and nothing else: a one-frame picture on a lane above everything, filling the
  // frame. It replaces that frame instead of being inserted before it, so the sound, the timing and the
  // length of the film do not move.
  if (options.cover?.url && tracks.length > 0) tracks.push({ kind: 'video', clips: [coverClip(options.cover.url)] });

  return {
    tracks,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    duration: timelineDuration(timeline),
    name,
    audio_only: tracks.length > 0 && tracks.every((t) => t.clips.every((c) => c.kind === 'audio')),
  };
}
