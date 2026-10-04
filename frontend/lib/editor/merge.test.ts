import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Clip, type Timeline, adjacentRuns, canMergeClips, emptyTimeline, mergeRuns } from './types';

const clip = (patch: Partial<Clip> & { id: string }): Clip => ({
  trackId: 'v1',
  assetId: 'a1',
  start: 0,
  inFrame: 0,
  outFrame: 48,
  speed: 1,
  volume: 1,
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
  ...patch,
});

/** A shot split at frame 48, exactly as splitAtPlayhead leaves it. */
function splitPair(): Timeline {
  const timeline = emptyTimeline();
  timeline.tracks = [{ id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false }];
  timeline.clips = [
    clip({ id: 'left', start: 0, inFrame: 0, outFrame: 48 }),
    clip({ id: 'right', start: 48, inFrame: 48, outFrame: 96 }),
  ];
  return timeline;
}

describe('merge', () => {
  it('joins the two halves of a split', () => {
    const timeline = splitPair();
    const runs = mergeRuns(timeline, ['left', 'right']);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((c) => c.id), ['left', 'right']);
  });

  it('joins a run of three in timeline order, whatever order they were selected in', () => {
    const timeline = splitPair();
    timeline.clips.push(clip({ id: 'third', start: 96, inFrame: 96, outFrame: 144 }));
    const runs = mergeRuns(timeline, ['third', 'left', 'right']);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((c) => c.id), ['left', 'right', 'third']);
  });

  it('refuses pieces that were trimmed after the split', () => {
    const timeline = splitPair();
    timeline.clips[1] = { ...timeline.clips[1], inFrame: 60 };
    assert.equal(mergeRuns(timeline, ['left', 'right']).length, 0);
  });

  it('refuses a gap on the timeline, a different source, and a speed change', () => {
    const gap = splitPair();
    gap.clips[1] = { ...gap.clips[1], start: 60 };
    assert.equal(mergeRuns(gap, ['left', 'right']).length, 0);

    const other = splitPair();
    other.clips[1] = { ...other.clips[1], assetId: 'a2' };
    assert.equal(mergeRuns(other, ['left', 'right']).length, 0);

    const fast = splitPair();
    fast.clips[1] = { ...fast.clips[1], speed: 2, start: 48 };
    assert.equal(mergeRuns(fast, ['left', 'right']).length, 0);
  });

  it('refuses to swallow a transition, and refuses a locked track', () => {
    const dressed = splitPair();
    dressed.clips[1] = { ...dressed.clips[1], transitionIn: { type: 'dissolve', frames: 12 } };
    assert.equal(mergeRuns(dressed, ['left', 'right']).length, 0);

    const locked = splitPair();
    locked.tracks[0] = { ...locked.tracks[0], locked: true };
    assert.equal(mergeRuns(locked, ['left', 'right']).length, 0);
  });

  it('joins identical titles but not differing ones', () => {
    const text = { content: 'hi', size: 48, color: '#fff', strokeColor: '#000', strokeWidth: 0, x: 0.5, y: 0.85, align: 'center' as const, fontWeight: 700 };
    const left = clip({ id: 'left', assetId: '', text });
    const right = clip({ id: 'right', start: 48, inFrame: 48, outFrame: 96, assetId: '', text });
    assert.equal(canMergeClips(left, right), true);
    assert.equal(canMergeClips(left, { ...right, text: { ...text, content: 'bye' } }), false);
  });
});

describe('adjacentRuns', () => {
  it('takes pieces mergeRuns refuses, as long as they touch', () => {
    const mixed = splitPair();
    // Different source, different speed, and a trim that broke continuity —
    // none of it matters to a render.
    mixed.clips[1] = { ...mixed.clips[1], assetId: 'a2', speed: 2, inFrame: 120, outFrame: 216 };
    assert.equal(mergeRuns(mixed, ['left', 'right']).length, 0);
    const runs = adjacentRuns(mixed, ['left', 'right']);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((c) => c.id), ['left', 'right']);
  });

  it('counts a dissolve as touching, since the overlap is exactly its length', () => {
    const dressed = splitPair();
    dressed.clips[1] = {
      ...dressed.clips[1],
      start: 36,
      transitionIn: { type: 'dissolve', frames: 12 },
    };
    assert.equal(adjacentRuns(dressed, ['left', 'right']).length, 1);
  });

  it('refuses a gap, another track, a locked track and a bypassed piece', () => {
    const gap = splitPair();
    gap.clips[1] = { ...gap.clips[1], start: 60 };
    assert.equal(adjacentRuns(gap, ['left', 'right']).length, 0);

    const other = splitPair();
    other.tracks.push({ id: 'v2', kind: 'video', name: 'V2', muted: false, locked: false });
    other.clips[1] = { ...other.clips[1], trackId: 'v2', start: 0 };
    assert.equal(adjacentRuns(other, ['left', 'right']).length, 0);

    const locked = splitPair();
    locked.tracks[0] = { ...locked.tracks[0], locked: true };
    assert.equal(adjacentRuns(locked, ['left', 'right']).length, 0);

    const bypassed = splitPair();
    bypassed.clips[1] = { ...bypassed.clips[1], bypassed: true };
    assert.equal(adjacentRuns(bypassed, ['left', 'right']).length, 0);
  });
});
