'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useCutRoom } from '@/lib/editor/store';
import { type CropRect, cropOf, isFullCrop, placeClip } from '@/lib/editor/geometry';
import { type Clip } from '@/lib/editor/types';
import { t } from '@/lib/i18n';

/** Which handle a drag grabbed. `move` slides the whole rectangle. */
type Grip = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e' | 'move';

const CORNERS: Grip[] = ['nw', 'ne', 'sw', 'se'];
const EDGES: Grip[] = ['n', 's', 'w', 'e'];

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The controls that belong on the picture rather than in a side panel: crop,
 * fit, rotate and flip.
 *
 * They appear when the picture is CLICKED, and act on whatever is on screen at
 * the playhead — clicking a thing to get at what can be done to it, rather than
 * having a toolbar hover over every shot the timeline selection happens to
 * touch. Clicking anywhere else puts them away.
 *
 * Everything is drawn in SCREEN pixels over the monitor canvas, mapped through
 * the same `placeClip` the compositor draws with, so the crop rectangle lands on
 * the picture under it at any window size or frame ratio.
 */
export default function MonitorOverlay({
  canvasRef,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  const timeline = useCutRoom((s) => s.timeline);
  const cropDraft = useCutRoom((s) => s.cropDraft);
  // Deliberately a selector down to an ID, not to the clip or to the playhead:
  // the playhead moves every frame while playing, and subscribing to it would
  // re-render this whole tree sixty times a second to answer the same question.
  // An unchanged string is Object.is-equal, so nothing re-renders.
  const clipId = useCutRoom((s) => {
    // The picture you are looking at is the topmost video track that has
    // something at the playhead — the same clip the compositor drew last, since
    // it composites bottom-up and this reads the list back down.
    for (const track of [...s.timeline.tracks].reverse()) {
      if (track.kind !== 'video') continue;
      const under = s.timeline.clips.find((c) => {
        if (c.trackId !== track.id || c.text || c.bypassed) return false;
        const length = Math.max(1, Math.round((c.outFrame - c.inFrame) / (c.speed || 1)));
        return s.playhead >= c.start && s.playhead < c.start + length;
      });
      if (under) return under.id;
    }
    return null;
  });

  /** Whether the picture has been clicked. Nothing is drawn until it has. */
  const [active, setActive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flipOpen, setFlipOpen] = useState(false);
  /** The canvas's on-screen box, relative to this overlay's own box. */
  const [box, setBox] = useState<Box | null>(null);
  /** The overlay's own size, needed to clip everything to the canvas. */
  const [rootSize, setRootSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  // The clip the toolbar acts on: the selected one, but only while the playhead
  // is inside it. Selecting a shot elsewhere in the cut must not put controls
  // over a picture that belongs to something else.
  const clip = useMemo(
    () => timeline.clips.find((c) => c.id === clipId) ?? null,
    [timeline.clips, clipId]
  );

  const asset = clip ? timeline.assets[clip.assetId] : null;

  // Measure the canvas rather than assume it: the layout sizes it, and it
  // reshapes whenever the frame ratio or the window does.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const measure = () => {
      const c = canvas.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      setBox({ left: c.left - r.left, top: c.top - r.top, width: c.width, height: c.height });
      setRootSize({ width: r.width, height: r.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(root);
    return () => observer.disconnect();
  }, [canvasRef, timeline.width, timeline.height]);

  // Clicking away puts the toolbar down — but a click on the toolbar, a menu or
  // a crop handle is not "away", and neither is a click back on the picture.
  useEffect(() => {
    if (!active) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      useCutRoom.getState().cancelCrop();
      setActive(false);
      setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [active]);

  // Nothing on screen to act on: put the controls away rather than leave them
  // armed and pointing at a picture that has since cut to something else.
  useEffect(() => {
    if (!clipId) {
      setActive(false);
      setMenuOpen(false);
    }
  }, [clipId]);

  // Moving off the clip with a half-dragged crop would strand it.
  useEffect(() => {
    if (cropDraft && (!clip || clip.id !== cropDraft.clipId)) useCutRoom.getState().cancelCrop();
  }, [cropDraft, clip]);

  useEffect(() => {
    if (!cropDraft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      // Capture, ahead of the cut room's own handler: Escape there closes the
      // whole room, and backing out of a crop is plainly what it means here.
      event.stopImmediatePropagation();
      event.preventDefault();
      if (event.key === 'Enter') useCutRoom.getState().commitCrop();
      else useCutRoom.getState().cancelCrop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cropDraft]);

  const update = useCallback(
    (patch: Partial<Clip>) => {
      if (!clip) return;
      useCutRoom.getState().commitUpdate(clip.id, patch);
    },
    [clip]
  );

  const empty = <div ref={rootRef} className="pointer-events-none absolute inset-0" />;
  if (!clip || !asset || !box || !asset.width || !asset.height) return empty;

  const cropping = cropDraft?.clipId === clip.id;
  // While cropping, the monitor shows the whole uncropped picture (the tick in
  // CutRoom substitutes it), so the handles are placed against that.
  const placement = placeClip(
    asset.width,
    asset.height,
    cropping ? { ...clip, crop: undefined, fit: 'contain' } : clip,
    timeline.width,
    timeline.height
  );
  if (!placement) return empty;

  // Frame pixels to screen pixels.
  const k = box.width / timeline.width;
  const picture: Box = {
    left: box.left + placement.destX * k,
    top: box.top + placement.destY * k,
    width: placement.destW * k,
    height: placement.destH * k,
  };

  const rect: CropRect = cropDraft?.rect ?? cropOf(clip);
  const cropBox: Box = {
    left: picture.left + rect.x * picture.width,
    top: picture.top + rect.y * picture.height,
    width: rect.w * picture.width,
    height: rect.h * picture.height,
  };

  const onGrip = (grip: Grip) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...rect };

    const onMove = (move: PointerEvent) => {
      // Pointer travel in fractions of the picture, which is what the rectangle
      // is measured in.
      const dx = (move.clientX - startX) / picture.width;
      const dy = (move.clientY - startY) / picture.height;
      if (grip === 'move') {
        useCutRoom.getState().setCropDraft({ ...start, x: start.x + dx, y: start.y + dy });
        return;
      }
      let { x, y, w, h } = start;
      if (grip.includes('w')) {
        x = start.x + dx;
        w = start.w - dx;
      }
      if (grip.includes('e')) w = start.w + dx;
      if (grip.includes('n')) {
        y = start.y + dy;
        h = start.h - dy;
      }
      if (grip.includes('s')) h = start.h + dy;
      useCutRoom.getState().setCropDraft({ x, y, w, h });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // Listeners on the window, not on the handle: a fast drag outruns a 12px
    // dot, and the crop must not stop following the cursor when it does.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * Drag inside the picture to slide it. The offsets are fractions of the
   * frame, and the pointer moves in screen pixels, so the ratio between the two
   * is the only conversion involved.
   */
  const onPan = (event: React.PointerEvent) => {
    const startX = event.clientX;
    const startY = event.clientY;
    const from = { x: clip.offsetX ?? 0, y: clip.offsetY ?? 0 };
    let moved = false;
    // The snapshot goes in BEFORE anything moves, and is taken back out again if
    // nothing did. Committing at the end would snapshot the finished position
    // and leave undo with nowhere to go.
    useCutRoom.getState().commit();

    const onMove = (move: PointerEvent) => {
      moved = true;
      useCutRoom.getState().updateClip(clip.id, {
        offsetX: from.x + (move.clientX - startX) / box.width,
        offsetY: from.y + (move.clientY - startY) / box.height,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // A click that never moved leaves no history behind.
      if (!moved) useCutRoom.setState((state) => ({ past: state.past.slice(0, -1) }));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * Drag a corner to resize. The opposite corner stays exactly where it is —
   * that is what makes the gesture feel like grabbing a picture by the edge,
   * rather than watching it grow out of its own centre in both directions.
   */
  const onCorner = (grip: Grip) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // The anchor, in screen pixels: the corner diagonally across from this one.
    const anchorX = grip.includes('w') ? picture.left + picture.width : picture.left;
    const anchorY = grip.includes('n') ? picture.top + picture.height : picture.top;
    // Where the grabbed corner is relative to the pointer. Handles are pinned
    // inside the monitor when the picture overflows it, so the dot is not always
    // sitting on the corner it drags — carrying the difference keeps the corner
    // under the cursor instead of snapping to it.
    const rootRect = rootRef.current?.getBoundingClientRect();
    const originX = rootRect ? rootRect.left : 0;
    const originY = rootRect ? rootRect.top : 0;
    const cornerX = grip.includes('w') ? picture.left : picture.left + picture.width;
    const cornerY = grip.includes('n') ? picture.top : picture.top + picture.height;
    const grabX = originX + cornerX - event.clientX;
    const grabY = originY + cornerY - event.clientY;
    // Size at zoom 1, in screen pixels — the yardstick the new zoom is read off.
    const zoom = clip.zoom && clip.zoom > 0 ? clip.zoom : 1;
    const baseW = picture.width / zoom;
    const baseH = picture.height / zoom;
    let moved = false;
    useCutRoom.getState().commit();

    const onMove = (move: PointerEvent) => {
      moved = true;
      // Uniform: the picture's own aspect is not up for negotiation here, so the
      // drag is read off whichever axis it travelled further along.
      const wantW = Math.abs(move.clientX + grabX - originX - anchorX);
      const wantH = Math.abs(move.clientY + grabY - originY - anchorY);
      const next = Math.min(12, Math.max(0.05, Math.max(wantW / baseW, wantH / baseH)));
      const width = baseW * next;
      const height = baseH * next;
      // Put the anchor back where it was: the centre moves by half the change,
      // away from the corner being dragged.
      const centreX = grip.includes('w') ? anchorX - width / 2 : anchorX + width / 2;
      const centreY = grip.includes('n') ? anchorY - height / 2 : anchorY + height / 2;
      useCutRoom.getState().updateClip(clip.id, {
        zoom: next,
        offsetX: (centreX - (box.left + box.width / 2)) / box.width,
        offsetY: (centreY - (box.top + box.height / 2)) / box.height,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) useCutRoom.setState((state) => ({ past: state.past.slice(0, -1) }));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const reshaped =
    Boolean(clip.rotate) ||
    Boolean(clip.flipH) ||
    Boolean(clip.flipV) ||
    clip.fit === 'cover' ||
    (clip.zoom ?? 1) !== 1 ||
    Boolean(clip.offsetX) ||
    Boolean(clip.offsetY) ||
    !isFullCrop(cropOf(clip));

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      {/* Everything that belongs to the picture is clipped to the monitor.
          A zoomed-in clip's rectangle runs past the frame, and without this its
          click target — an invisible one — would reach out over the media bin
          and the inspector, where a stray click would grab the picture instead
          of what was aimed at. Clipping is what makes "inside the monitor" and
          "can be clicked" the same thing. The toolbar is deliberately outside
          this layer: it sits above the frame. */}
      <div
        className="absolute inset-0"
        style={{
          clipPath: `inset(${box.top}px ${Math.max(0, rootSize.width - (box.left + box.width))}px ${
            Math.max(0, rootSize.height - (box.top + box.height))
          }px ${box.left}px)`,
        }}
      >
      {/* The picture itself, as a target. Clicking it summons the toolbar and
          selects the clip on the timeline, so the inspector and the timeline
          agree about what is being worked on; dragging it slides the picture
          inside the frame. */}
      <div
        className={`pointer-events-auto absolute ${active && !cropping ? 'cursor-move' : 'cursor-pointer'}`}
        style={picture}
        onPointerDown={(event) => {
          const wasActive = active;
          setActive(true);
          useCutRoom.getState().setSelection([clip.id]);
          if (wasActive && !cropping) onPan(event);
        }}
      />

      {/* ── Selection frame ────────────────────────────────────────── */}
      {/* Four corner points on the picture: what is selected, and what can be
          done to it. Drag one to resize, drag between them to move. */}
      {active && !cropping && (
        <>
          <div className="pointer-events-none absolute border border-violet-400" style={picture} />
          {CORNERS.map((grip) => {
            // Pinned inside the monitor when the picture overflows it. A handle
            // clipped away is a handle you cannot use to shrink the picture back
            // — which is exactly the state you would be trying to get out of.
            const x = grip.includes('w') ? picture.left : picture.left + picture.width;
            const y = grip.includes('n') ? picture.top : picture.top + picture.height;
            return (
              <span
                key={grip}
                onPointerDown={onCorner(grip)}
                className="pointer-events-auto absolute h-3 w-3 rounded-full border border-violet-400 bg-white shadow"
                style={{
                  left: Math.min(box.left + box.width - 7, Math.max(box.left + 1, x)) - 6,
                  top: Math.min(box.top + box.height - 7, Math.max(box.top + 1, y)) - 6,
                  cursor: grip === 'nw' || grip === 'se' ? 'nwse-resize' : 'nesw-resize',
                }}
                title={t('拖动缩放画面；拖动画面本身可移动位置')}
              />
            );
          })}
        </>
      )}

      {/* ── Crop rectangle ─────────────────────────────────────────── */}
      {cropping && (
        <>
          {/* What is being cut away, dimmed but still readable — you have to see
              it to decide you want it back. Four bands rather than a cut-out
              mask: they are trivially correct, and one of them being zero-sized
              when the crop touches an edge is exactly right. */}
          <Shade
            box={{ left: picture.left, top: picture.top, width: picture.width, height: cropBox.top - picture.top }}
          />
          <Shade
            box={{
              left: picture.left,
              top: cropBox.top + cropBox.height,
              width: picture.width,
              height: picture.top + picture.height - (cropBox.top + cropBox.height),
            }}
          />
          <Shade
            box={{ left: picture.left, top: cropBox.top, width: cropBox.left - picture.left, height: cropBox.height }}
          />
          <Shade
            box={{
              left: cropBox.left + cropBox.width,
              top: cropBox.top,
              width: picture.left + picture.width - (cropBox.left + cropBox.width),
              height: cropBox.height,
            }}
          />

          <div
            className="pointer-events-auto absolute cursor-move border border-violet-400"
            style={cropBox}
            onPointerDown={onGrip('move')}
          >
            {/* Thirds: the only guide worth drawing while framing. */}
            <span className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/25" />
            <span className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/25" />
            <span className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/25" />
            <span className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/25" />
          </div>

          {CORNERS.map((grip) => (
            <span
              key={grip}
              onPointerDown={onGrip(grip)}
              className="pointer-events-auto absolute h-3 w-3 rounded-full border border-violet-300 bg-white"
              style={{
                left: (grip.includes('w') ? cropBox.left : cropBox.left + cropBox.width) - 6,
                top: (grip.includes('n') ? cropBox.top : cropBox.top + cropBox.height) - 6,
                cursor: grip === 'nw' || grip === 'se' ? 'nwse-resize' : 'nesw-resize',
              }}
            />
          ))}
          {EDGES.map((grip) => {
            const horizontalEdge = grip === 'n' || grip === 's';
            return (
              <span
                key={grip}
                onPointerDown={onGrip(grip)}
                className="pointer-events-auto absolute rounded bg-white/85"
                style={{
                  left: horizontalEdge
                    ? cropBox.left + cropBox.width / 2 - 10
                    : (grip === 'w' ? cropBox.left : cropBox.left + cropBox.width) - 2,
                  top: horizontalEdge
                    ? (grip === 'n' ? cropBox.top : cropBox.top + cropBox.height) - 2
                    : cropBox.top + cropBox.height / 2 - 10,
                  width: horizontalEdge ? 20 : 4,
                  height: horizontalEdge ? 4 : 20,
                  cursor: horizontalEdge ? 'ns-resize' : 'ew-resize',
                }}
              />
            );
          })}
        </>
      )}

      </div>

      {/* ── Toolbar ────────────────────────────────────────────────── */}
      {active && (
      <div
        className="pointer-events-auto absolute flex -translate-x-1/2 items-center gap-1 rounded-lg border border-white/10 bg-[#1b1b23]/95 p-1 shadow-xl backdrop-blur"
        style={{ left: box.left + box.width / 2, top: Math.max(4, box.top - 40) }}
      >
        {cropping ? (
          <>
            <button
              onClick={() => useCutRoom.getState().commitCrop()}
              className="rounded px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-400/20"
            >
              
              {t('✓ 完成裁剪')}
            </button>
            <button
              onClick={() => useCutRoom.getState().setCropDraft({ x: 0, y: 0, w: 1, h: 1 })}
              className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
              title={t('裁剪框恢复到整幅画面')}
            >
              
              {t('铺满')}
            </button>
            <button
              onClick={() => useCutRoom.getState().cancelCrop()}
              className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              
              {t('取消 (Esc)')}
            </button>
          </>
        ) : (
          <>
            <ToolButton
              label={t('裁剪')}
              active={!isFullCrop(cropOf(clip))}
              onClick={() => useCutRoom.getState().beginCrop(clip.id)}
            >
              <path d="M6 2v14h14M2 6h14v14" />
            </ToolButton>
            <ToolButton
              label={clip.fit === 'cover' ? t('铺满画框（点击改为完整留黑）') : t('完整留黑（点击改为铺满画框）')}
              active={clip.fit === 'cover'}
              onClick={() => update({ fit: clip.fit === 'cover' ? 'contain' : 'cover' })}
            >
              <path d="M3 8V5h3M18 5h3v3M21 16v3h-3M6 19H3v-3M8 12h8" />
            </ToolButton>
            <div className="relative">
              <ToolButton label={t('更多')} active={menuOpen} onClick={() => setMenuOpen((on) => !on)}>
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </ToolButton>
              {menuOpen && (
                <div
                  className="absolute left-1/2 top-full z-50 mt-1 w-[150px] -translate-x-1/2 rounded-lg border border-white/10 bg-[#1b1b23] p-1 shadow-2xl"
                  onPointerLeave={() => {
                    setFlipOpen(false);
                    setMenuOpen(false);
                  }}
                >
                  <MenuItem
                    onClick={() => {
                      update({ rotate: (((clip.rotate ?? 0) + 90) % 360) as 0 | 90 | 180 | 270 });
                      setMenuOpen(false);
                    }}
                  >
                    
                    {t('旋转 90°')}
                  </MenuItem>
                  <div className="relative" onPointerEnter={() => setFlipOpen(true)}>
                    <MenuItem onClick={() => setFlipOpen((on) => !on)}>
                      <span className="flex items-center justify-between">
                        
                        {t('翻转')}<span className="text-zinc-600">›</span>
                      </span>
                    </MenuItem>
                    {flipOpen && (
                      <div className="absolute left-full top-0 ml-1 w-[112px] rounded-lg border border-white/10 bg-[#1b1b23] p-1 shadow-2xl">
                        <MenuItem
                          active={clip.flipH}
                          onClick={() => {
                            update({ flipH: !clip.flipH });
                            setMenuOpen(false);
                          }}
                        >
                          
                          {t('水平翻转')}
                        </MenuItem>
                        <MenuItem
                          active={clip.flipV}
                          onClick={() => {
                            update({ flipV: !clip.flipV });
                            setMenuOpen(false);
                          }}
                        >
                          
                          {t('垂直翻转')}
                        </MenuItem>
                      </div>
                    )}
                  </div>
                  <MenuItem
                    disabled={!reshaped}
                    onClick={() => {
                      update({
                        crop: undefined,
                        rotate: 0,
                        flipH: false,
                        flipV: false,
                        fit: 'contain',
                        zoom: 1,
                        offsetX: 0,
                        offsetY: 0,
                      });
                      setMenuOpen(false);
                    }}
                  >
                    
                    {t('重置画面调整')}
                  </MenuItem>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}

/** One dimmed band outside the crop. Collapses to nothing at a picture edge. */
function Shade({ box }: { box: Box }) {
  if (box.width <= 0 || box.height <= 0) return null;
  return <div className="pointer-events-none absolute bg-black/55" style={box} />;
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  /** The icon's paths; the frame around them is shared. */
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded p-1.5 transition-colors ${
        active ? 'bg-violet-500/25 text-violet-200' : 'text-zinc-300 hover:bg-white/10'
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`block w-full rounded px-2 py-1.5 text-left text-[11px] transition-colors disabled:opacity-40 ${
        active ? 'bg-violet-500/20 text-violet-200' : 'text-zinc-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}
