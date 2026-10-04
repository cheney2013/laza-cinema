import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { EDGES_BUDGET, NODES_BUDGET, cacheCanvas, resetCanvasCache, safeSetItem } from './canvasCache';

class FakeStorage {
  data = new Map<string, string>();
  sets = 0;
  capacity: number;
  constructor(capacity = Infinity) {
    this.capacity = capacity;
  }
  setItem(key: string, value: string) {
    this.sets += 1;
    const used = [...this.data].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), 0);
    if (used + key.length + value.length > this.capacity) throw new DOMException('quota', 'QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string) { this.data.delete(key); }
}

const nodes = (count: number, size = 10) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, data: { p: 'x'.repeat(size) } }));

describe('cacheCanvas', () => {
  beforeEach(() => resetCanvasCache());

  it('keeps a small canvas, as it always did', () => {
    const s = new FakeStorage();
    assert.equal(cacheCanvas(s, 'n', 'e', nodes(5), [{ id: 'e1' }]), 'saved');
    assert.deepEqual(JSON.parse(s.data.get('n')!).length, 5);
    assert.ok(s.data.has('e'));
  });

  it('does not write a canvas over the budget, and removes the older copy so a fallback cannot bring it back', () => {
    const s = new FakeStorage();
    cacheCanvas(s, 'n', 'e', nodes(3), []);                       // an older, smaller save
    const said: string[] = [];
    const big = nodes(1, NODES_BUDGET + 10);                       // one node whose text alone is over the budget
    assert.equal(cacheCanvas(s, 'n', 'e', big, [], (m) => said.push(m)), 'too-big');
    assert.equal(s.data.has('n'), false);
    assert.equal(s.data.has('e'), false);
    assert.equal(said.length, 1);
    assert.match(said[0], /不再保存浏览器本地备份/);
  });

  it('survives a full storage without throwing, drops what it had and says so once', () => {
    const s = new FakeStorage(200);
    cacheCanvas(s, 'n', 'e', nodes(1), []);                        // fits
    const said: string[] = [];
    assert.equal(cacheCanvas(s, 'n', 'e', nodes(40), [], (m) => said.push(m)), 'full');
    assert.equal(s.data.size, 0);
    assert.equal(cacheCanvas(s, 'n', 'e', nodes(41), [], (m) => said.push(m)), 'full');
    assert.equal(said.length, 1);                                  // not on every autosave
  });

  it('does not serialise a canvas again while it is still about as big as the one that was too big', () => {
    const s = new FakeStorage();
    const huge = nodes(1, NODES_BUDGET + 10);
    assert.equal(cacheCanvas(s, 'n', 'e', huge, []), 'too-big');
    let touched = 0;
    const spy = new Proxy(huge, { get(t, p, r) { touched += 1; return Reflect.get(t, p, r); } });
    assert.equal(cacheCanvas(s, 'n', 'e', spy, []), 'too-big');
    assert.equal(touched, 1);                                      // only .length was read
  });

  it('caches again once the canvas is clearly smaller, e.g. after switching to a small project', () => {
    const s = new FakeStorage();
    cacheCanvas(s, 'n', 'e', Array.from({ length: 10 }, (_, i) => ({ id: i, p: 'x'.repeat(NODES_BUDGET) })), []);
    assert.equal(s.data.size, 0);
    assert.equal(cacheCanvas(s, 'n', 'e', nodes(3), []), 'saved');
    assert.ok(s.data.has('n'));
  });

  it('counts the edges against their own budget', () => {
    const s = new FakeStorage();
    const edges = [{ id: 'e', label: 'x'.repeat(EDGES_BUDGET) }];
    assert.equal(cacheCanvas(s, 'n', 'e', nodes(2), edges), 'too-big');
  });
});

describe('safeSetItem', () => {
  it('reports a failure instead of throwing', () => {
    assert.equal(safeSetItem(new FakeStorage(), 'k', 'v'), true);
    assert.equal(safeSetItem(new FakeStorage(3), 'key', 'value'), false);
  });
});
