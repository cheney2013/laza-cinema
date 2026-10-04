'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '@/lib/store';
import { useQueuePosition } from '@/hooks/useJobPoller';
import { useJobPollerStore } from '@/lib/jobPollerStore';
import { useT } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';

/**
 * The header's task list, after ComfyUI's queue panel: every canvas node that is
 * rendering or waiting, the running one first and the rest in queue order, each
 * with its step count or its place in line. Clicking a row jumps the canvas to
 * that node and selects it.
 */
export default function TaskQueuePanel() {
  const t = useT();
  const { fitView } = useReactFlow();
  const setNodes = useStore((s) => s.setNodes);
  // Ids joined into a string so the header re-renders only when the set changes,
  // not on every drag frame.
  const busyKey = useStore((s) =>
    s.nodes.filter((n) => (n.data as any)?.status === 'generating').map((n) => n.id).join('|'));
  const busyIds = busyKey ? busyKey.split('|') : [];
  const activeJobId = useJobPollerStore((s) => s.queue.active?.id as string | undefined);
  const pendingKey = useJobPollerStore((s) => s.queue.pending.map((j) => j.id).join('|'));
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const focus = useCallback((nodeId: string) => {
    const { nodes } = useStore.getState();
    setNodes(nodes.map((n) => ({ ...n, selected: n.id === nodeId })));
    fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.6, maxZoom: 1.2 });
  }, [fitView, setNodes]);

  // Running job first, then the backend queue order, then anything whose job the
  // poller has not reported yet.
  const pending = pendingKey ? pendingKey.split('|') : [];
  const rows = (() => {
    const { nodes } = useStore.getState();
    const busy = nodes.filter((n) => busyIds.includes(n.id));
    const rank = (jobId?: string) => {
      if (!jobId) return 1e6;
      if (jobId === activeJobId) return -1;
      const i = pending.indexOf(jobId);
      return i === -1 ? 1e5 : i;
    };
    return busy
      .map((n) => ({ id: n.id, type: n.type as string, data: n.data as any }))
      .sort((a, b) => rank(a.data?.jobId) - rank(b.data?.jobId));
  })();

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('任务列表：正在生成和排队的节点，点一行跳过去')}
        className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer select-none active:scale-95"
      >
        <span className={busyIds.length ? 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse' : 'w-1.5 h-1.5 rounded-full bg-zinc-600'} />
        <span className="hidden xl:inline">{t('任务')}</span>
        <span className="font-mono">{busyIds.length}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-9 w-[360px] max-h-[60vh] overflow-y-auto rounded-xl p-1.5 z-50"
          style={{
            background: 'rgba(16, 16, 22, 0.96)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.7)',
          }}
        >
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-xs text-zinc-500 text-center">{t('没有正在生成或排队的节点')}</div>
          ) : rows.map((r) => (
            <TaskRow key={r.id} nodeId={r.id} type={r.type} data={r.data} onFocus={focus} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ nodeId, type, data, onFocus }: {
  nodeId: string; type: string; data: any; onFocus: (id: string) => void;
}) {
  const t = useT();
  const q = useQueuePosition(data?.jobId);
  // The backend orders its queue by expected run order and stamps each queued
  // job with when it should start and why it moved (backend/job_scheduler.py).
  const sched = useJobPollerStore(useShallow((s) => {
    const j = s.queue.pending.find((x) => x.id === data?.jobId);
    return {
      eta: j?.sched_eta as number | undefined,
      reason: (j?.sched_reason as string | undefined) || '',
      suspended: j?.status === 'running' && s.queue.active?.id !== data?.jobId,
      // Seconds this configuration took on its past runs (min, max), when known.
      range: j?.sched_range as [number, number] | null | undefined,
    };
  }));
  // The running job: learned remaining seconds, and whether its steps are
  // running several times slower than predicted (memory paging).
  const live = useJobPollerStore(useShallow((s) => {
    const a = s.queue.active as any;
    const mine = a?.id === data?.jobId;
    return {
      remaining: mine ? (a?.sched_remaining as number | undefined) : undefined,
      paged: mine && Boolean(a?.sched_paged),
    };
  }));
  const p = q.activeProgress;
  const pct = p && p.max > 0 ? Math.round((p.step / p.max) * 100) : null;
  const label = String(data?.label || nodeId);
  return (
    <button
      onClick={() => onFocus(nodeId)}
      className="w-full text-left flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-white/[0.06] transition-colors cursor-pointer"
    >
      <span className={q.isActive ? 'mt-1 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0' : 'mt-1 w-1.5 h-1.5 rounded-full bg-zinc-500 flex-shrink-0'} />
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] text-zinc-200 truncate" title={label}>{label}</span>
        <span className="block text-[10px] text-zinc-500 font-mono truncate">{nodeId} · {type}</span>
        {!q.isActive && (sched.suspended || sched.eta !== undefined) && (
          <span className="block text-[10px] text-zinc-400 truncate">
            {sched.suspended ? t('分段间让路给短任务') : t('约 {m} 后开始', { m: fmtWait(sched.eta ?? 0) })}
            {!sched.suspended && sched.reason ? ` · ${t(sched.reason)}` : ''}
            {!sched.suspended && sched.range ? ` · ${t('耗时 {r}', { r: fmtRange(sched.range) })}` : ''}
          </span>
        )}
        {q.isActive && (live.remaining !== undefined || live.paged) && (
          <span className={`block text-[10px] truncate ${live.paged ? 'text-amber-400' : 'text-zinc-400'}`}>
            {live.remaining !== undefined ? t('剩余约 {m}', { m: fmtWait(live.remaining) }) : ''}
            {live.paged ? ` · ${t('显存换页，比平时慢')}` : ''}
          </span>
        )}
        {q.isActive && pct !== null && (
          <span className="block mt-1 h-1 rounded bg-white/10 overflow-hidden">
            <span className="block h-full bg-zinc-100" style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <span className="text-[10px] font-mono text-zinc-400 flex-shrink-0 mt-0.5">
        {q.isActive
          ? (p && p.max > 0 ? `${Math.floor(p.step)}/${Math.floor(p.max)}` : t('运行中'))
          : q.isQueued ? t('排队 #{n}', { n: q.aheadCount }) : t('等待中')}
      </span>
    </button>
  );
}

function fmtWait(sec: number): string {
  if (sec < 60) return '1 分钟内';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function fmtRange([lo, hi]: [number, number]): string {
  const a = Math.max(1, Math.round(lo / 60));
  const b = Math.max(1, Math.round(hi / 60));
  return a === b ? `${a} 分钟` : `${a}–${b} 分钟`;
}

/**
 * A hairline across the very top of the window showing the running job's step
 * progress, so progress is visible whatever part of the canvas is on screen.
 * Hidden when nothing is running.
 */
export function ActiveJobBar() {
  const progress = useJobPollerStore((s) => s.queue.active?.progress as { step?: number; max?: number } | undefined);
  const running = useJobPollerStore((s) => Boolean(s.queue.active));
  const jobProject = useJobPollerStore((s) => (s.queue.active as any)?.project_id as string | undefined);
  const myProject = useStore((s) => s.currentProjectId);
  // Another project's render (another user, another tab) draws in amber.
  const foreign = running && !!jobProject && !!myProject && jobProject !== myProject;
  const pct = progress && progress.max && progress.max > 0
    ? Math.min(100, Math.max(0, ((progress.step || 0) / progress.max) * 100))
    : null;

  // The tab title carries the running job's progress, so it can be watched from
  // another tab or window.
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (baseTitle.current === null) baseTitle.current = document.title.replace(/^\[[^\]]*\]\s*/, '');
    const base = baseTitle.current;
    if (!running) { document.title = base; return; }
    const tag = pct !== null ? `${Math.round(pct)}%` : '…';
    document.title = `[${foreign ? '⏳ ' : ''}${tag}] ${base}`;
  }, [running, pct, foreign]);
  useEffect(() => () => { if (baseTitle.current !== null) document.title = baseTitle.current; }, []);

  if (!running) return null;
  const color = foreign ? 'bg-amber-400' : 'bg-zinc-100';
  return (
    <div className="fixed top-0 left-0 right-0 h-[3px] z-[60] pointer-events-none bg-white/[0.04]">
      {pct === null ? (
        <div className={`h-full w-1/4 ${color} opacity-60 animate-pulse`} />
      ) : (
        <div className={`h-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}
