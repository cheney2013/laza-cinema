import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useJobPollerStore, TERMINAL_STATUSES, QueueJob } from '@/lib/jobPollerStore';
import { t } from '@/lib/i18n';

export type JobOutcomeStatus = 'done' | 'error' | 'cancelled';
export type JobOutcome = QueueJob & { status: JobOutcomeStatus };

const noOutputError = () => t('任务已完成但没有产出文件，请重试');

/**
 * The finished state of a backend job, or null while it is still queued/running
 * (or the backend has not answered yet).
 *
 * Every terminal status is surfaced -- `done`, `error` and `cancelled` -- and a
 * `done` without an output URL is downgraded to an `error`, so a node that
 * handles those three can never be left "generating" forever. A job the backend
 * no longer knows about (restart, pruned history) arrives as an `error` too.
 *
 * Jobs whose payload is data rather than a file pass `{ requireUrl: false }` so a valid result is not
 * read as a missing output.
 */
export function useJobResult(
  jobId: string | undefined,
  opts?: { requireUrl?: boolean },
): JobOutcome | null {
  const requireUrl = opts?.requireUrl !== false;
  const registerJob = useJobPollerStore((s) => s.registerJob);
  const unregisterJob = useJobPollerStore((s) => s.unregisterJob);
  const entry = useJobPollerStore((s) => (jobId ? s.jobs[jobId] : undefined));

  useEffect(() => {
    if (!jobId) return;
    registerJob(jobId);
    return () => unregisterJob(jobId);
  }, [jobId, registerJob, unregisterJob]);

  return useMemo(() => {
    if (!entry || !TERMINAL_STATUSES.has(entry.status)) return null;

    // Completed queue jobs store their payload under `result`, while older
    // persisted jobs exposed url/filename at the top level. Normalize both
    // shapes here so every node can finish and clear its generating state.
    const result = entry.result;
    const merged = (result && typeof result === 'object'
      ? { ...entry, ...(result as Record<string, unknown>) }
      : { ...entry }) as JobOutcome;

    if (requireUrl && merged.status === 'done' && !merged.url) {
      return { ...merged, status: 'error', error: (merged.error as string) || noOutputError() };
    }
    return merged;
  }, [entry, requireUrl]);
}

export function useActiveBatchInfo(jobId: string | undefined): string | undefined {
  return useJobPollerStore((s) => {
    if (!jobId || s.queue.active?.id !== jobId) return undefined;
    return (s.queue.active?.batch_info as string | undefined);
  });
}

export function useJobStatusText(jobId: string | undefined): string | undefined {
  return useJobPollerStore((s) => {
    if (!jobId) return undefined;
    if (s.queue.active?.id === jobId) {
      const prog = s.queue.active.progress as ActiveProgressInfo | undefined;
      return prog?.phase || (s.queue.active.batch_info as string | undefined);
    }
    if (s.queue.pending.some((job) => job.id === jobId)) return t('正在排队…');
    return undefined;
  });
}

export type JobLiveness =
  | 'submitting'   // no job id yet: the POST that creates the job is in flight
  | 'active'
  | 'queued'
  | 'finished'     // terminal state reported, node is about to leave "generating"
  | 'unknown'      // backend reachable but has not (yet) reported this job
  | 'offline';     // last poll failed

/** Where a job stands according to the last poll -- drives the fallback status line. */
export function useJobLiveness(jobId: string | undefined): JobLiveness {
  return useJobPollerStore((s) => {
    if (!jobId) return 'submitting';
    if (!s.backendReachable) return 'offline';
    if (s.queue.active?.id === jobId) return 'active';
    if (s.queue.pending.some((job) => job.id === jobId)) return 'queued';
    const entry = s.jobs[jobId];
    if (entry && TERMINAL_STATUSES.has(entry.status)) return 'finished';
    return 'unknown';
  });
}

export interface ActiveProgressInfo {
  step: number;
  max: number;
  eta?: number | null;
  speed?: number | null;
  elapsed?: number | null;
  phase?: string | null;
  node_type?: string | null;
}

export function useActiveProgress(jobId?: string): ActiveProgressInfo | null {
  return useJobPollerStore((s) => {
    if (!jobId || s.queue.active?.id !== jobId) return null;
    return (s.queue.active.progress as ActiveProgressInfo | undefined) ?? null;
  });
}

export interface JobScheduleInfo {
  /** Queued: seconds until it is expected to start (backend job_scheduler). */
  startIn?: number;
  /** Running: seconds left, learned from past runs, live step rate once sampling. */
  remaining?: number;
  /** Seconds this configuration took on its past runs. */
  range?: [number, number] | null;
  paged: boolean;
  createdAt?: string;
  startedAt?: string;
}

/** The backend's timing for a job, from the /queue poll. */
export function useJobSchedule(jobId?: string): JobScheduleInfo {
  return useJobPollerStore(
    useShallow((s) => {
      const a = s.queue.active as any;
      const j = (a?.id === jobId ? a : s.queue.pending.find((x) => x.id === jobId)) as any;
      if (!jobId || !j) return { paged: false };
      return {
        startIn: j.status === 'queued' ? (j.sched_eta as number | undefined) : undefined,
        remaining: a?.id === jobId ? (a.sched_remaining as number | undefined) : undefined,
        range: j.sched_range as [number, number] | null | undefined,
        paged: Boolean(j.sched_paged),
        createdAt: j.created_at as string | undefined,
        startedAt: j.started_at as string | undefined,
      };
    })
  );
}

export interface QueuePositionInfo {
  isQueued: boolean;
  isActive: boolean;
  aheadCount: number;
  activeJobType?: string;
  activeProgress?: ActiveProgressInfo | null;
}

const DEFAULT_QUEUE_INFO: QueuePositionInfo = {
  isQueued: false,
  isActive: false,
  aheadCount: 0,
};

export function useQueuePosition(jobId: string | undefined): QueuePositionInfo {
  return useJobPollerStore(
    useShallow((s) => {
      if (!jobId) {
        return DEFAULT_QUEUE_INFO;
      }
      if (s.queue.active?.id === jobId) {
        return {
          isQueued: false,
          isActive: true,
          aheadCount: 0,
          activeJobType: (s.queue.active?.type as string | undefined),
          activeProgress: (s.queue.active?.progress as ActiveProgressInfo | undefined) ?? null,
        };
      }
      // Filter out the active job so we only count strictly waiting queue items
      const waitingList = s.queue.pending.filter((j) => j.id !== s.queue.active?.id);
      const idx = waitingList.findIndex((j) => j.id === jobId);
      if (idx !== -1) {
        const ahead = (s.queue.active ? 1 : 0) + idx;
        return {
          isQueued: true,
          isActive: false,
          aheadCount: ahead,
          activeJobType: (s.queue.active?.type as string | undefined),
          activeProgress: (s.queue.active?.progress as ActiveProgressInfo | undefined) ?? null,
        };
      }
      return DEFAULT_QUEUE_INFO;
    })
  );
}
