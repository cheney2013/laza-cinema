import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clampCrop, placeClip, rotatedSize } from './geometry';
import type { Clip } from './types';

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: 'c',
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

describe('画面几何', () => {
  it('四分之一转会交换宽高，半转不会', () => {
    assert.deepEqual(rotatedSize(1920, 1080, 90), { width: 1080, height: 1920 });
    assert.deepEqual(rotatedSize(1920, 1080, 270), { width: 1080, height: 1920 });
    assert.deepEqual(rotatedSize(1920, 1080, 180), { width: 1920, height: 1080 });
  });

  it('比例相同时完整铺满整个画框', () => {
    const place = placeClip(1920, 1080, clip(), 1280, 720);
    assert.deepEqual(
      { x: place!.destX, y: place!.destY, w: place!.destW, h: place!.destH },
      { x: 0, y: 0, w: 1280, h: 720 }
    );
  });

  it('横片放进竖画框：留黑时上下居中', () => {
    const place = placeClip(1920, 1080, clip(), 1080, 1920)!;
    assert.equal(place.destW, 1080);
    assert.equal(place.destH, 607.5);
    assert.equal(place.destX, 0);
    assert.equal(place.destY, (1920 - 607.5) / 2);
  });

  it('横片放进竖画框：填满时高度铺满、宽度溢出', () => {
    const place = placeClip(1920, 1080, clip({ fit: 'cover' }), 1080, 1920)!;
    assert.equal(place.destH, 1920);
    assert.ok(place.destW > 1080);
    // Centred, so the overflow is cut evenly off both sides.
    assert.equal(place.destX, (1080 - place.destW) / 2);
  });

  it('旋转 90° 后横片正好装满竖画框', () => {
    const place = placeClip(1920, 1080, clip({ rotate: 90 }), 1080, 1920)!;
    assert.equal(place.rotatedW, 1080);
    assert.equal(place.rotatedH, 1920);
    assert.equal(place.destW, 1080);
    assert.equal(place.destH, 1920);
  });

  it('裁剪按旋转之后的画面算，而不是原始画面', () => {
    const cropped = clip({ rotate: 90, crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    const place = placeClip(1920, 1080, cropped, 1080, 1920)!;
    assert.equal(place.contentW, 1080);
    assert.equal(place.contentH, 960);
  });

  it('缩放以画框中心为准，两边各留一半', () => {
    const place = placeClip(1920, 1080, clip({ zoom: 0.5 }), 1920, 1080)!;
    assert.equal(place.destW, 960);
    assert.equal(place.destX, 480);
    assert.equal(place.baseScale, 1);
    assert.equal(place.scale, 0.5);
  });

  it('位移按画框比例算，换画框尺寸后含义不变', () => {
    const half = clip({ zoom: 0.5, offsetX: 0.25 });
    assert.equal(placeClip(1920, 1080, half, 1920, 1080)!.destX, 480 + 480);
    assert.equal(placeClip(1920, 1080, half, 960, 540)!.destX, 240 + 240);
  });

  it('裁剪框不会跑出画面，也不会缩到看不见', () => {
    assert.deepEqual(clampCrop({ x: -0.4, y: 0.2, w: 0.5, h: 0.5 }), { x: 0, y: 0.2, w: 0.5, h: 0.5 });
    assert.deepEqual(clampCrop({ x: 0.8, y: 0, w: 0.5, h: 1 }), { x: 0.5, y: 0, w: 0.5, h: 1 });
    assert.equal(clampCrop({ x: 0.2, y: 0.2, w: 0.001, h: 0.001 }).w, 0.05);
    assert.equal(clampCrop({ x: 0, y: 0, w: 3, h: 3 }).h, 1);
  });
});
