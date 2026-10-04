import { create } from 'zustand';
import { api, QueueJob, QueueSnapshot } from './api';
import { t } from './i18n';

export type { QueueJob };

export const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);
export const lostJobError = () => t('任务记录已丢失（后端可能已重启或清理了历史记录），请重新生成');

// A job is declared lost only after this many polls that (a) started after the
// job was registered and (b) came back from a backend that reports `missing`.
// One miss is not enough: a poll that was already in flight when the job was
// registered can legitimately come back without it.
const MISS_THRESHOLD = 2;
const POLL_INTERVAL_MS = 600;
const OFFLINE_POLL_INTERVAL_MS = 2000;

interface Tracked {
  registeredAt: number;
  misses: number;
}

interface JobPollerStore {
  queue: QueueSnapshot;
  /** Every job the last poll reported, keyed by id — tracked ids are definitive. */
  jobs: Record<string, QueueJob>;
  /** false once a poll fails; true again on the next successful one. */
  backendReachable: boolean;
  lastPollAt: number | null;
  activeJobs: Set<string>;
  registerJob: (jobId: string) => void;
  unregisterJob: (jobId: string) => void;
  _applyPoll: (q: QueueSnapshot, startedAt: number) => void;
  _markUnreachable: () => void;
}

const emptyQueue: QueueSnapshot = { pending: [], active: null, history: [] };

let _timer: ReturnType<typeof setTimeout> | null = null;
let _isPolling = false;
const _tracked = new Map<string, Tracked>();
const _lost = new Map<string, QueueJob>();

async function _pollOnce() {
  const store = useJobPollerStore.getState();
  if (store.activeJobs.size === 0) {
    _timer = null;
    return;
  }
  if (_isPolling) return;
  _isPolling = true;
  const startedAt = Date.now();
  let ok = false;
  try {
    const q = await api.getQueue(Array.from(store.activeJobs));
    useJobPollerStore.getState()._applyPoll(q, startedAt);
    ok = true;
  } catch {
    useJobPollerStore.getState()._markUnreachable();
  } finally {
    _isPolling = false;
    _scheduleNext(ok ? POLL_INTERVAL_MS : OFFLINE_POLL_INTERVAL_MS);
  }
}

function _scheduleNext(delay = POLL_INTERVAL_MS) {
  const store = useJobPollerStore.getState();
  if (store.activeJobs.size === 0) {
    _timer = null;
    return;
  }
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _pollOnce();
  }, delay);
}

function _lostEntry(jobId: string): QueueJob {
  let entry = _lost.get(jobId);
  if (!entry) {
    entry = { id: jobId, status: 'error', error: lostJobError(), lost: true };
    _lost.set(jobId, entry);
  }
  return entry;
}

export const useJobPollerStore = create<JobPollerStore>((set) => ({
  queue: emptyQueue,
  jobs: {},
  backendReachable: true,
  lastPollAt: null,
  activeJobs: new Set(),

  registerJob(jobId) {
    if (!_tracked.has(jobId)) {
      _tracked.set(jobId, { registeredAt: Date.now(), misses: 0 });
    }
    set((s) => {
      if (s.activeJobs.has(jobId)) return {};
      const next = new Set(s.activeJobs);
      next.add(jobId);
      return { activeJobs: next };
    });
    // Immediately trigger instant poll without waiting
    _pollOnce();
  },

  unregisterJob(jobId) {
    _tracked.delete(jobId);
    _lost.delete(jobId);
    set((s) => {
      if (!s.activeJobs.has(jobId)) return {};
      const next = new Set(s.activeJobs);
      next.delete(jobId);
      return { activeJobs: next };
    });
  },

  _applyPoll(q, startedAt) {
    const jobs: Record<string, QueueJob> = {};
    for (const j of q.history ?? []) jobs[j.id] = j;
    for (const j of q.pending ?? []) jobs[j.id] = j;
    if (q.active) jobs[q.active.id] = q.active;
    // The per-id answer wins: it is what the backend actually looked up for us.
    for (const [id, j] of Object.entries(q.tracked ?? {})) jobs[id] = j;

    // Only a backend that reports `missing` can be definitive about absence.
    const definitive = Array.isArray(q.missing);
    for (const [id, t] of _tracked) {
      if (jobs[id]) {
        t.misses = 0;
        continue;
      }
      if (_lost.has(id)) {
        jobs[id] = _lostEntry(id);
        continue;
      }
      if (!definitive || startedAt < t.registeredAt) continue;
      t.misses += 1;
      if (t.misses >= MISS_THRESHOLD) {
        jobs[id] = _lostEntry(id);
      }
    }

    set({ queue: q, jobs, backendReachable: true, lastPollAt: Date.now() });
  },

  _markUnreachable() {
    set((s) => (s.backendReachable ? { backendReachable: false } : {}));
  },
}));
