import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { pushTrail, useCanvasNav } from './canvasNav';

describe('canvas back trail', () => {
  it('keeps distinct places in order', () => {
    let trail = pushTrail([], { x: 0, y: 0, zoom: 1 });
    trail = pushTrail(trail, { x: -900, y: 200, zoom: 1 });
    assert.deepEqual(trail.map((v) => v.x), [0, -900]);
  });

  it('ignores a jump from where the last one started', () => {
    const trail = pushTrail([{ x: 0, y: 0, zoom: 1 }], { x: 10, y: 5, zoom: 1 });
    assert.equal(trail.length, 1);
  });

  it('keeps a same-spot view at another zoom', () => {
    const trail = pushTrail([{ x: 0, y: 0, zoom: 1 }], { x: 0, y: 0, zoom: 0.4 });
    assert.equal(trail.length, 2);
  });

  it('is capped', () => {
    let trail: ReturnType<typeof pushTrail> = [];
    for (let i = 0; i < 50; i += 1) trail = pushTrail(trail, { x: i * 1000, y: 0, zoom: 1 });
    assert.equal(trail.length, 20);
    assert.equal(trail[19].x, 49000);
  });

  it('back returns the latest place and drops it', () => {
    const nav = useCanvasNav.getState();
    nav.clear();
    nav.remember({ x: 0, y: 0, zoom: 1 });
    nav.remember({ x: 500, y: 0, zoom: 1 });
    assert.equal(useCanvasNav.getState().back()?.x, 500);
    assert.equal(useCanvasNav.getState().back()?.x, 0);
    assert.equal(useCanvasNav.getState().back(), null);
  });
});
