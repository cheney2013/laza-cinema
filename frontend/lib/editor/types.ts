import { t } from '../i18n';
/**
 * Cut Room data model.
 *
 * Everything on the timeline is an integer frame count on ONE grid (`Timeline.fps`).
 * Seconds only exist at the edges: when a value is drawn as a timecode, when a
 * <video> is seeked, and when a clip is handed to ffmpeg. Floating-point seconds
 * kept in the model drift as clips are dragged and split, and the export then no
 * longer matches what the monitor showed.
 *
 * Source media may run at any rate (generated shots are often 16fps). Assets record
 * their real `fps` and native `frames`; `timelineFrames` is that length re-expressed
 * on the timeline grid, and clip trim points are always on the timeline grid.
 */

export const DEFAULT_FPS = 24;

/** How long a still sits on screen when first dropped in. */
export const IMAGE_DEFAULT_FRAMES = 72; // 3s @ 24fps

export type AssetKind = 'video' | 'image' | 'audio';

export interface EditorAsset {
  id: string;
  /** Canvas node this came from — lets a clip jump back to its generator. */
  nodeId: string;
  url: string;
  title: string;
  kind: AssetKind;
  width: number;
  height: number;
  /** The source's own frame rate. 0 for stills. */
  fps: number;
  /** Frame count in the source's own rate. */
  frames: number;
  /** `frames` re-expressed on the timeline grid. */
  timelineFrames: number;
  hasAudio: boolean;
  /**
   * 540p all-keyframe re-encode. Preview and scrubbing always use this: the
   * generated mp4s carry very sparse keyframes, and stepping a frame backwards
   * in one costs hundreds of milliseconds.
   */
  proxyUrl?: string;
  /** Horizontal sprite sheet of thumbnails, for the clip strip. */
  thumbsUrl?: string;
  thumbCount?: number;
  /** Normalised 0..1 audio peaks, one per bucket, for the waveform. */
  peaks?: number[];
  /** Momentary loudness (RMS over ~100 ms) per bucket, 0..1 of full scale, same buckets as `peaks`. */
  rms?: number[];
  /** Set when the source file has gone missing or the node was deleted. */
  offline?: boolean;
  /**
   * A chained shot opened out to its full render: `url` is the untrimmed file
   * and its first `frames` (timeline grid) are the overlap with the previous
   * shot, trimmed off by default and revealed by dragging the clip's head.
   * `trimmedUrl` is the canvas node's normal output.
   */
  chainHead?: { trimmedUrl: string; frames: number };
  /** The rough-cut file this asset pointed at before 换成高清版 relinked it. */
  roughUrl?: string;
  /** chainHead as it was on the rough-cut file, restored by 换回粗版. */
  roughChainHead?: { trimmedUrl: string; frames: number };
}

export type TransitionType = 'dissolve' | 'fade' | 'dip';

export interface Transition {
  type: TransitionType;
  frames: number;
  /** Made by 接缝溶解 (automatic), not set by hand. What its sound does is `Clip.seamMute`, not this flag. */
  seam?: boolean;
}

export interface ClipFilters {
  /** ffmpeg `eq` ranges: brightness -1..1, contrast 0..3, saturation 0..3. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** Kelvin, 1000..40000. 6500 is neutral. */
  temperature: number;
}

export interface ClipText {
  content: string;
  /** px at the timeline's own resolution, not at preview scale. */
  size: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** Position as a fraction of the frame, so it survives a resolution change. */
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  fontWeight: number;
}

export const NEUTRAL_FILTERS: ClipFilters = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 6500,
};

export function isNeutral(filters?: ClipFilters): boolean {
  if (!filters) return true;
  return (
    Math.abs(filters.brightness) < 0.001 &&
    Math.abs(filters.contrast - 1) < 0.001 &&
    Math.abs(filters.saturation - 1) < 0.001 &&
    Math.abs(filters.temperature - 6500) < 1
  );
}

