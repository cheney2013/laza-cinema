import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { srtTime, timelineToSrt } from './srt';
import { defaultClip, type Timeline } from './types';

const title = (id: string, start: number, length: number, content: string, extra: object = {}) =>
  defaultClip({
    id, trackId: 'SUB_1', assetId: '', start, inFrame: 0, outFrame: length,
    text: { content } as never, ...extra,
  });

const film = (clips: ReturnType<typeof title>[]): Timeline =>
  ({ fps: 24, width: 1920, height: 1080, tracks: [], clips, assets: {} });

describe('srt export', () => {
  it('writes HH:MM:SS,mmm time codes', () => {
    assert.equal(srtTime(0, 24), '00:00:00,000');
    assert.equal(srtTime(36, 24), '00:00:01,500');
    assert.equal(srtTime(24 * 3661, 24), '01:01:01,000');
  });

  it('numbers cues in time order and skips bypassed and empty ones', () => {
    const out = timelineToSrt(film([
      title('b', 48, 24, '第二句'),
      title('a', 0, 36, '第一句\n\n还有一行'),
      title('x', 100, 24, '旁通', { bypassed: true }),
      title('e', 120, 24, '  '),
    ]));
    assert.equal(out, '1\n00:00:00,000 --> 00:00:01,500\n第一句\n还有一行\n\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n');
  });

  it('cuts a cue that runs into the next one', () => {
    const out = timelineToSrt(film([title('a', 0, 48, 'A'), title('b', 24, 24, 'B')]));
    assert.match(out, /00:00:00,000 --> 00:00:01,000\nA/);
  });

  it('is empty when there are no subtitles', () => {
    assert.equal(timelineToSrt(film([])), '');
  });
});
