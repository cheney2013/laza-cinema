/**
 * The canvas copy kept in the browser.
 *
 * It is an offline fallback, read only when the backend cannot be reached; the backend holds the
 * canvas. A browser gives an origin a few MB of localStorage, and a finished film's canvas (hundreds
 * of nodes with their prompts and takes) is bigger than that, so the write used to fail with
 * QuotaExceededError on every autosave, after serialising several MB each time, and in the
 * project-switch paths, where it was not guarded, it surfaced as "无法打开项目" for a project that had
 * in fact opened.
 *
 * A canvas over the budget is simply not cached, and the copy that was there is removed so the
 * fallback can never bring back an older version. The size is learned once; while the canvas stays
 * about that big it is not serialised again.
 */

export interface CacheStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Characters. localStorage counts two bytes each against roughly 10 MB, shared with everything else the studio keeps. */
export const NODES_BUDGET = 1_800_000;
export const EDGES_BUDGET = 400_000;

export type CacheResult = 'saved' | 'too-big' | 'full';

let skipAbove: number | null = null;
let said = false;

/** Forget what was learned (tests; a changed project is handled by the node-count rule). */
export function resetCanvasCache(): void {
  skipAbove = null;
  said = false;
}

export function cacheCanvas(
  storage: CacheStorage,
  nodesKey: string,
  edgesKey: string,
  nodes: unknown[],
  edges: unknown[],
  say: (message: string) => void = (m) => console.info(m),
): CacheResult {
  // Too big a moment ago and about as big now: do not serialise it just to find out again.
  if (skipAbove !== null && nodes.length > skipAbove * 0.7) return 'too-big';

  const drop = () => {
    try { storage.removeItem(nodesKey); storage.removeItem(edgesKey); } catch { /* nothing to clean */ }
  };
  const explain = (why: string) => {
    if (said) return;
    said = true;
    say(`画布 ${nodes.length} 个节点${why}，不再保存浏览器本地备份（后端保存不受影响；离线兜底只对较小的画布有效）。`);
  };

  const n = JSON.stringify(nodes);
  const e = JSON.stringify(edges);
  if (n.length > NODES_BUDGET || e.length > EDGES_BUDGET) {
    drop();
    skipAbove = nodes.length;
    explain('超过本地备份的大小上限');
    return 'too-big';
  }
  try {
    storage.setItem(nodesKey, n);
    storage.setItem(edgesKey, e);
  } catch {
    drop();
    explain('，浏览器本地存储已满');
    return 'full';
  }
  skipAbove = null;
  said = false;
  return 'saved';
}

/** A small setting that must never take a screen down with it when the storage is full. */
export function safeSetItem(storage: Pick<CacheStorage, 'setItem'>, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