export interface Clip {
  id: string;
  trackId: string;
  /** Empty for a text clip, which has no source media. */
  assetId: string;
  /** Timeline frame this clip starts on. */
  start: number;
  /**
   * Trim points inside the asset, on the timeline grid and BEFORE speed is
   * applied. On-timeline length is `(outFrame - inFrame) / speed`.
   */
  inFrame: number;
  outFrame: number;
  speed: number;
  volume: number;
  muted: boolean;
  /** Frames of audio+video fade at each end. */
  fadeIn: number;
  fadeOut: number;
  /** Transition into this clip from whatever precedes it on the same track. */
  transitionIn?: Transition;
  /**
   * Head frames of a chained clip whose own sound is not used, [from, to) counted from the clip's
   * start: the automatic seam rule. That stretch is the previous shot's last frames regenerated, so
   * the previous clip's sound is the one heard there. Written by 接缝溶解 only, for the frames the
   * user did not handle by hand; a hand-set dissolve and whatever sound the user made of its frames
   * are never in this range. Any hand edit of the transition clears it.
   */
  seamMute?: { from: number; to: number };
  filters?: ClipFilters;
  /**
   * Bypassed: the clip keeps its place, its trim and its settings, but neither
   * the monitor nor the export sees it — the timeline plays black (and silent)
   * across it. Deleting is destructive and rippling moves everything else;
   * bypassing is how you ask "does the cut work without this shot?".
   */
  bypassed?: boolean;
  /**
   * Clips locked together. A shot and the sound detached from it, or a run of
   * cuts that has to keep its internal timing, move and are selected as one —
   * picking any member picks the whole group. Trimming stays per-clip: a group
   * fixes what moves together, not what a clip is.
   */
  groupId?: string;
  /**
   * How the picture sits in a frame of a different shape.
   *
   * `contain` (the default) shows all of it and pads with black. `cover` fills
   * the frame and crops the overflow — which is what a 16:9 shot dropped into a
   * 9:16 cut almost always wants, since the alternative is a thin band adrift
   * in black.
   */
  fit?: 'contain' | 'cover';
  /**
   * Quarter turns clockwise: 0, 90, 180, 270. Applied before the crop, so the
   * crop rectangle is always expressed on the picture as it is being looked at.
   */
  rotate?: 0 | 90 | 180 | 270;
  /**
   * The part of the (rotated) picture to keep, as fractions of it. Absent means
   * all of it — a full-frame rectangle is stripped back off rather than stored,
   * so "has a crop" stays a question with one answer.
   */
  crop?: { x: number; y: number; w: number; h: number };
  /**
   * Free placement inside the frame, set by dragging the picture's corner
   * points: `zoom` multiplies whatever the fit worked out to, and the offsets
   * slide the result, measured as fractions of the FRAME (not of the picture)
   * so they survive a change of frame size unchanged.
   */
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
  /**
   * Mirror the picture. Horizontal is the useful one — it turns a shot that
   * looks screen-left into one that looks screen-right, which is how an
   * eyeline is fixed without re-generating the shot. Sound is untouched, and
   * so is the clip's geometry: only what is drawn inside the frame flips.
   */
  flipH?: boolean;
  flipV?: boolean;
  /**
   * What this clip is called on the timeline. Absent until someone names it —
   * the fallback (the asset's title, or the subtitle's own text) is what makes
   * an unnamed clip readable, and storing that as a name would freeze it.
   */
  name?: string;
  /** Present only on text clips. */
  text?: ClipText;
  /**
   * Another film of this project, placed here whole (assetId is empty). It is a
   * live reference: the monitor and the export expand it into that film's clips
   * at the moment they are drawn, so an edit made in its own tab shows up here.
   * Trim points are frames of the referenced film.
   */
  seqRef?: string;
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  muted: boolean;
  locked: boolean;
  /**
   * The whole lane out of the cut: its clips stay where they are, but neither
   * the monitor nor the export sees or hears any of them. Clip bypass per lane.
   */
  bypassed?: boolean;
}

