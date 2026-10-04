import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildExportPayload, coverClip, nativeExportFps } from './exportPayload';
import type { Timeline } from './types';

describe('nativeExportFps', () => {
  it('turns grid rate and speed into the rate the shot really plays at', () => {
    assert.equal(nativeExportFps(24, 0.5), 12);
    assert.equal(nativeExportFps(24, 0.75), 18);
    assert.equal(nativeExportFps(24, 2), 48);
  });

  it('leaves normal speed alone', () => {
    assert.equal(nativeExportFps(24, 1), undefined);
    assert.equal(nativeExportFps(24, 1.0004), undefined);
    assert.equal(nativeExportFps(24, undefined), undefined);
    assert.equal(nativeExportFps(24, 0), undefined);
  });

  it('keeps a fractional rate to three places and refuses what an encoder cannot take', () => {
    assert.equal(nativeExportFps(24, 0.4), 9.6);
    assert.equal(nativeExportFps(24, 0.01), undefined);
    assert.equal(nativeExportFps(24, 20), undefined);
  });
});

describe('the cover', () => {
  const film = (): Timeline => ({
    fps: 24, width: 1376, height: 768,
    tracks: [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false }],
    clips: [{ id: 'c1', trackId: 'V1', assetId: 'a1', start: 0, inFrame: 0, outFrame: 48, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }],
    assets: { a1: { id: 'a1', nodeId: 'n', url: '/uploads/shot.mp4', title: 'shot', kind: 'video', width: 1376, height: 768, fps: 24, frames: 48, timelineFrames: 48, hasAudio: true } },
  } as unknown as Timeline);

  it('is one frame of a picture on a lane above everything, so frame 0 is the cover and nothing else moves', async () => {
    const without = await buildExportPayload(film(), 'cut');
    const payload = await buildExportPayload(film(), 'cut', { cover: { url: '/uploads/cover.png' } });
    assert.equal(payload.tracks.length, without.tracks.length + 1);
    const top = payload.tracks[payload.tracks.length - 1];
    assert.equal(top.kind, 'video');
    assert.equal(top.clips.length, 1);
    assert.deepEqual(
      [top.clips[0].url, top.clips[0].kind, top.clips[0].start, top.clips[0].duration, top.clips[0].fit],
      ['/uploads/cover.png', 'image', 0, 1, 'cover'],
    );
    // the film itself, its length and its sound are exactly what they were
    assert.deepEqual(payload.tracks.slice(0, -1), without.tracks);
    assert.equal(payload.duration, without.duration);
    assert.equal(payload.audio_only, false);
  });

  it('is left out unless the caller asks for it (a lone shot, a merge or a transcription render)', async () => {
    const payload = await buildExportPayload(film(), 'cut');
    assert.ok(payload.tracks.every((track) => track.clips.every((c) => c.url !== '/uploads/cover.png')));
  });

  it('has nothing to sit on in a film with no clips', async () => {
    const empty = { ...film(), clips: [] } as Timeline;
    const payload = await buildExportPayload(empty, 'cut', { cover: { url: '/uploads/cover.png' } });
    assert.equal(payload.tracks.length, 0);
  });

  it('does not play: muted, no fades, no transition', () => {
    const c = coverClip('/uploads/cover.png');
    assert.deepEqual([c.muted, c.fade_in, c.fade_out, c.transition, c.seam_mute], [true, 0, 0, null, null]);
  });
});
