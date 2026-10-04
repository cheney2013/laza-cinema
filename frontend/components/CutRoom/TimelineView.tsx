'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { groupEdges, groupLanes } from '@/lib/editor/groupMove';
import { useCutRoom, resolverOf, scheduleViewSave, snapWithTarget } from '@/lib/editor/store';
import { flattenTimeline } from '@/lib/editor/nest';
import { laneGapsOf, rulerGaps } from '@/lib/editor/gap';
import { resolveAssetUrl } from '@/lib/config';
import { filmstripTiles } from '@/lib/editor/filmstrip';
import {
  clampZoom,
  clipEnd,
  clipLabel,
  clipLength,
  expandGroups,
  formatTimecode,
  type Clip,
  type EditorAsset,
  peakHeight,
  clipInSpan,
} from '@/lib/editor/types';
import { t } from '@/lib/i18n';
import { SEQ_DRAG_TYPE } from './SequenceTabs';

const TRACK_HEIGHT = 56;
/** A clip block's height, border included; thumbnails are sized to what is inside the border. */
const CLIP_HEIGHT = 44;
const RULER_HEIGHT = 26;
const SNAP_PX = 7;

type Gesture =
  | {
      kind: 'move';
      clipId: string;
      grabOffset: number;
      originTrack: string;
      /** Every clip travelling with this one, and where (and on which track) each started. */
      group: Array<{ id: string; start: number; trackId: string }>;
    }
  | { kind: 'trim'; clipId: string; edge: 'in' | 'out' }
  | { kind: 'scrub' }
  /**
   * Box select, started on empty lane space. Coordinates are in content space
   * (scroll included) so the box stays put under an auto-scroll. A release that
   * never moved is a plain click and scrubs instead.
   */
  | { kind: 'marquee'; x: number; y: number; clientX: number; base: string[] }
  /** Space held: the drag moves the view, not anything in the cut. */
  | { kind: 'pan'; clientX: number; clientY: number; scrollLeft: number; scrollTop: number };

/**
 * The timeline: a ruler, one lane per track, and clips positioned by frame.
 *
 * All three gestures (scrub, move, trim) run on pointer capture over the whole
 * surface rather than per-clip listeners, so a fast drag that outruns the cursor
 * does not drop the clip halfway.
 */
/** dataTransfer type a bin row sets when dragged: the asset url. */
export const BIN_DRAG_TYPE = 'application/x-cutroom-bin-url';

