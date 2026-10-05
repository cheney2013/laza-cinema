import { referenceTitle } from './subtitleLang';
import { resolveAssetUrl } from '../config';
import { cropOf, placeClip } from './geometry';
import {
  type Clip,
  type EditorAsset,
  type Timeline,
  clipEnd,
  clipGain,
  clipOpacity,
  filterCss,
  sourceFrameAt,
} from './types';

/**
 * The monitor's compositor.
 *
 * Media elements are never shown on screen. Every frame is assembled here: the
 * clips visible at the playhead are drawn bottom track first into one canvas,
 * each with its own colour filter and its own alpha, and their audio runs
 * through a WebAudio gain node so a fade sounds like it looks.
 *
 * Two rules keep this honest:
 *  - The clock lives outside. `render(playhead)` is told where it is; it never
 *    reads a position back off a <video>. One element stalling on a seek must
 *    not drag the whole timeline with it.
 *  - Elements are pooled and reused. Creating one per clip makes a ten-shot
 *    timeline open ten decoders, and browsers quietly stop decoding well before
 *    that on lower-end machines.
 */

/** Floor for the pool; the real limit grows to whatever the playhead needs. */
const POOL_LIMIT = 4;
/** How far ahead to warm up the next clip's decoder, in seconds. */
const PREROLL_S = 1.0;
/** Paused/pre-roll positioning: closer than this is already frame-accurate. */
const SYNC_TOLERANCE_S = 0.12;
/** While playing, drift under this is pulled in by rate; over it, by a seek. */
const HARD_SEEK_S = 0.5;
/** How hard the rate nudge pulls, and how far it may bend the clip's speed. */
const RATE_GAIN = 0.6;
const RATE_LIMIT = 0.05;
/**
 * Any rate other than exactly the clip's speed runs the browser's time-stretcher,
 * which is audible as a faint grain/warble. So small drift is left alone: the
 * nudge starts only past NUDGE_START_S and stops once back under NUDGE_STOP_S.
 * Nudging on every frame (as before) kept the stretcher on almost all the time.
 */
const NUDGE_START_S = 0.06;
const NUDGE_STOP_S = 0.01;

interface PoolEntry {
  element: HTMLVideoElement | HTMLAudioElement;
  url: string;
  gain?: GainNode;
  /** Currently bending the rate to catch up (see NUDGE_START_S). */
  nudging?: boolean;
  lastUsed: number;
  ready: boolean;
  /**
   * The last frame this element actually decoded. A <video> drops back to
   * readyState 1 on every seek and whenever the browser deprioritises it, and
   * the monitor clears to black each frame -- without something to hold up in
   * those gaps the picture flickers at exactly the cuts you are judging.
   */
  lastFrame?: HTMLCanvasElement;
}

