'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { posterUrl } from '@/lib/config';
import { t } from '@/lib/i18n';
import { NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';

const FPS = 24;

/** A span of the source clip, in frames, drawn on the bar with its own meaning. */
export interface RangeZone {
  start: number;
  end: number;
  kind: 'keep' | 'regen' | 'context';
  label: string;
}

export interface SegmentRangePickerProps {
  /** Absolute URL of the clip being repaired. */
  sourceUrl: string;
  startSeconds: number;
  durationSeconds: number;
  onChange: (startSeconds: number, durationSeconds: number) => void;
  /** Duration of the source, reported once its metadata is in. */
  onSourceDuration?: (seconds: number) => void;
  /**
   * What will actually happen to each part of the clip, in source frames: the
   * frozen or context runs around the window and the frames that get regenerated.
   * Drawn over the selection so the grid-snapped result is visible before rendering.
   */
  zones?: RangeZone[];
  /** One line under the bar: the resolved plan, or why the window does not fit. */
  status?: { text: string; tone: 'info' | 'error' | 'pending' };
}

const snap = (seconds: number) => Math.round(seconds * FPS) / FPS;
const fmt = (seconds: number) => {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

/** Grab one frame of a video at `time` as a data URL (source must allow CORS). */
function useFrameAt(src: string, time: number | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (time == null || !src) return;
    let live = true;
    const timer = setTimeout(() => {
      const v = videoRef.current ?? document.createElement('video');
      videoRef.current = v;
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'auto';
      if (v.src !== src) v.src = src;
      const draw = () => {
        if (!live || !v.videoWidth) return;
        const canvas = document.createElement('canvas');
        const w = 160;
        canvas.width = w;
        canvas.height = Math.round((w * v.videoHeight) / v.videoWidth);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        try {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          setUrl(canvas.toDataURL('image/jpeg', 0.7));
        } catch {
          setUrl(null);
        }
      };
      const seek = () => {
        v.addEventListener('seeked', draw, { once: true });
        v.currentTime = Math.min(Math.max(0, time), Math.max(0, (v.duration || time) - 1 / FPS));
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener('loadedmetadata', seek, { once: true });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [src, time]);
  return url;
}

/**
 * Pick the part of a clip to redo, by looking at it: the source plays in the
 * node, a window on the bar under it marks the span, and the plan's zones show
 * what stays, what is frozen and what is regenerated. Selection playback loops
 * the window, and the frames at both edges are shown side by side.
 */
export default function SegmentRangePicker({
  sourceUrl, startSeconds, durationSeconds, onChange, onSourceDuration, zones = [], status,
}: SegmentRangePickerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopSelection, setLoopSelection] = useState(true);
  const drag = useRef<{ mode: 'start' | 'end' | 'move' | 'scrub'; originX: number; start: number; end: number } | null>(null);

  const start = Math.max(0, startSeconds);
  const end = duration ? Math.min(duration, start + durationSeconds) : start + durationSeconds;

  const startFrame = useFrameAt(sourceUrl, duration ? start : null);
  const endFrame = useFrameAt(sourceUrl, duration ? Math.max(start, end - 1 / FPS) : null);

  const secondsAt = useCallback((clientX: number) => {
    const bar = barRef.current;
    if (!bar || !duration) return 0;
    const rect = bar.getBoundingClientRect();
    return snap(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration);
  }, [duration]);

  const seek = (seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, seconds), Math.max(0, duration - 1 / FPS));
    setTime(v.currentTime);
  };

  const commit = (s: number, e: number) => {
    const minLen = 1 / FPS;
    const ns = snap(Math.min(Math.max(0, s), Math.max(0, duration - minLen)));
    const ne = snap(Math.min(duration, Math.max(ns + minLen, e)));
    onChange(ns, snap(ne - ns));
  };

  const onPointerDown = (e: React.PointerEvent, mode: 'start' | 'end' | 'move' | 'scrub') => {
    if (!duration) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, originX: e.clientX, start, end };
    if (mode === 'scrub') seek(secondsAt(e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const at = secondsAt(e.clientX);
    if (d.mode === 'scrub') {
      seek(at);
    } else if (d.mode === 'start') {
      commit(Math.min(at, d.end - 1 / FPS), d.end);
      seek(at);
    } else if (d.mode === 'end') {
      commit(d.start, Math.max(at, d.start + 1 / FPS));
      seek(Math.max(d.start, at - 1 / FPS));
    } else {
      const shift = secondsAt(e.clientX) - secondsAt(d.originX);
      const len = d.end - d.start;
      const ns = Math.min(Math.max(0, d.start + shift), duration - len);
      commit(ns, ns + len);
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  // Keep playback inside the window while "loop selection" is on.
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    if (loopSelection && !v.paused && (v.currentTime >= end || v.currentTime < start - 0.05)) {
      v.currentTime = start;
    }
    setTime(v.currentTime);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (loopSelection && (v.currentTime < start || v.currentTime >= end)) v.currentTime = start;
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  const step = (frames: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    seek(snap(v.currentTime + frames / FPS));
  };

  const pct = (seconds: number) => (duration ? `${(Math.min(Math.max(seconds, 0), duration) / duration) * 100}%` : '0%');
  const zoneStyle: Record<RangeZone['kind'], string> = {
    regen: 'bg-fuchsia-500/55',
    context: 'bg-sky-400/35 bg-[repeating-linear-gradient(45deg,transparent_0_4px,rgba(255,255,255,0.18)_4px_6px)]',
    keep: 'bg-white/10',
  };

  return (
    <div
      className="nodrag nowheel space-y-2"
      // Canvas shortcuts stand down while the picker has focus, as they do for inputs.
      onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
      onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        if (e.key === 'f' || e.key === 'F' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        if (e.key === ' ') { e.preventDefault(); togglePlay(); }
        if (e.key === 'i' || e.key === 'I') { e.preventDefault(); commit(snap(time), Math.max(end, snap(time) + 1 / FPS)); }
        if (e.key === 'o' || e.key === 'O') { e.preventDefault(); commit(Math.min(start, snap(time)), snap(time) + 1 / FPS); }
      }}
      tabIndex={0}
    >
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={sourceUrl}
          poster={posterUrl(sourceUrl) ?? undefined}
          preload="metadata"
          crossOrigin="anonymous"
          playsInline
          {...NATIVE_VIDEO_CHROME_OFF}
          className="block max-h-[220px] w-full object-contain"
          onLoadedMetadata={() => {
            const d = videoRef.current?.duration || 0;
            setDuration(d);
            onSourceDuration?.(d);
          }}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />
        {duration > 0 && time >= start && time < end && (
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-fuchsia-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {t('选区内')}
          </span>
        )}
      </div>

      {/* The bar: the whole clip, the plan's zones, the window and the playhead. */}
      <div
        ref={barRef}
        className="relative h-9 cursor-pointer select-none rounded-md bg-white/[0.06]"
        onPointerDown={(e) => onPointerDown(e, 'scrub')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {zones.map((z, i) => (
          <div
            key={i}
            className={`absolute bottom-0 top-3 ${zoneStyle[z.kind]}`}
            style={{ left: pct(z.start / FPS), width: `calc(${pct(z.end / FPS)} - ${pct(z.start / FPS)})` }}
            title={z.label}
          />
        ))}
        {/* The requested window */}
        <div
          className="absolute top-0 h-full cursor-grab rounded-sm border-2 border-fuchsia-300/90 active:cursor-grabbing"
          style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
          onPointerDown={(e) => onPointerDown(e, 'move')}
          title={t('拖动整段')}
        >
          <div
            className="absolute -left-1.5 top-0 h-full w-3 cursor-ew-resize rounded-sm bg-fuchsia-300"
            onPointerDown={(e) => onPointerDown(e, 'start')}
            title={t('拖动起点')}
          />
          <div
            className="absolute -right-1.5 top-0 h-full w-3 cursor-ew-resize rounded-sm bg-fuchsia-300"
            onPointerDown={(e) => onPointerDown(e, 'end')}
            title={t('拖动终点')}
          />
        </div>
        <div className="pointer-events-none absolute top-0 h-full w-px bg-white" style={{ left: pct(time) }} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <button onClick={togglePlay} className="rounded border border-white/15 bg-white/10 px-2 py-1 text-zinc-100 hover:bg-white/20">
          {playing ? t('暂停') : loopSelection ? t('▶ 播放选区') : t('▶ 播放')}
        </button>
        <label className="flex cursor-pointer items-center gap-1 text-zinc-400">
          <input type="checkbox" checked={loopSelection} onChange={(e) => setLoopSelection(e.target.checked)} className="h-3 w-3 accent-fuchsia-400" />
          {t('循环选区')}
        </label>
        <button onClick={() => step(-1)} className="rounded border border-white/10 px-1.5 py-1 text-zinc-300 hover:bg-white/10" title={t('上一帧 (D)')}>‹</button>
        <button onClick={() => step(1)} className="rounded border border-white/10 px-1.5 py-1 text-zinc-300 hover:bg-white/10" title={t('下一帧 (F)')}>›</button>
        <span className="font-mono text-zinc-400">{fmt(time)}</span>
        <span className="ml-auto flex gap-1">
          <button
            onClick={() => commit(snap(time), Math.max(end, snap(time) + 1 / FPS))}
            className="rounded border border-white/10 px-1.5 py-1 text-zinc-300 hover:bg-white/10"
            title={t('把当前画面设为起点 (I)')}
          >
            {t('[ 设为起点')}
          </button>
          <button
            onClick={() => commit(Math.min(start, snap(time)), snap(time) + 1 / FPS)}
            className="rounded border border-white/10 px-1.5 py-1 text-zinc-300 hover:bg-white/10"
            title={t('把当前画面设为终点 (O)')}
          >
            {t('设为终点 ]')}
          </button>
        </span>
      </div>

      {/* The frames on either edge of the window, and its exact extent. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <button onClick={() => seek(start)} className="overflow-hidden rounded border border-white/10 bg-black/40 text-left hover:border-fuchsia-300/60">
          {startFrame ? <img src={startFrame} alt="" className="block aspect-video w-full object-cover" /> : <div className="aspect-video" />}
          <div className="px-1 py-0.5 font-mono text-[9px] text-zinc-400">{t('起')} {fmt(start)} · #{Math.round(start * FPS)}</div>
        </button>
        <div className="text-center font-mono text-[10px] text-fuchsia-200">
          {(end - start).toFixed(2)}s
          <div className="text-zinc-500">{Math.round((end - start) * FPS)}{t('帧')}</div>
        </div>
        <button onClick={() => seek(Math.max(start, end - 1 / FPS))} className="overflow-hidden rounded border border-white/10 bg-black/40 text-left hover:border-fuchsia-300/60">
          {endFrame ? <img src={endFrame} alt="" className="block aspect-video w-full object-cover" /> : <div className="aspect-video" />}
          <div className="px-1 py-0.5 font-mono text-[9px] text-zinc-400">{t('止')} {fmt(end)} · #{Math.round(end * FPS) - 1}</div>
        </button>
      </div>

      {zones.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-400">
          {zones.some((z) => z.kind === 'regen') && <span className="flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm bg-fuchsia-500/70" />{t('重新生成')}</span>}
          {zones.some((z) => z.kind === 'context') && <span className="flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm bg-sky-400/50" />{zones.find((z) => z.kind === 'context')?.label}</span>}
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm border border-fuchsia-300" />{t('你选的区间')}</span>
        </div>
      )}

      {status && (
        <div className={`rounded px-2 py-1 text-[10px] leading-relaxed ${
          status.tone === 'error' ? 'bg-red-500/10 text-red-300' : status.tone === 'pending' ? 'bg-black/20 text-zinc-500' : 'bg-fuchsia-500/10 text-fuchsia-100'
        }`}>
          {status.text}
        </div>
      )}
      <p className="text-[9px] text-zinc-600">{t('点这块区域后可用快捷键：空格 播放 · D/F 逐帧 · I/O 设起点/终点')}</p>
    </div>
  );
}
