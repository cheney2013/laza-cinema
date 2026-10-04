import { create } from 'zustand';

import { api, type NodeVersion, type SequenceInfo } from '../api';
import { type ClipboardPayload, buildClipboard, pasteInto } from './clipboard';
import { repointClipVersion } from './clipVersion';
import { SUBTITLE_TRACK_PREFIX, closeGap } from './gap';
import { applySeamPlan, planAllSeamDissolves, planSeamDissolve } from './seam';
import { buildExportPayload, nativeExportFps } from './exportPayload';
import { type ResolveSequence, flattenTimeline, referenceMismatch, referencesSequence, sequenceLength } from './nest';
import { type CropRect, clampCrop, isFullCrop } from './geometry';
import {
  type Clip,
  type ClipFilters,
  type ClipText,
  type EditorAsset,
  type Timeline,
  type Track,
  type Transition,
  type SubtitleStyle,
  DEFAULT_FPS,
  IMAGE_DEFAULT_FRAMES,
  NEUTRAL_FILTERS,
  adjacentRuns,
  clampZoom,
  clipEnd,
  clipInSpan,
  clipLabel,
  clipLength,
  clipOutsideSpan,
  defaultClip,
  emptyTimeline,
  expandGroups,
  mergeRuns,
  timelineDuration,
  adoptFirstFrameSize,
  resizeTimeline,
  subtitleStyleOf,
  subtitleText,
} from './types';
import { t } from '../i18n';
import { planDetach } from './detach';

/**
 * The cut room keeps its own store, deliberately separate from the canvas store.
 * They share a project but not a history: Ctrl+Z in the editor must never reach
 * back and move a node on the canvas.
 *
 * Undo is snapshot-based rather than command-inverse. A whole timeline is a few
 * kilobytes of plain JSON, so a snapshot per committed gesture is cheap, and it
 * cannot drift out of sync with the operations the way hand-written inverses do.
 * The cost is paid only on commit: drags and trims mutate freely while the
 * pointer is down and push exactly one snapshot when it comes up.
 */

const HISTORY_LIMIT = 100;
const AUTOSAVE_DEBOUNCE_MS = 800;

/** Open tabs kept in memory at once; the least recently used idle one is closed past this. */
export const MAX_OPEN_SESSIONS = 8;
const SCRATCH_PREFIX = 'scratch:';

