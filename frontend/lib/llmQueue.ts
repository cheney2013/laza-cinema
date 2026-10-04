/**
 * One LLM request at a time, and not too often.
 *
 * 译, ✨ 改写, 起草 and 读图 all go to the same provider on the same key, and that
 * key is rate limited. The console makes a burst trivial to produce: 译 on six
 * fields in six seconds is six requests, and the provider answers the last four
 * with 429. That is not something the director should have to pace by hand, so
 * the pacing lives here.
 *
 * Three rules:
 *
 * - **One in flight.** A burst becomes a queue instead of a spike.
 * - **A floor between departures.** Even a slow answer does not license the next
 *   request to leave immediately behind it.
 * - **Identical overlapping requests share one answer.** Two callers asking for
 *   the same translation is one call, not two.
 *
 * The server side still retries a 429 with backoff (`_llm.ts`); this only keeps
 * the client from producing them in the first place.
 */

export interface LlmQueue {
  /**
   * Queue one call. `key` deduplicates concurrent identical requests — pass `null`
   * when the same inputs may legitimately be asked twice (a rewrite, a draft).
   */
  request<T>(key: string | null, run: () => Promise<T>): Promise<T>;
  /** How many keyed calls are outstanding, for a "排队中" hint. */
  pending(): number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLlmQueue(minGapMs: number): LlmQueue {
  /** The tail of the chain. Every new request waits on it, failures included. */
  let tail: Promise<unknown> = Promise.resolve();
  let lastDeparture = 0;
  const inflight = new Map<string, Promise<unknown>>();

  return {
    request<T>(key: string | null, run: () => Promise<T>): Promise<T> {
      if (key) {
        const shared = inflight.get(key) as Promise<T> | undefined;
        if (shared) return shared;
      }

      const started = tail.then(async () => {
        const wait = minGapMs - (Date.now() - lastDeparture);
        if (wait > 0) await sleep(wait);
        lastDeparture = Date.now();
        return run();
      });

      // The chain must survive a rejected link, or one failed call blocks every
      // call behind it for the rest of the session.
      tail = started.catch(() => undefined);

      if (key) {
        inflight.set(key, started);
        const forget = () => {
          if (inflight.get(key) === started) inflight.delete(key);
        };
        // Both handlers, so this branch is never an unhandled rejection.
        void started.then(forget, forget);
      }

      return started;
    },
    pending: () => inflight.size,
  };
}

/** The one queue the whole app shares, because the quota is shared too. */
const shared = createLlmQueue(1100);

export function llmRequest<T>(key: string | null, run: () => Promise<T>): Promise<T> {
  return shared.request(key, run);
}

export function llmQueueLength(): number {
  return shared.pending();
}