export default function TimelineView({
  onDropAsset,
}: {
  onDropAsset?: (url: string, trackId: string | undefined, at: number) => void;
} = {}) {
  const timeline = useCutRoom((s) => s.timeline);
  const playhead = useCutRoom((s) => s.playhead);
  const pxPerFrame = useCutRoom((s) => s.pxPerFrame);
  const selection = useCutRoom((s) => s.selection);
  const snapping = useCutRoom((s) => s.snapping);
  const ripple = useCutRoom((s) => s.ripple);
  const spaceHeld = useCutRoom((s) => s.spaceHeld);
  // The film on screen. Scroll is restored when this changes — the component
  // itself is never remounted, so nothing else would reset it.
  const activeSeqId = useCutRoom((s) => s.activeSeqId);
  const loading = useCutRoom((s) => s.loading);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const movedRef = useRef(false);
  /** Frame the current drag is snapped to, drawn for as long as it holds. */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  /** Where a film tab being dragged over the timeline would land. */
  const [dropHint, setDropHint] = useState<{ frame: number; lane: number } | null>(null);
  /** The box being dragged, in content px below the ruler. */
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  /** Set while scroll is being restored, so the restore is not read back as a
   * user scroll before the new film's clips have laid out. */
  const restoringRef = useRef(false);

  // Bypassed clips count here, and only here: they are out of the cut, but they
  // are still drawn, so the scrollable area has to reach far enough to grab one.
  const duration = useMemo(
    () => timeline.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0),
    [timeline.clips]
  );
  // Stretches of time with no video clip on any picture lane, between the start of the film
  // and its last shot -- the holes a delete or a move left behind. Subtitles and sound do not count.
  const gaps = useMemo(() => rulerGaps(timeline.clips, timeline.tracks), [timeline.clips, timeline.tracks]);
  const [hoverGap, setHoverGap] = useState<number | null>(null);
  // The same holes, per picture lane, drawn in the lane itself with a trash
  // button (Clipchamp's 删除此间隙).
  const laneGaps = useMemo(() => laneGapsOf(timeline.clips, timeline.tracks), [timeline.clips, timeline.tracks]);

  // Always leave a few seconds of empty runway to drop or drag into.
  const visibleFrames = Math.max(duration + timeline.fps * 6, timeline.fps * 20);
  const contentWidth = visibleFrames * pxPerFrame;

  // Where a clip dragged in from the bin would put its head.
  const [dropFrame, setDropFrame] = useState<number | null>(null);
  const frameAt = useCallback(
    (clientX: number) => {
      const surface = surfaceRef.current;
      if (!surface) return 0;
      const rect = surface.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - rect.left + surface.scrollLeft) / pxPerFrame));
    },
    [pxPerFrame]
  );

  /** Every edge a dragged frame may stick to: the playhead and other clips' ends. */
  const snapTargets = useCallback(
    (excludeIds: string[]) => {
      const targets = [0, playhead];
      timeline.clips.forEach((c) => {
        // A clip never snaps to itself, and in a group move nothing travelling
        // with it is a target either.
        if (excludeIds.includes(c.id)) return;
        targets.push(c.start, clipEnd(c));
      });
      return targets;
    },
    [timeline.clips, playhead]
  );

  const onPointerDownSurface = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const surface = surfaceRef.current;
    // Space + left drag pans. It is checked before anything else so a clip
    // under the cursor is neither selected nor moved by the grab.
    if (spaceHeld && surface) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      movedRef.current = false;
      gestureRef.current = {
        kind: 'pan',
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: surface.scrollLeft,
        scrollTop: surface.scrollTop,
      };
      return;
    }
    const target = event.target as HTMLElement;
    const clipId = target.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId;
    const handle = target.dataset.handle as 'in' | 'out' | undefined;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    movedRef.current = false;

    if (clipId && handle) {
      useCutRoom.getState().commit();
      useCutRoom.getState().setSelection([clipId]);
      gestureRef.current = { kind: 'trim', clipId, edge: handle };
      return;
    }
    if (clipId) {
      const clip = timeline.clips.find((c) => c.id === clipId);
      if (!clip) return;
      // Shift on something already selected takes it back out — that is the only
      // way to drop one clip from a big selection without building it again.
      // It ends there: no drag follows a deselect, and no commit either —
      // undo would otherwise step through pure selection changes.
      if (event.shiftKey && selection.includes(clipId)) {
        const dropped = expandGroups(timeline.clips, [clipId]);
        useCutRoom.getState().setSelection(selection.filter((sid) => !dropped.includes(sid)));
        gestureRef.current = null;
        return;
      }
      useCutRoom.getState().commit();
      // Grabbing a clip that is already part of a multi-selection drags the whole
      // selection; grabbing anything else selects just that clip.
      const picked = event.shiftKey
        ? [...selection, clipId]
        : selection.includes(clipId)
        ? selection
        : [clipId];
      // The drag has to carry exactly what the selection ends up being, so the
      // group is widened here too rather than read back out of the store.
      // The clip under the pointer goes first: the inspector shows the first
      // selected clip, and inside a group that has to be the one clicked, not
      // whichever member happens to lead the group.
      const widened = expandGroups(timeline.clips, picked);
      const next = [clipId, ...widened.filter((sid) => sid !== clipId)];
      useCutRoom.getState().setSelection(next);
      // Picking a clip brings the playhead to it, so the monitor shows what was
      // picked. A playhead already inside the clip stays where it is.
      if (!event.shiftKey && (playhead < clip.start || playhead >= clipEnd(clip))) {
        useCutRoom.getState().setPlayhead(clip.start);
      }
      gestureRef.current = {
        kind: 'move',
        clipId,
        grabOffset: frameAt(event.clientX) - clip.start,
        originTrack: clip.trackId,
        group: timeline.clips
          .filter((c) => next.includes(c.id))
          .map((c) => ({ id: c.id, start: c.start, trackId: c.trackId })),
      };
      return;
    }

    const onRuler = Boolean(target.closest('[data-ruler]'));
    if (!onRuler && surface) {
      const rect = surface.getBoundingClientRect();
      gestureRef.current = {
        kind: 'marquee',
        x: event.clientX - rect.left + surface.scrollLeft,
        y: event.clientY - rect.top + surface.scrollTop - RULER_HEIGHT,
        clientX: event.clientX,
        base: event.shiftKey ? selection : [],
      };
      return;
    }

    useCutRoom.getState().setSelection([]);
    useCutRoom.getState().setPlaying(false);
    useCutRoom.getState().setPlayhead(frameAt(event.clientX));
    gestureRef.current = { kind: 'scrub' };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    movedRef.current = true;
    const store = useCutRoom.getState();

    if (gesture.kind === 'pan') {
      const surface = surfaceRef.current;
      if (!surface) return;
      // Drag right and the content follows the hand, so the view goes left.
      surface.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.clientX);
      surface.scrollTop = gesture.scrollTop - (event.clientY - gesture.clientY);
      // Any actual movement turns this space press into a pan, so releasing the
      // key does not also start playback.
      store.markSpacePanned();
      return;
    }

    if (gesture.kind === 'marquee') {
      const surface = surfaceRef.current;
      if (!surface) return;
      // A few px of jitter on a click is not a box.
      if (Math.abs(event.clientX - gesture.clientX) < 3 && !marquee) {
        movedRef.current = false;
        return;
      }
      const rect = surface.getBoundingClientRect();
      const x = event.clientX - rect.left + surface.scrollLeft;
      const y = event.clientY - rect.top + surface.scrollTop - RULER_HEIGHT;
      const box = {
        left: Math.min(x, gesture.x),
        top: Math.min(y, gesture.y),
        width: Math.abs(x - gesture.x),
        height: Math.abs(y - gesture.y),
      };
      setMarquee(box);
      const firstFrame = box.left / pxPerFrame;
      const lastFrame = (box.left + box.width) / pxPerFrame;
      const firstLane = Math.floor(box.top / TRACK_HEIGHT);
      const lastLane = Math.floor((box.top + box.height) / TRACK_HEIGHT);
      const tracks = store.timeline.tracks;
      const hit = store.timeline.clips
        .filter((c) => {
          const lane = tracks.findIndex((tr) => tr.id === c.trackId);
          if (lane < firstLane || lane > lastLane || tracks[lane]?.locked) return false;
          // Touching is enough, the way every NLE's marquee works.
          return c.start < lastFrame && clipEnd(c) > firstFrame;
        })
        .map((c) => c.id);
      store.setSelection(expandGroups(store.timeline.clips, [...new Set([...gesture.base, ...hit])]));
      return;
    }

    const raw = frameAt(event.clientX);
    const tolerance = snapping && !event.altKey ? SNAP_PX / pxPerFrame : 0;

    if (gesture.kind === 'scrub') {
      store.setPlayhead(raw);
      return;
    }
    if (gesture.kind === 'trim') {
      const clip = store.timeline.clips.find((c) => c.id === gesture.clipId);
      if (!clip) return;
      const { frame: snapped, target } = snapWithTarget(raw, snapTargets([clip.id]), tolerance);
      setSnapLine(target);
      // Handles are dragged in timeline space; trim points live in asset space.
      // Both edges convert the same way: the clip's in point plus the distance
      // from where the clip currently starts.
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      store.trimClip(clip.id, gesture.edge, clip.inFrame + (snapped - clip.start) * speed);
      return;
    }

    // Move: pick the lane under the cursor, but never drop a video clip on an
    // audio lane — the compositor has nothing to do with it there.
    const clip = store.timeline.clips.find((c) => c.id === gesture.clipId);
    if (!clip) return;
    const groupIds = gesture.group.map((g) => g.id);
    const asset = store.timeline.assets[clip.assetId];
    const surface = surfaceRef.current;
    let trackId = gesture.originTrack;
    // A single clip goes to the lane under the cursor. A group is carried by the same number of lanes
    // as the grabbed clip (below), so its own layout across tracks is kept.
    if (surface && groupIds.length === 1) {
      const rect = surface.getBoundingClientRect();
      const lane = Math.floor((event.clientY - rect.top - RULER_HEIGHT + surface.scrollTop) / TRACK_HEIGHT);
      const candidate = store.timeline.tracks[lane];
      // Any clip may go on any lane. The lane decides what of it is used: on an
      // audio lane only its sound, on a video lane its picture (and its sound).
      if (candidate && !candidate.locked) trackId = candidate.id;
    }
    const desired = raw - gesture.grabOffset;

    if (groupIds.length > 1) {
      // Every edge in the group is offered to the snapper: what the user is
      // lining up may belong to any clip travelling along, not just the one
      // under the cursor.
      const shift = desired - clip.start;
      const targets = snapTargets(groupIds);
      let bestDelta = 0;
      let bestDistance = tolerance;
      let bestTarget: number | null = null;
      // The group is one block: only its outer edges (earliest start, latest end) snap.
      for (const edge of groupEdges(store.timeline.clips.filter((c) => groupIds.includes(c.id)), shift)) {
        const { frame, target } = snapWithTarget(edge, targets, tolerance);
        if (target === null) continue;
        const distance = Math.abs(frame - edge);
        if (distance <= bestDistance) {
          bestDistance = distance;
          bestDelta = frame - edge;
          bestTarget = target;
        }
      }
      setSnapLine(bestTarget);
      // Lanes: the group moves by as many lanes as the cursor is away from the lane it was grabbed on.
      let lanes: Record<string, string> | undefined;
      if (surface) {
        const rect = surface.getBoundingClientRect();
        const cursorLane = Math.floor((event.clientY - rect.top - RULER_HEIGHT + surface.scrollTop) / TRACK_HEIGHT);
        const grabbedLane = store.timeline.tracks.findIndex((tr) => tr.id === gesture.originTrack);
        if (grabbedLane >= 0 && cursorLane >= 0) {
          lanes = groupLanes(gesture.group, store.timeline.tracks, cursorLane - grabbedLane).tracks;
        }
      }
      store.moveClips(groupIds, shift + bestDelta, lanes);
      // The grab offset is measured against the clip's live position, which the
      // shift above has just moved.
      gestureRef.current = { ...gesture, grabOffset: raw - (clip.start + shift + bestDelta) };
      return;
    }

    const { frame: snapped, target } = snapWithTarget(desired, snapTargets(groupIds), tolerance);
    setSnapLine(target);
    store.moveClip(clip.id, snapped, trackId);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setSnapLine(null);
    setMarquee(null);
    // A marquee that never became a box was a click on empty space: clear the
    // selection and put the playhead there, as a click always did.
    if (gesture?.kind === 'marquee' && !movedRef.current && !gesture.base.length) {
      const store = useCutRoom.getState();
      store.setSelection([]);
      store.setPlaying(false);
      store.setPlayhead(frameAt(event.clientX));
    }
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    // A click that never moved still pushed a snapshot on pointer-down; drop it
    // so plain selection does not fill the undo stack with no-ops.
    if (gesture && gesture.kind !== 'scrub' && gesture.kind !== 'pan' && gesture.kind !== 'marquee' && !movedRef.current) {
      useCutRoom.setState((s) => ({ past: s.past.slice(0, -1) }));
    }
  };

  // Ctrl+wheel zooms the timeline, anchored on the frame under the pointer so
  // the shot being examined does not slide out from under it. A bare wheel is
  // left to the browser: on a tall cut the tracks are what you need to move
  // through, and Shift+wheel still scrolls sideways. The listener is registered
  // by hand because React's onWheel is passive and cannot preventDefault the
  // browser's own ctrl+wheel page zoom.
  //
  // The anchored scrollLeft cannot be written in the handler: the content only
  // widens when React re-renders at the new zoom, and until then the browser
  // clamps to the old width -- near the right edge every notch landed short and
  // the next notch compounded it. The target is held here and applied once the
  // new width is laid out; a notch arriving before that anchors on the target.
  const zoomScrollRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || zoomScrollRef.current === null) return;
    surface.scrollLeft = zoomScrollRef.current;
    zoomScrollRef.current = null;
  }, [pxPerFrame]);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      // metaKey: the same gesture on a Mac trackpad, where pinch-to-zoom also
      // arrives as a ctrl-flagged wheel event and lands here correctly.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const store = useCutRoom.getState();
      const current = store.pxPerFrame;
      const rect = surface.getBoundingClientRect();
      const offset = event.clientX - rect.left;
      const scrollLeft = zoomScrollRef.current ?? surface.scrollLeft;
      const frameUnderPointer = (offset + scrollLeft) / current;
      // A fixed ratio per notch: zoom is multiplicative, so the same gesture
      // covers the same visual distance at every scale.
      const next = clampZoom(current * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (next === current) return;
      zoomScrollRef.current = Math.max(0, frameUnderPointer * next - offset);
      store.setPxPerFrame(next);
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, []);

  const gutterRef = useRef<HTMLDivElement>(null);
  const syncGutter = useCallback((top: number) => {
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-top}px)`;
  }, []);

  // Scroll position belongs to the film, not to this component. It is written
  // straight to the store rather than held in a subscribed value: the timeline
  // would otherwise re-render on every scrolled pixel.
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    // The track names live outside the scroller; they follow it here, by
    // transform, before any early return so they never fall out of step.
    syncGutter(event.currentTarget.scrollTop);
    // While a film is still loading the surface is showing the previous one and
    // the browser clamps scroll as the DOM shrinks; reading that back would
    // overwrite the position being restored with a 0.
    if (restoringRef.current || useCutRoom.getState().loading) return;
    const surface = event.currentTarget;
    useCutRoom.setState({ scrollLeft: surface.scrollLeft, scrollTop: surface.scrollTop });
    scheduleViewSave();
  }, [syncGutter]);

  // Restoring has to wait for the incoming film's clips: scrollLeft is clamped
  // to the content width, and setting it before the lanes are laid out silently
  // lands on 0.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || loading) return;
    const { scrollLeft, scrollTop } = useCutRoom.getState();
    restoringRef.current = true;
    surface.scrollLeft = scrollLeft;
    surface.scrollTop = scrollTop;
    syncGutter(surface.scrollTop);
    const done = requestAnimationFrame(() => {
      restoringRef.current = false;
    });
    // Cleared here as well: an unmount (the cut room closing mid-restore) would
    // otherwise leave the flag set and every later scroll ignored.
    return () => {
      cancelAnimationFrame(done);
      restoringRef.current = false;
    };
    // Deliberately not keyed on contentWidth: a zoom changes it, and re-running
    // the restore then would fight the wheel handler's anchoring.
  }, [activeSeqId, loading, syncGutter]);

  const ticks = useMemo(() => {
    // Aim for a label roughly every 90px, rounded to a whole number of seconds.
    const step = Math.max(1, Math.round(90 / pxPerFrame / timeline.fps)) * timeline.fps;
    const out: number[] = [];
    for (let frame = 0; frame <= visibleFrames; frame += step) out.push(frame);
    return out;
  }, [pxPerFrame, timeline.fps, visibleFrames]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Track name gutter — outside the scroller so names stay put. */}
      <div className="flex w-[74px] flex-none flex-col overflow-hidden border-r border-white/10 bg-black/20">
        <div className="flex-none" style={{ height: RULER_HEIGHT }} />
        <div className="relative flex-1 overflow-hidden">
        <div ref={gutterRef} style={{ willChange: 'transform' }}>
        {timeline.tracks.map((track) => (
          <div
            key={track.id}
            className="flex flex-col justify-center gap-1 border-b border-white/[0.06] px-2 font-mono text-[10px] text-zinc-400"
            style={{ height: TRACK_HEIGHT }}
          >
            <span className="truncate">{track.name}</span>
            <span className="flex gap-1">
              <button
                onClick={() => useCutRoom.getState().setTrackFlag(track.id, { muted: !track.muted })}
                className={`rounded px-1 ${track.muted ? 'bg-red-500/25 text-red-200' : 'bg-white/[0.06] text-zinc-500 hover:text-zinc-200'}`}
                title={track.muted ? t('取消静音') : t('静音这条轨道')}
              >
                M
              </button>
              <button
                onClick={() => useCutRoom.getState().setTrackFlag(track.id, { locked: !track.locked })}
                className={`rounded px-1 ${track.locked ? 'bg-amber-500/25 text-amber-200' : 'bg-white/[0.06] text-zinc-500 hover:text-zinc-200'}`}
                title={track.locked ? t('解锁') : t('锁定这条轨道')}
              >
                L
              </button>
              <button
                onClick={() => useCutRoom.getState().setTrackFlag(track.id, { bypassed: !track.bypassed })}
                className={`rounded px-1 ${track.bypassed ? 'bg-amber-400/25 text-amber-200' : 'bg-white/[0.06] text-zinc-500 hover:text-zinc-200'}`}
                title={track.bypassed ? t('取消旁通这条轨道') : t('旁通整条轨道：片段留在原位，但不参与预览与导出')}
              >
                B
              </button>
            </span>
          </div>
        ))}
        </div>
        </div>
      </div>

    <div
      ref={surfaceRef}
      className="relative flex-1 overflow-auto select-none"
      style={{ touchAction: 'none', cursor: spaceHeld ? 'grab' : undefined }}
      onScroll={onScroll}
      onPointerDown={onPointerDownSurface}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Two things can be dropped here: a media-bin asset, and a film tab
      // dragged down from the tab bar, which is placed as a reference where it
      // is let go (that lane, that frame, or the next free stretch).
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (types.includes(SEQ_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          const surface = surfaceRef.current;
          if (!surface) return;
          const rect = surface.getBoundingClientRect();
          const lane = Math.floor((e.clientY - rect.top - RULER_HEIGHT + surface.scrollTop) / TRACK_HEIGHT);
          const tracks = useCutRoom.getState().timeline.tracks;
          const frame = frameAt(e.clientX);
          const clamped = Math.min(Math.max(0, lane), tracks.length - 1);
          if (!dropHint || dropHint.frame !== frame || dropHint.lane !== clamped) setDropHint({ frame, lane: clamped });
          return;
        }
        if (!onDropAsset || !types.includes(BIN_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const f = frameAt(e.clientX);
        setDropFrame((prev) => (prev === f ? prev : f));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropFrame(null);
          setDropHint(null);
        }
      }}
      onDrop={(e) => {
        const seqId = e.dataTransfer.getData(SEQ_DRAG_TYPE);
        if (seqId) {
          const hint = dropHint;
          setDropHint(null);
          if (!hint) return;
          e.preventDefault();
          const store = useCutRoom.getState();
          const track = store.timeline.tracks[hint.lane];
          store.appendSequenceRef(seqId, track?.id, hint.frame).catch((error: Error) => {
            window.dispatchEvent(new CustomEvent('cutRoomRefError', { detail: error.message }));
          });
          return;
        }
        const url = e.dataTransfer.getData(BIN_DRAG_TYPE);
        setDropFrame(null);
        if (!onDropAsset || !url) return;
        e.preventDefault();
        const lane = (e.target as HTMLElement).closest('[data-track-id]') as HTMLElement | null;
        onDropAsset(url, lane?.dataset.trackId, frameAt(e.clientX));
      }}
    >
      <div style={{ width: contentWidth, minWidth: '100%', position: 'relative' }}>
        {dropFrame !== null && (
          <div
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-sky-400"
            style={{ left: dropFrame * pxPerFrame }}
          />
        )}
        {/* Ruler */}
        <div
          data-ruler
          className="sticky top-0 z-20 border-b border-white/10 bg-[#0d0d12]/95 backdrop-blur"
          style={{ height: RULER_HEIGHT }}
        >
          {ticks.map((frame) => (
            <div
              key={frame}
              className="absolute top-0 h-full border-l border-white/10 pl-1 font-mono text-[10px] leading-[26px] text-zinc-500 tabular-nums"
              style={{ left: frame * pxPerFrame }}
            >
              {formatTimecode(frame, timeline.fps)}
            </div>
          ))}
          {gaps.map(([from, to], index) => (
            <div
              key={`gap-${from}`}
              className={`absolute top-[4px] bottom-[4px] rounded-sm border ${hoverGap === index ? 'border-zinc-300/70' : 'border-zinc-500/50'}`}
              style={{
                left: from * pxPerFrame,
                width: Math.max(6, (to - from) * pxPerFrame),
                backgroundImage: 'repeating-linear-gradient(135deg, rgba(161,161,170,0.35) 0 1px, transparent 1px 7px)',
              }}
              onPointerEnter={() => setHoverGap(index)}
              onPointerLeave={() => setHoverGap((h) => (h === index ? null : h))}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {hoverGap === index && (
                <button
                  className="absolute left-1/2 top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-700 text-[11px] text-zinc-100 shadow hover:bg-red-500/80"
                  title={t('删除此间隙：所有轨道（视频、音频、字幕）上后面的片段一起左移')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHoverGap(null);
                    useCutRoom.getState().deleteGap(from, to);
                  }}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>

        {/* The hovered gap, drawn down through every lane so it is plain which
            stretch of time the trash button takes out. */}
        {hoverGap !== null && gaps[hoverGap] && (
          <div
            className="pointer-events-none absolute bottom-0 z-10 border-x border-zinc-400/50"
            style={{
              top: RULER_HEIGHT,
              left: gaps[hoverGap][0] * pxPerFrame,
              width: (gaps[hoverGap][1] - gaps[hoverGap][0]) * pxPerFrame,
              backgroundImage: 'repeating-linear-gradient(135deg, rgba(161,161,170,0.18) 0 1px, transparent 1px 9px)',
            }}
          />
        )}

        {/* Lanes */}
        {timeline.tracks.map((track) => (
          <div
            key={track.id}
            data-track-id={track.id}
            className={`relative border-b border-white/[0.06] ${track.bypassed ? 'opacity-40 saturate-0' : ''}`}
            style={{ height: TRACK_HEIGHT, background: track.kind === 'audio' ? 'rgba(255,255,255,0.015)' : 'transparent' }}
          >
            {timeline.clips
              .filter((c) => c.trackId === track.id)
              .map((clip) => (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  selected={selection.includes(clip.id)}
                  pxPerFrame={pxPerFrame}
                  audioOnly={track.kind === 'audio'}
                />
              ))}
            {(laneGaps.get(track.id) ?? []).map(([from, to]) => (
              <div
                key={`lanegap-${from}`}
                className="group absolute top-[3px] bottom-[3px] flex items-center justify-center rounded-md border border-zinc-500/40 hover:border-zinc-300/70"
                style={{
                  left: from * pxPerFrame,
                  width: Math.max(6, (to - from) * pxPerFrame),
                  backgroundImage: 'repeating-linear-gradient(135deg, rgba(161,161,170,0.28) 0 1px, transparent 1px 8px)',
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  className="hidden h-7 w-7 items-center justify-center rounded-full text-zinc-300 hover:bg-red-500/70 hover:text-white group-hover:flex"
                  title={ripple === 'all' ? t('删除此间隙：所有轨道上后面的片段一起左移') : t('删除此间隙：只左移这条轨道上后面的片段（成组的一起动）')}
                  onClick={(e) => {
                    e.stopPropagation();
                    useCutRoom.getState().deleteGap(from, to, track.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ))}

        {/* Snap indicator: the edge the drag has locked onto. Amber, so it is
            never confused with the emerald playhead — which is itself one of
            the things a clip can snap to. */}
        {snapLine !== null && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-amber-300"
            style={{ left: snapLine * pxPerFrame, boxShadow: '0 0 6px rgba(252, 211, 77, 0.9)' }}
          >
            <div className="-ml-[3px] h-1.5 w-1.5 rotate-45 bg-amber-300" />
          </div>
        )}

        {marquee && (
          <div
            className="pointer-events-none absolute z-30 rounded-sm border border-emerald-300/80 bg-emerald-300/10"
            style={{ left: marquee.left, top: marquee.top + RULER_HEIGHT, width: marquee.width, height: marquee.height }}
          />
        )}

        {dropHint && (
          <div
            className="pointer-events-none absolute z-30 w-0.5 bg-amber-300"
            style={{
              left: dropHint.frame * pxPerFrame,
              top: RULER_HEIGHT + dropHint.lane * TRACK_HEIGHT,
              height: TRACK_HEIGHT,
              boxShadow: '0 0 6px rgba(252, 211, 77, 0.9)',
            }}
          />
        )}

        {/* Playhead */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-emerald-400"
          style={{ left: playhead * pxPerFrame }}
        >
          <div className="-ml-[5px] h-2.5 w-2.5 rotate-45 bg-emerald-400" />
        </div>
      </div>
    </div>
    </div>
  );
}

function ClipBlock({
  clip,
  selected,
  pxPerFrame,
  audioOnly,
}: {
  clip: Clip;
  selected: boolean;
  pxPerFrame: number;
  /** On an audio lane: only the sound of this asset is in play. */
  audioOnly: boolean;
}) {
  const asset = useCutRoom((s) => s.timeline.assets[clip.assetId]);
  const width = Math.max(6, clipLength(clip) * pxPerFrame);
  const offline = asset?.offline;
  const seqName = useCutRoom((s) =>
    clip.seqRef ? s.sequences.find((q) => q.id === clip.seqRef)?.name : undefined
  );
  const label = clipLabel(clip, asset, seqName);
  const [renaming, setRenaming] = useState(false);
  const transition = clip.transitionIn;
  const sheet = !audioOnly && asset?.thumbsUrl ? resolveAssetUrl(asset.thumbsUrl) : null;
  // The sheet covers the whole file; this clip shows the part it was cut to, so
  // the tiles are picked by the clip's own trim and move when it is trimmed.
  const tiles = useMemo(
    () =>
      sheet && asset
        ? filmstripTiles({
            inFrame: clip.inFrame,
            outFrame: clip.outFrame,
            sourceFrames: asset.timelineFrames,
            thumbCount: asset.thumbCount ?? 0,
            width,
            height: CLIP_HEIGHT - 2,
            aspect: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9,
          })
        : [],
    [sheet, asset, clip.inFrame, clip.outFrame, width]
  );

  return (
    <div
      data-clip-id={clip.id}
      className={`absolute top-1.5 flex cursor-grab items-center overflow-hidden rounded-md border text-[11px] active:cursor-grabbing ${
        offline
          ? 'border-red-500/60 bg-red-500/15 text-red-200'
          : clip.seqRef && !selected
          ? 'border-amber-300/40 bg-amber-300/[0.10] text-amber-100 hover:bg-amber-300/[0.16]'
          : selected
          ? 'border-emerald-400 bg-emerald-400/20 text-emerald-100 ring-2 ring-emerald-400/70'
          : 'border-white/15 bg-white/[0.07] text-zinc-200 hover:bg-white/[0.11]'
      } ${
        // Bypassed reads as "still here, not in the cut". The dimming belongs to
        // the CONTENT layer below, never to this element: dropping the whole
        // clip to 45% and zero saturation also drains the selection ring, and a
        // bypassed clip is exactly the one you are selecting to bring back.
        clip.bypassed ? 'border-dashed' : ''
      }`}
      style={{ left: clip.start * pxPerFrame, width, height: CLIP_HEIGHT }}
      // Double-click to rename, the way every NLE does it. Naming a shot is what
      // turns a row of identical grey blocks into a cut you can read.
      onDoubleClick={(event) => {
        event.stopPropagation();
        // A reference is edited in its own tab; double-click goes there.
        if (clip.seqRef) {
          void useCutRoom.getState().activate(clip.seqRef).catch(() => undefined);
          return;
        }
        setRenaming(true);
      }}
      title={t('{label} · {frames} 帧{speed}{flipH}{flipV}{bypassed}', {
        label,
        frames: clipLength(clip),
        speed: clip.speed !== 1 ? ` · ${clip.speed}x` : '',
        flipH: clip.flipH ? t(' · 水平镜像') : '',
        flipV: clip.flipV ? t(' · 垂直镜像') : '',
        bypassed: clip.bypassed ? t(' · 已旁通（不参与预览与导出）') : '',
      }) + (clip.seqRef ? t(' · 双击打开该影片编辑') : '')}
    >
      {/* The thumbnail strip is the fastest way to recognise a shot; it sits
          behind the label rather than replacing it. A detached shot keeps a
          video asset, thumbnails and all, but on an audio lane the picture is
          not what is playing — the waveform is, and a filmstrip behind it
          would claim otherwise. */}
      <div className={`pointer-events-none absolute inset-0 overflow-hidden ${clip.bypassed ? 'opacity-40 saturate-0' : ''}`}>
        {tiles.map((tile) => (
          <div
            key={tile.left}
            className="absolute top-0 h-full"
            style={{
              left: tile.left,
              width: tile.width,
              backgroundImage: `url(${sheet})`,
              // The sheet is `thumbCount` frames wide, so one frame fills the
              // tile when the whole sheet is that many tiles wide.
              backgroundSize: `${(asset?.thumbCount ?? 1) * 100}% 100%`,
              backgroundPositionX: tile.positionX,
              backgroundRepeat: 'no-repeat',
            }}
          />
        ))}
      </div>
      {clip.seqRef && <ReferenceStrip clip={clip} pxPerFrame={pxPerFrame} audioOnly={audioOnly} />}
      {asset?.peaks && asset.peaks.length > 0 && (
        <div className={`pointer-events-none absolute inset-0 ${clip.bypassed ? 'opacity-40 saturate-0' : ''}`}>
          <Waveform
            peaks={asset.peaks}
            rms={asset.rms}
            inFrame={clip.inFrame}
            outFrame={clip.outFrame}
            sourceFrames={asset.timelineFrames}
            width={width}
            muted={clip.muted}
            gain={clip.volume ?? 1}
          />
        </div>
      )}

      {/* Frames this clip shows that overlap the previous shot: the file of a
          chained shot keeps them so the seam can be moved, and a clip whose in
          point has been dragged back into them plays them. Marked, not hidden. */}
      {(() => {
        const head = asset?.chainHead?.frames ?? 0;
        if (!(head > clip.inFrame)) return null;
        const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
        const frames = Math.min(clipLength(clip), Math.round((head - clip.inFrame) / speed));
        return (
          <div
            className="pointer-events-none absolute left-0 top-0 z-[1] h-full border-r border-amber-300/80"
            style={{
              width: frames * pxPerFrame,
              backgroundColor: 'rgba(251, 191, 36, 0.28)',
              backgroundImage: 'repeating-linear-gradient(135deg, rgba(251,191,36,0.55) 0 2px, transparent 2px 7px)',
            }}
            title={t('与上一段重叠的 {v1} 帧（接续片段保留在文件开头，用来挪接缝）', { v1: frames })}
          />
        );
      })()}

      {transition && transition.frames > 0 && (
        <div
          className="pointer-events-none absolute left-0 top-0 h-full bg-gradient-to-r from-sky-400/60 to-transparent"
          style={{ width: transition.frames * pxPerFrame }}
          title={t('{kind} {frames} 帧', {
            kind: transition.type === 'dissolve' ? t('交叉溶解') : transition.type === 'dip' ? t('闪白') : t('淡入黑'),
            frames: transition.frames,
          })}
        />
      )}

      <div
        data-handle="in"
        className="absolute left-0 top-0 z-10 h-full w-2 cursor-ew-resize bg-white/10 hover:bg-emerald-400/70"
      />
      {clip.bypassed && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/60" />
      )}
      {clip.groupId && (
        // A group is only visible as a shared band across its members: nothing
        // else on the clip changes, because grouping changes nothing about it
        // except what it moves with.
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-violet-400/80"
          title={t('已合组：选中其一即选中整组')}
        />
      )}
      <span
        className={`pointer-events-none relative truncate px-3 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${
          // Struck through and greyed, but only when it is not the clip under
          // the cursor's attention — a selected one keeps its emerald label.
          clip.bypassed ? (selected ? 'line-through' : 'line-through opacity-70') : ''
        }`}
      >
        {offline ? t('素材缺失 · ') : ''}
        {clip.bypassed ? t('旁通 · ') : ''}
        {clip.flipH ? '⇄ ' : ''}
        {clip.flipV ? '⇅ ' : ''}
        {label}
        {clip.speed !== 1 ? ` ${clip.speed}x` : ''}
      </span>
      {renaming && (
        <RenameField
          clipId={clip.id}
          initial={clip.name ?? ''}
          placeholder={label}
          onDone={() => setRenaming(false)}
        />
      )}
      <div
        data-handle="out"
        className="absolute right-0 top-0 z-10 h-full w-2 cursor-ew-resize bg-white/10 hover:bg-emerald-400/70"
      />
    </div>
  );
}

/**
 * The rename box, shown over the clip until it is committed.
 *
 * Its pointer events are held back from the surface: every gesture on the
 * timeline is captured up there, so without this, clicking into the field to
 * put the caret somewhere would start dragging the clip instead.
 */
function RenameField({
  clipId,
  initial,
  placeholder,
  onDone,
}: {
  clipId: string;
  initial: string;
  /** What the clip is called now — typing nothing keeps exactly that. */
  placeholder: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initial);

  const commit = () => {
    const next = value.trim();
    // An empty name is not a name: it clears the override and the clip goes back
    // to being called after its source.
    useCutRoom.getState().commitUpdate(clipId, { name: next || undefined });
    onDone();
  };

  return (
    <input
      autoFocus
      data-clip-rename=""
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
      className="absolute inset-x-2 top-1/2 z-20 -translate-y-1/2 rounded border border-emerald-400/70 bg-black/85 px-1.5 py-0.5 text-[11px] text-emerald-100 outline-none"
    />
  );
}

/**
 * Peaks come from the backend already normalised, one value per bucket, and
 * they cover the WHOLE asset. A clip is a window into that asset, so the
 * buckets have to be sliced to the clip's trim points before they are drawn —
 * otherwise trimming an audio clip squeezes the entire waveform into the
 * shorter box, and every peak sits somewhere the sound is not.
 *
 * Speed deliberately plays no part here: `inFrame`/`outFrame` address the
 * source, and speed only changes how wide that window is drawn.
 */
/**
 * What a referenced film looks like on this film's timeline: the thumbnails and
 * waveform of the clips it is made of, cut to the stretch the reference shows.
 * A reference used to be a flat amber block, so a film built from references
 * could not be told apart by eye the way its own shots can.
 */
function ReferenceStrip({
  clip,
  pxPerFrame,
  audioOnly,
}: {
  clip: Clip;
  pxPerFrame: number;
  audioOnly: boolean;
}) {
  const source = useCutRoom((s) => resolverOf(s)(clip.seqRef as string));
  const nested = useMemo(
    () => (source ? flattenTimeline(source, resolverOf(useCutRoom.getState()), new Set([clip.seqRef as string])) : null),
    [source, clip.seqRef]
  );
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const parts = useMemo(() => {
    if (!nested) return { pictures: [], sounds: [] };
    const kindOf = new Map(nested.tracks.map((tr) => [tr.id, tr]));
    const cutOf = (c: Clip) => {
      const cut = clipInSpan(c, clip.inFrame, clip.outFrame);
      return cut ? { cut, left: (cut.start / speed) * pxPerFrame, width: Math.max(1, (clipLength(cut) / speed) * pxPerFrame) } : null;
    };
    const live = (c: Clip) => {
      const track = kindOf.get(c.trackId);
      return track && !track.bypassed && !c.bypassed && !c.text;
    };
    const video = nested.clips.filter((c) => live(c) && kindOf.get(c.trackId)?.kind === 'video' && nested.assets[c.assetId]?.kind === 'video');
    const audio = nested.clips.filter((c) => live(c) && kindOf.get(c.trackId)?.kind === 'audio');
    // Sound comes from the audio lanes; a film with none is heard through its shots.
    const sound = audio.length > 0 ? audio : video;
    return {
      pictures: video.flatMap((c) => { const p = cutOf(c); return p ? [{ ...p, asset: nested.assets[c.assetId] }] : []; }),
      sounds: sound.flatMap((c) => { const p = cutOf(c); return p ? [{ ...p, asset: nested.assets[c.assetId], silent: Boolean(kindOf.get(c.trackId)?.muted) }] : []; }),
    };
  }, [nested, clip.inFrame, clip.outFrame, speed, pxPerFrame]);
  if (!nested) return null;

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${clip.bypassed ? 'opacity-40 saturate-0' : ''}`}>
      {!audioOnly &&
        parts.pictures.map((p) => (
          <FilmstripPart key={`v${p.cut.id}`} asset={p.asset} inFrame={p.cut.inFrame} outFrame={p.cut.outFrame} left={p.left} width={p.width} />
        ))}
      {parts.sounds.map((p) =>
        p.asset?.peaks && p.asset.peaks.length > 0 ? (
          <div key={`a${p.cut.id}`} className="absolute top-0 h-full" style={{ left: p.left, width: p.width }}>
            <Waveform
              peaks={p.asset.peaks}
              rms={p.asset.rms}
              inFrame={p.cut.inFrame}
              outFrame={p.cut.outFrame}
              sourceFrames={p.asset.timelineFrames}
              width={p.width}
              muted={p.cut.muted || p.silent || clip.muted}
              gain={(p.cut.volume ?? 1) * (clip.volume ?? 1)}
            />
          </div>
        ) : null
      )}
    </div>
  );
}

