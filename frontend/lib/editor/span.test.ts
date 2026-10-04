import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Clip, clipEnd, clipInSpan, clipOutsideSpan } from './types';

const clip = (patch: Partial<Clip> & { id: string }): Clip => ({
  trackId: 'A1',
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

describe('取片段落在某一段里的部分', () => {
  it('完全在外面就没有', () => {
    assert.equal(clipInSpan(clip({ id: 'c', start: 0 }), 100, 200), null);
  });

  it('切头切尾都跟着改素材内的取点', () => {
    const piece = clipInSpan(clip({ id: 'c', start: 90, inFrame: 10, outFrame: 58 }), 100, 120)!;
    assert.equal(piece.start, 0);
    assert.equal(piece.inFrame, 20, '头上切掉 10 帧，取点前进 10');
    assert.equal(piece.outFrame, 40, '尾巴上切掉 18 帧');
    assert.equal(clipEnd(piece), 20);
  });

  it('变速片段按倍速换算取点', () => {
    const piece = clipInSpan(clip({ id: 'c', start: 90, speed: 2, outFrame: 96 }), 100, 140)!;
    // 2 倍速：时间线上切 10 帧等于素材里的 20 帧。
    assert.equal(piece.inFrame, 20);
  });
});

describe('把一段从片段里挖掉', () => {
  const newId = (() => {
    let n = 0;
    return () => `new${++n}`;
  })();

  it('整段被吃掉就什么都不剩', () => {
    assert.deepEqual(clipOutsideSpan(clip({ id: 'c', start: 10, outFrame: 20 }), 0, 100, newId), []);
  });

  it('中间被挖掉会留下前后两段', () => {
    const rest = clipOutsideSpan(clip({ id: 'c', start: 0, outFrame: 100 }), 40, 60, newId);
    assert.equal(rest.length, 2);
    assert.deepEqual([rest[0].start, clipEnd(rest[0])], [0, 40]);
    assert.deepEqual([rest[1].start, clipEnd(rest[1])], [60, 100]);
    assert.notEqual(rest[1].id, 'c', '后半段是新片段，不能和前半段同 id');
    assert.equal(rest[0].outFrame, 40);
    assert.equal(rest[1].inFrame, 60, '后半段从素材的第 60 帧接着放');
  });

  it('变速片段挖掉中间，取点按倍速换算', () => {
    const rest = clipOutsideSpan(clip({ id: 'c', start: 0, speed: 2, outFrame: 200 }), 40, 60, newId);
    assert.equal(rest[1].inFrame, 120);
  });

  it('碰不到的片段原样返回', () => {
    const untouched = clip({ id: 'c', start: 200 });
    assert.deepEqual(clipOutsideSpan(untouched, 0, 100, newId), [untouched]);
  });
});
