import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupEdges, groupLanes } from './groupMove';
import { defaultClip, type Track } from './types';

const track = (id: string, locked = false): Track => ({ id, kind: 'video', name: id, muted: false, locked });
const tracks = [track('V1'), track('V2'), track('V3'), track('V4')];

describe('groupLanes', () => {
  it('carries every clip by the same number of lanes', () => {
    const out = groupLanes([{ id: 'a', trackId: 'V1' }, { id: 'b', trackId: 'V2' }], tracks, 1);
    assert.equal(out.delta, 1);
    assert.deepEqual(out.tracks, { a: 'V2', b: 'V3' });
  });

  it('shrinks the move until the whole group fits on the track list', () => {
    const out = groupLanes([{ id: 'a', trackId: 'V3' }, { id: 'b', trackId: 'V4' }], tracks, 2);
    assert.equal(out.delta, 0);
    assert.deepEqual(out.tracks, { a: 'V3', b: 'V4' });
    const up = groupLanes([{ id: 'a', trackId: 'V2' }, { id: 'b', trackId: 'V3' }], tracks, 5);
    assert.equal(up.delta, 1);
  });

  it('does not land on a locked track', () => {
    const locked = [track('V1'), track('V2', true), track('V3')];
    const out = groupLanes([{ id: 'a', trackId: 'V1' }], locked, 1);
    assert.equal(out.delta, 0);
    assert.deepEqual(out.tracks, { a: 'V1' });
  });

  it('a delta of 0 changes nothing', () => {
    assert.deepEqual(groupLanes([{ id: 'a', trackId: 'V2' }], tracks, 0).tracks, { a: 'V2' });
  });
});

describe('groupEdges', () => {
  it('is the earliest start and the latest end of the whole group', () => {
    const clip = (id: string, start: number, length: number) =>
      defaultClip({ id, trackId: 'V1', assetId: 'x', start, inFrame: 0, outFrame: length });
    assert.deepEqual(groupEdges([clip('a', 10, 20), clip('b', 40, 5), clip('c', 25, 30)], 3), [13, 58]);
  });
});
