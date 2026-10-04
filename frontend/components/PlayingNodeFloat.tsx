'use client';

import { useEffect, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { t } from '@/lib/i18n';

/**
 * A floating mini-player for the node whose video is playing once that node has
 * scrolled out of view. Clicking it flies the canvas back to the node.
 *
 * Node video players are scattered over a dozen node types, so this does not
 * hook into any of them: it listens for play/pause on every <video> inside a
 * `.react-flow__node` at the document level. The node's own video keeps playing
 * and carries the sound; the float is a muted copy kept in step with it.
 */
export default function PlayingNodeFloat() {
  const { getNode, setCenter, getViewport, setNodes } = useReactFlow();
  const [source, setSource] = useState<{ nodeId: string; video: HTMLVideoElement } | null>(null);
  const [offscreen, setOffscreen] = useState(false);
  const floatRef = useRef<HTMLVideoElement>(null);
  const transform = useStore((s) => s.transform);
  const domNode = useStore((s) => s.domNode);

  useEffect(() => {
    const nodeOf = (target: EventTarget | null) => {
      if (!(target instanceof HTMLVideoElement)) return null;
      const el = target.closest('.react-flow__node');
      const id = el?.getAttribute('data-id');
      return id ? { nodeId: id, video: target } : null;
    };
    const onPlay = (e: Event) => {
      const hit = nodeOf(e.target);
      if (hit) setSource(hit);
    };
    const onStop = (e: Event) => {
      setSource((cur) => (cur && cur.video === e.target ? null : cur));
    };
    document.addEventListener('play', onPlay, true);
    document.addEventListener('pause', onStop, true);
    document.addEventListener('ended', onStop, true);
    document.addEventListener('emptied', onStop, true);
    return () => {
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('pause', onStop, true);
      document.removeEventListener('ended', onStop, true);
      document.removeEventListener('emptied', onStop, true);
    };
  }, []);

  // Visibility of the node against the canvas pane, re-checked on every pan/zoom.
  useEffect(() => {
    if (!source) { setOffscreen(false); return; }
    if (!source.video.isConnected) { setSource(null); return; }
    const node = getNode(source.nodeId);
    const pane = domNode?.getBoundingClientRect();
    if (!node || !pane) return;
    const [tx, ty, zoom] = transform;
    const w = node.measured?.width ?? node.width ?? 0;
    const h = node.measured?.height ?? node.height ?? 0;
    const pos = (node as { internals?: { positionAbsolute?: { x: number; y: number } } })
      .internals?.positionAbsolute ?? node.position;
    const left = pos.x * zoom + tx;
    const top = pos.y * zoom + ty;
    const right = left + w * zoom;
    const bottom = top + h * zoom;
    setOffscreen(right < 0 || bottom < 0 || left > pane.width || top > pane.height);
  }, [source, transform, domNode, getNode]);

  // Keep the muted copy on the source's clock.
  useEffect(() => {
    const float = floatRef.current;
    if (!source || !offscreen || !float) return;
    const sync = () => {
      if (Math.abs(float.currentTime - source.video.currentTime) > 0.25) {
        float.currentTime = source.video.currentTime;
      }
      if (float.paused) void float.play().catch(() => {});
    };
    sync();
    const timer = window.setInterval(sync, 500);
    return () => window.clearInterval(timer);
  }, [source, offscreen]);

  if (!source || !offscreen) return null;

  const node = getNode(source.nodeId);
  const label = (node?.data as { label?: string } | undefined)?.label || source.nodeId;

  const locate = () => {
    if (!node) return;
    const w = node.measured?.width ?? node.width ?? 0;
    const h = node.measured?.height ?? node.height ?? 0;
    setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      zoom: Math.max(getViewport().zoom, 0.6),
      duration: 300,
    });
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
  };

  return (
    <div
      className="absolute bottom-[176px] right-4 z-50 w-[280px] cursor-pointer overflow-hidden rounded-xl border border-white/15 bg-black/80 shadow-2xl backdrop-blur hover:border-white/40"
      onClick={locate}
      title={t('点击定位到节点')}
    >
      <video
        ref={floatRef}
        src={source.video.currentSrc || source.video.src}
        // Outside the one-thing-plays rule (useSingleAudioCoordinator): starting
        // this copy must not pause the node it mirrors.
        data-media-ambient=""
        muted
        playsInline
        className="block w-full"
      />
      <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-white/80">
        <span className="truncate flex-1">{label}</span>
        <button
          type="button"
          className="text-white/60 hover:text-white"
          title={t('暂停')}
          onClick={(e) => { e.stopPropagation(); source.video.pause(); }}
        >
          ❚❚
        </button>
      </div>
    </div>
  );
}