/** Everything about a subtitle except its words. */
export type SubtitleStyle = Omit<ClipText, 'content'>;

/** The shared style, or the default for this frame height when none is set yet. */
export function subtitleStyleOf(timeline: Timeline): SubtitleStyle {
  return (
    timeline.subtitleStyle ?? {
      size: Math.round(timeline.height / 18),
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: Math.max(2, Math.round(timeline.height / 240)),
      x: 0.5,
      y: 0.86,
      align: 'center',
      fontWeight: 600,
    }
  );
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  /**
   * True once the frame size was picked by hand. Until then the film takes the
   * size of the picture at its first frame; after, a new clip never overrides it.
   */
  frameSizeManual?: boolean;
  /**
   * The film's cover. It is the picture of frame 0 and of nothing else: the first frame of the
   * rendered film is this image, and every other frame, the sound and the length are untouched. Held
   * as a path into the backend's files, so it survives a reload; absent until one is set.
   */
  cover?: { url: string; title: string };
  /**
   * The one look every subtitle shares. Editing any subtitle's style writes here
   * and to all of them; new subtitles start from it. Absent until first set.
   */
  subtitleStyle?: SubtitleStyle;
  /** Bottom layer first. A later video track composites over an earlier one. */
  tracks: Track[];
  clips: Clip[];
  assets: Record<string, EditorAsset>;
}

/** On-timeline length in frames, after speed. */
export function clipLength(clip: Clip): number {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return Math.max(1, Math.round((clip.outFrame - clip.inFrame) / speed));
}

export const clipEnd = (clip: Clip): number => clip.start + clipLength(clip);

/**
 * Where inside the asset a given timeline frame lands, on the timeline grid.
 * Divide by fps for seconds — the source's own rate never enters here, because
 * trim points were normalised to the timeline grid when the asset was imported.
 */
export function sourceFrameAt(clip: Clip, playhead: number): number {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return clip.inFrame + (playhead - clip.start) * speed;
}

/**
 * Can `right` be joined back onto `left` as one clip?
 *
 * Merging is the exact inverse of a split, and nothing looser. Two pieces may
 * only become one when the join is invisible: same track, touching on the
 * timeline, same source, same speed, and continuous inside that source. Two
 * pieces that are merely adjacent after separate trims would have to gain or
 * lose frames to become one clip, and silently rewriting a cut is worse than
 * refusing it -- that case is a trim, and the trim handles are right there.
 */
export function canMergeClips(left: Clip, right: Clip): boolean {
  if (left.id === right.id) return false;
  if (left.trackId !== right.trackId) return false;
  if (clipEnd(left) !== right.start) return false;
  if ((left.speed || 1) !== (right.speed || 1)) return false;
  if (Boolean(left.bypassed) !== Boolean(right.bypassed)) return false;
  // A transition into the right-hand piece is a cut being dressed; joining the
  // two would delete it along with the cut it belongs to.
  if (right.transitionIn) return false;
  if (left.seqRef !== right.seqRef) return false;
  if (left.text || right.text) {
    // Titles carry no source, so continuity is about the text itself.
    return Boolean(left.text && right.text) && JSON.stringify(left.text) === JSON.stringify(right.text);
  }
  if (left.assetId !== right.assetId) return false;
  return left.outFrame === right.inFrame;
}

/**
 * The clips a merge would produce, each as a run of two or more pieces in
 * timeline order. Empty when the selection has nothing joinable in it.
 */
