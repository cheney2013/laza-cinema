import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ZOOM_MAX, ZOOM_MIN, clampZoom } from './types';

describe('timeline zoom range', () => {
  it('lets a ten-minute film fit a narrow strip', () => {
    const frames = 10 * 60 * 24;
    assert.ok(frames * ZOOM_MIN <= 300);
  });

  it('clamps to the range and keeps values inside it', () => {
    assert.equal(clampZoom(0.0001), ZOOM_MIN);
    assert.equal(clampZoom(1000), ZOOM_MAX);
    assert.equal(clampZoom(3), 3);
  });
});
