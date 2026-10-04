import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adoptFirstFrameSize, defaultClip, emptyTimeline, type Timeline } from './types';

function film(): Timeline {
  const timeline = emptyTimeline();
  timeline.assets = {
    tall: { width: 768, height: 1376 } as Timeline['assets'][string],
    wide: { width: 1376, height: 768 } as Timeline['assets'][string],
  };
  return timeline;
}

describe('影片尺寸跟随首帧素材', () => {
  it('取最早的视频片段的分辨率', () => {
    const timeline = film();
    timeline.clips = [
      defaultClip({ id: 'b', trackId: 'V1', assetId: 'wide', start: 100, inFrame: 0, outFrame: 10 }),
      defaultClip({ id: 'a', trackId: 'V1', assetId: 'tall', start: 0, inFrame: 0, outFrame: 10 }),
    ];
    const out = adoptFirstFrameSize(timeline);
    assert.equal(out.width, 768);
    assert.equal(out.height, 1376);
  });

  it('手动改过就不再跟随', () => {
    const timeline = { ...film(), width: 1920, height: 1080, frameSizeManual: true };
    timeline.clips = [defaultClip({ id: 'a', trackId: 'V1', assetId: 'tall', start: 0, inFrame: 0, outFrame: 10 })];
    assert.equal(adoptFirstFrameSize(timeline), timeline);
  });
});