export class Compositor {
  private canvas: HTMLCanvasElement;
  private pool = new Map<string, PoolEntry>();
  private audioContext: AudioContext | null = null;
  private playing = false;
  private tick = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** Transport rate (1, ½, ¼): multiplies every clip's own speed while playing. */
  private rate = 1;
  setRate(rate: number): void {
    this.rate = rate > 0 ? rate : 1;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) void this.audioContext?.resume();
    if (!playing) {
      this.pool.forEach((entry) => entry.element.pause());
    }
  }

  /** Called from a user gesture, where creating an AudioContext is allowed. */
  ensureAudio(): void {
    if (this.audioContext) {
      void this.audioContext.resume();
      return;
    }
    try {
      this.audioContext = new AudioContext();
    } catch {
      this.audioContext = null; // No audio available; picture still plays.
      return;
    }
    // Elements built before the context existed carry no gain node, and an
    // element may only be handed to createMediaElementSource once -- so they are
    // dropped here and rebuilt on the next frame, routed like everything else.
    // Without this, whether a clip is heard depends on whether it happened to be
    // under the playhead when the room opened.
    this.pool.forEach((entry) => {
      entry.element.pause();
      entry.element.removeAttribute('src');
    });
    this.pool.clear();
  }

  dispose(): void {
    this.pool.forEach((entry) => {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
    });
    this.pool.clear();
    void this.audioContext?.close();
    this.audioContext = null;
  }

  /** Draw the timeline at `playhead` (fractional frames) into the canvas. */
  render(timeline: Timeline, playhead: number): void {
    const context = this.canvas.getContext('2d');
    if (!context) return;
    this.tick += 1;
    this.lastPlayhead = playhead;

    if (this.canvas.width !== timeline.width || this.canvas.height !== timeline.height) {
      this.canvas.width = timeline.width;
      this.canvas.height = timeline.height;
    }

    context.save();
    context.globalAlpha = 1;
    context.filter = 'none';
    context.fillStyle = '#000';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const active = new Set<string>();

    for (const track of timeline.tracks) {
      // Sorted by start, not array order: during a dissolve the outgoing clip
      // has to be drawn first so the incoming one can ramp its alpha up over it.
      const clips = timeline.clips
        .filter((c) => c.trackId === track.id)
        .sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        // A bypassed clip is not pre-rolled either: it must not hold a decoder
        // open, and it must not be heard.
        if (clip.bypassed || track.bypassed) continue;
        const visible = playhead >= clip.start && playhead < clipEnd(clip);
        const upcoming =
          !visible &&
          clip.start > playhead &&
          (clip.start - playhead) / timeline.fps < PREROLL_S;
        if (!visible && !upcoming) continue;

        const asset = timeline.assets[clip.assetId];
        if (clip.text) {
          if (visible && track.kind === 'video') this.drawText(context, timeline, clip, playhead);
          continue;
        }
        if (!asset || asset.offline) continue;

        // A still has no media element to pool or sync; acquire() would return
        // null for it and skip the draw below.
        if (asset.kind === 'image') {
          if (visible && track.kind === 'video') this.drawImage(context, timeline, clip, asset, playhead);
          continue;
        }

        const entry = this.acquire(clip, asset, track.kind === 'audio' || asset.kind === 'audio');
        if (!entry) continue;
        active.add(clip.id);

        this.syncElement(entry, timeline, clip, visible);
        this.applyGain(entry, timeline, clip, track.muted, visible);

        if (!visible || track.kind !== 'video' || asset.kind === 'audio') continue;
        const element = entry.element as HTMLVideoElement;
        context.globalAlpha = clipOpacity(clip, playhead);
        context.filter = filterCss(clip.filters);
        if (element.readyState >= 2 && element.videoWidth) {
          this.drawPicture(context, element, element.videoWidth, element.videoHeight, timeline, clip);
          this.keepFrame(entry, element);
        } else if (entry.lastFrame) {
          // The held frame is stashed unflipped, so it mirrors here like a live
          // one — a stall must not un-mirror the picture for a few frames.
          this.drawPicture(context, entry.lastFrame, entry.lastFrame.width, entry.lastFrame.height, timeline, clip);
        }
      }
    }

    // The cover is frame 0 and nothing else.
    if (timeline.cover && playhead >= 0 && playhead < 1) this.drawCover(context, timeline, timeline.cover.url);

    context.restore();

    // Anything that scrolled out of range stops making noise immediately.
    this.pool.forEach((entry, clipId) => {
      if (!active.has(clipId)) {
        entry.element.pause();
        if (entry.gain) entry.gain.gain.value = 0;
      }
    });
    this.evict(active);
  }

  /** Stash the decoded frame so a stall has something to hold. */
  private keepFrame(entry: PoolEntry, element: HTMLVideoElement): void {
    let frame = entry.lastFrame;
    if (!frame) {
      frame = document.createElement('canvas');
      entry.lastFrame = frame;
    }
    if (frame.width !== element.videoWidth || frame.height !== element.videoHeight) {
      frame.width = element.videoWidth;
      frame.height = element.videoHeight;
    }
    const context = frame.getContext('2d');
    if (!context) return;
    context.drawImage(element, 0, 0, frame.width, frame.height);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  /**
   * Draw one source into the frame under the clip's rotate / crop / fit /
   * mirror settings.
   *
   * The transform is built outwards from the frame and read inwards: clip to
   * where the picture is allowed to be, mirror the frame, land on the centre of
   * that patch, drop into source pixels, offset so the crop's centre is what
   * sits there, and finally turn the picture inside its own box. `placeClip` is
   * the same function the crop handles are drawn from, so what is dragged and
   * what is rendered cannot drift apart.
   */
  private drawPicture(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    width: number,
    height: number,
    timeline: Timeline,
    clip?: Clip
  ): void {
    if (!width || !height) return;
    const settings = clip ?? ({ fit: 'contain' } as Clip);
    const place = placeClip(width, height, settings, timeline.width, timeline.height);
    if (!place) return;
    const crop = cropOf(settings);
    const rotate = settings.rotate ?? 0;

    context.save();
    // Everything outside the picture's own patch belongs to whatever is under
    // it: without this, a crop would still show the parts it cut away, and a
    // cover fit would paint over the whole frame.
    context.beginPath();
    context.rect(place.destX, place.destY, place.destW, place.destH);
    context.clip();

    if (settings.flipH || settings.flipV) {
      // A reflection of the frame about its centre. The patch is centred there
      // too, so mirroring never moves it -- only what is inside it.
      context.translate(timeline.width / 2, timeline.height / 2);
      context.scale(settings.flipH ? -1 : 1, settings.flipV ? -1 : 1);
      context.translate(-timeline.width / 2, -timeline.height / 2);
    }

    context.translate(place.destX + place.destW / 2, place.destY + place.destH / 2);
    context.scale(place.scale, place.scale);
    // Now in rotated-source pixels, with the origin where the crop's centre has
    // to end up.
    context.translate(
      -(crop.x + crop.w / 2) * place.rotatedW,
      -(crop.y + crop.h / 2) * place.rotatedH
    );
    // The rotated picture fills [0,0,rotatedW,rotatedH]; spin the original about
    // the centre of that box to put it there.
    context.translate(place.rotatedW / 2, place.rotatedH / 2);
    if (rotate) context.rotate((rotate * Math.PI) / 180);
    context.drawImage(source, -width / 2, -height / 2, width, height);
    context.restore();
  }

  private imageCache = new Map<string, HTMLImageElement>();

  /** The film's cover over the whole frame, cropped to fill like a poster. */
  private drawCover(context: CanvasRenderingContext2D, timeline: Timeline, url: string): void {
    let image = this.imageCache.get(url);
    if (!image) {
      image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = resolveAssetUrl(url);
      this.imageCache.set(url, image);
    }
    if (!image.complete || image.naturalWidth === 0) return;
    context.globalAlpha = 1;
    context.filter = 'none';
    this.drawPicture(context, image, image.naturalWidth, image.naturalHeight, timeline, { fit: 'cover' } as Clip);
  }

  private drawImage(
    context: CanvasRenderingContext2D,
    timeline: Timeline,
    clip: Clip,
    asset: EditorAsset,
    playhead: number
  ): void {
    let image = this.imageCache.get(asset.url);
    if (!image) {
      image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = resolveAssetUrl(asset.url);
      this.imageCache.set(asset.url, image);
    }
    if (!image.complete || image.naturalWidth === 0) return;
    context.globalAlpha = clipOpacity(clip, playhead);
    context.filter = filterCss(clip.filters);
    this.drawPicture(context, image, image.naturalWidth, image.naturalHeight, timeline, clip);
  }

  private drawText(
    context: CanvasRenderingContext2D,
    timeline: Timeline,
    clip: Clip,
    playhead: number
  ): void {
    const text = clip.text;
    // A title not yet translated shows the first language, dimmed: monitor only, the export never sees it.
    const reference = text ? referenceTitle(timeline, clip) : '';
    const words = text ? text.content || reference : '';
    if (!text || !words) return;
    context.globalAlpha = clipOpacity(clip, playhead) * (reference ? 0.5 : 1);
    context.filter = 'none';
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
  }

  // ── Media elements ─────────────────────────────────────────────────────────

  private acquire(clip: Clip, asset: EditorAsset, audioOnly: boolean): PoolEntry | null {
    // Preview always prefers the all-keyframe proxy; the original is the
    // fallback for assets whose proxy could not be built.
    const url = resolveAssetUrl(asset.kind === 'video' ? asset.proxyUrl || asset.url : asset.url);
    const existing = this.pool.get(clip.id);
    if (existing && existing.url === url) {
      existing.lastUsed = this.tick;
      return existing;
    }
    if (existing) {
      existing.element.pause();
      this.pool.delete(clip.id);
    }
    if (asset.kind === 'image') return null;

    const element = audioOnly ? document.createElement('audio') : document.createElement('video');
    // crossOrigin BEFORE src, always. Setting it afterwards does not re-fetch,
    // so the media stays "CORS-cross-origin" -- it still plays on its own, but
    // routing it through createMediaElementSource then outputs pure silence.
    // That is the whole bug behind a clip that looks right and makes no sound.
    element.crossOrigin = 'anonymous';
    element.src = url;
    element.preload = 'auto';
    (element as HTMLVideoElement).playsInline = true;
    element.muted = false;

    const entry: PoolEntry = { element, url, lastUsed: this.tick, ready: false };
    element.addEventListener('loadeddata', () => {
      entry.ready = true;
    });
    // A saved timeline remembers the proxy it was cut against, and a proxy is a
    // derived file that can be rebuilt under a new name or cleaned away. Falling
    // back to the master keeps that clip playing (sharper, just slower to
    // scrub) instead of leaving a black frame and an unplayable element.
    const master = resolveAssetUrl(asset.url);
    if (url !== master) {
      element.addEventListener(
        'error',
        () => {
          // Only the element's source moves. `entry.url` stays the key this pool
          // slot was acquired under -- rewriting it makes the next acquire() see
          // a mismatch and rebuild the element, every frame, which is a black
          // monitor rather than a fallback.
          element.src = master;
          element.load();
        },
        { once: true }
      );
    }

    if (this.audioContext && asset.hasAudio) {
      try {
        const source = this.audioContext.createMediaElementSource(element);
        const gain = this.audioContext.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(this.audioContext.destination);
        entry.gain = gain;
      } catch {
        // Routing failed (already connected elsewhere); element audio still works.
      }
    }

    this.pool.set(clip.id, entry);
    return entry;
  }

  private syncElement(entry: PoolEntry, timeline: Timeline, clip: Clip, visible: boolean): void {
    const element = entry.element;
    // Trim points sit on the timeline grid, so the position inside the source is
    // frames / fps — the source's own rate never enters the arithmetic.
    const wanted = Math.max(0, sourceFrameAt(clip, visible ? this.lastPlayhead : clip.start) / timeline.fps);
    const offset = wanted - element.currentTime;
    const drift = Math.abs(offset);

    if (!visible) {
      // Pre-roll: seek the decoder to the clip's head and leave it paused.
      if (drift > SYNC_TOLERANCE_S && element.readyState >= 1) element.currentTime = wanted;
      if (!element.paused) element.pause();
      return;
    }

    const speed = (clip.speed && clip.speed > 0 ? clip.speed : 1) * this.rate;

    if (this.playing) {
      // The clock lives outside, so the decoder always drifts away from it.
      // Seeking that back every frame costs a decode flush -- a visible stutter --
      // so small drift is absorbed by bending the rate a few percent, and only
      // a real desync is worth a seek.
      if (drift > HARD_SEEK_S) {
        element.currentTime = wanted;
        element.playbackRate = speed;
      } else {
        if (drift > NUDGE_START_S) entry.nudging = true;
        else if (drift < NUDGE_STOP_S) entry.nudging = false;
        const nudge = Math.max(-RATE_LIMIT, Math.min(RATE_LIMIT, offset * RATE_GAIN));
        const rate = entry.nudging ? speed * (1 + nudge) : speed;
        if (Math.abs(element.playbackRate - rate) > 0.001) element.playbackRate = rate;
      }
      if (element.paused) void element.play().catch(() => {});
    } else {
      if (element.playbackRate !== speed) element.playbackRate = speed;
      if (!element.paused) element.pause();
      if (drift > 0.001) element.currentTime = wanted;
    }
  }

  private applyGain(
    entry: PoolEntry,
    timeline: Timeline,
    clip: Clip,
    trackMuted: boolean,
    visible: boolean
  ): void {
    const gain = visible && !trackMuted && this.playing ? clipGain(clip, this.lastPlayhead) : 0;
    if (entry.gain) {
      // Glide rather than jump: a gain stepped once per animation frame is a
      // staircase, heard as zipper noise under fades and volume changes.
      const param = entry.gain.gain;
      if (Math.abs(param.value - gain) > 1e-4 && this.audioContext) {
        param.setTargetAtTime(gain, this.audioContext.currentTime, gain === 0 ? 0.004 : 0.012);
      }
      entry.element.muted = false;
    } else {
      entry.element.volume = Math.min(1, Math.max(0, gain));
      entry.element.muted = gain <= 0;
    }
  }

  private lastPlayhead = 0;

  private evict(active: Set<string>): void {
    // Everything the playhead touches this frame is off limits: within one tick
    // those entries share a `lastUsed`, so a size-ordered cull would happily
    // drop the clip currently on screen and rebuild its decoder from scratch.
    const limit = Math.max(POOL_LIMIT, active.size);
    if (this.pool.size <= limit) return;
    const ordered = [...this.pool.entries()]
      .filter(([clipId]) => !active.has(clipId))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [clipId, entry] of ordered.slice(0, this.pool.size - limit)) {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
      this.pool.delete(clipId);
    }
  }
}
