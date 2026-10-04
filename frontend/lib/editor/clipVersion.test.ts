import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { repointClipVersion } from './clipVersion';
import type { Clip, EditorAsset, Timeline } from './types';

const asset = (patch: Partial<EditorAsset> & { id: string }): EditorAsset => ({
  nodeId: 'n1', url: '/a.mp4', title: 'shot', kind: 'video', width: 1376, height: 768,
  fps: 24, frames: 240, timelineFrames: 240, hasAudio: true, ...patch,
});

const clip = (patch: Partial<Clip> & { id: string }): Clip => ({
  trackId: 'V1', assetId: 'a1', start: 0, inFrame: 0, outFrame: 100, speed: 1, volume: 1,
  muted: false, fadeIn: 0, fadeOut: 0, ...patch,
} as Clip);

const timeline = (assets: EditorAsset[], clips: Clip[]): Timeline => ({
  fps: 24, width: 1376, height: 768, tracks: [], clips,
  assets: Object.fromEntries(assets.map((a) => [a.id, a])),
} as unknown as Timeline);

describe('repointClipVersion', () => {
  it('moves only the chosen clip when its shot is cut into several', () => {
    const tl = timeline(
      [asset({ id: 'a1' })],
      [clip({ id: 'c1', inFrame: 0, outFrame: 60 }), clip({ id: 'c2', inFrame: 60, outFrame: 120 })],
    );
    const out = repointClipVersion(tl, 'c2', asset({ id: 'x', url: '/b.mp4' }), 'a2');
    assert.equal(out.clips.find((c) => c.id === 'c1')?.assetId, 'a1');
    assert.equal(out.clips.find((c) => c.id === 'c2')?.assetId, 'a2');
    assert.equal(out.assets.a1.url, '/a.mp4');
    assert.equal(out.assets.a2.url, '/b.mp4');
  });

  it('changes the asset in place when the clip is its only user', () => {
    const tl = timeline([asset({ id: 'a1' })], [clip({ id: 'c1' })]);
    const out = repointClipVersion(tl, 'c1', asset({ id: 'x', url: '/b.mp4' }), 'a2');
    assert.deepEqual(Object.keys(out.assets), ['a1']);
    assert.equal(out.assets.a1.url, '/b.mp4');
    assert.equal(out.clips[0].assetId, 'a1');
  });

  it('reuses the asset already holding that file instead of making another', () => {
    const tl = timeline(
      [asset({ id: 'a1' }), asset({ id: 'a2', url: '/b.mp4' })],
      [clip({ id: 'c1' }), clip({ id: 'c2' }), clip({ id: 'c3', assetId: 'a2' })],
    );
    const out = repointClipVersion(tl, 'c2', asset({ id: 'x', url: '/b.mp4' }), 'a9');
    assert.equal(out.clips.find((c) => c.id === 'c2')?.assetId, 'a2');
    assert.equal(out.assets.a9, undefined);
  });

  it('shifts the cut by the difference in head overlap and keeps it inside the file', () => {
    const tl = timeline(
      [asset({ id: 'a1', chainHead: { trimmedUrl: '/t.mp4', frames: 22 } })],
      [clip({ id: 'c1', inFrame: 22, outFrame: 100 }), clip({ id: 'c2', inFrame: 22, outFrame: 40 })],
    );
    const out = repointClipVersion(tl, 'c1', asset({ id: 'x', url: '/b.mp4', timelineFrames: 90 }), 'a2');
    const moved = out.clips.find((c) => c.id === 'c1')!;
    assert.equal(moved.inFrame, 0); // 22 - 22: the new file has no overlap at its head
    assert.equal(moved.outFrame, 78); // 100 - 22

    const plain = timeline([asset({ id: 'a1' })], [clip({ id: 'c1', outFrame: 100 }), clip({ id: 'c2' })]);
    const short = repointClipVersion(plain, 'c1', asset({ id: 'x', url: '/c.mp4', timelineFrames: 70 }), 'a3');
    assert.equal(short.clips.find((c) => c.id === 'c1')?.outFrame, 70);
  });
});
