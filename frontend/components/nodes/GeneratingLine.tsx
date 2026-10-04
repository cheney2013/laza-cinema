'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveProgress, useJobLiveness, useJobSchedule, useQueuePosition } from '@/hooks/useJobPoller';
import { api } from '@/lib/api';
import { resolveAssetUrl } from '@/lib/config';
import { t, translatePhase } from '@/lib/i18n';
import { parseShotMarks, shotAt } from '@/lib/shotTimeline';

interface Props {
  active: boolean;
  jobId?: string;
  steps?: number;
  statusText?: string;
  onCancel?: () => void;
  /** The prompt being rendered: its [Shot N] cut points label the live preview. */
  prompt?: string;
}

export default function GeneratingLine({ active, jobId, steps = 20, statusText, onCancel, prompt }: Props) {
  const [previewTime, setPreviewTime] = useState(0);
  const shotMarks = useMemo(() => parseShotMarks(prompt || ''), [prompt]);
  const liveProgress = useActiveProgress(jobId);
  const queueInfo = useQueuePosition(jobId);
  const liveness = useJobLiveness(jobId);
  const sched = useJobSchedule(jobId);
  // Backend figures arrive once per poll; count them down in between. Keyed on
  // the value, so a new estimate restarts the countdown from itself.
  const startInRef = useRef<{ v: number; at: number } | null>(null);
  const remainingRef = useRef<{ v: number; at: number } | null>(null);
  if (sched.startIn !== startInRef.current?.v) {
    startInRef.current = sched.startIn === undefined ? null : { v: sched.startIn, at: Date.now() };
  }
  if (sched.remaining !== remainingRef.current?.v) {
    remainingRef.current = sched.remaining === undefined ? null : { v: sched.remaining, at: Date.now() };
  }
  const countdown = (r: { v: number; at: number } | null) =>
    r ? Math.max(0, Math.round(r.v - (Date.now() - r.at) / 1000)) : null;
  const since = (iso?: string) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 1000)) : null;
  };
  const [done, setDone] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const lastProgressRef = useRef<{ step: number; at: number } | null>(null);
  const secondsPerStepRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setDone(true);
      setElapsed(0);
      setEtaSeconds(null);
      lastProgressRef.current = null;
      secondsPerStepRef.current = null;
      const t = setTimeout(() => setDone(false), 500);
      return () => clearTimeout(t);
    }
    setDone(false);
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
      setEtaSeconds((current) => current === null ? null : Math.max(0, current - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [active]);

  useEffect(() => {
    if (!active || !liveProgress || liveProgress.max <= 0 || liveProgress.step <= 0) return;

    // 1. Prefer authoritative backend ETA computed directly from ComfyUI step timings
    if (liveProgress.eta !== undefined && liveProgress.eta !== null) {
      setEtaSeconds(liveProgress.eta);
      return;
    }

    // 2. Fallback to client-side smoothed EMA
    const now = Date.now();
    const previous = lastProgressRef.current;
    if (previous && liveProgress.step > previous.step) {
      const observed = (now - previous.at) / 1000 / (liveProgress.step - previous.step);
      const prior = secondsPerStepRef.current;
      const smoothed = prior === null ? observed : prior * 0.65 + observed * 0.35;
      secondsPerStepRef.current = smoothed;
      setEtaSeconds(Math.max(0, Math.round((liveProgress.max - liveProgress.step) * smoothed)));
    }
    if (!previous || liveProgress.step !== previous.step) {
      lastProgressRef.current = { step: liveProgress.step, at: now };
    }
  }, [active, liveProgress?.step, liveProgress?.max, liveProgress?.eta]);

  if (!active && !done) return null;

  const progress = active ? liveProgress : null;
  // ComfyUI's console counts elapsed from the moment the running node started, not
  // from when this node card began waiting -- the local clock also carries queueing
  // and weight loading, which is why the two used to disagree by minutes.
  const sampleElapsed = progress && typeof progress.elapsed === 'number' ? progress.elapsed : null;
  const pct = progress && progress.max > 0 ? Math.round((progress.step / progress.max) * 100) : null;
  const hasRealProgress = pct !== null && pct > 0;

  // What to say when the backend has not given us a phase for this job. Only an
  // *active* job is plausibly loading weights; anything else used to borrow that
  // line and read as a hang.
  const fallbackText =
    liveness === 'submitting' ? t('正在提交任务…')
    : liveness === 'offline' ? t('后端连接中断，等待重连…')
    : liveness === 'unknown' ? t('正在同步任务状态…')
    : liveness === 'finished' ? t('正在整理结果…')
    : t('正在初始化模型与权重…');

  // Queue details
  const { isQueued, aheadCount, activeProgress: predProgress } = queueInfo;
  // Server-side clocks: queued since the job was submitted, running since it
  // started -- not since this card mounted.
  const waited = since(sched.createdAt) ?? elapsed;
  const startIn = countdown(startInRef.current);
  // The backend's remaining time covers loading and decoding too; ComfyUI's own
  // eta only exists during sampling and only counts the sampler.
  // Past the learned total with the sampler not yet moving (e.g. waiting behind
  // another prompt in ComfyUI), 0 would be a false figure: say it is unknown.
  const learned = countdown(remainingRef.current);
  const remaining = (learned !== null && (learned > 0 || hasRealProgress) ? learned : null) ?? etaSeconds;
  // Whole-clip preview decoded on the CPU after each sampler step
  // (ComfyUI custom_nodes/aicinema-live-preview), shown behind the stats.
  const livePreview = !isQueued ? (progress as any)?.preview as { url: string; step: number } | undefined : undefined;
  // With the preview playing, the picture is the status: no dimming, and the
  // figures shrink to one strip along the foot of the card.
  if (livePreview) {
    return (
      <div className="gen-overlay gen-running absolute inset-0 z-50 rounded-2xl overflow-hidden bg-black" style={{ opacity: done ? 0 : 1, pointerEvents: 'auto' }}>
        <video
          key={livePreview.url}
          src={resolveAssetUrl(livePreview.url)}
          autoPlay loop muted playsInline
          onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
        {shotMarks.length > 0 && (
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white/90">
            {t('镜')}{shotAt(shotMarks, previewTime)} / {shotMarks.length} · F {Math.floor(previewTime * 24 + 1e-3)}
          </div>
        )}
        <div className="lod-gen" aria-hidden="true">
          <span className="lod-gen-figure">{hasRealProgress ? `${pct}%` : '…'}</span>
          <div className="lod-gen-bar"><div style={{ width: `${pct ?? 0}%` }} /></div>
        </div>
        <div className="absolute left-0 right-0 bottom-0 px-3 pt-4 pb-2 bg-gradient-to-t from-black/70 to-transparent">
          <div className="h-[3px] rounded-full bg-white/15 overflow-hidden mb-1.5">
            <div className="h-full bg-white/90 transition-all duration-300" style={{ width: `${pct ?? 0}%` }} />
          </div>
          <div className={`flex items-center gap-2 text-[10px] font-mono whitespace-nowrap ${sched.paged ? 'text-amber-300' : 'text-zinc-200'}`}>
            {progress && progress.max > 0 && <span>{Math.floor(progress.step)}/{Math.floor(progress.max)}</span>}
            {remaining !== null && <span>{t('剩余 {eta}', { eta: formatTime(remaining) })}</span>}
            {sched.paged && <span>{t('显存换页，比平时慢')}</span>}
            <span className="flex-1" />
            {onCancel && (
              <button className="nodrag text-zinc-300 hover:text-red-400 cursor-pointer" onClick={onCancel} title={t('中断生成')}>
                ✕ {t('中断生成')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const predPct = predProgress && predProgress.max > 0 ? Math.round((predProgress.step / predProgress.max) * 100) : null;

  return (
    <div 
      className={`gen-overlay ${isQueued ? 'gen-queued' : 'gen-running'} absolute inset-0 z-50 flex flex-col items-center justify-center rounded-2xl transition-all duration-300 px-4`}
      style={{
        background: 'rgba(8, 8, 12, 0.90)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.8)',
        opacity: done ? 0 : 1,
        pointerEvents: 'auto',
      }}
    >
      {/* Outline mode (zoomed out): the card is a few pixels tall, so the status is
          one large figure sized to the card and a bar along its foot; the detailed
          lines below are hidden there by CSS (.canvas-lod .gen-overlay). */}
      <div className="lod-gen" aria-hidden="true">
        <span className="lod-gen-figure">
          {isQueued ? (aheadCount > 0 ? `#${aheadCount}` : '…') : (hasRealProgress ? `${pct}%` : '…')}
        </span>
        <div className="lod-gen-bar"><div style={{ width: `${isQueued ? 0 : (pct ?? 0)}%` }} /></div>
      </div>
      {/* Precision Circular Spinner or Queue Badge */}
      <div className="relative flex items-center justify-center mb-2">
        <div className={`w-11 h-11 rounded-full border-2 ${
          isQueued 
            ? 'border-white/10 border-t-amber-400' 
            : 'border-white/10 border-t-white shadow-[0_0_10px_rgba(255,255,255,0.4)]'
        } animate-spin`} />
        <span className="absolute font-mono text-[11px] font-bold text-white tracking-tight flex items-center justify-center">
          {isQueued 
            ? (aheadCount > 0 ? `#${aheadCount}` : '⏳')
            : (hasRealProgress ? `${pct}%` : '✦')
          }
        </span>
      </div>

      {/* Main Status Label */}
      <div className="text-xs font-medium text-zinc-200 tracking-wide mb-1.5 flex items-center justify-center gap-1.5 font-mono text-center max-w-[90%] truncate">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isQueued ? 'bg-amber-400' : 'bg-white shadow-[0_0_6px_#ffffff]'} animate-pulse`} />
        <span className="truncate">
          {isQueued ? (
            aheadCount > 1 
              ? t('排队中 · 前方有 {n} 个任务', { n: aheadCount })
              : aheadCount === 1
              ? t('排队中 · 前方任务进行中')
              : t('排队就绪，准备启动…')
          ) : (
            translatePhase(statusText || progress?.phase) ||
            (hasRealProgress
              ? t('扩散去噪采样中 ({step}/{max})', {
                  step: Math.floor(progress?.step || 0),
                  max: Math.floor(progress?.max || 0),
                })
              : fallbackText)
          )}
        </span>
      </div>

      {/* Modern Progress Bar Track */}
      <div className="w-full max-w-[200px] h-1.5 bg-white/[0.08] rounded-full overflow-hidden relative mb-2.5 border border-white/5">
        {hasRealProgress ? (
          <div 
            className="h-full bg-gradient-to-r from-zinc-300 to-white rounded-full transition-all duration-300 relative shadow-[0_0_8px_rgba(255,255,255,0.4)]"
            style={{ width: `${pct}%` }}
          />
        ) : isQueued && aheadCount === 1 && predPct !== null ? (
          <div 
            className="h-full bg-amber-400 rounded-full transition-all duration-300 relative shadow-sm"
            style={{ width: `${predPct}%` }}
          />
        ) : (
          <div 
            className="w-full h-full rounded-full"
            style={{
              backgroundImage: isQueued 
                ? 'linear-gradient(90deg, transparent 0%, rgba(251, 191, 36, 0.7) 50%, transparent 100%)'
                : 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.7) 50%, transparent 100%)',
              backgroundSize: '200% 100%',
              animation: 'laser-sweep 1.5s ease-in-out infinite',
            }}
          />
        )}
      </div>

      {/* Clean Typography Metrics HUD (No capsule/pill boxes) */}
      <div className="flex flex-col items-center gap-1 text-[11px] font-mono select-none">
        {isQueued ? (
          <>
            {aheadCount === 1 ? (
              predProgress && predProgress.max > 0 ? (
                <div className="text-amber-300 font-medium whitespace-nowrap">
                  
                  {t('前序任务 {step}/{max} 步 ({pct}%)', { step: predProgress.step, max: predProgress.max, pct: predPct ?? 0 })}
                </div>
              ) : (
                <span className="text-zinc-400 whitespace-nowrap">{t('前方任务处理中，即将轮到本任务')}</span>
              )
            ) : (
              <span className="text-amber-300 font-medium whitespace-nowrap">
                
                {t('排在队列第 #{n} 位 · 请稍候', { n: aheadCount })}
              </span>
            )}
            <span className="text-zinc-500 text-[10px] whitespace-nowrap">
              {startIn !== null ? `${t('约 {m} 后开始', { m: formatTime(startIn) })} · ` : ''}
              {t('已等待')} {formatTime(waited)}
            </span>
          </>
        ) : (
          <>
            {/* Line 1: Step & Elapsed */}
            <div className="flex items-center justify-center gap-2 text-zinc-400 whitespace-nowrap">
              {progress && progress.max > 0 ? (
                <span>
                  <span className="text-zinc-100 font-semibold">{Math.floor(progress.step)}</span>
                  <span className="text-zinc-500"> / </span>
                  <span className="text-zinc-300">{Math.floor(progress.max)}</span>
                  <span className="text-zinc-500 ml-1">{t('步')}</span>
                </span>
              ) : null}
              <span className="text-zinc-600">·</span>
              <span>{t('耗时')} {formatTime(sampleElapsed ?? since(sched.startedAt) ?? elapsed)}</span>
            </div>

            {/* Line 2: ETA & Speed */}
            {(hasRealProgress || remaining !== null) && (
              <div className={`flex items-center justify-center gap-1.5 whitespace-nowrap ${sched.paged ? 'text-amber-300' : 'text-zinc-300'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-white/80 animate-pulse inline-block mr-0.5" />
                <span>{t('剩余 {eta}', { eta: remaining === null ? t('计算中…') : formatTime(remaining) })}</span>
                {sched.paged ? <span className="text-[10px]">{t('显存换页，比平时慢')}</span> : null}
                {progress?.speed ? (
                  <span className="text-zinc-500 text-[10px]">{t('({speed}s/步)', { speed: progress.speed })}</span>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {/* Pin to top: only meaningful when another queued job is ahead of this one */}
      {jobId && isQueued && aheadCount > (queueInfo.activeJobType ? 1 : 0) && (
        <button
          className="nodrag mt-2 flex items-center gap-1.5 px-2.5 py-1 text-zinc-400 hover:text-amber-300 hover:bg-white/[0.04] rounded-md text-[11px] font-mono transition-colors cursor-pointer"
          title={t('置顶到队首，当前任务完成后立即开始')}
          onClick={() => { api.pinJob(jobId).catch(() => { }); }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="4" x2="19" y2="4" />
            <polyline points="7 14 12 9 17 14" />
            <line x1="12" y1="9" x2="12" y2="20" />
          </svg>
          <span>{t('置顶')}</span>
        </button>
      )}

      {/* Clean Minimal Cancel Button (No capsule border) */}
      {onCancel && (
        <button 
          className="nodrag mt-2 flex items-center gap-1.5 px-2.5 py-1 text-zinc-500 hover:text-red-400 hover:bg-white/[0.04] rounded-md text-[11px] font-mono transition-colors cursor-pointer"
          onClick={onCancel}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          <span>{isQueued ? t('取消排队') : t('中断生成')}</span>
        </button>
      )}
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