/** One shot's thumbnails, laid out in `width` px starting at `left`. */
function FilmstripPart({
  asset,
  inFrame,
  outFrame,
  left,
  width,
}: {
  asset: EditorAsset | undefined;
  inFrame: number;
  outFrame: number;
  left: number;
  width: number;
}) {
  const sheet = asset?.thumbsUrl ? resolveAssetUrl(asset.thumbsUrl) : null;
  const tiles = useMemo(
    () =>
      sheet && asset
        ? filmstripTiles({
            inFrame,
            outFrame,
            sourceFrames: asset.timelineFrames,
            thumbCount: asset.thumbCount ?? 0,
            width,
            height: CLIP_HEIGHT - 2,
            aspect: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9,
          })
        : [],
    [sheet, asset, inFrame, outFrame, width]
  );
  return (
    <div className="absolute top-0 h-full overflow-hidden" style={{ left, width }}>
      {tiles.map((tile) => (
        <div
          key={tile.left}
          className="absolute top-0 h-full"
          style={{
            left: tile.left,
            width: tile.width,
            backgroundImage: `url(${sheet})`,
            backgroundSize: `${(asset?.thumbCount ?? 1) * 100}% 100%`,
            backgroundPositionX: tile.positionX,
            backgroundRepeat: 'no-repeat',
          }}
        />
      ))}
    </div>
  );
}

