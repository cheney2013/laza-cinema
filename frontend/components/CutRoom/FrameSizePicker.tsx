'use client';

import React, { useEffect, useRef, useState } from 'react';

import { useCutRoom } from '@/lib/editor/store';
import { FRAME_QUALITIES, FRAME_RATIOS, describeRatio, firstFrameSize, frameSizeFor } from '@/lib/editor/types';
import { t } from '@/lib/i18n';

/**
 * The finished film's frame.
 *
 * Shape and quality are separate decisions and are offered separately: picking
 * 9:16 should not also decide whether that is 720p or 4K, and raising the
 * quality should not straighten out a widescreen cut. Both write through one
 * store action, so the monitor reshapes the moment either is touched — nothing
 * about the clips changes, only the frame they are composited into.
 */
export default function FrameSizePicker() {
  const width = useCutRoom((s) => s.timeline.width);
  const height = useCutRoom((s) => s.timeline.height);
  const manual = useCutRoom((s) => Boolean(s.timeline.frameSizeManual));
  const firstW = useCutRoom((s) => firstFrameSize(s.timeline)?.width ?? 0);
  const firstH = useCutRoom((s) => firstFrameSize(s.timeline)?.height ?? 0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The quality this frame is already at, so reopening the panel shows where
  // the cut stands rather than a default. It is the short side by definition.
  const currentQuality = Math.min(width, height);
  const currentRatio = height > 0 ? width / height : 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture: the cut room stops a lot of events on their way up, and a panel
    // that will not close is worse than one that never opened.
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const apply = (ratio: number, quality: number) => {
    const size = frameSizeFor(ratio, quality);
    useCutRoom.getState().setFrameSize(size.width, size.height);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((on) => !on)}
        className={`rounded border px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors ${
          open
            ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
            : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
        }`}
        title={t('调整影片尺寸：画面比例与分辨率')}
      >
        {width}×{height} · {describeRatio(width, height)}
        {manual && firstW > 0 && (firstW !== width || firstH !== height) && (
          <span className="ml-1 text-zinc-600">{t('（首帧 {v1}×{v2}）', { v1: firstW, v2: firstH })}</span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[268px] rounded-lg border border-white/10 bg-[#15151c] p-3 shadow-2xl">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{t('首帧素材')}</p>
          <button
            disabled={!firstW}
            onClick={() => useCutRoom.getState().followFirstFrame()}
            className={`mb-3 flex w-full items-center justify-between rounded border px-2 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-40 ${
              !manual && firstW
                ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08]'
            }`}
            title={t('影片尺寸跟随时间线第一个画面的原始分辨率')}
          >
            <span>{firstW ? `${firstW}×${firstH} · ${describeRatio(firstW, firstH)}` : t('还没有画面素材')}</span>
            <span className="font-sans">{!manual && firstW ? t('跟随中') : t('跟随首帧')}</span>
          </button>

          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{t('画面比例')}</p>
          <div className="grid grid-cols-3 gap-1">
            {FRAME_RATIOS.map((option) => {
              const active = Math.abs(option.ratio - currentRatio) < 0.01;
              return (
                <button
                  key={option.label}
                  onClick={() => apply(option.ratio, currentQuality)}
                  className={`flex flex-col items-center gap-1 rounded border px-1 py-1.5 transition-colors ${
                    active
                      ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200'
                      : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08]'
                  }`}
                  title={t(option.note)}
                >
                  {/* The shape itself, drawn at the ratio it stands for — far
                      quicker to pick out than the numbers underneath. */}
                  <span
                    className={`block rounded-[2px] border ${active ? 'border-emerald-300' : 'border-zinc-500'}`}
                    style={{
                      width: option.ratio >= 1 ? 26 : 26 * option.ratio,
                      height: option.ratio >= 1 ? 26 / option.ratio : 26,
                    }}
                  />
                  <span className="font-mono text-[10px]">{option.label}</span>
                </button>
              );
            })}
          </div>

          <p className="mb-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            
            {t('分辨率')}<span className="ml-1 normal-case tracking-normal text-zinc-600">{t('（短边）')}</span>
          </p>
          <div className="flex gap-1">
            {FRAME_QUALITIES.map((quality) => (
              <button
                key={quality}
                onClick={() => apply(currentRatio, quality)}
                className={`flex-1 rounded border px-1 py-1 font-mono text-[10px] transition-colors ${
                  currentQuality === quality
                    ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200'
                    : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08]'
                }`}
              >
                {quality}p
              </button>
            ))}
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-zinc-600">
            
            {t('换比例不动任何片段的时长和位置。画不满新画框的镜头默认留黑边，想让它铺满就在右侧属性面板里改成「裁切填满」。')}
          </p>
        </div>
      )}
    </div>
  );
}
