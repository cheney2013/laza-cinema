'use client';

import React, { useEffect, useRef, useState } from 'react';

import { useCutRoom } from '@/lib/editor/store';
import { type SubtitleStyle, subtitleStyleOf } from '@/lib/editor/types';
import { t } from '@/lib/i18n';

import { Slider, chip } from './Inspector';

/**
 * The one look every subtitle of this film shares.
 *
 * It sits in the film's header next to the frame size, not in a clip's
 * properties: a change here lands on every subtitle of the film on screen, and
 * a control inside one clip's panel reads as if it touched that clip alone.
 * Other films (tabs) keep their own look.
 */
export default function SubtitleStylePicker() {
  const height = useCutRoom((s) => s.timeline.height);
  const stored = useCutRoom((s) => s.timeline.subtitleStyle);
  const style = stored ?? subtitleStyleOf({ ...useCutRoom.getState().timeline, height });
  const count = useCutRoom((s) => s.timeline.clips.filter((c) => c.text).length);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The subtitle's own panel has a button that points here.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('openSubtitleStyle', show);
    return () => window.removeEventListener('openSubtitleStyle', show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const apply = (patch: Partial<SubtitleStyle>) => useCutRoom.getState().setSubtitleStyle(patch);
  const snapshot = () => useCutRoom.getState().commit();

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((on) => !on)}
        className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
          open
            ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
            : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
        }`}
        title={t('本影片所有字幕共用的样式')}
      >
        {t('字幕样式')}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 flex w-[248px] flex-col gap-1.5 rounded-lg border border-white/10 bg-[#15151c] p-3 shadow-2xl">
          <p className="text-[10px] leading-relaxed text-zinc-500">
            {t('对本影片的全部 {v1} 条字幕生效，其他影片标签各有自己的样式。', { v1: count })}
          </p>
          <div className="flex gap-1">
            {(['left', 'center', 'right'] as const).map((align) => (
              <button key={align} onClick={() => { snapshot(); apply({ align }); }} className={chip(style.align === align)}>
                {align === 'left' ? t('左') : align === 'center' ? t('中') : t('右')}
              </button>
            ))}
          </div>
          <Slider label={t('字号')} min={16} max={Math.round(height / 4)} step={2} value={style.size}
            onChange={(size) => apply({ size })} />
          <Slider label={t('描边')} min={0} max={24} step={1} value={style.strokeWidth}
            onChange={(strokeWidth) => apply({ strokeWidth })} />
          <Slider label={t('水平')} min={0} max={1} step={0.01} value={style.x}
            onChange={(x) => apply({ x })} />
          <Slider label={t('垂直')} min={0} max={1} step={0.01} value={style.y}
            onChange={(y) => apply({ y })} />
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            {t('颜色')}
            <span className="flex gap-1">
              <input type="color" value={style.color}
                onPointerDown={snapshot}
                onChange={(e) => apply({ color: e.target.value })}
                className="h-6 w-8 rounded border border-white/10 bg-transparent" />
              <input type="color" value={style.strokeColor}
                onPointerDown={snapshot}
                onChange={(e) => apply({ strokeColor: e.target.value })}
                className="h-6 w-8 rounded border border-white/10 bg-transparent" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
