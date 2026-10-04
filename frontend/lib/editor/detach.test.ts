import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planDetach } from './detach';

const clip = (id: string, trackId: string, assetId: string, extra: Record<string, unknown> = {}) =>
  ({ id, trackId, assetId, start: 0, ...extra }) as any;
const tracks: any[] = [
  { id: 'V1', kind: 'video' }, { id: 'A1', kind: 'audio' },
];
const assets: any = {
  talk: { hasAudio: true }, silent: { hasAudio: false }, gone: { hasAudio: false, offline: true },
};

describe('planDetach', () => {
  it('takes every selected picture clip that still has its sound', () => {
    const plan = planDetach([clip('a', 'V1', 'talk'), clip('b', 'V1', 'talk')], tracks, assets, ['a', 'b']);
    assert.deepEqual(plan.sources.map((c) => c.id), ['a', 'b']);
    assert.equal(plan.message, null);
  });

  it('says so when nothing is selected', () => {
    const plan = planDetach([clip('a', 'V1', 'talk')], tracks, assets, []);
    assert.equal(plan.sources.length, 0);
    assert.match(plan.message!, /先选中/);
  });

  it('explains a clip that is already muted (detached before) and one on an audio lane', () => {
    const muted = planDetach([clip('a', 'V1', 'talk', { muted: true })], tracks, assets, ['a']);
    assert.equal(muted.sources.length, 0);
    assert.match(muted.message!, /已经静音/);
    const lane = planDetach([clip('a', 'A1', 'talk')], tracks, assets, ['a']);
    assert.match(lane.message!, /音频轨上的片段/);
  });

  it('explains a title, an asset without sound and an offline asset', () => {
    assert.match(planDetach([clip('a', 'V1', 'talk', { text: { content: 'x' } })], tracks, assets, ['a']).message!, /标题/);
    assert.match(planDetach([clip('a', 'V1', 'silent')], tracks, assets, ['a']).message!, /没有音轨/);
    assert.match(planDetach([clip('a', 'V1', 'gone')], tracks, assets, ['a']).message!, /离线/);
  });

  it('detaches what it can and says what it passed over', () => {
    const plan = planDetach(
      [clip('a', 'V1', 'talk'), clip('b', 'V1', 'talk', { muted: true }), clip('c', 'V1', 'talk', { muted: true })],
      tracks, assets, ['a', 'b', 'c']);
    assert.deepEqual(plan.sources.map((c) => c.id), ['a']);
    assert.match(plan.message!, /已分离 1 段/);
    assert.match(plan.message!, /另外 2 段/);
    assert.match(plan.message!, /已经静音/);
  });
});
