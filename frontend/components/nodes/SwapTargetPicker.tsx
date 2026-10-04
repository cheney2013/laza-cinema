'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { MAX_SWAP_TARGETS } from '@/lib/charswapRequest';

export interface SwapPoint {
  x: number;
  y: number;
}

/** A click this close to a marker (in fractions of the frame's width) takes the marker away instead of adding one. */
const HIT = 0.035;

interface Props {
  videoSrc: string;
  /** The wired-in photos, in order: point i is replaced with photo i. */
  photoSrcs: string[];
  seconds: number | undefined;
  points: SwapPoint[];
  disabled?: boolean;
  onSeconds: (seconds: number) => void;
  onPoints: (points: SwapPoint[]) => void;
}

/**
 * Point at the people of a clip to replace. The clip's own <video> is paused at the chosen second and
 * serves as the picture (no extra file, no canvas); a click puts a numbered marker on it, in fractions of
 * the frame, which the server turns into "the person on the left, in a grey hoodie". The points mean
 * something only on the frame they were made on, so moving the frame clears them.
 */
export default function SwapTargetPicker({ videoSrc, photoSrcs, seconds, points, disabled, onSeconds, onPoints }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const at = typeof seconds === 'number' ? seconds : 0;
  const limit = Math.min(MAX_SWAP_TARGETS, photoSrcs.length);

  // Keep the paused video on the chosen second.
  useEffect(() => {
    const video = videoRef.current;
    if (video && Math.abs(video.currentTime - at) > 0.01) video.currentTime = at;
  }, [at, videoSrc]);

  const click = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const hit = points.findIndex((p) => Math.hypot(p.x - x, (p.y - y) * (rect.height / rect.width)) < HIT);
    if (hit >= 0) {
      onPoints(points.filter((_, i) => i !== hit));
      return;
    }
    if (points.length >= limit) return;
    if (typeof seconds !== 'number') onSeconds(at);   // the points pin the frame they were made on
    onPoints([...points, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }]);
  }, [disabled, points, limit, seconds, at, onSeconds, onPoints]);

  return (
    <div className="nodrag nowheel flex w-full basis-full flex-col gap-1">
      <div
        className="relative w-full cursor-crosshair overflow-hidden rounded border border-white/10 bg-black"
        onClick={click}
        title={t('点要换的人。第 N 个点对应接入的第 N 张参考图；再点一次同一个点就取消它')}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={videoSrc}
          muted
          preload="auto"
          playsInline
          className="pointer-events-none block w-full"
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            e.currentTarget.currentTime = at;
          }}
        />
        {points.map((p, i) => (
          <span
            key={i}
            className="pointer-events-none absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-teal-500 text-[9px] font-semibold text-white shadow"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-zinc-400">
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(at, duration || at)}
          disabled={disabled || duration <= 0}
          onChange={(e) => {
            onSeconds(Number(e.target.value));
            if (points.length) onPoints([]);
          }}
          className="min-w-0 flex-1"
          title={t('换到哪一帧上点人（点只在这一帧上有意义，换帧会清掉点）')}
        />
        <span className="w-9 text-right font-mono">{at.toFixed(1)}s</span>
        {points.length > 0 && (
          <button type="button" disabled={disabled} onClick={() => onPoints([])}
                  className="rounded border border-white/10 px-1 py-0.5 hover:text-zinc-200">
            {t('清除')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-zinc-400">
        {photoSrcs.slice(0, MAX_SWAP_TARGETS).map((src, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white ${
              i < points.length ? 'bg-teal-500' : 'bg-zinc-600'}`}>{i + 1}</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="h-6 rounded border border-white/10" />
          </span>
        ))}
        <span className="ml-auto text-[9px] text-zinc-500">
          {points.length === 0
            ? t('在帧上点要换的人；没点到的人保持原样')
            : points.length < photoSrcs.length
              ? t('还有参考图没有对应的点，它们不会用到')
              : t('每个点对应一张参考图')}
        </span>
      </div>
    </div>
  );
}