export function mergeRuns(timeline: Timeline, selection: string[]): Clip[][] {
  const locked = new Set(timeline.tracks.filter((t) => t.locked).map((t) => t.id));
  const chosen = timeline.clips
    .filter((c) => selection.includes(c.id) && !locked.has(c.trackId))
    .sort((a, b) => (a.trackId === b.trackId ? a.start - b.start : a.trackId.localeCompare(b.trackId)));

  const runs: Clip[][] = [];
  let run: Clip[] = [];
  for (const clip of chosen) {
    if (run.length > 0 && canMergeClips(run[run.length - 1], clip)) run.push(clip);
    else {
      if (run.length > 1) runs.push(run);
      run = [clip];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Runs of selected clips that touch on the timeline, whatever they are made of.
 *
 * This is the weaker relation `mergeRuns` refuses: different sources, different
 * speeds, colour moves, crops. Two such pieces cannot become one clip by
 * arithmetic — a clip points at exactly one asset — so joining them means
 * rendering the span to a new file. That is a real render, which is why it is a
 * separate action with a separate button, not a silent fallback from 合并.
 *
 * A dissolve counts as touching: it makes the right-hand piece overlap the left
 * by its own length, and the render reproduces it.
 */
export function adjacentRuns(timeline: Timeline, selection: string[]): Clip[][] {
  const locked = new Set(timeline.tracks.filter((t) => t.locked).map((t) => t.id));
  const chosen = timeline.clips
    .filter((c) => selection.includes(c.id) && !locked.has(c.trackId) && !c.bypassed)
    .sort((a, b) => (a.trackId === b.trackId ? a.start - b.start : a.trackId.localeCompare(b.trackId)));

  const touching = (left: Clip, right: Clip): boolean => {
    if (left.trackId !== right.trackId) return false;
    const end = clipEnd(left);
    if (right.start === end) return true;
    const overlap = right.transitionIn?.frames ?? 0;
    return overlap > 0 && right.start + overlap === end;
  };

  const runs: Clip[][] = [];
  let run: Clip[] = [];
  for (const clip of chosen) {
    if (run.length > 0 && touching(run[run.length - 1], clip)) run.push(clip);
    else {
      if (run.length > 1) runs.push(run);
      run = [clip];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

export function timelineDuration(timeline: Timeline): number {
  // A bypassed clip is not in the cut, so it does not lengthen it either: with
  // the last shot bypassed the timeline ends at the one before it, instead of
  // running on into an equally long stretch of black.
  return timeline.clips.reduce(
    (max, clip) => (clip.bypassed ? max : Math.max(max, clipEnd(clip))),
    0
  );
}

/**
 * The frame shapes offered by the size picker.
 *
 * Ratios, not resolutions: the shape is the decision, and the pixel count that
 * goes with it falls out of the quality setting.
 */
export const FRAME_RATIOS: Array<{ label: string; note: string; ratio: number }> = [
  { label: '16:9', note: '横屏 · 影片', ratio: 16 / 9 },
  { label: '9:16', note: '竖屏 · 短视频', ratio: 9 / 16 },
  { label: '1:1', note: '方形', ratio: 1 },
  { label: '4:5', note: '竖版信息流', ratio: 4 / 5 },
  { label: '4:3', note: '经典电视', ratio: 4 / 3 },
  { label: '21:9', note: '宽银幕', ratio: 21 / 9 },
];

/** Quality steps. The number is the SHORT side, so 1080 is 1080p either way up. */
export const FRAME_QUALITIES = [720, 1080, 1440, 2160];

/**
 * A concrete frame size for a ratio at a given quality.
 *
 * The quality names the short side, so switching 16:9 to 9:16 turns 1920×1080
 * into 1080×1920 rather than into something tiny or enormous. Both dimensions
 * are forced even: yuv420p, which every consumer player wants, cannot encode an
 * odd one.
 */
export function frameSizeFor(ratio: number, quality: number): { width: number; height: number } {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return ratio >= 1
    ? { width: even(quality * ratio), height: even(quality) }
    : { width: even(quality), height: even(quality / ratio) };
}

/** "16:9", or "1.85:1" for anything that is not one of the named shapes. */
export function describeRatio(width: number, height: number): string {
  if (!width || !height) return '—';
  const ratio = width / height;
  const named = FRAME_RATIOS.find((r) => Math.abs(r.ratio - ratio) < 0.01);
  return named ? named.label : `${ratio.toFixed(2)}:1`;
}

/**
 * What a clip is called: its own name if it has been given one, otherwise
 * whatever describes it best. One function, so the timeline block, the
 * inspector header and any future list all read the same.
 */
export function clipLabel(clip: Clip, asset?: EditorAsset | null, seqName?: string): string {
  const named = clip.name?.trim();
  if (named) return named;
  if (clip.seqRef) return t('引用：{v1}', { v1: seqName || clip.seqRef });
  if (clip.text) return t('字幕：{v1}', { v1: clip.text.content.split(/[\r\n]/)[0] || t('空') });
  return asset?.title || '素材';
}

/**
 * The selection, widened to whole groups.
 *
 * Every selection passes through here, so there is exactly one place where
 * "grouped" means anything: click one member and the group comes with it, and
 * every operation that reads the selection — move, delete, bypass — follows.
 */
export function expandGroups(clips: Clip[], ids: string[]): string[] {
  const groups = new Set(
    clips.filter((c) => ids.includes(c.id) && c.groupId).map((c) => c.groupId as string)
  );
  if (groups.size === 0) return ids;
  const out = new Set(ids);
  clips.forEach((c) => {
    if (c.groupId && groups.has(c.groupId)) out.add(c.id);
  });
  return [...out];
}

/**
 * A transcribed line as it goes on screen: without a closing full stop,
 * Chinese or English, since subtitles do not end on one. Only a single stop
 * is taken -- an ellipsis ("..." / "……") is a pause the line means, and ?/!
 * change how it reads, so those stay.
 */
export function subtitleText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd().replace(/(?<![.。．])[。．.]$/u, '').trimEnd())
    .join('\n')
    .trim();
}

/** SMPTE-ish timecode, non-drop: HH:MM:SS:FF. */
export function formatTimecode(frame: number, fps: number): string {
  const total = Math.max(0, Math.round(frame));
  const ff = total % fps;
  const seconds = Math.floor(total / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(ff)}`;
}

/**
 * Change the frame size. Titles are sized in pixels at the timeline's own
 * resolution, so they scale by the height ratio to keep the size they look;
 * their position is already a fraction of the frame. Even numbers only:
 * yuv420p cannot encode an odd dimension.
 */
export function resizeTimeline(timeline: Timeline, width: number, height: number): Timeline {
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round(height / 2) * 2);
  if (w === timeline.width && h === timeline.height) return timeline;
  const scale = timeline.height > 0 ? h / timeline.height : 1;
  const style = timeline.subtitleStyle;
  return {
    ...timeline,
    width: w,
    height: h,
    subtitleStyle: style && {
      ...style,
      size: Math.max(8, Math.round(style.size * scale)),
      strokeWidth: Math.round(style.strokeWidth * scale),
    },
    clips: timeline.clips.map((c) =>
      c.text
        ? {
            ...c,
            text: {
              ...c.text,
              size: Math.max(8, Math.round(c.text.size * scale)),
              strokeWidth: Math.round(c.text.strokeWidth * scale),
            },
          }
        : c
    ),
  };
}

/** The size of the picture at the film's first frame: the earliest video-track clip with a probed size. */
export function firstFrameSize(timeline: Timeline): { width: number; height: number } | null {
  const videoTracks = new Set(timeline.tracks.filter((tr) => tr.kind === 'video').map((tr) => tr.id));
  let best: { start: number; width: number; height: number } | null = null;
  for (const clip of timeline.clips) {
    if (clip.text || !videoTracks.has(clip.trackId)) continue;
    const asset = timeline.assets[clip.assetId];
    if (!asset || !(asset.width > 0) || !(asset.height > 0)) continue;
    if (!best || clip.start < best.start) best = { start: clip.start, width: asset.width, height: asset.height };
  }
  return best && { width: best.width, height: best.height };
}

/** Until the size is picked by hand, the film is the size of its first frame. */
export function adoptFirstFrameSize(timeline: Timeline): Timeline {
  if (timeline.frameSizeManual) return timeline;
  const size = firstFrameSize(timeline);
  return size ? resizeTimeline(timeline, size.width, size.height) : timeline;
}

export function emptyTimeline(fps = DEFAULT_FPS, width = 1920, height = 1080): Timeline {
  return {
    fps,
    width,
    height,
    tracks: [
      { id: 'V1', kind: 'video', name: t('V1 主轨'), muted: false, locked: false },
      { id: 'V2', kind: 'video', name: t('V2 叠加'), muted: false, locked: false },
      { id: 'A1', kind: 'audio', name: t('A1 音乐'), muted: false, locked: false },
    ],
    clips: [],
    assets: {},
  };
}

/** A trim point on the timeline grid, expressed in the source's own frames. */
export function toSourceFrame(frame: number, asset: EditorAsset, fps: number): number {
  if (!asset.fps || asset.fps <= 0) return frame;
  return Math.round((frame * asset.fps) / fps);
}

/**
 * Opacity of a clip at a given timeline frame, from its fades and its incoming
 * transition. A dissolve is an alpha ramp on the clip that arrives on top of the
 * one it replaces — the outgoing clip is still there underneath, which is what
 * makes it a cross dissolve rather than a dip to black.
 */
export function clipOpacity(clip: Clip, playhead: number): number {
  const local = playhead - clip.start;
  const length = clipLength(clip);
  let alpha = 1;

  const transition = clip.transitionIn;
  if (transition && transition.frames > 0 && local < transition.frames) {
    alpha = Math.min(alpha, local / transition.frames);
  }
  if (clip.fadeIn > 0 && local < clip.fadeIn) {
    alpha = Math.min(alpha, local / clip.fadeIn);
  }
  if (clip.fadeOut > 0 && local > length - clip.fadeOut) {
    alpha = Math.min(alpha, Math.max(0, (length - local) / clip.fadeOut));
  }
  return Math.max(0, Math.min(1, alpha));
}

/**
 * Volume as decibels.
 *
 * `Clip.volume` stays a linear gain, because that is what the monitor's
 * <video>.volume and ffmpeg's `volume` filter both take. Decibels only exist at
 * the panel: a slider that is linear in gain spends its top half on changes
 * nobody can hear and crushes every useful quiet setting into the first
 * centimetre.
 *
 * `VOLUME_FLOOR_DB` is the bottom of that slider and means silence, not
 * -60 dB — a gain of 0 has no decibel value at all.
 */
export const VOLUME_FLOOR_DB = -60;
export const VOLUME_CEILING_DB = 24;

export function gainToDb(gain: number): number {
  if (!(gain > 0)) return VOLUME_FLOOR_DB;
  return Math.max(VOLUME_FLOOR_DB, Math.min(VOLUME_CEILING_DB, 20 * Math.log10(gain)));
}

export function dbToGain(db: number): number {
  if (db <= VOLUME_FLOOR_DB) return 0;
  return 10 ** (Math.min(VOLUME_CEILING_DB, db) / 20);
}

/** Bottom of the waveform scale: a peak this quiet or quieter draws as the baseline. */
export const WAVEFORM_FLOOR_DB = -60;

/**
 * Waveform bar height, 0..1, for a peak (linear, 1 = full scale) played at a
 * clip gain. Every clip shares one dBFS scale, so a quiet line looks quiet next
 * to a loud one, and turning a clip up raises its bars. Above 0 dBFS it clips.
 */
export function peakHeight(peak: number, gain = 1): number {
  const level = peak * gain;
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - WAVEFORM_FLOOR_DB) / -WAVEFORM_FLOOR_DB));
}

/** `-∞`, `0.0` or `+3.5` — signed, because what matters is which side of unity. */
export function formatDb(db: number): string {
  if (db <= VOLUME_FLOOR_DB) return '-∞';
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

/**
 * The part of a clip that falls inside [from, to), rebased so `from` is frame 0.
 * Null when it does not reach into the span at all.
 *
 * Trim points move with the cut, scaled by speed: a clip playing at 2x consumes
 * two source frames per timeline frame, so cutting one frame off its head
 * advances its in point by two.
 */
export function clipInSpan(clip: Clip, from: number, to: number): Clip | null {
  const end = clipEnd(clip);
  if (clip.start >= to || end <= from) return null;
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const headCut = Math.max(0, from - clip.start);
  const tailCut = Math.max(0, end - to);
  const inFrame = clip.inFrame + Math.round(headCut * speed);
  const outFrame = clip.outFrame - Math.round(tailCut * speed);
  if (outFrame <= inFrame) return null;
  return {
    ...clip,
    start: Math.max(0, clip.start - from),
    inFrame,
    outFrame,
    // A fade that was cut through is no longer the shape it was; what survives
    // is only the part still inside the span.
    fadeIn: Math.max(0, clip.fadeIn - headCut),
    fadeOut: Math.max(0, clip.fadeOut - tailCut),
  };
}

/**
 * What is left of a clip once [from, to) has been taken out of it: nothing, the
 * head, the tail, or both as two clips. `newId` names the second piece.
 *
 * This is what keeps a merge from doubling its own sound — the span went into
 * the rendered file, so the part of the audio it swallowed has to leave the
 * timeline, while anything hanging out either side stays.
 */
export function clipOutsideSpan(clip: Clip, from: number, to: number, newId: () => string): Clip[] {
  const end = clipEnd(clip);
  if (clip.start >= to || end <= from) return [clip];
  const out: Clip[] = [];
  const head = clipInSpan(clip, clip.start, from);
  if (head) out.push({ ...head, start: clip.start });
  const tail = clipInSpan(clip, to, end);
  if (tail) out.push({ ...tail, id: newId(), start: to });
  return out;
}

/** Audio gain at a timeline frame, from the clip's own fades and volume. */
export function clipGain(clip: Clip, playhead: number): number {
  const local = playhead - clip.start;
  const length = clipLength(clip);
  let gain = clip.muted ? 0 : clip.volume;
  // The overlap of a seam dissolve belongs to the previous clip's sound (see Transition.seam).
  if (clip.seamMute && local >= clip.seamMute.from && local < clip.seamMute.to) return 0;
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= Math.max(0, local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > length - clip.fadeOut) {
    gain *= Math.max(0, (length - local) / clip.fadeOut);
  }
  return Math.max(0, gain);
}

/** The CSS/canvas `filter` string matching a clip's colour settings. */
export function filterCss(filters?: ClipFilters): string {
  if (!filters || isNeutral(filters)) return 'none';
  const parts = [
    `brightness(${(1 + filters.brightness).toFixed(3)})`,
    `contrast(${filters.contrast.toFixed(3)})`,
    `saturate(${filters.saturation.toFixed(3)})`,
  ];
  // Canvas has no temperature filter; sepia+hue-rotate is the closest stand-in
  // and is only ever a warm/cool nudge, matching what the slider offers.
  const delta = (filters.temperature - 6500) / 6500;
  if (Math.abs(delta) > 0.01) {
    parts.push(`sepia(${Math.min(0.4, Math.abs(delta) * 0.5).toFixed(3)})`);
    parts.push(`hue-rotate(${(delta > 0 ? -12 : 12) * Math.min(1, Math.abs(delta))}deg)`);
  }
  return parts.join(' ');
}

export function defaultClip(partial: Partial<Clip> & { id: string; trackId: string; assetId: string }): Clip {
  return {
    start: 0,
    inFrame: 0,
    outFrame: IMAGE_DEFAULT_FRAMES,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    ...partial,
  };
}

/**
 * Timeline zoom, in screen px per frame. The floor lets a ten-minute film (14 400
 * frames at 24 fps) fit a ~300 px strip and a half-hour one about 860 px; the
 * ceiling is where one frame is wider than a thumbnail tile.
 */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 48;
export const clampZoom = (px: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, px));
