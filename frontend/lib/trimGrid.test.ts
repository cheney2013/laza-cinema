import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gridEnds, latentCut, onGrid, snapEnd } from './trimGrid';

describe('trimGrid', () => {
  it('knows the 17n+5 lengths', () => {
    assert.deepEqual([5, 22, 175, 192, 209].map(onGrid), [true, true, true, true, true]);
    assert.deepEqual([0, 4, 23, 180, 208].map(onGrid), [false, false, false, false, false]);
  });

  it('lists the grid ends of a 209-frame clip', () => {
    assert.deepEqual(gridEnds(209), [5, 22, 39, 56, 73, 90, 107, 124, 141, 158, 175, 192, 209]);
  });

  it('counts the context of a chained clip from the head of its latent', () => {
    // 22 frames of context: served frame 175 would be 197 on the latent, not on the grid
    assert.equal(gridEnds(209, 22).includes(175), false);
    assert.equal(gridEnds(209, 22).includes(170), true); // 22 + 170 = 192
  });

  it('snaps to the nearest grid end only inside the threshold', () => {
    const ends = gridEnds(209);
    assert.equal(snapEnd(180, ends, 6), 175);
    assert.equal(snapEnd(184, ends, 6), 184);
    assert.equal(snapEnd(188, ends, 6), 192);
    assert.equal(snapEnd(100, ends, 3), 100);
  });

  it('says whether a cut keeps its latent, and why not', () => {
    const base = { totalFrames: 209, contextFrames: 0, hasLatent: true };
    assert.deepEqual(latentCut({ ...base, start: 0, end: 175 }), { ok: true, reason: 'ok', before: 158, after: 192 });
    const off = latentCut({ ...base, start: 0, end: 180 });
    assert.equal(off.ok, false);
    assert.equal(off.reason, 'grid');
    assert.equal(off.before, 175);
    assert.equal(off.after, 192);
    assert.equal(latentCut({ ...base, start: 10, end: 175 }).reason, 'start');
    assert.equal(latentCut({ ...base, hasLatent: false, start: 0, end: 175 }).reason, 'no-latent');
    assert.equal(latentCut({ ...base, start: 0, end: 209 }).ok, true);
  });
});
