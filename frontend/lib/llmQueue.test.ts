import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createLlmQueue } from './llmQueue';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LLM request queue', () => {
  it('runs one call at a time', async () => {
    const queue = createLlmQueue(0);
    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      return 'ok';
    };

    await Promise.all([1, 2, 3, 4].map(() => queue.request(null, work)));
    assert.equal(peak, 1);
  });

  it('keeps a floor between departures', async () => {
    const queue = createLlmQueue(60);
    const starts: number[] = [];
    const work = async () => {
      starts.push(Date.now());
      return 'ok';
    };

    await Promise.all([queue.request(null, work), queue.request(null, work)]);
    assert.equal(starts.length, 2);
    // Two calls fired back to back leave at least the gap apart.
    assert.ok(starts[1] - starts[0] >= 55, `gap was ${starts[1] - starts[0]}ms`);
  });

  it('shares one call between identical concurrent requests', async () => {
    const queue = createLlmQueue(0);
    let calls = 0;
    const gate = deferred<string>();
    const work = () => {
      calls += 1;
      return gate.promise;
    };

    const a = queue.request('same', work);
    const b = queue.request('same', work);
    assert.equal(a, b);

    gate.resolve('译文');
    assert.deepEqual(await Promise.all([a, b]), ['译文', '译文']);
    assert.equal(calls, 1);
  });

  it('does not share a key once the first call has settled', async () => {
    const queue = createLlmQueue(0);
    let calls = 0;
    const work = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await queue.request('same', work), 1);
    assert.equal(await queue.request('same', work), 2);
    assert.equal(queue.pending(), 0);
  });

  it('is not wedged by a failed call', async () => {
    // One rejected link used to poison the chain every later call waits on.
    const queue = createLlmQueue(0);
    await assert.rejects(
      queue.request(null, async () => {
        throw new Error('429');
      }),
      /429/,
    );
    assert.equal(await queue.request(null, async () => 'ok'), 'ok');
  });

  it('reports a rejection to its sharers, not to the queue', async () => {
    const queue = createLlmQueue(0);
    const gate = deferred<string>();
    const a = queue.request('same', () => gate.promise);
    const b = queue.request('same', () => gate.promise);

    gate.reject(new Error('限流'));
    await assert.rejects(a, /限流/);
    await assert.rejects(b, /限流/);
    assert.equal(await queue.request(null, async () => 'ok'), 'ok');
  });
});
