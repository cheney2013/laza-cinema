import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VOLUME_FLOOR_DB, dbToGain, formatDb, gainToDb, peakHeight } from './types';

describe('音量的分贝刻度', () => {
  it('0 dB 就是素材本身的响度', () => {
    assert.equal(dbToGain(0), 1);
    assert.equal(gainToDb(1), 0);
  });

  it('每 6 dB 大约翻一倍', () => {
    assert.ok(Math.abs(dbToGain(6) - 2) < 0.01);
    assert.ok(Math.abs(dbToGain(-6) - 0.5) < 0.01);
  });

  it('推到底是静音，不是 -60 dB 的微弱声音', () => {
    assert.equal(dbToGain(VOLUME_FLOOR_DB), 0);
    assert.equal(gainToDb(0), VOLUME_FLOOR_DB);
    assert.equal(formatDb(VOLUME_FLOOR_DB), '-∞');
  });

  it('来回换算不会漂', () => {
    for (const gain of [0.1, 0.25, 0.5, 1, 1.5, 1.99]) {
      assert.ok(Math.abs(dbToGain(gainToDb(gain)) - gain) < 1e-9, String(gain));
    }
  });

  it('比刻度顶还响的老片段读到顶为止', () => {
    // 上限 +24 dB（约 16 倍增益），给录得很轻的素材留足余量。
    assert.equal(gainToDb(100), 24);
    assert.ok(Math.abs(dbToGain(24) - 15.85) < 0.01);
    assert.ok(Math.abs(dbToGain(40) - dbToGain(24)) < 1e-9);
  });

  it('读数带符号，因为要紧的是比原声大还是小', () => {
    assert.equal(formatDb(3.5), '+3.5');
    assert.equal(formatDb(-3.5), '-3.5');
    assert.equal(formatDb(0), '0.0');
  });
});

describe('波形高度按 dBFS', () => {
  it('满幅顶满，-60 dB 以下贴底，-30 dB 在一半', () => {
    assert.equal(peakHeight(1), 1);
    assert.equal(peakHeight(0.001), 0);
    assert.ok(Math.abs(peakHeight(10 ** (-30 / 20)) - 0.5) < 1e-9);
  });

  it('片段音量抬高波形，超过 0 dBFS 封顶', () => {
    assert.ok(peakHeight(0.1, 2) > peakHeight(0.1));
    assert.equal(peakHeight(0.5, 16), 1);
  });
});