export const isScratchSession = (id: string | null) => Boolean(id && id.startsWith(SCRATCH_PREFIX));

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let savePromise: Promise<void> | null = null;
let clipSeq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(clipSeq++).toString(36)}`;

/**
 * Everything that belongs to one open film. The active one lives in the flat
 * fields of the store (so every selector reads it as before); the others are
 * parked here whole, undo history included, and swapped back in on activate.
 */
export interface SessionSnapshot {
  scratch: { name: string; url: string } | null;
  timeline: Timeline;
  past: Timeline[];
  future: Timeline[];
  revision: number;
  loading: boolean;
  saveError: string | null;
  playhead: number;
  pxPerFrame: number;
  /**
   * Where the timeline is scrolled to. It belongs to the film, not to the
   * component: <TimelineView> is not remounted when tabs change, so without
   * this the incoming film inherits the outgoing one's scroll and its playhead
   * is off screen.
   */
  scrollLeft: number;
  scrollTop: number;
  selection: string[];
  exportJobId: string | null;
  exportStatus: string | null;
  exportTarget: 'film' | 'canvas' | 'merge';
  mergeJob: CutRoomState['mergeJob'];
  exportProgress: number;
  exportUrl: string | null;
  exportError: string | null;
  /** A merge render that finished while this film was parked; applied on activate. */
  pendingMergeUrl: string | null;
}

const SESSION_KEYS: (keyof SessionSnapshot)[] = [
  'scratch', 'timeline', 'past', 'future', 'revision', 'loading', 'saveError', 'playhead',
  'pxPerFrame', 'scrollLeft', 'scrollTop', 'selection', 'exportJobId', 'exportStatus', 'exportTarget', 'mergeJob',
  'exportProgress', 'exportUrl', 'exportError', 'pendingMergeUrl',
];

const blankSession = (): SessionSnapshot => ({
  scratch: null,
  timeline: emptyTimeline(),
  past: [],
  future: [],
  revision: 0,
  loading: false,
  saveError: null,
  playhead: 0,
  pxPerFrame: 4,
  scrollLeft: 0,
  scrollTop: 0,
  selection: [],
  exportJobId: null,
  exportStatus: null,
  exportTarget: 'film',
  mergeJob: null,
  exportProgress: 0,
  exportUrl: null,
  exportError: null,
  pendingMergeUrl: null,
});

const snapshotOf = (state: CutRoomState): SessionSnapshot =>
  Object.fromEntries(SESSION_KEYS.map((k) => [k, state[k]])) as unknown as SessionSnapshot;

export interface CutRoomState extends SessionSnapshot {
  /** The project's films, in tab order (not including scratch sessions). */
  /** Ctrl+C's payload. Survives tab switches; not saved with any film. */
  clipboard: ClipboardPayload | null;
  sequences: SequenceInfo[];
  /** Session on screen: a sequence id, or `scratch:…` for a lone-asset trim. */
  activeSeqId: string | null;
  /** Open tabs, in the order they were opened. */
  openOrder: string[];
  /** Parked sessions — every open one except the active. */
  sessions: Record<string, SessionSnapshot>;
  lastUsed: Record<string, number>;
  /**
   * Films referenced from an open tab but not open themselves, as last read
   * from disk. Open films are read from their session instead, so an edit in
   * another tab reaches a reference to it without a save round trip.
   */
  refTimelines: Record<string, Timeline>;
  /** Read every referenced film that is not open (again, so the cache is fresh). */
  loadRefs: () => Promise<void>;
  /** Place another film of this project on the active timeline, at the end of a lane. */
  appendSequenceRef: (seqId: string, trackId?: string, start?: number) => Promise<void>;

  activate: (id: string) => Promise<void>;
  /** Move an open tab to sit just before `beforeId`, or last when that is null. */
  moveTab: (id: string, beforeId: string | null) => void;
  closeSession: (id: string) => Promise<void>;
  createSequence: (name: string, copyFrom?: string) => Promise<void>;
  renameSequence: (id: string, name: string) => Promise<void>;
  deleteSequence: (id: string) => Promise<void>;
  /** Wait for any pending or in-flight autosave of the active film. */
  flushSave: () => Promise<void>;

  /**
   * Whether the cut room is on screen. The canvas binds the same keys (Space,
   * Ctrl+Z, Ctrl+C/V, Delete) on `window`, and its listener is registered first,
   * so it has to be able to stand down while the editor holds the keyboard.
   */
  open: boolean;
  setOpen: (open: boolean) => void;

  /**
   * Set while one asset is being trimmed on its own, outside any project. The
   * project's own timeline is left untouched on disk — autosave is keyed to
   * `projectId`, which is cleared for the duration.
   */
  scratch: { name: string; url: string } | null;
  /**
   * A 单素材剪辑 tab is being opened right now.
   *
   * Set synchronously, before the first await. Opening one is asynchronous —
   * parking the current film, then probing the file, which on a large clip means
   * building a proxy and takes seconds — while the cut room is told to open in
   * the same breath. Its own "no project load while a lone clip is being cut"
   * guard reads `scratch`, which is not set until the end of all that, so on a
   * big file the room loaded the project's films over the tab that was still
   * being built and it appeared only on the second click.
   */
  openingScratch: boolean;
  openScratch: (asset: { name: string; url: string; kind?: 'video' | 'audio' | 'image' }) => Promise<void>;
  exitScratch: () => void;

  timeline: Timeline;
  past: Timeline[];
  future: Timeline[];

  projectId: string | null;
  revision: number;
  loading: boolean;
  saving: boolean;
  saveError: string | null;

  playhead: number;
  playing: boolean;
  /** Timeline zoom. */
  pxPerFrame: number;
  selection: string[];
  /**
   * A clip the cut room should land on once it is open and loaded. Set from
   * outside (the asset library's 定位), consumed once by the cut room: opening
   * may trigger a load, and a load resets the selection, so the intent has to
   * outlive it rather than be applied on the spot.
   */
  focusClipId: string | null;
  /**
   * Ripple makes trims and deletes close (or open) the gap they leave behind.
   * 'track' moves only the clips on the edited track; 'all' moves every track
   * by the same amount, so picture, dialogue and music stay in sync.
   */
  ripple: RippleMode;
  snapping: boolean;
  /**
   * Space is held down. Held rather than pressed: while it is down the timeline
   * pans under a left-drag instead of scrubbing, so play/pause waits for the
   * key to come back up and is skipped entirely when a pan actually happened.
   */
  spaceHeld: boolean;
  /** A space-drag panned the timeline, so this press is not a play/pause. */
  spacePanned: boolean;

  exportJobId: string | null;
  exportStatus: string | null;
  /**
   * What the render running now is for. 'film' is the whole timeline; 'canvas'
   * is a single clip on its way back to the canvas as a node. The room needs to
   * know which, because the finished file is handed somewhere different — and
   * both use the one export slot, so only one can be in flight.
   */
  exportTarget: 'film' | 'canvas' | 'merge';
  /**
   * The run being flattened by `startMergeRender`, kept until its render lands
   * so the finished file can take the pieces' place.
   */
  mergeJob: {
    clipIds: string[];
    /**
     * Audio clips whose sound went into the render. A shot whose audio was
     * detached has its sound on another lane; rendering only the picture lane
     * would hand back a silent clip, and leaving those clips on the grid after
     * baking them in would play the same sound twice.
     */
    audioClipIds: string[];
    trackId: string;
    start: number;
    frames: number;
    name: string;
  } | null;
  exportProgress: number;
  exportUrl: string | null;
  exportError: string | null;

  load: (projectId: string) => Promise<void>;
  save: () => Promise<void>;
  scheduleSave: () => void;

  commit: () => void;
  undo: () => void;
  redo: () => void;

  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setPxPerFrame: (px: number) => void;
  setSpaceHeld: (held: boolean) => void;
  markSpacePanned: () => void;
  /** Copy the selection (whole groups) into the cross-tab clipboard. */
  copySelection: () => void;
  /**
   * Drop the clipboard onto this film at the playhead, keeping the copied
   * clips' spacing, lanes and settings. Works across tabs — and across films of
   * a different frame rate or frame size, which is why so much is rescaled.
   */
  pasteClipboard: () => void;
  setSelection: (ids: string[]) => void;
  /** With a sequence id, that film is opened first. */
  requestFocusClip: (clipId: string, seqId?: string) => void;
  /** Apply a pending focus request; no-op when the clip is not (yet) there. */
  consumeFocusClip: () => void;
  toggleRipple: () => void;
  toggleSnapping: () => void;
  /** Lock the selected clips together, so they are picked and moved as one. */
  groupSelection: () => void;
  /** Break every group the selection touches back into loose clips. */
  ungroupSelection: () => void;

  addAsset: (input: { nodeId: string; url: string; title: string; kind: 'video' | 'image' | 'audio' }) => Promise<string | null>;
  /**
   * Put an asset on the grid. Without `at` it goes on the end of the track;
   * with `at` it is inserted there: a frame inside a clip moves to that clip's
   * end, and everything after it on the same track moves right to make room.
   */
  /** `exact`: a drop -- past the track's last clip it lands at `at` instead of being appended. */
  appendClip: (assetId: string, trackId?: string, at?: number, exact?: boolean) => void;
  /**
   * Open chained shots out to their untrimmed renders so the overlap frames can
   * be trimmed back in. `map`: trimmed url -> { url: untrimmed, frames: overlap
   * in the SOURCE's frames }. Clips keep exactly what they showed; their in/out
   * points move by the overlap. Resolves to how many assets changed.
   */
  openChainHeads: (map: Record<string, { url: string; frames: number }>) => Promise<number>;
  addTextClip: (trackId?: string) => void;
  /**
   * Transcribe the film's sound and lay one title per sentence on the 字幕 track,
   * replacing what an earlier run put there. Resolves to the number of titles.
   */
  autoSubtitles: (options?: {
    onProgress?: (progress: number, stage: 'mixing' | 'transcribing') => void;
    signal?: AbortSignal;
  }) => Promise<number | null>;
  addTrack: (kind: 'video' | 'audio') => void;
  setTrackFlag: (trackId: string, patch: Partial<Pick<Track, 'muted' | 'locked' | 'bypassed'>>) => void;
  setTransition: (clipId: string, transition: Transition | null) => void;
  /** One click: dissolve over a chained shot's overlap frames, aligned to the end of the previous shot. Returns why not, or null. */
  seamDissolve: (clipId: string) => string | null;
  /** The same for every chained shot on the picture lanes, as one undo step. */
  seamDissolveAll: () => { applied: number; already: number; blocked: Array<{ label: string; reason: string }> };
  setFilters: (clipId: string, patch: Partial<ClipFilters>) => void;
  setText: (clipId: string, patch: Partial<ClipText>) => void;
  /** The film's shared subtitle look: written to the film and to every subtitle in it. */
  setSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;
  commitUpdate: (clipId: string, patch: Partial<Clip>) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  moveClip: (id: string, start: number, trackId?: string) => void;
  /**
   * Shift several clips by the same number of frames, keeping their spacing. `tracks` (clip id -> track id)
   * re-homes them as well, which the caller has already checked against locked and missing tracks.
   */
  moveClips: (ids: string[], deltaFrames: number, tracks?: Record<string, string>) => void;
  trimClip: (id: string, edge: 'in' | 'out', frame: number) => void;
  splitAtPlayhead: () => void;
  /** Join selected pieces that were split apart back into one clip. */
  mergeSelection: () => void;
  deleteSelection: () => void;
  /** Take the frames [from, to) out of the film: every unlocked track after them moves left. */
  /** Close a gap. With a trackId the hole is that lane's own and only it (and what is grouped to it) closes up. */
  deleteGap: (from: number, to: number, trackId?: string) => void;
  /** Take the selected clips out of the cut without removing them. */
  toggleBypass: () => void;
  /** Move the selected shots' sound onto an audio track of its own. */
  /** Splits the sound of the selected shots onto audio lanes. Returns what to tell the user (why nothing happened, or what was passed over), or null. */
  detachAudio: () => string | null;
  /**
   * The file behind these clips is gone. Marks them offline rather than cutting
   * them: the monitor and the export both skip an offline asset, so the cut
   * keeps its shape and its timings while showing plainly what is missing.
   */
  markAssetsOffline: (url: string) => void;
  /**
   * Point assets at other files, keeping every clip's position and trims:
   * the rough cut's clips swapped for their upscaled versions (and back).
   * `map` is old url -> new url. Resolves to how many assets changed.
   */
  relinkAssets: (map: Record<string, { url: string; headFrames: number }>, direction: 'hd' | 'rough') => Promise<number>;
  /** Point one clip, not every clip cut from the same shot, at another version of its node, keeping the cut where it is. */
  switchClipVersion: (clipId: string, version: NodeVersion, useHd: boolean) => Promise<boolean>;
  /** Rename assets by url (shot label + version from the canvas). No undo entry. */
  retitleAssets: (titles: Record<string, string>) => void;
  /**
   * Re-probe every asset marked offline and bring back the ones whose file
   * answers. An asset goes offline when prepare-asset failed at drop time, and
   * that flag is saved with the timeline — so a backend fix (nested upload
   * paths, 2026-09-06) or a restored file never reached clips already on the
   * grid. Runs after load; harmless when nothing is offline.
   */
  relinkOfflineAssets: () => Promise<number>;
  /**
   * Re-probe one file and update every record pointing at it — in this film and
   * in the parked ones, which point at the same file.
   *
   * Called after 覆盖原素材. Clip trim points are deliberately left alone: the
   * overwritten file is usually SHORTER (that is what trimming in place is
   * for), and clamping other films' clips to it would quietly change cuts
   * nobody asked to change. A clip running past the new end shows black there,
   * which is visible and undoable; a silently retimed film is neither.
   */
  refreshAssetByUrl: (url: string) => Promise<void>;
  /**
   * Re-fetch peaks that were built at the old fixed 400-bucket density. Peaks
   * are saved with the timeline, so a project cut before the backend started
   * scaling density with duration would keep drawing a handful of fat blocks
   * for every trim. Runs after load; a no-op once every asset is dense.
   */
  refreshCoarsePeaks: () => Promise<number>;
  /** Reshape the finished film. Clips keep their timing; only the frame changes. */
  setFrameSize: (width: number, height: number) => void;
  /** The film's cover: the picture of frame 0, in the monitor and in the exported film. Null clears it. */
  setCover: (cover: { url: string; title: string } | null) => void;
  /** Drop a hand-picked size and go back to the first frame's. */
  followFirstFrame: () => void;
  /**
   * The crop being dragged on the monitor, if any. While this is set the monitor
   * shows that clip WHOLE and uncropped — the rectangle is what is being chosen,
   * so the thing being cropped away has to stay visible to be chosen back.
   */
  cropDraft: { clipId: string; rect: CropRect } | null;
  beginCrop: (clipId: string) => void;
  setCropDraft: (rect: CropRect) => void;
  commitCrop: () => void;
  cancelCrop: () => void;
  clearTimeline: () => void;

  /** `burnSubtitles: false` leaves the titles out of the render (they go out as an .srt instead). */
  startExport: (name: string, options?: { burnSubtitles?: boolean; download?: boolean }) => Promise<void>;
  /**
   * Render ONE clip, exactly as it is cut here — trim, speed, crop, colour,
   * volume and all — and leave the result for the room to hang on the canvas.
   * Its transition is dropped: a transition is a join with the clip before it,
   * and on its own there is nothing to join to.
   */
  startClipExport: (clipId: string, name: string) => Promise<void>;
  /**
   * Render the selected run of touching clips to one file and put that file on
   * the timeline in their place. Everything the pieces carried — trims, speeds,
   * fades, colour, crops, the dissolves between them — is baked into the render,
   * so the clip that replaces them is a plain untouched shot.
   */
  startMergeRender: (name: string) => Promise<void>;
  dismissExport: () => void;
}

const cloneTimeline = (timeline: Timeline): Timeline => ({
  ...timeline,
  tracks: timeline.tracks.map((t) => ({ ...t })),
  clips: timeline.clips.map((c) => ({ ...c })),
  assets: { ...timeline.assets },
});

type Get = () => CutRoomState;
type Set = (partial: Partial<CutRoomState> | ((s: CutRoomState) => Partial<CutRoomState>)) => void;

export type RippleMode = 'off' | 'track' | 'all';

function lockedTracks(timeline: Timeline): globalThis.Set<string> {
  return new globalThis.Set(timeline.tracks.filter((t) => t.locked).map((t) => t.id));
}

/**
 * Replace `before` with `after` and move what followed it by `delta` frames:
 * every clip starting at or after its old end, on its own track ('track') or on
 * every unlocked track ('all'). Called on each step of a trim drag, so `delta`
 * is always measured against the state the previous step left.
 */
function rippleAfter(
  get: Get, set: Set, before: Clip, after: Clip, oldEnd: number, delta: number, mode: RippleMode
): void {
  const { timeline } = get();
  const locked = lockedTracks(timeline);
  const moves = (c: Clip) =>
    c.id !== before.id && c.start >= oldEnd &&
    (mode === 'all' ? !locked.has(c.trackId) : c.trackId === before.trackId);
  set({
    timeline: {
      ...timeline,
      clips: timeline.clips.map((c) =>
        c.id === before.id ? after : delta !== 0 && moves(c) ? { ...c, start: Math.max(0, c.start + delta) } : c
      ),
    },
  });
  get().scheduleSave();
}

/**
 * How a referenced film is looked up: the tab on screen, a parked tab, or the
 * copy read from disk -- in that order, so unsaved edits in an open tab count.
 */
export function resolverOf(state: CutRoomState): ResolveSequence {
  return (id) => {
    if (id === state.activeSeqId) return state.timeline;
    return state.sessions[id]?.timeline ?? state.refTimelines[id] ?? null;
  };
}

let flatCache: { keys: unknown[]; out: Timeline } | null = null;

/**
 * The active timeline with its references expanded, which is what the monitor
 * plays. Cached on the identities it depends on, so it is safe to call from a
 * selector and from the paint loop every frame.
 */
export function flatTimelineOf(state: CutRoomState): Timeline {
  if (!state.timeline.clips.some((c) => c.seqRef)) return state.timeline;
  const keys = [state.timeline, state.sessions, state.refTimelines, state.activeSeqId];
  if (flatCache && flatCache.keys.every((k, i) => k === keys[i])) return flatCache.out;
  const out = flattenTimeline(state.timeline, resolverOf(state), new Set(state.activeSeqId ? [state.activeSeqId] : []));
  flatCache = { keys, out };
  return out;
}

/** One session's fields, wherever it is: the flat store if active, else parked. */
function readSession(get: Get, id: string | null): SessionSnapshot | null {
  const state = get();
  if (id === state.activeSeqId) return state;
  return id ? state.sessions[id] ?? null : null;
}

/** Write to one session's fields without disturbing whichever film is on screen. */
function writeSession(get: Get, set: Set, id: string | null, patch: Partial<SessionSnapshot>): void {
  if (id === get().activeSeqId) {
    set(patch);
    return;
  }
  set((state) => {
    const parked = id ? state.sessions[id] : undefined;
    if (!id || !parked) return {};
    return { sessions: { ...state.sessions, [id]: { ...parked, ...patch } } };
  });
}

/**
 * Follow one export job to its end. The export runs off the GPU queue, so it
 * has its own poll rather than joining jobPollerStore; the job id is re-checked
 * every tick so a second export started meanwhile takes over cleanly. It is
 * tied to the session that started it, so several films can render at once
 * and a render keeps reporting into its own tab while another one is shown.
 */
async function pollExport(
  jobId: string,
  sid: string | null,
  get: Get,
  set: Set,
  onComplete?: (url: string) => void
): Promise<void> {
  if (readSession(get, sid)?.exportJobId !== jobId) return;
  try {
    const job = await api.getExportJob(jobId);
    if (readSession(get, sid)?.exportJobId !== jobId) return;
    writeSession(get, set, sid, {
      exportStatus: job.status,
      exportProgress: job.progress ?? 0,
      exportUrl: job.video_url ?? null,
      exportError: job.error ?? null,
    });
    if (job.status === 'completed') {
      if (job.video_url) onComplete?.(job.video_url);
      return;
    }
    if (job.status === 'failed') return;
  } catch (error) {
    writeSession(get, set, sid, { exportStatus: 'failed', exportError: (error as Error).message });
    return;
  }
  setTimeout(() => void pollExport(jobId, sid, get, set, onComplete), 1000);
}

/** A merge edits the timeline, so it waits until its film is the one on screen. */
function landMerge(url: string, sid: string | null, get: Get, set: Set): void {
  if (sid === get().activeSeqId) void finishMerge(url, get, set);
  else writeSession(get, set, sid, { pendingMergeUrl: url });
}

/**
 * Put a finished merge render on the timeline in place of the pieces it was
 * made from.
 *
 * The new clip is deliberately neutral — speed 1, no fades, no filters, no
 * crop: every one of those was applied while rendering, and carrying them over
 * would apply them a second time. Its length is the span the run occupied, so
 * nothing downstream of it moves.
 */
async function finishMerge(
  url: string,
  get: Get,
  set: Set
): Promise<void> {
  set({ pendingMergeUrl: null });
  const job = get().mergeJob;
  if (!job) return;
  const assetId = await get().addAsset({
    nodeId: '',
    url,
    title: job.name,
    kind: url.endsWith('.wav') ? 'audio' : 'video',
  });
  if (!assetId) {
    set({ exportStatus: 'failed', exportError: t('合并后的文件无法读入时间线。') });
    return;
  }

  const { timeline } = get();
  const asset = timeline.assets[assetId];
  const pieces = job.clipIds
    .map((id) => timeline.clips.find((c) => c.id === id))
    .filter((c): c is Clip => Boolean(c));
  if (pieces.length === 0) {
    // The run was edited away while it rendered. The file is in the library and
    // the media bin will list it; nothing is put back on the grid by force.
    set({ mergeJob: null, exportError: t('这些片段在合并渲染完成前已被改动，合并结果没有放回时间线。'), exportStatus: 'failed' });
    return;
  }

  get().commit();
  const merged: Clip = defaultClip({
    id: nextId('clip'),
    trackId: job.trackId,
    assetId,
    start: job.start,
    inFrame: 0,
    // The render is the run's own span; a probe a frame off must not open a gap
    // or overlap the next shot.
    outFrame: Math.min(job.frames, asset?.timelineFrames || job.frames),
    transitionIn: pieces[0].transitionIn,
    name: pieces[0].name,
  });

  const removed = new Set(job.clipIds);
  const baked = new Set(job.audioClipIds ?? []);
  const spanEnd = job.start + job.frames;
  const clips: Clip[] = [];
  for (const clip of get().timeline.clips) {
    if (removed.has(clip.id)) continue;
    // The sound over this span is inside the rendered file now. What hung out
    // either side of it stays, as a head and a tail; what was wholly inside
    // goes, or it would play on top of itself.
    if (baked.has(clip.id)) {
      clips.push(...clipOutsideSpan(clip, job.start, spanEnd, () => nextId('clip')));
      continue;
    }
    clips.push(clip);
  }
  set({
    timeline: { ...get().timeline, clips: [...clips, merged] },
    selection: [merged.id],
    mergeJob: null,
  });
  get().scheduleSave();
  // The timeline itself is the receipt; an export banner offering to open the
  // file would only be in the way.
  get().dismissExport();
}

/**
 * An asset record rebuilt from a fresh probe, on a given film's grid.
 *
 * The derived parts — proxy, thumbnail strip, peaks, and the length on the grid
 * — all describe the file as it was when the record was made. When the file is
 * rewritten under the same name they are all wrong at once, and the proxy is the
 * one that shows: the monitor keeps playing the old cut from a proxy that is
 * still on disk under its old name.
 */
function probedAsset(current: EditorAsset, probe: Awaited<ReturnType<typeof api.prepareTimelineAsset>>, fps: number): EditorAsset {
  const kind = (probe.kind as EditorAsset['kind']) || current.kind;
  const nativeFrames = probe.frames || 0;
  return {
    ...current,
    kind,
    width: probe.width || 0,
    height: probe.height || 0,
    fps: probe.fps || 0,
    frames: nativeFrames,
    timelineFrames:
      kind === 'image'
        ? IMAGE_DEFAULT_FRAMES
        : kind === 'audio'
        ? Math.max(1, Math.round((probe.duration || 0) * fps))
        // Floor for the same reason as in addAsset: never claim a frame the
        // file does not have.
        : Math.max(1, Math.floor((nativeFrames * fps) / (probe.fps || fps))),
    hasAudio: Boolean(probe.has_audio),
    proxyUrl: probe.proxy_url,
    thumbsUrl: probe.thumbs_url,
    thumbCount: probe.thumb_count,
    peaks: probe.peaks,
    rms: probe.rms,
    offline: false,
  };
}

export const useCutRoom = create<CutRoomState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),

  ...blankSession(),

  clipboard: null,
  sequences: [],
  activeSeqId: null,
  openOrder: [],
  sessions: {},
  lastUsed: {},
  refTimelines: {},

  loadRefs: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    const fetched: Record<string, Timeline> = {};
    const visited = new Set<string>();
    const openTimeline = (id: string): Timeline | null => {
      const state = get();
      if (id === state.activeSeqId) return state.timeline;
      return state.sessions[id]?.timeline ?? null;
    };
    const walk = async (timeline: Timeline): Promise<void> => {
      for (const clip of timeline.clips) {
        const id = clip.seqRef;
        if (!id || visited.has(id)) continue;
        visited.add(id);
        let nested = openTimeline(id);
        if (!nested) {
          try {
            const data = await api.loadSequence(projectId, id);
            if (!data.timeline) continue;
            nested = loadedTimeline(data.timeline as Timeline);
            fetched[id] = nested;
          } catch {
            continue;
          }
        }
        await walk(nested);
      }
    };
    const state = get();
    await walk(state.timeline);
    for (const session of Object.values(state.sessions)) await walk(session.timeline);
    if (get().projectId !== projectId) return;
    if (Object.keys(fetched).length > 0) set((s) => ({ refTimelines: { ...s.refTimelines, ...fetched } }));
  },

  appendSequenceRef: async (seqId, trackId, at) => {
    const state = get();
    const host = state.activeSeqId;
    if (!host || isScratchSession(host)) throw new Error(t('单素材标签里不能引用影片'));
    if (seqId === host) throw new Error(t('不能在影片里引用它自己'));
    let resolve = resolverOf(get());
    if (!resolve(seqId) && state.projectId) {
      const data = await api.loadSequence(state.projectId, seqId);
      const loaded = data.timeline ? loadedTimeline(data.timeline as Timeline) : emptyTimeline();
      set((s) => ({ refTimelines: { ...s.refTimelines, [seqId]: loaded } }));
      await get().loadRefs();
      resolve = resolverOf(get());
    }
    const nested = resolve(seqId);
    if (!nested) throw new Error(t('读不到这部影片'));
    if (referencesSequence(seqId, host, resolve)) {
      throw new Error(t('这部影片已经引用了当前影片，互相引用会无限套娃'));
    }
    const { timeline } = get();
    // An empty film has no shape of its own yet: it takes the referenced film's.
    const adopt = timeline.clips.length === 0;
    // Only the frame rate has to match; a film of another size is fitted into this one's frame.
    const mismatch = adopt ? null : referenceMismatch(timeline, nested);
    if (mismatch) {
      throw new Error(
        t('帧率不同（{v1}fps 与当前 {v2}fps），帧率必须一样才能引用', { v1: mismatch.nestedFps, v2: mismatch.hostFps })
      );
    }
    const frames = sequenceLength(seqId, resolve);
    if (frames <= 0) throw new Error(t('这部影片还是空的'));
    const track =
      timeline.tracks.find((tr) => tr.id === trackId) ?? timeline.tracks.find((tr) => tr.kind === 'video');
    if (!track) return;
    if (track.locked) throw new Error(t('这条轨道已锁定'));
    const lane = timeline.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
    // Dropped at a frame: the first stretch from there on that is long enough
    // (nothing already on the lane is moved). No frame: the end of the lane.
    let start = at === undefined ? lane.reduce((max, c) => Math.max(max, clipEnd(c)), 0) : Math.max(0, Math.round(at));
    for (const c of lane) {
      if (c.start < start + frames && clipEnd(c) > start) start = clipEnd(c);
    }
    const clip = defaultClip({
      id: nextId('clip'),
      trackId: track.id,
      assetId: '',
      seqRef: seqId,
      start: adopt ? 0 : start,
      inFrame: 0,
      outFrame: frames,
    });
    get().commit();
    set((s) => {
      const base = adopt
        ? {
            ...resizeTimeline(s.timeline, nested.width, nested.height),
            fps: nested.fps,
            frameSizeManual: nested.frameSizeManual,
          }
        : s.timeline;
      return { timeline: { ...base, clips: [...base.clips, clip] }, selection: [clip.id] };
    });
    get().scheduleSave();
  },

  moveTab: (id, beforeId) => {
    set((s) => {
      if (!s.openOrder.includes(id) || id === beforeId) return {};
      const rest = s.openOrder.filter((sid) => sid !== id);
      const at = beforeId ? rest.indexOf(beforeId) : -1;
      const openOrder = at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
      return openOrder.every((sid, i) => sid === s.openOrder[i]) ? {} : { openOrder };
    });
  },

  flushSave: async () => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      await get().save();
    }
    if (savePromise) await savePromise;
  },

  activate: async (id) => {
    const state = get();
    if (id === state.activeSeqId) return;
    await get().flushSave();

    const current = get();
    const sessions = { ...current.sessions };
    if (current.activeSeqId) {
      sessions[current.activeSeqId] = snapshotOf(current);
      saveView(current);
    }
    const parked = sessions[id];
    delete sessions[id];

    const openOrder = current.openOrder.includes(id) ? current.openOrder : [...current.openOrder, id];
    set({
      // A parked tab still holds its own view. A cold one — reopened after a
      // reload, or evicted past the cap — gets back whatever was last stored.
      ...(parked ?? {
        ...blankSession(),
        ...readSavedView(current.projectId, id),
        loading: !isScratchSession(id),
      }),
      sessions,
      activeSeqId: id,
      openOrder,
      lastUsed: { ...current.lastUsed, [id]: Date.now() },
      playing: false,
      cropDraft: null,
    });

    // Past the cap, close the least recently used tab that is not rendering.
    // Parked tabs are always saved (the flush above), so closing loses nothing
    // but their undo history.
    const now = get();
    if (now.openOrder.length > MAX_OPEN_SESSIONS) {
      const idle = now.openOrder
        .filter((sid) => sid !== id && !isScratchSession(sid))
        .filter((sid) => !['queued', 'running'].includes(now.sessions[sid]?.exportStatus ?? ''))
        .sort((a, b) => (now.lastUsed[a] ?? 0) - (now.lastUsed[b] ?? 0));
      const victim = idle[0];
      if (victim) {
        const rest = { ...now.sessions };
        delete rest[victim];
        set({ sessions: rest, openOrder: now.openOrder.filter((sid) => sid !== victim) });
      }
    }

    if (parked) {
      if (parked.pendingMergeUrl) void finishMerge(parked.pendingMergeUrl, get, set);
      void get().loadRefs();
      return;
    }
    if (isScratchSession(id)) return;
    const projectId = get().projectId;
    if (!projectId) return;
    try {
      const data = await api.loadSequence(projectId, id);
      if (get().activeSeqId !== id) return;
      set({
        timeline: data.timeline ? loadedTimeline(data.timeline as Timeline) : emptyTimeline(),
        revision: data.revision ?? 0,
        loading: false,
      });
      void get().relinkOfflineAssets();
      void get().refreshCoarsePeaks();
      void get().loadRefs();
    } catch (error) {
      if (get().activeSeqId === id) set({ loading: false, saveError: (error as Error).message });
    }
  },

  closeSession: async (id) => {
    const state = get();
    if (!state.openOrder.includes(id)) return;
    const remaining = state.openOrder.filter((sid) => sid !== id);
    if (id === state.activeSeqId) {
      // The neighbour to the left, else the right; a scratch tab falls back to
      // the film that was on screen before it.
      const at = state.openOrder.indexOf(id);
      const next = remaining[Math.max(0, at - 1)] ?? state.sequences[0]?.id ?? null;
      if (next) await get().activate(next);
      else {
        await get().flushSave();
        set({ ...blankSession(), activeSeqId: null });
      }
    }
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions, openOrder: s.openOrder.filter((sid) => sid !== id) };
    });
  },

  createSequence: async (name, copyFrom) => {
    const { projectId } = get();
    if (!projectId) return;
    // A copy of the film on screen must include edits autosave has not written.
    if (copyFrom && copyFrom === get().activeSeqId) await get().flushSave();
    const info = await api.createSequence(projectId, name, copyFrom);
    set((s) => ({ sequences: [...s.sequences, info] }));
    await get().activate(info.id);
  },

  renameSequence: async (id, name) => {
    const { projectId } = get();
    if (!projectId || !name.trim()) return;
    const info = await api.renameSequence(projectId, id, name.trim());
    set((s) => ({ sequences: s.sequences.map((q) => (q.id === id ? { ...q, ...info } : q)) }));
  },

  deleteSequence: async (id) => {
    const { projectId, sequences } = get();
    if (!projectId || sequences.length <= 1) return;
    if (id === get().activeSeqId) {
      const other = get().openOrder.find((sid) => sid !== id && !isScratchSession(sid))
        ?? sequences.find((q) => q.id !== id)!.id;
      await get().activate(other);
    }
    await api.deleteSequence(projectId, id);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return {
        sequences: s.sequences.filter((q) => q.id !== id),
        sessions,
        openOrder: s.openOrder.filter((sid) => sid !== id),
      };
    });
  },

  openScratch: async (asset) => {
    // A lone-asset trim is a tab of its own, never saved to the project: the
    // film on screen is parked, not replaced.
    const sid = `${SCRATCH_PREFIX}${nextId('s')}`;
    // Before the first await, so the cut room opening alongside this sees it.
    set({ openingScratch: true });
    try {
      await get().activate(sid);
      set({ scratch: { name: asset.name, url: asset.url } });

      // A sound file lands on the A track (appendClip picks the track by kind);
      // the probe corrects the kind anyway if the caller guessed wrong.
      const assetId = await get().addAsset({
        nodeId: '', url: asset.url, title: asset.name, kind: asset.kind ?? 'video',
      });
      if (assetId) {
        get().appendClip(assetId);
        // appendClip already took the source's size; this repeats it for a
        // probe that finished after the clip went down.
        set((state) => ({ timeline: adoptFirstFrameSize(state.timeline) }));
      }
      // The setup itself is not an edit worth undoing.
      set({ past: [], future: [], selection: [] });
    } finally {
      set({ openingScratch: false });
    }
  },

  exitScratch: () => {
    const { activeSeqId } = get();
    if (isScratchSession(activeSeqId)) void get().closeSession(activeSeqId!);
  },

  projectId: null,
  openingScratch: false,
  saving: false,

  playing: false,
  focusClipId: null,
  ripple: 'off',
  snapping: true,
  spaceHeld: false,
  spacePanned: false,

  load: async (projectId) => {
    await get().flushSave();
    // A different project: its films replace the previous project's tabs.
    // Scratch tabs belong to no project and stay.
    set((s) => {
      const sessions = Object.fromEntries(
        Object.entries(s.sessions).filter(([sid]) => isScratchSession(sid))
      );
      return {
        ...blankSession(),
        loading: true,
        projectId,
        sequences: [],
        activeSeqId: null,
        refTimelines: {},
        sessions,
        openOrder: s.openOrder.filter(isScratchSession),
      };
    });
    try {
      const { sequences } = await api.listSequences(projectId);
      if (get().projectId !== projectId) return;
      set({ sequences });
      // Reopen the tabs this project had last time, in their order, and land on
      // the one that was in front. Films deleted since are skipped.
      const known = new Set(sequences.map((q) => q.id));
      const saved = readSavedTabs(projectId);
      const reopen = saved.open.filter((id) => known.has(id)).slice(0, MAX_OPEN_SESSIONS);
      const front = saved.active && known.has(saved.active) ? saved.active : reopen[reopen.length - 1];
      if (reopen.length > 0) {
        set((s) => ({ openOrder: [...s.openOrder, ...reopen.filter((id) => !s.openOrder.includes(id))] }));
        await get().activate(front ?? reopen[0]);
      } else if (sequences[0]) await get().activate(sequences[0].id);
      else set({ loading: false });
    } catch (error) {
      set({ loading: false, saveError: (error as Error).message });
    }
  },

  refreshAssetByUrl: async (url) => {
    let probe;
    try {
      probe = await api.prepareTimelineAsset(url);
    } catch {
      return; // the file is not readable; the record stays as it was
    }
    const refreshIn = (timeline: Timeline): Timeline => {
      const ids = Object.values(timeline.assets).filter((a) => a.url === url).map((a) => a.id);
      if (ids.length === 0) return timeline;
      const assets = { ...timeline.assets };
      for (const id of ids) assets[id] = probedAsset(assets[id], probe, timeline.fps);
      return { ...timeline, assets };
    };
    // Not an edit the user made: no undo entry, same as markAssetsOffline.
    set((state) => ({
      timeline: refreshIn(state.timeline),
      sessions: Object.fromEntries(
        Object.entries(state.sessions).map(([sid, session]) => [
          sid,
          { ...session, timeline: refreshIn(session.timeline) },
        ])
      ),
    }));
    get().scheduleSave();
  },

  refreshCoarsePeaks: async () => {
    // The backend gives 40 buckets a second (floor 400). Anything at or below
    // half that for its length came from the old recipe.
    const { timeline } = get();
    const stale = Object.values(timeline.assets).filter((asset) => {
      if (asset.offline || !asset.peaks || asset.peaks.length === 0) return false;
      // Built before loudness was measured: fetch it once so the bars can show it.
      if (!asset.rms || asset.rms.length === 0) return true;
      const seconds = asset.timelineFrames / (timeline.fps || DEFAULT_FPS);
      const expected = Math.min(Math.max(seconds * 40, 400), 6000);
      return asset.peaks.length < expected * 0.5;
    });
    if (stale.length === 0) return 0;

    let updated = 0;
    for (const asset of stale) {
      let probe;
      try {
        probe = await api.prepareTimelineAsset(asset.url);
      } catch {
        continue;
      }
      if (!probe.peaks || (probe.peaks.length <= (asset.peaks?.length ?? 0) && !probe.rms)) continue;
      set((state) => {
        const current = state.timeline.assets[asset.id];
        if (!current) return state;
        return {
          timeline: {
            ...state.timeline,
            assets: { ...state.timeline.assets, [asset.id]: { ...current, peaks: probe.peaks, rms: probe.rms } },
          },
        };
      });
      updated += 1;
    }
    // Not an edit the user made: no undo entry, but worth persisting so the
    // next open does not fetch them again.
    if (updated > 0) get().scheduleSave();
    return updated;
  },

  relinkOfflineAssets: async () => {
    const offline = Object.values(get().timeline.assets).filter((a) => a.offline);
    if (offline.length === 0) return 0;
    let restored = 0;
    for (const stale of offline) {
      let probe;
      try {
        probe = await api.prepareTimelineAsset(stale.url);
      } catch {
        continue; // still gone; the clip stays marked
      }
      const { timeline } = get();
      const fps = timeline.fps;
      const current = timeline.assets[stale.id];
      if (!current || !current.offline) continue;
      const relinked = probedAsset(current, probe, fps);
      // Not an edit the user made, so no undo entry — same as markAssetsOffline.
      set((state) => ({
        timeline: { ...state.timeline, assets: { ...state.timeline.assets, [stale.id]: relinked } },
      }));
      restored += 1;
    }
    if (restored > 0) get().scheduleSave();
    return restored;
  },

  save: async () => {
    if (savePromise) await savePromise;
    const { projectId, activeSeqId: sid, timeline, revision } = get();
    // Scratch tabs are never written to the project.
    if (!projectId || !sid || isScratchSession(sid)) return;
    set({ saving: true, saveError: null });
    const run = (async () => {
      try {
        const result = await api.saveSequence(projectId, sid, timeline, revision);
        writeSession(get, set, sid, { revision: result.revision });
        set({ saving: false });
      } catch (error) {
        writeSession(get, set, sid, { saveError: (error as Error).message });
        set({ saving: false });
      }
    })();
    savePromise = run;
    await run;
    if (savePromise === run) savePromise = null;
  },

  scheduleSave: () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void get().save();
    }, AUTOSAVE_DEBOUNCE_MS);
  },

  commit: () => {
    set((state) => ({
      past: [...state.past, cloneTimeline(state.timeline)].slice(-HISTORY_LIMIT),
      future: [],
    }));
  },

  undo: () => {
    const { past, timeline, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({
      timeline: previous,
      past: past.slice(0, -1),
      future: [cloneTimeline(timeline), ...future].slice(0, HISTORY_LIMIT),
      selection: [],
    });
    get().scheduleSave();
  },

  redo: () => {
    const { past, timeline, future } = get();
    if (future.length === 0) return;
    set({
      timeline: future[0],
      past: [...past, cloneTimeline(timeline)].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      selection: [],
    });
    get().scheduleSave();
  },

  // The playhead stays fractional: the master clock advances it by ~0.4 frames
  // per animation frame, and rounding on every write would pin it in place.
  setPlayhead: (frame) => set({ playhead: Math.max(0, frame) }),
  setPlaying: (playing) => {
    set({ playing });
    // Where playback was stopped is where the film is being looked at; while it
    // runs the playhead is not worth storing.
    if (!playing) saveView(get());
  },
  setPxPerFrame: (px) => {
    set({ pxPerFrame: clampZoom(px) });
    scheduleViewSave();
  },
  // Releasing the key clears the pan flag as well: it only describes the press
  // that is ending.
  setSpaceHeld: (held) => set(held ? { spaceHeld: true } : { spaceHeld: false, spacePanned: false }),
  markSpacePanned: () => set({ spacePanned: true }),
  // Grouping lives here, not at the call sites: every path into the selection —
  // a click, a shift-click, a focus request — widens to whole groups by going
  // through this one function.
  setSelection: (ids) => set((s) => ({ selection: expandGroups(s.timeline.clips, ids) })),

  groupSelection: () => {
    const { selection } = get();
    if (selection.length < 2) return;
    const groupId = nextId('grp');
    get().commit();
    set((state) => ({
      timeline: {
        ...state.timeline,
        clips: state.timeline.clips.map((c) =>
          selection.includes(c.id) ? { ...c, groupId } : c
        ),
      },
    }));
    get().scheduleSave();
  },

  ungroupSelection: () => {
    const { selection, timeline } = get();
    const groups = new Set(
      timeline.clips.filter((c) => selection.includes(c.id) && c.groupId).map((c) => c.groupId)
    );
    if (groups.size === 0) return;
    get().commit();
    set((state) => ({
      timeline: {
        ...state.timeline,
        clips: state.timeline.clips.map((c) => {
          if (!c.groupId || !groups.has(c.groupId)) return c;
          const { groupId: _dropped, ...rest } = c;
          return rest;
        }),
      },
    }));
    get().scheduleSave();
  },

  requestFocusClip: (clipId, seqId) => {
    set({ focusClipId: clipId });
    if (seqId && seqId !== get().activeSeqId && get().sequences.some((q) => q.id === seqId)) {
      void get().activate(seqId);
    }
  },

  consumeFocusClip: () => {
    const { focusClipId, timeline } = get();
    if (!focusClipId) return;
    const clip = timeline.clips.find((c) => c.id === focusClipId);
    // Still loading, or the clip was cut since the request: drop the intent
    // rather than leave it armed to fire at some unrelated later moment.
    set({ focusClipId: null });
    if (!clip) return;
    set({ selection: [clip.id], playhead: clip.start, playing: false });
  },
  toggleRipple: () =>
    set((s) => ({ ripple: s.ripple === 'off' ? 'track' : s.ripple === 'track' ? 'all' : 'off' })),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),

  copySelection: () => {
    const { timeline, selection } = get();
    const payload = buildClipboard(timeline, selection);
    if (payload) set({ clipboard: payload });
  },

  pasteClipboard: () => {
    const { clipboard, timeline, playhead } = get();
    if (!clipboard) return;
    const { assets, clips } = pasteInto(timeline, clipboard, playhead, nextId);
    if (clips.length === 0) return;
    get().commit();
    set((state) => ({
      timeline: adoptFirstFrameSize({ ...state.timeline, assets, clips: [...state.timeline.clips, ...clips] }),
      selection: clips.map((c) => c.id),
    }));
    get().scheduleSave();
  },

  addAsset: async ({ nodeId, url, title, kind }) => {
    const existing = Object.values(get().timeline.assets).find((a) => a.url === url);
    if (existing) return existing.id;

    const fps = get().timeline.fps;
    let asset: EditorAsset;
    try {
      const probe = await api.prepareTimelineAsset(url);
      const probedKind = (probe.kind as EditorAsset['kind']) || kind;
      const nativeFrames = probe.frames || 0;
      asset = {
        id: nextId('asset'),
        nodeId,
        url,
        title,
        kind: probedKind,
        width: probe.width || 0,
        height: probe.height || 0,
        fps: probe.fps || 0,
        frames: nativeFrames,
        timelineFrames:
          probedKind === 'image'
            ? IMAGE_DEFAULT_FRAMES
            : probedKind === 'audio'
            // Sound has no frames of its own: its length on the grid comes from
            // its duration. Reading nativeFrames here would give every music bed
            // a single frame.
            ? Math.max(1, Math.round((probe.duration || 0) * fps))
            // Floor, not round: half a frame rounded UP is a clip asking for
            // footage the file does not have, which the monitor hides by holding
            // the last frame and the export cannot.
            : Math.max(1, Math.floor((nativeFrames * fps) / (probe.fps || fps))),
        hasAudio: Boolean(probe.has_audio),
        proxyUrl: probe.proxy_url,
        thumbsUrl: probe.thumbs_url,
        thumbCount: probe.thumb_count,
        peaks: probe.peaks,
        rms: probe.rms,
      };
    } catch {
      // Probing failed (ffprobe missing, file gone). Still let the shot onto the
      // timeline — marked offline — rather than silently doing nothing.
      asset = {
        id: nextId('asset'),
        nodeId,
        url,
        title,
        kind,
        width: 0,
        height: 0,
        fps: 0,
        frames: 0,
        timelineFrames: IMAGE_DEFAULT_FRAMES,
        hasAudio: false,
        offline: true,
      };
    }

    get().commit();
    set((state) => ({
      timeline: { ...state.timeline, assets: { ...state.timeline.assets, [asset.id]: asset } },
    }));
    get().scheduleSave();
    return asset.id;
  },

  appendClip: (assetId, trackId, at, exact) => {
    const { timeline } = get();
    const asset = timeline.assets[assetId];
    if (!asset) return;
    const track =
      timeline.tracks.find((t) => t.id === trackId) ??
      timeline.tracks.find((t) => t.kind === (asset.kind === 'audio' ? 'audio' : 'video'));
    if (!track) return;

    const onTrack = timeline.clips.filter((c) => c.trackId === track.id);
    const end = onTrack.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
    const newLength = asset.timelineFrames - (asset.chainHead?.frames ?? 0);
    let start = end;
    let ripple = true;
    if (at !== undefined && exact && at >= end) {
      // Dropped past the last clip: it goes where the pointer let go.
      start = Math.max(0, Math.round(at));
      ripple = false;
    } else if (at !== undefined && at < end) {
      start = Math.max(0, Math.round(at));
      const inside = onTrack.find((c) => c.start < start && clipEnd(c) > start);
      if (inside) {
        start = clipEnd(inside);
      } else {
        // In a gap: if the clip fits in it, it goes there and nothing moves --
        // at the frame asked for, or pulled left as far as the gap allows.
        const gapStart = onTrack.reduce((m, c) => (clipEnd(c) <= start ? Math.max(m, clipEnd(c)) : m), 0);
        const gapEnd = onTrack.reduce((m, c) => (c.start >= start ? Math.min(m, c.start) : m), Infinity);
        if (gapEnd - gapStart >= newLength) {
          start = Math.max(gapStart, Math.min(start, gapEnd - newLength));
          ripple = false;
        }
      }
    }

    const clip = defaultClip({
      id: nextId('clip'),
      trackId: track.id,
      assetId,
      start,
      inFrame: asset.chainHead?.frames ?? 0,
      outFrame: asset.timelineFrames,
    });
    const length = clipEnd(clip) - clip.start;
    get().commit();
    set((state) => ({
      timeline: adoptFirstFrameSize({
        ...state.timeline,
        clips: [
          ...state.timeline.clips.map((c) =>
            ripple && c.trackId === track.id && c.start >= start ? { ...c, start: c.start + length } : c
          ),
          clip,
        ],
      }),
      selection: [clip.id],
    }));
    get().scheduleSave();
  },

  addTextClip: (trackId) => {
    const { timeline, playhead } = get();
    // A title belongs above the picture, so it defaults to the topmost video
    // track rather than the one the last shot went on.
    const videoTracks = timeline.tracks.filter((t) => t.kind === 'video');
    const track =
      timeline.tracks.find((t) => t.id === trackId) ?? videoTracks[videoTracks.length - 1];
    if (!track) return;

    const clip = defaultClip({
      id: nextId('clip'),
      trackId: track.id,
      assetId: '',
      start: Math.round(playhead),
      inFrame: 0,
      outFrame: timeline.fps * 3,
      fadeIn: 6,
      fadeOut: 6,
      text: { ...subtitleStyleOf(timeline), content: '字幕' },
    });
    get().commit();
    set((state) => ({
      timeline: { ...state.timeline, clips: [...state.timeline.clips, clip] },
      selection: [clip.id],
    }));
    get().scheduleSave();
  },

  autoSubtitles: async (options) => {
    const sid = get().activeSeqId;
    const source = flattenTimeline(get().timeline, resolverOf(get()));
    // Only what is actually heard: no titles, nothing bypassed or muted (itself
    // or its track), no picture without a sound stream.
    const mutedTracks = new Set(source.tracks.filter((tr) => tr.muted || tr.bypassed).map((tr) => tr.id));
    const sounding = {
      ...source,
      clips: source.clips.filter((c) => {
        if (c.text || c.bypassed || c.muted || mutedTracks.has(c.trackId)) return false;
        const asset = source.assets[c.assetId];
        return Boolean(asset && !asset.offline && asset.kind !== 'image' && (asset.kind === 'audio' || asset.hasAudio));
      }),
    };
    if (sounding.clips.length === 0) throw new Error(t('时间线上没有有声音的片段'));
    const built = await buildExportPayload(sounding, 'transcribe');
    // Every lane goes as sound: the backend then skips the picture chain
    // entirely instead of decoding video nobody will see.
    const payload = { ...built, tracks: built.tracks.map((tr) => ({ ...tr, kind: 'audio' as const })) };
    if (options?.signal?.aborted) return null;
    const { job_id } = await api.transcribeTimeline(payload);
    const cancel = () => void api.cancelTranscribe(job_id).catch(() => undefined);
    options?.signal?.addEventListener('abort', cancel, { once: true });
    let job;
    try {
      job = await api.getTranscribeJob(job_id);
      while (job.status === 'queued' || job.status === 'running') {
        options?.onProgress?.(job.progress ?? 0, job.stage === 'transcribing' ? 'transcribing' : 'mixing');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (options?.signal?.aborted) return null;
        job = await api.getTranscribeJob(job_id);
      }
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
    }
    if (job.status === 'cancelled' || options?.signal?.aborted) return null;
    if (job.status !== 'completed') throw new Error(job.error || t('识别失败'));
    if (get().activeSeqId !== sid) throw new Error(t('识别完成时已经换到别的影片，字幕没有放入。'));

    const { timeline } = get();
    const fps = timeline.fps;
    let track = timeline.tracks.find((tr) => tr.id.startsWith(SUBTITLE_TRACK_PREFIX));
    const tracks = [...timeline.tracks];
    if (!track) {
      track = { id: `${SUBTITLE_TRACK_PREFIX}${nextId('t')}`, kind: 'video', name: t('字幕'), muted: false, locked: false };
      // Topmost video lane, so titles composite over every picture.
      const lastVideo = tracks.map((tr) => tr.kind).lastIndexOf('video');
      tracks.splice(lastVideo + 1, 0, track);
    }
    const trackId = track.id;
    const titles = (job.segments ?? []).map((segment) => {
      const start = Math.round(segment.start * fps);
      const end = Math.max(start + 1, Math.round(segment.end * fps));
      return defaultClip({
        id: nextId('clip'),
        trackId,
        assetId: '',
        start,
        inFrame: 0,
        outFrame: end - start,
        text: { ...subtitleStyleOf(timeline), content: subtitleText(segment.text) },
      });
    });
    get().commit();
    set((state) => ({
      timeline: {
        ...state.timeline,
        tracks,
        clips: [...state.timeline.clips.filter((c) => c.trackId !== trackId), ...titles],
      },
      selection: titles.map((c) => c.id),
    }));
    get().scheduleSave();
    return titles.length;
  },

  addTrack: (kind) => {
    const { timeline } = get();
    const sameKind = timeline.tracks.filter((t) => t.kind === kind).length + 1;
    const track: Track = {
      id: `${kind === 'video' ? 'V' : 'A'}${sameKind}_${nextId('t')}`,
      kind,
      name: t('{v1}{v2} {v3}', { v1: kind === 'video' ? 'V' : 'A', v2: sameKind, v3: kind === 'video' ? t('叠加') : t('音频') }),
      muted: false,
      locked: false,
    };
    get().commit();
    set((state) => {
      // Video tracks composite bottom-up, so a new one goes above the existing
      // video tracks but stays below the audio lanes in the list.
      const tracks = [...state.timeline.tracks];
      const insertAt =
        kind === 'video' ? tracks.filter((t) => t.kind === 'video').length : tracks.length;
      tracks.splice(insertAt, 0, track);
      return { timeline: { ...state.timeline, tracks } };
    });
    get().scheduleSave();
  },

  setTrackFlag: (trackId, patch) => {
    set((state) => ({
      timeline: {
        ...state.timeline,
        tracks: state.timeline.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      },
    }));
    get().scheduleSave();
  },

  seamDissolve: (clipId) => {
    const plan = planSeamDissolve(get().timeline, clipId);
    if (!plan.ok) return plan.reason;
    if (plan.kind === 'none') return plan.note;
    get().commit();
    set((state) => ({
      timeline: {
        ...state.timeline,
        clips: state.timeline.clips.map((c) => (c.id === clipId ? applySeamPlan(c, plan) : c)),
      },
    }));
    get().scheduleSave();
    return null;
  },

  seamDissolveAll: () => {
    const { timeline } = get();
    const batch = planAllSeamDissolves(timeline);
    if (batch.applied.length > 0) {
      get().commit();
      set({ timeline: batch.timeline });
      get().scheduleSave();
    }
    return {
      applied: batch.applied.length,
      already: batch.already.length,
      blocked: batch.blocked.map(({ clipId, reason }) => {
        const clip = timeline.clips.find((c) => c.id === clipId);
        const asset = clip ? timeline.assets[clip.assetId] : null;
        return { label: clip ? clipLabel(clip, asset) : clipId, reason };
      }),
    };
  },

  setTransition: (clipId, transition) => {
    const { timeline } = get();
    const clip = timeline.clips.find((c) => c.id === clipId);
    if (!clip) return;

    if (transition && transition.type === 'dissolve' && transition.frames > 0) {
      // A dissolve is an overlap: the incoming clip has to start before the
      // outgoing one ends, or there is nothing to dissolve from. Pull it back
      // over its predecessor, but never further than that clip can spare.
      const previous = timeline.clips
        .filter((c) => c.trackId === clip.trackId && c.start < clip.start)
        .sort((a, b) => clipEnd(b) - clipEnd(a))[0];
      if (previous) {
        const room = Math.min(transition.frames, clipLength(previous) - 1, clipLength(clip) - 1);
        const frames = Math.max(1, room);
        get().commit();
        set((state) => ({
          timeline: {
            ...state.timeline,
            clips: state.timeline.clips.map((c) =>
              c.id === clipId
                ? { ...c, start: clipEnd(previous) - frames, transitionIn: { type: 'dissolve', frames }, seamMute: undefined }
                : c
            ),
          },
        }));
        get().scheduleSave();
        return;
      }
    }

    // A hand edit takes the seam over: the automatic mark of its sound goes with it.
    get().commitUpdate(clipId, { transitionIn: transition ?? undefined, seamMute: undefined });
  },

  setFilters: (clipId, patch) => {
    const clip = get().timeline.clips.find((c) => c.id === clipId);
    if (!clip) return;
    get().updateClip(clipId, { filters: { ...NEUTRAL_FILTERS, ...clip.filters, ...patch } });
  },

  setText: (clipId, patch) => {
    const { timeline } = get();
    const clip = timeline.clips.find((c) => c.id === clipId);
    if (!clip || !clip.text) return;
    const { content, ...style } = patch;
    if (Object.keys(style).length === 0) {
      get().updateClip(clipId, { text: { ...clip.text, content: content ?? clip.text.content } });
      return;
    }
    if (content !== undefined) get().updateClip(clipId, { text: { ...clip.text, content } });
    get().setSubtitleStyle(style);
  },

  setSubtitleStyle: (patch) => {
    // Subtitles share one look: a style change lands on every one of them.
    const shared = { ...subtitleStyleOf(get().timeline), ...patch };
    set((state) => ({
      timeline: {
        ...state.timeline,
        subtitleStyle: shared,
        clips: state.timeline.clips.map((c) => (c.text ? { ...c, text: { ...shared, content: c.text.content } } : c)),
      },
    }));
    get().scheduleSave();
  },

  commitUpdate: (clipId, patch) => {
    get().commit();
    get().updateClip(clipId, patch);
  },

  updateClip: (id, patch) => {
    set((state) => ({
      timeline: {
        ...state.timeline,
        clips: state.timeline.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    }));
    get().scheduleSave();
  },

  moveClip: (id, start, trackId) => {
    const { timeline } = get();
    const clip = timeline.clips.find((c) => c.id === id);
    if (!clip) return;
    const track = trackId ? timeline.tracks.find((t) => t.id === trackId) : undefined;
    get().updateClip(id, {
      start: Math.max(0, Math.round(start)),
      ...(track && !track.locked ? { trackId: track.id } : {}),
    });
  },

  moveClips: (ids, deltaFrames, tracks) => {
    const { timeline } = get();
    const moving = timeline.clips.filter((c) => ids.includes(c.id));
    const rehomed = Boolean(tracks && moving.some((c) => tracks[c.id] && tracks[c.id] !== c.trackId));
    if (moving.length === 0 || (deltaFrames === 0 && !rehomed)) return;
    // One clamp for the whole group: shifting each clip to >= 0 on its own would
    // squash the spacing the group was dragged to keep.
    const earliest = moving.reduce((min, c) => Math.min(min, c.start), Infinity);
    const delta = Math.round(Math.max(deltaFrames, -earliest));
    if (delta === 0 && !rehomed) return;
    set({
      timeline: {
        ...timeline,
        clips: timeline.clips.map((c) =>
          ids.includes(c.id) ? { ...c, start: Math.max(0, c.start + delta), ...(tracks?.[c.id] ? { trackId: tracks[c.id] } : {}) } : c
        ),
      },
    });
    get().scheduleSave();
  },

  trimClip: (id, edge, frame) => {
    const { timeline } = get();
    const clip = timeline.clips.find((c) => c.id === id);
    if (!clip) return;
    const asset = timeline.assets[clip.assetId];
    // A title carries no asset at all (addTextClip leaves assetId empty), so
    // bailing on a missing asset made subtitle handles dead on the timeline.
    // A still has no source to run out of; neither does a title; a shot does.
    const maxOut = clip.seqRef
      ? sequenceLength(clip.seqRef, resolverOf(get())) || clip.outFrame
      : !asset || asset.kind === 'image' ? Number.MAX_SAFE_INTEGER : asset.timelineFrames;

    const { ripple } = get();
    const oldEnd = clip.start + clipLength(clip);
    if (edge === 'in') {
      const inFrame = Math.min(Math.max(0, Math.round(frame)), clip.outFrame - 1);
      // The head moves in source frames; on the timeline that distance is
      // divided by the clip's speed.
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const delta = Math.round((inFrame - clip.inFrame) / speed);
      if (ripple === 'off') {
        get().updateClip(id, { inFrame, start: Math.max(0, clip.start + delta) });
      } else {
        // Rippled, the head stays put and everything after the clip follows
        // its tail instead of leaving a gap in front of it.
        const next = { ...clip, inFrame };
        rippleAfter(get, set, clip, next, oldEnd, next.start + clipLength(next) - oldEnd, ripple);
      }
    } else {
      const outFrame = Math.max(clip.inFrame + 1, Math.min(Math.round(frame), maxOut));
      if (ripple === 'off') {
        get().updateClip(id, { outFrame });
      } else {
        const next = { ...clip, outFrame };
        rippleAfter(get, set, clip, next, oldEnd, next.start + clipLength(next) - oldEnd, ripple);
      }
    }
  },

  splitAtPlayhead: () => {
    const { timeline, selection } = get();
    const playhead = Math.round(get().playhead);
    const targets = timeline.clips.filter((clip) => {
      if (selection.length > 0 && !selection.includes(clip.id)) return false;
      const track = timeline.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return false;
      return playhead > clip.start && playhead < clipEnd(clip);
    });
    if (targets.length === 0) return;

    get().commit();
    const additions: Clip[] = [];
    const clips = timeline.clips.map((clip) => {
      const hit = targets.find((t) => t.id === clip.id);
      if (!hit) return clip;
      // inFrame/outFrame address the source; the timeline distance is scaled by speed.
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const cutAt = clip.inFrame + (playhead - clip.start) * speed;
      additions.push({
        ...clip,
        id: nextId('clip'),
        start: playhead,
        inFrame: cutAt,
      });
      return { ...clip, outFrame: cutAt };
    });
    set({
      timeline: { ...timeline, clips: [...clips, ...additions] },
      selection: additions.map((c) => c.id),
    });
    get().scheduleSave();
  },

  mergeSelection: () => {
    const { timeline, selection } = get();
    const runs = mergeRuns(timeline, selection);
    if (runs.length === 0) return;

    get().commit();
    const absorbed = new Set<string>();
    const merged = new Map<string, Clip>();
    for (const run of runs) {
      const head = run[0];
      const tail = run[run.length - 1];
      run.slice(1).forEach((c) => absorbed.add(c.id));
      merged.set(head.id, {
        ...head,
        // The run is source-continuous by construction, so the whole span is
        // just the first head to the last tail. fadeOut belongs to the end of
        // the joined clip, which is the last piece's end.
        outFrame: tail.outFrame,
        fadeOut: tail.fadeOut,
      });
    }

    const clips = timeline.clips
      .filter((c) => !absorbed.has(c.id))
      .map((c) => merged.get(c.id) ?? c);
    set({ timeline: { ...timeline, clips }, selection: [...merged.keys()] });
    get().scheduleSave();
  },

  deleteSelection: () => {
    const { timeline, selection, ripple } = get();
    if (selection.length === 0) return;
    const removed = timeline.clips.filter((c) => selection.includes(c.id));
    get().commit();

    let clips = timeline.clips.filter((c) => !selection.includes(c.id));
    if (ripple === 'track') {
      // Close each gap on its own track, working right-to-left so earlier shifts
      // do not move the clips a later gap is measured against.
      const byStart = [...removed].sort((a, b) => b.start - a.start);
      for (const gap of byStart) {
        const width = clipLength(gap);
        clips = clips.map((c) =>
          c.trackId === gap.trackId && c.start >= gap.start ? { ...c, start: c.start - width } : c
        );
      }
    } else if (ripple === 'all') {
      // The removed stretches of TIME, merged: a shot deleted together with its
      // own sound is one gap, not two, and must close once.
      const spans = removed
        .map((c) => [c.start, c.start + clipLength(c)] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      const locked = lockedTracks(timeline);
      // Right to left, as above. Everything that starts at or after a gap's end,
      // on every unlocked track, moves left by its width; a clip that only
      // overlaps the gap on another track stays where it is.
      for (const [from, to] of merged.reverse()) {
        clips = clips.map((c) =>
          !locked.has(c.trackId) && c.start >= to ? { ...c, start: c.start - (to - from) } : c
        );
      }
    }
    set({ timeline: { ...timeline, clips }, selection: [] });
    get().scheduleSave();
  },

  deleteGap: (from, to, trackId) => {
    const { timeline, ripple } = get();
    if (Math.round(to - from) <= 0) return;
    const clips = closeGap(timeline.clips, timeline.tracks, from, to, trackId, ripple);
    if (clips === timeline.clips) return;
    get().commit();
    set({ timeline: { ...timeline, clips } });
    get().scheduleSave();
  },

  toggleBypass: () => {
    const { timeline, selection } = get();
    if (selection.length === 0) return;
    const chosen = timeline.clips.filter((c) => selection.includes(c.id));
    // A mixed selection turns all of it off, which is the useful direction; a
    // second press brings all of it back.
    const bypassed = !chosen.every((c) => c.bypassed);
    get().commit();
    set({
      timeline: {
        ...timeline,
        clips: timeline.clips.map((c) =>
          selection.includes(c.id) ? { ...c, bypassed } : c
        ),
      },
    });
    get().scheduleSave();
  },

  detachAudio: () => {
    const { timeline, selection } = get();
    // Only a shot that is on a video track and still carries its own sound has
    // anything to detach: a title has no audio, and a clip already muted was
    // detached (or silenced) before. planDetach says which, and why for the rest.
    const plan = planDetach(timeline.clips, timeline.tracks, timeline.assets, selection);
    const sources = plan.sources;
    if (sources.length === 0) return plan.message;

    get().commit();

    const tracks = [...timeline.tracks];
    const clips = [...timeline.clips];
    const detached: string[] = [];

    for (const source of sources) {
      const span = { start: source.start, end: clipEnd(source) };
      // Land on the first audio lane with room at that point; a lane that is
      // already occupied there would hide one of the two takes.
      let lane = tracks.find(
        (t) =>
          t.kind === 'audio' &&
          !t.locked &&
          !clips.some(
            (c) => c.trackId === t.id && c.start < span.end && clipEnd(c) > span.start
          )
      );
      if (!lane) {
        lane = {
          id: `A${tracks.filter((t) => t.kind === 'audio').length + 1}_${nextId('t')}`,
          kind: 'audio',
          name: `A${tracks.filter((t) => t.kind === 'audio').length + 1}`,
          muted: false,
          locked: false,
        };
        tracks.push(lane);
      }

      // The sound keeps every timing property of the picture it came from, so
      // the two stay in sync until one of them is deliberately moved.
      const copy: Clip = {
        ...source,
        id: nextId('clip'),
        trackId: lane.id,
        transitionIn: undefined,
        filters: undefined,
      };
      clips.push(copy);
      detached.push(copy.id);
    }

    const sourceIds = sources.map((c) => c.id);
    set({
      timeline: {
        ...timeline,
        tracks,
        // The picture goes silent: leaving both audible would double every
        // level by 6 dB and defeat the point of separating them.
        clips: clips.map((c) => (sourceIds.includes(c.id) ? { ...c, muted: true } : c)),
      },
      selection: detached,
    });
    get().scheduleSave();
    return plan.message;
  },

  openChainHeads: async (map) => {
    const fps = get().timeline.fps;
    const targets = Object.values(get().timeline.assets).filter((a) => !a.chainHead && map[a.url]);
    const probed = new Map<string, EditorAsset>();
    for (const asset of targets) {
      const { url, frames } = map[asset.url];
      try {
        const probe = await api.prepareTimelineAsset(url);
        const next = probedAsset({ ...asset, url }, probe, fps);
        const head = Math.round((frames * fps) / (next.fps || fps));
        if (head <= 0 || head >= next.timelineFrames) continue;
        next.chainHead = { trimmedUrl: asset.url, frames: head };
        probed.set(asset.id, next);
      } catch {
        // unreadable: stays on the trimmed file
      }
    }
    if (probed.size === 0) return 0;
    get().commit();
    set((state) => ({
      timeline: {
        ...state.timeline,
        assets: Object.fromEntries(
          Object.entries(state.timeline.assets).map(([id, a]) => [id, probed.get(id) ?? a])
        ),
        clips: state.timeline.clips.map((c) => {
          const head = probed.get(c.assetId)?.chainHead?.frames;
          return head ? { ...c, inFrame: c.inFrame + head, outFrame: c.outFrame + head } : c;
        }),
      },
    }));
    get().scheduleSave();
    return probed.size;
  },

  relinkAssets: async (map, direction) => {
    const fps = get().timeline.fps;
    const assets = Object.values(get().timeline.assets);
    // Which entry an asset answers to: its own file, or (opened out) the
    // trimmed file the canvas node knows it by.
    const keyOf = (a: EditorAsset) => (map[a.url] ? a.url : a.chainHead?.trimmedUrl ?? a.url);
    const targets =
      direction === 'hd' ? assets.filter((a) => map[keyOf(a)]) : assets.filter((a) => a.roughUrl);
    const probed = new Map<string, EditorAsset>();
    // Clips move by (new head - old head): the overlap frames at the front of
    // each file are hidden by trimming, so what shows stays exactly the same.
    const shift = new Map<string, number>();
    for (const asset of targets) {
      const url = direction === 'hd' ? map[keyOf(asset)].url : (asset.roughUrl as string);
      try {
        const probe = await api.prepareTimelineAsset(url);
        const next = probedAsset({ ...asset, url }, probe, fps);
        const trimmedUrl = asset.chainHead?.trimmedUrl ?? keyOf(asset);
        let head = 0;
        if (direction === 'hd') {
          const src = map[keyOf(asset)].headFrames;
          head = src > 0 ? Math.round((src * fps) / (next.fps || fps)) : 0;
          next.roughUrl = asset.roughUrl ?? asset.url;
          next.roughChainHead = asset.roughUrl ? asset.roughChainHead : asset.chainHead;
        } else {
          head = asset.roughChainHead?.frames ?? 0;
          next.roughUrl = undefined;
          next.roughChainHead = undefined;
        }
        next.chainHead = head > 0 ? { trimmedUrl, frames: head } : undefined;
        probed.set(asset.id, next);
        shift.set(asset.id, head - (asset.chainHead?.frames ?? 0));
      } catch {
        // unreadable: leave this one on its current file
      }
    }
    if (probed.size === 0) return 0;
    get().commit();
    set((state) => ({
      // An auto-sized film follows its first frame, and that frame just changed
      // resolution. Without this the film stayed 1376x768 after relinking to a
      // 2752x1536 master, so the monitor and the export scaled the HD file back
      // down and the swap changed nothing visible. A size picked by hand stays.
      timeline: adoptFirstFrameSize({
        ...state.timeline,
        assets: Object.fromEntries(
          Object.entries(state.timeline.assets).map(([id, a]) => [id, probed.get(id) ?? a])
        ),
        clips: state.timeline.clips.map((c) => {
          const by = shift.get(c.assetId);
          if (!by) return c;
          // Moving back onto a file without the overlap: frames from inside it
          // do not exist there, so the head is clamped.
          const inFrame = Math.max(0, c.inFrame + by);
          return { ...c, inFrame, outFrame: Math.max(inFrame + 1, c.outFrame + by) };
        }),
      }),
    }));
    get().scheduleSave();
    return probed.size;
  },

  switchClipVersion: async (clipId, version, useHd) => {
    const fps = get().timeline.fps;
    const clip = get().timeline.clips.find((c) => c.id === clipId);
    const asset = clip ? get().timeline.assets[clip.assetId] : undefined;
    if (!clip || !asset) return false;
    // A chained shot the cut room opened out keeps showing the full render.
    const opened = Boolean(asset.chainHead || asset.roughChainHead);
    const openRough = opened && Boolean(version.untrimmedUrl) && version.contextFrames > 0;
    const roughUrl = openRough ? (version.untrimmedUrl as string) : version.url;
    const roughHead = openRough ? version.contextFrames : 0;
    const hd = useHd ? version.hd : null;
    const url = hd ? hd.url : roughUrl;
    try {
      const probe = await api.prepareTimelineAsset(url);
      const next = probedAsset({ ...asset, url }, probe, fps);
      let head = roughHead;
      if (hd) {
        head = hd.headFrames > 0 ? Math.round((hd.headFrames * fps) / (next.fps || fps)) : 0;
        next.roughUrl = roughUrl;
        next.roughChainHead = roughHead > 0 ? { trimmedUrl: version.url, frames: roughHead } : undefined;
      } else {
        next.roughUrl = undefined;
        next.roughChainHead = undefined;
      }
      next.chainHead = head > 0 ? { trimmedUrl: version.url, frames: head } : undefined;
      get().commit();
      set((state) => ({
        timeline: adoptFirstFrameSize(repointClipVersion(state.timeline, clipId, next, nextId('asset'))),
      }));
      get().scheduleSave();
      return true;
    } catch {
      return false;
    }
  },

  retitleAssets: (titles) => {
    const retitle = (timeline: Timeline): Timeline => {
      let changed = false;
      const assets = Object.fromEntries(
        Object.entries(timeline.assets).map(([id, a]) => {
          const next = titles[a.url];
          if (!next || next === a.title) return [id, a];
          changed = true;
          return [id, { ...a, title: next }];
        })
      );
      return changed ? { ...timeline, assets } : timeline;
    };
    const current = get().timeline;
    const next = retitle(current);
    const sessions = Object.fromEntries(
      Object.entries(get().sessions).map(([sid, session]) => [sid, { ...session, timeline: retitle(session.timeline) }])
    );
    const sessionsChanged = Object.keys(sessions).some((sid) => sessions[sid].timeline !== get().sessions[sid].timeline);
    if (next === current && !sessionsChanged) return;
    set({ timeline: next, sessions });
    get().scheduleSave();
  },

  markAssetsOffline: (url) => {
    const { timeline } = get();
    const ids = Object.values(timeline.assets)
      .filter((a) => a.url === url && !a.offline)
      .map((a) => a.id);
    if (ids.length === 0) return;
    // No commit: this is not an edit the user made, it is reality catching up,
    // and Ctrl+Z must not appear to bring a deleted file back.
    set({
      timeline: {
        ...timeline,
        assets: Object.fromEntries(
          Object.entries(timeline.assets).map(([id, asset]) =>
            ids.includes(id) ? [id, { ...asset, offline: true }] : [id, asset]
          )
        ),
      },
    });
    get().scheduleSave();
  },

  cropDraft: null,

  beginCrop: (clipId) => {
    const clip = get().timeline.clips.find((c) => c.id === clipId);
    if (!clip) return;
    set({ cropDraft: { clipId, rect: clip.crop ?? { x: 0, y: 0, w: 1, h: 1 } } });
  },

  setCropDraft: (rect) => {
    const draft = get().cropDraft;
    if (!draft) return;
    set({ cropDraft: { ...draft, rect: clampCrop(rect) } });
  },

  commitCrop: () => {
    const draft = get().cropDraft;
    set({ cropDraft: null });
    if (!draft) return;
    // A full-frame crop is not a crop. Storing one would leave every clip
    // carrying a rectangle that means nothing, and "is this cropped?" would stop
    // having a straight answer.
    get().commitUpdate(draft.clipId, {
      crop: isFullCrop(draft.rect) ? undefined : draft.rect,
    });
  },

  cancelCrop: () => set({ cropDraft: null }),

  setCover: (cover) => {
    const { timeline } = get();
    if ((timeline.cover?.url ?? null) === (cover?.url ?? null)) return;
    get().commit();
    const { cover: _old, ...rest } = timeline;
    set({ timeline: cover ? { ...rest, cover } : rest });
    get().scheduleSave();
  },

  setFrameSize: (width, height) => {
    const { timeline } = get();
    const resized = resizeTimeline(timeline, width, height);
    if (resized === timeline && timeline.frameSizeManual) return;
    get().commit();
    set({ timeline: { ...resized, frameSizeManual: true } });
    get().scheduleSave();
  },

  followFirstFrame: () => {
    const { timeline } = get();
    if (!timeline.frameSizeManual) return;
    get().commit();
    set({ timeline: adoptFirstFrameSize({ ...timeline, frameSizeManual: false }) });
    get().scheduleSave();
  },

  clearTimeline: () => {
    get().commit();
    set((state) => ({ timeline: { ...state.timeline, clips: [] }, selection: [] }));
    get().scheduleSave();
  },

  startExport: async (name, options) => {
    const { timeline } = get();
    if (timeline.clips.length === 0) {
      set({ exportError: t('时间线上没有可导出的片段。'), exportStatus: 'failed' });
      return;
    }
    const bypassedLanes = new Set(timeline.tracks.filter((tr) => tr.bypassed).map((tr) => tr.id));
    if (timeline.clips.every((c) => c.bypassed || bypassedLanes.has(c.trackId))) {
      set({ exportError: t('所有片段都被旁通了，没有内容可导出。'), exportStatus: 'failed' });
      return;
    }

    const sid = get().activeSeqId;
    set({
      exportStatus: 'queued', exportTarget: 'film', mergeJob: null, exportProgress: 0,
      exportUrl: null, exportError: null,
    });
    try {
      // The cover belongs to the finished film only: a lone shot, a merge or a transcription render
      // built from this timeline must not get it on their first frame.
      const flat = flattenTimeline(timeline, resolverOf(get()));
      const rendered = options?.burnSubtitles === false ? { ...flat, clips: flat.clips.filter((c) => !c.text) } : flat;
      if (rendered.clips.length === 0) throw new Error(t('去掉字幕后时间线上没有可导出的片段。'));
      const payload = await buildExportPayload(rendered, name, { cover: timeline.cover });
      const { job_id } = await api.exportTimeline(options?.download ? { ...payload, download: true } : payload);
      writeSession(get, set, sid, { exportJobId: job_id });

      void pollExport(job_id, sid, get, set);
    } catch (error) {
      writeSession(get, set, sid, { exportStatus: 'failed', exportError: (error as Error).message });
    }
  },

  startMergeRender: async (name) => {
    const { timeline, selection } = get();
    const runs = adjacentRuns(timeline, selection);
    if (runs.length === 0) {
      set({ exportError: t('选中的片段没有首尾相接的，无法合并。'), exportStatus: 'failed', exportTarget: 'merge' });
      return;
    }
    if (runs.length > 1) {
      // One export slot, one run. Merging several at once would need several
      // renders, and a half-finished set of them is worse than saying no.
      set({ exportError: t('一次只能合并一段连续的片段。'), exportStatus: 'failed', exportTarget: 'merge' });
      return;
    }
    const run = runs[0];
    const track = timeline.tracks.find((t) => t.id === run[0].trackId);
    if (!track) return;
    if (run.some((c) => !c.text && !timeline.assets[c.assetId])) {
      set({ exportError: t('有片段的源文件不在了，无法合并。'), exportStatus: 'failed', exportTarget: 'merge' });
      return;
    }

    const start = run[0].start;
    const frames = clipEnd(run[run.length - 1]) - start;

    // Everything audible over this span goes in: the shots' own sound after
    // 分离音频, and any music or effects lying across them. What the span sounds
    // like on the timeline is what the rendered clip has to sound like, so the
    // rule is the span, not which file the sound came from.
    const audible = new Set(
      timeline.tracks.filter((tr) => tr.kind === 'audio' && !tr.muted && !tr.bypassed).map((tr) => tr.id)
    );
    const overlapping =
      track.kind === 'video'
        ? timeline.clips.filter(
            (c) => audible.has(c.trackId) && !c.bypassed && c.start < start + frames && clipEnd(c) > start
          )
        : [];
    const bakedAudio = overlapping
      .map((c) => ({ source: c, piece: clipInSpan(c, start, start + frames) }))
      .filter((x): x is { source: Clip; piece: Clip } => Boolean(x.piece));

    const solo: Timeline = {
      ...timeline,
      tracks: [
        { ...track },
        ...timeline.tracks.filter((tr) => bakedAudio.some((x) => x.source.trackId === tr.id)),
      ],
      clips: [
        ...run.map((clip, index) => ({
          ...clip,
          start: clip.start - start,
          // The head's transition joins it to whatever precedes the run, which is
          // not in this render. It moves onto the merged clip instead.
          transitionIn: index === 0 ? undefined : clip.transitionIn,
        })),
        ...bakedAudio.map((x) => x.piece),
      ],
    };

    const sid = get().activeSeqId;
    set({
      exportStatus: 'queued',
      exportTarget: 'merge',
      mergeJob: {
        clipIds: run.map((c) => c.id),
        // A locked lane is still heard, so it is still rendered — but it is not
        // edited afterwards. Its clip doubles, and the lock is what says so.
        audioClipIds: bakedAudio
          .filter((x) => !timeline.tracks.find((tr) => tr.id === x.source.trackId)?.locked)
          .map((x) => x.source.id),
        trackId: track.id,
        start,
        frames,
        name,
      },
      exportProgress: 0,
      exportUrl: null,
      exportError: null,
    });
    try {
      const payload = await buildExportPayload(flattenTimeline(solo, resolverOf(get())), name);
      const { job_id } = await api.exportTimeline(payload);
      writeSession(get, set, sid, { exportJobId: job_id });
      void pollExport(job_id, sid, get, set, (url) => landMerge(url, sid, get, set));
    } catch (error) {
      writeSession(get, set, sid, { exportStatus: 'failed', exportError: (error as Error).message });
    }
  },

  startClipExport: async (clipId, name) => {
    const { timeline } = get();
    const clip = timeline.clips.find((c) => c.id === clipId);
    const track = clip ? timeline.tracks.find((t) => t.id === clip.trackId) : undefined;
    if (!clip || !track) {
      set({ exportError: t('找不到要导出的片段。'), exportStatus: 'failed', exportTarget: 'canvas' });
      return;
    }
    const asset = timeline.assets[clip.assetId];
    if (!clip.text && !clip.seqRef && (!asset || asset.offline)) {
      set({ exportError: t('这个片段的源文件不在了，无法导出。'), exportStatus: 'failed', exportTarget: 'canvas' });
      return;
    }

    // A clip on its own is rendered at its source's own size, not the film's:
    // asking for one shot back means that shot, not a pillarboxed copy of it.
    const width = asset?.width && asset.width > 0 ? asset.width : timeline.width;
    const height = asset?.height && asset.height > 0 ? asset.height : timeline.height;
    // Whatever is audible across this shot comes with it — its own sound after
    // 分离音频, and anything else lying over it. Exporting the picture alone
    // would hand back a shot that does not sound like the cut it came from.
    const detached = timeline.clips.filter((c) => {
      if (c.id === clip.id || c.bypassed) return false;
      const lane = timeline.tracks.find((tr) => tr.id === c.trackId);
      if (!lane || lane.kind !== 'audio' || lane.muted || lane.bypassed) return false;
      return c.start < clipEnd(clip) && clipEnd(c) > clip.start;
    });
    const detachedPieces = detached
      .map((c) => clipInSpan(c, clip.start, clipEnd(clip)))
      .filter((c): c is Clip => Boolean(c));

    const solo: Timeline = {
      ...timeline,
      width,
      height,
      tracks: [
        { ...track },
        ...timeline.tracks.filter((tr) => detached.some((c) => c.trackId === tr.id)),
      ],
      // Rebased to zero so the render is the shot and nothing before it, and
      // un-bypassed: asking for this clip by name overrides its bypass.
      clips: [{ ...clip, start: 0, bypassed: false, transitionIn: undefined }, ...detachedPieces],
    };

    const sid = get().activeSeqId;
    set({
      exportStatus: 'queued', exportTarget: 'canvas', mergeJob: null, exportProgress: 0,
      exportUrl: null, exportError: null,
    });
    try {
      const payload = await buildExportPayload(flattenTimeline(solo, resolverOf(get())), name);
      // One slowed or sped-up shot on its own comes back at the rate it really
      // plays at (24 fps at 0.5x is a 12 fps file), not as the same frames
      // repeated up to the grid rate.
      if (!clip.text && !clip.seqRef && asset?.kind === 'video') {
        const outFps = nativeExportFps(timeline.fps, clip.speed);
        if (outFps) payload.out_fps = outFps;
      }
      const { job_id } = await api.exportTimeline(payload);
      writeSession(get, set, sid, { exportJobId: job_id });
      void pollExport(job_id, sid, get, set);
    } catch (error) {
      writeSession(get, set, sid, { exportStatus: 'failed', exportError: (error as Error).message });
    }
  },

  dismissExport: () =>
    set({
      exportJobId: null, exportStatus: null, exportTarget: 'film', mergeJob: null,
      exportProgress: 0, exportUrl: null, exportError: null,
    }),
}));

// ── Each film's view survives a reload ───────────────────────────────────────
// Playhead, zoom and scroll are per-film and already travel with the session
// while the tab is open (SESSION_KEYS). This keeps them for the two cold paths
// where the session itself is gone: a reload, and a tab evicted past
// MAX_OPEN_SESSIONS.
//
// It is browser-local rather than part of the saved film on purpose: writing a
// playhead into the film record would bump its revision and fire an autosave on
// every scrub, and where someone else left their playhead is not part of a cut.
interface SavedView {
  playhead: number;
  pxPerFrame: number;
  scrollLeft: number;
  scrollTop: number;
}

const viewKey = (projectId: string, seqId: string) => `cutroom.view.${projectId}.${seqId}`;

function readSavedView(projectId: string | null, seqId: string): Partial<SavedView> {
  if (!projectId || isScratchSession(seqId) || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(viewKey(projectId, seqId));
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const out: Partial<SavedView> = {};
    if (num(data.playhead) !== undefined) out.playhead = data.playhead;
    // Clamped to the same range setPxPerFrame allows: a stored value outside it
    // would leave the timeline at a zoom no gesture can reach.
    if (num(data.pxPerFrame) !== undefined) out.pxPerFrame = clampZoom(data.pxPerFrame);
    if (num(data.scrollLeft) !== undefined) out.scrollLeft = data.scrollLeft;
    if (num(data.scrollTop) !== undefined) out.scrollTop = data.scrollTop;
    return out;
  } catch {
    // Storage blocked or corrupt: the film opens at its start, as it used to.
    return {};
  }
}

/**
 * Remember where a film is being looked at. Called at the few moments the view
 * settles — parking a tab, stopping playback, a zoom or a scroll coming to rest
 * — rather than from a subscription: the master clock moves the playhead every
 * animation frame, and a write per frame is a write 60 times a second.
 */
/** A film whose size was never picked by hand follows its first frame from the moment it opens. */
function loadedTimeline(saved: Timeline): Timeline {
  return adoptFirstFrameSize({ ...emptyTimeline(), ...saved });
}

function saveView(state: CutRoomState, seqId: string | null = state.activeSeqId) {
  if (!seqId || !state.projectId || isScratchSession(seqId) || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      viewKey(state.projectId, seqId),
      JSON.stringify({
        playhead: Math.round(state.playhead),
        pxPerFrame: state.pxPerFrame,
        scrollLeft: Math.round(state.scrollLeft),
        scrollTop: Math.round(state.scrollTop),
      } satisfies SavedView)
    );
  } catch {
    // Private window or storage full: the view just is not remembered.
  }
}

/** Debounced `saveView` for the two gestures that fire continuously. */
let viewSaveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleViewSave() {
  if (typeof window === 'undefined') return;
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    viewSaveTimer = null;
    saveView(useCutRoom.getState());
  }, 300);
}

if (typeof window !== 'undefined') {
  // A reload is the one moment nothing else fires: the debounce above may still
  // be pending, and playback may still be running.
  window.addEventListener('beforeunload', () => saveView(useCutRoom.getState()));
}

// ── Open tabs survive a reload ────────────────────────────────────────────────
// Per project, in this browser: which films were open and which was in front.
// Scratch tabs are never remembered; their asset is picked from the canvas.
const tabsKey = (projectId: string) => `cutroom.tabs.${projectId}`;

function readSavedTabs(projectId: string): { open: string[]; active: string | null } {
  try {
    const raw = window.localStorage.getItem(tabsKey(projectId));
    const data = raw ? JSON.parse(raw) : null;
    if (data && Array.isArray(data.open)) {
      return { open: data.open.filter((id: unknown) => typeof id === 'string'), active: data.active ?? null };
    }
  } catch {
    // Storage blocked or corrupt: fall back to opening the first film.
  }
  return { open: [], active: null };
}

if (typeof window !== 'undefined') {
  useCutRoom.subscribe((state, previous) => {
    if (state.openOrder === previous.openOrder && state.activeSeqId === previous.activeSeqId) return;
    // Nothing to remember until a project's films are listed; the load reset
    // empties the list first, so it cannot wipe the saved tabs before they are read.
    if (!state.projectId || state.sequences.length === 0) return;
    const open = state.openOrder.filter((id) => !isScratchSession(id));
    const active = isScratchSession(state.activeSeqId) ? null : state.activeSeqId;
    try {
      window.localStorage.setItem(tabsKey(state.projectId), JSON.stringify({ open, active }));
    } catch {
      // Private window or storage full: tabs just are not remembered.
    }
  });
}

/** Frame the playhead should land on, given a raw frame and nearby edges. */
/**
 * Nearest candidate within tolerance, and which one it was.
 *
 * The caller needs the target as well as the result: a snap that is not drawn is
 * a clip that appears to move on its own.
 */
export function snapWithTarget(
  raw: number,
  candidates: number[],
  tolerance: number
): { frame: number; target: number | null } {
  let best = raw;
  let bestDistance = tolerance;
  let target: number | null = null;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - raw);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
      target = candidate;
    }
  }
  return { frame: Math.round(best), target };
}

export function snapFrame(raw: number, candidates: number[], tolerance: number): number {
  let best = raw;
  let bestDistance = tolerance;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - raw);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return Math.round(best);
}

export { timelineDuration, clipEnd, clipLength, DEFAULT_FPS };
