import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dropRate, effectiveLevel, isQualityChoice, levelForDisplay, previewUrlFor, proxyKey, stepDown,
} from './previewLevels';

describe('preview levels', () => {
  it('picks the lowest level that still fills the monitor', () => {
    assert.equal(levelForDisplay(300), 360);
    assert.equal(levelForDisplay(540), 540);
    assert.equal(levelForDisplay(560), 540);
    assert.equal(levelForDisplay(700), 720);
    assert.equal(levelForDisplay(1440), 1080);
  });

  it('steps down one level at a time and stops at the bottom', () => {
    assert.equal(stepDown(1080), 720);
    assert.equal(stepDown(720), 540);
    assert.equal(stepDown(360), 360);
  });

  it('judges drops over a window, and ignores one with too few frames or a replaced element', () => {
    assert.equal(dropRate({ total: 0, dropped: 0 }, { total: 100, dropped: 20 }), 0.2);
    assert.equal(dropRate({ total: 0, dropped: 0 }, { total: 10, dropped: 10 }), null);
    assert.equal(dropRate({ total: 500, dropped: 50 }, { total: 520, dropped: 0 }), null);
  });

  it('manual choice wins; auto is the display level held down by drops', () => {
    assert.equal(effectiveLevel(360, 1080, 1080), 360);
    assert.equal(effectiveLevel('auto', 1080, 1080), 1080);
    assert.equal(effectiveLevel('auto', 1080, 540), 540);
    assert.equal(effectiveLevel('auto', 300, 1080), 360);
  });

  it('plays the standard proxy until a lower level is built, and never for a source already that small', () => {
    const asset = { url: '/a.mp4', proxyUrl: '/p.mp4', height: 1080 };
    assert.equal(previewUrlFor(asset, 1080, {}), '/p.mp4');
    assert.equal(previewUrlFor(asset, 540, {}), '/p.mp4');
    assert.equal(previewUrlFor(asset, 540, { [proxyKey('/a.mp4', 540)]: '/p540.mp4' }), '/p540.mp4');
    assert.equal(previewUrlFor({ ...asset, height: 480 }, 540, { [proxyKey('/a.mp4', 540)]: '/x.mp4' }), '/p.mp4');
    assert.equal(previewUrlFor({ url: '/a.mp4', height: 1080 }, 1080, {}), '/a.mp4');
  });

  it('knows a valid choice', () => {
    assert.ok(isQualityChoice('auto') && isQualityChoice(720));
    assert.ok(!isQualityChoice(480) && !isQualityChoice('720'));
  });
});
