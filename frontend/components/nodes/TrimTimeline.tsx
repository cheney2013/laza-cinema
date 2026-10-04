'use client';

import { useRef, useState } from 'react';

import { gridEnds, latentCut, snapEnd } from '@/lib/trimGrid';
import { t } from '@/lib/i18n';

interface Props {
  totalFrames: number;
  /** First frame kept. */
  start: number;
  /** Frame the cut stops at, not kept. */
  end: number;
  /** Chain context frames at the head of the source's latent (0 for an unchained clip). */
  contextFrames: number;
  /** The source clip has a latent to cut. */
  hasLatent: boolean;
  /** Frame the player is on, in the source clip. */
  playFrame: number | null;
  onChange: (next: { start?: number; end?: number }) => void;
  onSeek: (frame: number) => void;
}

const AMBER = '#fbbf24';
const GREEN = '#34d399';

/**
 * Start / end handles on a strip of the source clip, with the cut points that keep the
 * latent marked as tall amber ticks (17n+5 frames, counted from the head of the latent).
 * The end handle snaps to them; hold Alt to cut on any frame.
 */
export default function TrimTimeline({ totalFrames, start, end, contextFrames, hasLatent, playFrame, onChange, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<'start' | 'end' | null>(null);
  const ends = gridEnds(totalFrames, contextFrames);
  const cut = latentCut({ start, end, totalFrames, contextFrames, hasLatent });
  const pct = (frame: number) => `${(Math.max(0, Math.min(totalFrames, frame)) / Math.max(1, totalFrames)) * 100}%`;
  const snapThreshold = Math.max(2, Math.round(totalFrames * 0.02));

  const frameAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.round(((clientX - rect.left) / rect.width) * totalFrames);
  };

  const startDrag = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(which);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const raw = frameAt(e.clientX);
    if (drag === 'end') {
      let next = Math.max(start + 1, Math.min(totalFrames, raw));
      if (!e.altKey) next = Math.max(start + 1, Math.min(totalFrames, snapEnd(next, ends, snapThreshold)));
      if (next !== end) onChange({ end: next });
    } else {
      let next = Math.max(0, Math.min(end - 1, raw));
      if (!e.altKey && next <= snapThreshold) next = 0;
      if (next !== start) onChange({ start: next });
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag) (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDrag(null);
  };

  const handle = (which: 'start' | 'end', frame: number, color: string) => (
    <div
      className="nodrag nopan"
      onPointerDown={startDrag(which)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title={which === 'start' ? t('起点：拖动调整（Alt 不吸附）') : t('终点：拖动调整，会吸附到琥珀色刻度（Alt 不吸附）')}
      style={{
        position: 'absolute', top: -4, bottom: -4, left: pct(frame), width: 14, marginLeft: which === 'start' ? -2 : -12,
        cursor: 'ew-resize', touchAction: 'none', zIndex: 3, display: 'flex', justifyContent: which === 'start' ? 'flex-start' : 'flex-end',
      }}
    >
      <div style={{
        width: 6, height: '100%', background: color, borderRadius: which === 'start' ? '3px 0 0 3px' : '0 3px 3px 0',
        boxShadow: drag === which ? `0 0 0 2px ${color}55` : 'none',
      }} />
      {drag === which && (
        <div style={{
          position: 'absolute', bottom: '100%', [which === 'start' ? 'left' : 'right']: 0, marginBottom: 2, padding: '1px 5px',
          borderRadius: 4, background: '#000c', color, fontSize: 10, fontFamily: 'monospace', whiteSpace: 'nowrap',
        }}>{frame}</div>
      )}
    </div>
  );

  // Label every grid tick when there is room, else every other one.
  const labelEvery = ends.length > 9 ? 2 : 1;
  const endColor = cut.ok ? GREEN : '#e5e7eb';

  return (
    <div className="nodrag nopan" style={{ display: 'flex', flexDirection: 'column', gap: 3, userSelect: 'none' }}>
      {/* numbers over the grid ticks */}
      <div style={{ position: 'relative', height: 12 }}>
        {ends.map((e, i) => (i % labelEvery === labelEvery - 1 || e === end) && (
          <span key={e} style={{
            position: 'absolute', left: pct(e), transform: 'translateX(-50%)', fontSize: 9, fontFamily: 'monospace',
            color: e === end && cut.ok ? GREEN : AMBER, opacity: e === end ? 1 : 0.8, fontWeight: e === end ? 700 : 500,
          }}>{e}</span>
        ))}
      </div>
      <div
        ref={trackRef}
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.bar) onSeek(Math.max(0, Math.min(totalFrames - 1, frameAt(e.clientX)))); }}
        style={{ position: 'relative', height: 30, background: 'rgba(255,255,255,0.07)', borderRadius: 4, cursor: 'pointer', margin: '0 7px' }}
      >
        {/* second ticks */}
        {Array.from({ length: Math.floor(totalFrames / 24) + 1 }, (_, i) => (
          <div key={`s${i}`} data-bar="1" style={{ position: 'absolute', left: pct(i * 24), top: 20, bottom: 0, width: 1, background: 'rgba(255,255,255,0.22)' }} />
        ))}
        {/* kept range */}
        <div data-bar="1" style={{
          position: 'absolute', left: pct(start), width: `${((end - start) / Math.max(1, totalFrames)) * 100}%`, top: 0, bottom: 0,
          background: cut.ok ? 'rgba(52,211,153,0.20)' : 'rgba(255,255,255,0.16)', borderRadius: 3,
        }} />
        {/* the cut points that keep the latent */}
        {ends.map((e) => (
          <div key={`g${e}`} data-bar="1" style={{
            position: 'absolute', left: pct(e), top: 0, bottom: 0, width: e === end && cut.ok ? 3 : 2, marginLeft: -1,
            background: e === end && cut.ok ? GREEN : AMBER, opacity: e === end ? 1 : 0.85,
          }} />
        ))}
        {playFrame !== null && (
          <div data-bar="1" style={{ position: 'absolute', left: pct(playFrame), top: -3, bottom: -3, width: 2, background: '#f87171', zIndex: 2, pointerEvents: 'none' }} />
        )}
        {handle('start', start, '#e5e7eb')}
        {handle('end', end, endColor)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#aaa', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace' }}>{t('保留 {v1} 帧', { v1: end - start })}</span>
        <span
          title={
            cut.ok ? t('这个终点落在 17n+5 的格子上：剪出来的片同时有切过的潜变量，后面的镜头可以直接用潜变量接')
              : cut.reason === 'no-latent' ? t('原片没有潜变量，剪出来只有画面')
              : cut.reason === 'start' ? t('起点不在片头，潜变量只能从片头切')
              : t('终点不在 17n+5 的格子上（琥珀色刻度），剪出来只有画面，后面的镜头会重新编码画面')
          }
          style={{
            padding: '1px 6px', borderRadius: 999, fontWeight: 600,
            background: cut.ok ? 'rgba(52,211,153,0.18)' : 'rgba(255,255,255,0.08)', color: cut.ok ? GREEN : '#9ca3af',
            border: `1px solid ${cut.ok ? 'rgba(52,211,153,0.5)' : 'rgba(255,255,255,0.12)'}`,
          }}
        >
          {cut.ok ? t('潜变量 ✓') : t('仅画面')}
        </span>
        {hasLatent && cut.reason === 'grid' && (
          <>
            {cut.before !== null && (
              <button type="button" className="nodrag" onClick={() => onChange({ end: cut.before! })}
                style={{ background: 'none', border: `1px solid ${AMBER}66`, color: AMBER, borderRadius: 4, fontSize: 10, padding: '0 5px', cursor: 'pointer' }}>
                ← {cut.before}
              </button>
            )}
            {cut.after !== null && (
              <button type="button" className="nodrag" onClick={() => onChange({ end: cut.after! })}
                style={{ background: 'none', border: `1px solid ${AMBER}66`, color: AMBER, borderRadius: 4, fontSize: 10, padding: '0 5px', cursor: 'pointer' }}>
                {cut.after} →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