function Waveform({
  peaks,
  rms,
  inFrame,
  outFrame,
  sourceFrames,
  width,
  muted,
  gain,
}: {
  peaks: number[];
  /** Loudness per bucket, when the asset has it: the solid bars. Peaks stay as the faint outline behind. */
  rms?: number[];
  inFrame: number;
  outFrame: number;
  /** Asset length on the timeline grid — the span the buckets are spread over. */
  sourceFrames: number;
  width: number;
  muted: boolean;
  /** The clip's volume, linear: its bars sit where it will actually be heard. */
  gain: number;
}) {
  const bars = useMemo(() => {
    const total = sourceFrames > 0 ? sourceFrames : Math.max(1, outFrame);
    const at = (frame: number) =>
      Math.min(peaks.length, Math.max(0, Math.round((frame / total) * peaks.length)));
    const from = at(inFrame);
    // Two buckets is the least that can draw anything; a very short trim on a
    // coarse peak set would otherwise collapse to nothing and vanish.
    const to = Math.max(from + 2, at(outFrame));
    const window = peaks.slice(from, to);
    if (window.length === 0) return [] as Array<{ peak: number; level: number }>;
    const loud = rms && rms.length === peaks.length ? rms.slice(from, to) : null;

    // One bar per 2 px of clip width — dense enough to read as a waveform,
    // still leaving a visible gap between bars. Each bar takes the loudest peak
    // it covers (an average would flatten transients away) and the mean of the
    // loudness under it, since loudness is what the ear follows.
    const count = Math.max(1, Math.min(window.length, Math.round(width / 2)));
    const out: Array<{ peak: number; level: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const lo = Math.floor((index / count) * window.length);
      const hi = Math.max(lo + 1, Math.floor(((index + 1) / count) * window.length));
      let peak = 0;
      let sum = 0;
      for (let bucket = lo; bucket < hi; bucket += 1) {
        peak = Math.max(peak, window[bucket]);
        sum += loud ? loud[bucket] ** 2 : 0;
      }
      out.push({ peak, level: loud ? Math.sqrt(sum / (hi - lo)) : peak });
    }
    return out;
  }, [peaks, rms, inFrame, outFrame, sourceFrames, width]);

  const fill = muted ? 'rgba(255,255,255,0.2)' : 'rgba(110,231,183,0.65)';
  // A 20% gap between bars reads as a bar chart rather than a filled area,
  // and never falls below a hairline once the clip is narrow.
  const slot = 100 / Math.max(1, bars.length);
  const barWidth = Math.max(slot * 0.8, 0.05);

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {bars.map(({ peak, level }, index) => {
        // dBFS, on one scale for every clip. Mirrored around the centre line,
        // with a floor so silence still shows a baseline tick. The faint bar is
        // the peak, the solid one the loudness; both sit where the clip's gain
        // puts them.
        const x = (index * slot + (slot - barWidth) / 2).toFixed(3);
        const peakH = Math.max(peakHeight(peak, gain) * 92, 0.8);
        const levelH = Math.max(peakHeight(level, gain) * 92, 0.8);
        return (
          <React.Fragment key={index}>
            {level !== peak && (
              <rect x={x} y={(50 - peakH / 2).toFixed(3)} width={barWidth.toFixed(3)} height={peakH.toFixed(3)} fill={fill} opacity={0.3} />
            )}
            <rect x={x} y={(50 - levelH / 2).toFixed(3)} width={barWidth.toFixed(3)} height={levelH.toFixed(3)} fill={fill} />
          </React.Fragment>
        );
      })}
    </svg>
  );
}
