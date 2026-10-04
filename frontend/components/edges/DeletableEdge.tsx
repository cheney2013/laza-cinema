import React, { useState, useRef, useCallback, useEffect } from 'react';
import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath, useReactFlow, type Node } from '@xyflow/react';
import { nodePreview } from '@/lib/nodePreview';
import { useCanvasNav } from '@/lib/canvasNav';
import { t } from '@/lib/i18n';

/** One end of a hovered edge whose node is outside the visible canvas. */
interface OffscreenEnd {
  role: 'source' | 'target';
  node: Node;
}

function DeletableEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
}: EdgeProps) {
  const { setEdges, screenToFlowPosition, getInternalNode, getViewport, setCenter } = useReactFlow();
  const [isHovered, setIsHovered] = useState(false);
  const [offscreen, setOffscreen] = useState<OffscreenEnd[]>([]);
  const [zoom, setZoom] = useState(1);
  const [mousePos, setMousePos] = useState({ 
    x: (sourceX + targetX) / 2, 
    y: (sourceY + targetY) / 2 
  });
  // The wrapper <g> is what we own; the visible path inside it is the one
  // BaseEdge draws. Reading it through the group avoids a third <path> per
  // edge: BaseEdge already renders its own 20px-wide interaction path, and the
  // duplicate 30px one we used to add doubled the hit-test geometry on a
  // 100-edge canvas.
  const groupRef = useRef<SVGGElement>(null);
  // Leaving the line for the card above it must not close the card on the way.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    // Zoomed out (outline mode) only the lit edges -- wired to the selection --
    // offer the delete button; a pass over the rest of the tangle must not.
    const edgeEl = groupRef.current?.closest('.react-flow__edge');
    if (edgeEl?.closest('.canvas-lod') && !edgeEl.classList.contains('edge-highlight-connected')) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setIsHovered(true);
  }, []);
  const hideSoon = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIsHovered(false), 250);
  }, []);
  const hideNow = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setIsHovered(false);
  }, []);
  // No delete button while anything is being dragged (a pan, a node, a wire):
  // it popped up under the moving pointer and looked like a threat (Yige, 2026-09-23).
  useEffect(() => {
    if (!isHovered) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element)?.closest?.('.edge-delete-btn, .edge-offscreen-preview')) hideNow();
    };
    // A wheel zoom moves the edge out from under a still pointer, which then never
    // sends mouseleave: the button stayed behind on empty canvas.
    const onWheel = () => hideNow();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [isHovered, hideNow]);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  /**
   * Which ends of this edge sit outside the canvas viewport, read once when the
   * pointer arrives. Done on hover rather than subscribed to the viewport, so
   * panning never re-renders every edge.
   */
  const findOffscreenEnds = useCallback(() => {
    // Only the amber edges (wired to the selection) point somewhere worth previewing.
    if (!groupRef.current?.closest('.react-flow__edge')?.classList.contains('edge-highlight-connected')) {
      setOffscreen([]);
      return;
    }
    const pane = groupRef.current?.closest('.react-flow')?.getBoundingClientRect();
    if (!pane) return;
    const vp = getViewport();
    setZoom(vp.zoom);
    const ends: OffscreenEnd[] = [];
    for (const [role, nodeId] of [['source', source], ['target', target]] as const) {
      const internal = getInternalNode(nodeId);
      if (!internal) continue;
      const pos = internal.internals.positionAbsolute;
      const w = internal.measured?.width ?? internal.width ?? 0;
      const h = internal.measured?.height ?? internal.height ?? 0;
      const left = pos.x * vp.zoom + vp.x;
      const top = pos.y * vp.zoom + vp.y;
      // Off screen = less than a quarter of the node's box is in view.
      const visibleW = Math.max(0, Math.min(left + w * vp.zoom, pane.width) - Math.max(left, 0));
      const visibleH = Math.max(0, Math.min(top + h * vp.zoom, pane.height) - Math.max(top, 0));
      const area = w * h * vp.zoom * vp.zoom;
      if (!area || (visibleW * visibleH) / area < 0.25) ends.push({ role, node: internal.internals.userNode });
    }
    setOffscreen(ends);
  }, [getInternalNode, getViewport, source, target]);

  /** Fly to the node at the far end of this edge, remembering where we were so "back" works. */
  const jumpTo = useCallback((node: Node) => {
    const internal = getInternalNode(node.id);
    if (!internal) return;
    const vp = getViewport();
    useCanvasNav.getState().remember(vp);
    const pos = internal.internals.positionAbsolute;
    const w = internal.measured?.width ?? internal.width ?? 0;
    const h = internal.measured?.height ?? internal.height ?? 0;
    void setCenter(pos.x + w / 2, pos.y + h / 2, { zoom: Math.max(vp.zoom, 0.6), duration: 400 });
    hideNow();
  }, [getInternalNode, getViewport, setCenter, hideNow]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // A button held down means a drag is passing over the edge: no delete button.
    if (e.buttons !== 0) { hideNow(); return; }
    const pathNode = groupRef.current?.querySelector<SVGPathElement>('.react-flow__edge-path');
    if (!pathNode) return;
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    const pathLength = pathNode.getTotalLength();
    let best = pathNode.getPointAtLength(0);
    let bestLength = 0;
    let bestDistance = Infinity;

    for (let scanLength = 0; scanLength <= pathLength; scanLength += 20) {
      const scan = pathNode.getPointAtLength(scanLength);
      const dist = Math.hypot(scan.x - flowPos.x, scan.y - flowPos.y);
      if (dist < bestDistance) {
        best = scan;
        bestLength = scanLength;
        bestDistance = dist;
      }
    }

    let precision = 10;
    while (precision > 0.5) {
      const beforeLength = Math.max(0, bestLength - precision);
      const before = pathNode.getPointAtLength(beforeLength);
      const beforeDist = Math.hypot(before.x - flowPos.x, before.y - flowPos.y);

      const afterLength = Math.min(pathLength, bestLength + precision);
      const after = pathNode.getPointAtLength(afterLength);
      const afterDist = Math.hypot(after.x - flowPos.x, after.y - flowPos.y);

      if (beforeDist < bestDistance) {
        best = before;
        bestLength = beforeLength;
        bestDistance = beforeDist;
      } else if (afterDist < bestDistance) {
        best = after;
        bestLength = afterLength;
        bestDistance = afterDist;
      } else {
        precision /= 2;
      }
    }

    setMousePos({ x: best.x, y: best.y });
  }, [screenToFlowPosition, hideNow]);

  return (
    <>
      {/* Hover colour is CSS (`.react-flow__edge:hover`), so the only React
          state left is whether the delete button is shown. */}
      <g
        ref={groupRef}
        style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => {
          if (e.buttons !== 0) return;
          show();
          findOffscreenEnds();
          handleMouseMove(e);
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={hideSoon}
      >
        <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} interactionWidth={30} />
        {/* Shown only on a highlighted (amber) edge, by CSS; drawn only while hovered. */}
        {isHovered && (
          <g className="edge-hover-pulse" pointerEvents="none">
            {/* pathLength=100 makes the dash sizes a share of the line, so a short and a long edge pulse alike. */}
            <path d={edgePath} pathLength={100} fill="none" className="edge-pulse-bed" />
            <path d={edgePath} pathLength={100} fill="none" className="edge-pulse-halo" />
            <path d={edgePath} pathLength={100} fill="none" className="edge-pulse-core" />
          </g>
        )}
      </g>

      {isHovered && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(${mousePos.x}px, ${mousePos.y}px) translate(-50%, -50%)`,
              pointerEvents: 'all',
            }}
            className="z-50"
            onMouseEnter={show}
            onMouseLeave={hideSoon}
          >
            {offscreen.length > 0 && (
              // The padding is a bridge: the pointer crosses it on its way from the line to
              // the card, and the card stays open the whole way.
              <div
                className="edge-offscreen-preview absolute bottom-3 left-1/2 flex gap-3 pb-3"
                // Screen-sized whatever the zoom: the label layer scales with the canvas.
                style={{ transform: `translateX(-50%) scale(${1 / zoom})`, transformOrigin: 'bottom center' }}
              >
                {offscreen.map(({ role, node }) => {
                  const preview = nodePreview(node.data, node.type);
                  return (
                    <button
                      type="button"
                      key={role}
                      onClick={(e) => {
                        e.stopPropagation();
                        jumpTo(node);
                      }}
                      className="w-80 cursor-pointer overflow-hidden rounded-xl border border-amber-300/60 bg-[#14141c]/95 text-left shadow-2xl transition-colors hover:border-amber-200 hover:bg-[#1b1b26]"
                      title={t('点击跳到这个节点（上方按钮可返回）')}
                    >
                      {preview.image ? (
                        <img src={preview.image} alt="" className="block aspect-video w-full bg-black object-contain" draggable={false} />
                      ) : null}
                      <div className="px-2.5 py-1.5">
                        <div className="flex items-center justify-between text-[11px] font-medium text-amber-200">
                          <span>{role === 'source' ? t('← 来自') : t('→ 连到')}</span>
                          <span className="text-amber-200/70">{t('点击跳转 ↗')}</span>
                        </div>
                        {preview.text && <div className="line-clamp-2 text-xs leading-snug text-zinc-300">{preview.text}</div>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="edge-delete-btn w-5 h-5 bg-[#14141c] hover:bg-red-600 text-zinc-300 hover:text-white rounded-full flex items-center justify-center transition-all hover:scale-110 shadow-xl cursor-pointer border border-white/20 text-[9px] font-bold select-none"
              onPointerDown={(e) => {
                pointerDownPos.current = { x: e.clientX, y: e.clientY };
              }}
              onClick={(e) => {
                e.stopPropagation();
                // If user dragged (moved more than 3px), treat it as a canvas pan gesture, not a click to delete
                if (pointerDownPos.current) {
                  const dx = e.clientX - pointerDownPos.current.x;
                  const dy = e.clientY - pointerDownPos.current.y;
                  if (dx * dx + dy * dy > 9) {
                    return;
                  }
                }
                setEdges((edges) => edges.filter((edge) => edge.id !== id));
              }}
              title={t('删除连线')}
            >
              ✕
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// xyflow's EdgeWrapper is not memoised, so without this every edge re-rendered
// whenever the edges array changed identity -- measured 2026-09-16: one
// selection click re-ran all 43 visible edges on a large canvas. The props are
// primitives plus the shared `style` object, so the shallow compare holds.
export default React.memo(DeletableEdge);
