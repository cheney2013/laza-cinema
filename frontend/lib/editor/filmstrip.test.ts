import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filmstripTiles } from './filmstrip';

const base = {
  inFrame: 0,
  outFrame: 240,
  sourceFrames: 240,
  thumbCount: 12,
  width: 480,
  height: 48,
  aspect: 16 / 9,
};

describe('片段上的缩略图条', () => {
  it('铺满整段素材时，缩略图从头往后递进', () => {
    const tiles = filmstripTiles(base);
    assert.ok(tiles.length > 1);
    const at = tiles.map((x) => Number.parseFloat(x.positionX));
    assert.equal(at[0], 0, '第一格就是片段的第一帧');
    // 每一格取的是这一格开头那一帧，所以最后一格不是素材的最末帧。
    assert.ok(at[at.length - 1] > 70, String(at));
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
  });

  it('剪过之后只取剪进来的那一段', () => {
    // 后四分之一：第一张缩略图应该来自素材的 9/12 附近，而不是开头。
    const tiles = filmstripTiles({ ...base, inFrame: 180, outFrame: 240 });
    assert.notEqual(tiles[0].positionX, '0%');
    assert.ok(Number.parseFloat(tiles[0].positionX) >= 70);
  });

  it('同一个片段切成两半，两半的缩略图不一样', () => {
    const left = filmstripTiles({ ...base, outFrame: 120, width: 240 });
    const right = filmstripTiles({ ...base, inFrame: 120, width: 240 });
    assert.notDeepEqual(left.map((x) => x.positionX), right.map((x) => x.positionX));
  });

  it('窄到放不下一张也给一张', () => {
    assert.equal(filmstripTiles({ ...base, width: 12 }).length, 1);
  });

  it('没有缩略图或没有长度就不画', () => {
    assert.deepEqual(filmstripTiles({ ...base, thumbCount: 0 }), []);
    assert.deepEqual(filmstripTiles({ ...base, outFrame: 0 }), []);
  });
});
