import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type Clip,
  type EditorAsset,
  clipLabel,
  describeRatio,
  expandGroups,
  frameSizeFor,
} from './types';

const clip = (patch: Partial<Clip> & { id: string }): Clip => ({
  trackId: 'V1',
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

describe('合组选择', () => {
  const clips = [
    clip({ id: 'shot', groupId: 'g1' }),
    clip({ id: 'sound', trackId: 'A1', groupId: 'g1' }),
    clip({ id: 'other', trackId: 'V2' }),
  ];

  it('选中组内任意一段即选中整组', () => {
    assert.deepEqual(expandGroups(clips, ['sound']).sort(), ['shot', 'sound']);
  });

  it('未合组的选择原样返回', () => {
    assert.deepEqual(expandGroups(clips, ['other']), ['other']);
  });

  it('混合选择保留组外的片段', () => {
    assert.deepEqual(expandGroups(clips, ['shot', 'other']).sort(), ['other', 'shot', 'sound']);
  });

  it('不会因重复选中而产生重复 id', () => {
    assert.deepEqual(expandGroups(clips, ['shot', 'sound']).sort(), ['shot', 'sound']);
  });
});

describe('片段命名', () => {
  const asset = { title: '视频镜头' } as EditorAsset;

  it('有名字就用名字', () => {
    assert.equal(clipLabel(clip({ id: 'c', name: '雨中回望' }), asset), '雨中回望');
  });

  it('没名字回落到素材标题', () => {
    assert.equal(clipLabel(clip({ id: 'c' }), asset), '视频镜头');
  });

  it('只有空格不算名字', () => {
    assert.equal(clipLabel(clip({ id: 'c', name: '   ' }), asset), '视频镜头');
  });

  it('未命名的字幕用第一行正文', () => {
    const text = { content: '第一行\n第二行' } as Clip['text'];
    assert.equal(clipLabel(clip({ id: 'c', text }), null), '字幕：第一行');
  });
});

describe('影片尺寸', () => {
  it('分辨率给的是短边，横竖屏都是 1080p', () => {
    assert.deepEqual(frameSizeFor(16 / 9, 1080), { width: 1920, height: 1080 });
    assert.deepEqual(frameSizeFor(9 / 16, 1080), { width: 1080, height: 1920 });
    assert.deepEqual(frameSizeFor(1, 1080), { width: 1080, height: 1080 });
  });

  it('两边都是偶数，yuv420p 才编得出来', () => {
    for (const quality of [720, 1080, 1440, 2160]) {
      for (const ratio of [21 / 9, 4 / 3, 4 / 5]) {
        const { width, height } = frameSizeFor(ratio, quality);
        assert.equal(width % 2, 0);
        assert.equal(height % 2, 0);
      }
    }
  });

  it('认得出常见比例，认不出的报小数', () => {
    assert.equal(describeRatio(1920, 1080), '16:9');
    assert.equal(describeRatio(1080, 1350), '4:5');
    assert.equal(describeRatio(1000, 540), '1.85:1');
  });
});
