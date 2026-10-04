import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeGap, laneGapsOf, rulerGaps } from './gap';
import type { Clip, Track } from './types';

const clip = (patch: Partial<Clip> & { id: string; trackId: string; start: number }): Clip => ({
  assetId: 'a1', inFrame: 0, outFrame: 24, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...patch,
} as Clip);

const track = (id: string, patch: Partial<Track> = {}): Track =>
  ({ id, kind: id.startsWith('A') ? 'audio' : 'video', name: id, muted: false, locked: false, ...patch } as Track);

const startsOf = (clips: Clip[]) => Object.fromEntries(clips.map((c) => [c.id, c.start]));

describe('closeGap', () => {
  const tracks = [track('V1'), track('V2'), track('A1')];

  it('a hole in one lane closes that lane only', () => {
    const clips = [
      clip({ id: 'v1a', trackId: 'V1', start: 0 }),
      clip({ id: 'v1b', trackId: 'V1', start: 48 }),        // after a 24-frame hole at 24..48
      clip({ id: 'v2a', trackId: 'V2', start: 50 }),
      clip({ id: 'a1a', trackId: 'A1', start: 60 }),
    ];
    const out = closeGap(clips, tracks, 24, 48, 'V1', 'off');
    assert.deepEqual(startsOf(out), { v1a: 0, v1b: 24, v2a: 50, a1a: 60 });
  });

  it('takes the clips grouped with the moved ones along, on any lane', () => {
    const clips = [
      clip({ id: 'v1b', trackId: 'V1', start: 48, groupId: 'g' }),
      clip({ id: 'a1b', trackId: 'A1', start: 48, groupId: 'g' }),
      clip({ id: 'a1c', trackId: 'A1', start: 90 }),
    ];
    const out = closeGap(clips, tracks, 24, 48, 'V1', 'track');
    assert.deepEqual(startsOf(out), { v1b: 24, a1b: 24, a1c: 90 });
  });

  it('with ripple on all lanes, a lane gap takes every unlocked lane along', () => {
    const clips = [
      clip({ id: 'v1b', trackId: 'V1', start: 48 }),
      clip({ id: 'v2a', trackId: 'V2', start: 50 }),
      clip({ id: 'a1a', trackId: 'A1', start: 60 }),
    ];
    assert.deepEqual(startsOf(closeGap(clips, tracks, 24, 48, 'V1', 'all')), { v1b: 24, v2a: 26, a1a: 36 });
  });

  it('the ruler gap closes every lane, audio included', () => {
    const clips = [
      clip({ id: 'v1b', trackId: 'V1', start: 48 }),
      clip({ id: 'v2a', trackId: 'V2', start: 50 }),
      clip({ id: 'a1a', trackId: 'A1', start: 60 }),
    ];
    for (const ripple of ['off', 'track', 'all'] as const) {
      assert.deepEqual(startsOf(closeGap(clips, tracks, 24, 48, undefined, ripple)), { v1b: 24, v2a: 26, a1a: 36 });
    }
  });

  it('the ruler gap takes a shot grouped sound along, moves the other sound lanes too, and skips a locked lane', () => {
    const clips = [
      clip({ id: 'v1b', trackId: 'V1', start: 48, groupId: 'g' }),
      clip({ id: 'a1b', trackId: 'A1', start: 48, groupId: 'g' }),
      clip({ id: 'a1c', trackId: 'A1', start: 90 }),
      clip({ id: 'v2a', trackId: 'V2', start: 60 }),
    ];
    assert.deepEqual(startsOf(closeGap(clips, tracks, 24, 48, undefined, 'off')), { v1b: 24, a1b: 24, a1c: 66, v2a: 36 });
    const lockedV2 = [track('V1'), track('V2', { locked: true }), track('A1')];
    assert.deepEqual(startsOf(closeGap(clips, lockedV2, 24, 48, undefined, 'off')), { v1b: 24, a1b: 24, a1c: 66, v2a: 60 });
    const lockedA1 = [track('V1'), track('V2'), track('A1', { locked: true })];
    assert.deepEqual(startsOf(closeGap(clips, lockedA1, 24, 48, undefined, 'off')), { v1b: 24, a1b: 48, a1c: 90, v2a: 36 });
  });

  it('never moves a locked lane, and never pulls a group before frame 0', () => {
    const locked = [track('V1', { locked: true }), track('V2'), track('A1')];
    const clips = [clip({ id: 'v1b', trackId: 'V1', start: 48 })];
    assert.equal(closeGap(clips, locked, 24, 48, 'V1', 'off'), clips);

    const grouped = [
      clip({ id: 'v1b', trackId: 'V1', start: 48, groupId: 'g' }),
      clip({ id: 'a1b', trackId: 'A1', start: 10, groupId: 'g' }),
    ];
    // A 24-frame gap, but the group's earliest clip is at 10: it moves 10, not 24.
    assert.deepEqual(startsOf(closeGap(grouped, tracks, 24, 48, 'V1', 'off')), { v1b: 38, a1b: 0 });
  });
});

describe('ruler gaps', () => {
  const lanes = [track('V1'), track('SUB_1', { kind: 'video' } as Partial<Track>), track('A1')];

  it('only holes between video clips count; subtitles and sound neither fill nor make them', () => {
    const clips = [
      clip({ id: 'v1a', trackId: 'V1', start: 0, outFrame: 24 }),
      clip({ id: 'v1b', trackId: 'V1', start: 60, outFrame: 24 }),
      // a subtitle across the hole and a sound under it: still a hole
      clip({ id: 'sub', trackId: 'SUB_1', start: 24, outFrame: 24 }),
      clip({ id: 'a1a', trackId: 'A1', start: 30, outFrame: 24 }),
      // and a subtitle past the last shot does not extend the film
      clip({ id: 'sub2', trackId: 'SUB_1', start: 200, outFrame: 24 }),
    ];
    assert.deepEqual(rulerGaps(clips, lanes), [[24, 60]]);
  });

  it('a text clip on an ordinary video lane is not a shot either', () => {
    const clips = [
      clip({ id: 'v1a', trackId: 'V1', start: 0, outFrame: 24 }),
      clip({ id: 'title', trackId: 'V1', start: 24, outFrame: 24, text: { content: 'x' } as never }),
      clip({ id: 'v1b', trackId: 'V1', start: 60, outFrame: 24 }),
    ];
    assert.deepEqual(rulerGaps(clips, lanes), [[24, 60]]);
  });

  it('lane gaps are drawn for picture lanes only: none for the subtitle lane or the audio lane', () => {
    const clips = [
      clip({ id: 'v1b', trackId: 'V1', start: 40, outFrame: 24 }),
      clip({ id: 'sub', trackId: 'SUB_1', start: 40, outFrame: 24 }),
      clip({ id: 'a1a', trackId: 'A1', start: 40, outFrame: 24 }),
    ];
    const out = laneGapsOf(clips, lanes);
    assert.deepEqual([...out.keys()], ['V1']);
    assert.deepEqual(out.get('V1'), [[0, 40]]);
  });
});
