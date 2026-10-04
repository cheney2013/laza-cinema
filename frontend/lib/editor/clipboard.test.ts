import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildClipboard, pasteInto } from './clipboard';
import { type Clip, type EditorAsset, type Timeline, type Track } from './types';

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

const asset = (patch: Partial<EditorAsset> & { id: string; url: string }): EditorAsset => ({
  nodeId: 'n1',
  title: 'shot',
  kind: 'video',
  width: 1920,
  height: 1080,
  fps: 24,
  frames: 96,
  timelineFrames: 96,
  hasAudio: true,
  ...patch,
});

const track = (id: string, kind: Track['kind']): Track => ({
  id,
  kind,
  name: id,
  muted: false,
  locked: false,
});

const film = (patch: Partial<Timeline> = {}): Timeline => ({
  fps: 24,
  width: 1920,
  height: 1080,
  tracks: [track('V1_a', 'video'), track('V2_a', 'video'), track('A1_a', 'audio')],
  clips: [],
  assets: {},
  ...patch,
});

// Ids that say what they are and count, so an assertion can name them.
const counter = () => {
  const seen: Record<string, number> = {};
  return (prefix: string) => `${prefix}${(seen[prefix] = (seen[prefix] ?? 0) + 1)}`;
};

describe('cross-tab copy and paste', () => {
  const source = film({
    clips: [
      clip({ id: 'c1', trackId: 'V1_a', start: 100, groupId: 'g1' }),
      clip({ id: 'c2', trackId: 'A1_a', start: 110, assetId: 'a1', groupId: 'g1' }),
      clip({ id: 'c3', trackId: 'V1_a', start: 400 }),
    ],
    assets: { a1: asset({ id: 'a1', url: '/shot.mp4' }) },
  });

  it('copies whole groups, and the assets behind them', () => {
    const payload = buildClipboard(source, ['c1']);
    assert.ok(payload);
    assert.deepEqual(payload.clips.map((c) => c.id).sort(), ['c1', 'c2']);
    assert.deepEqual(payload.assets.map((a) => a.url), ['/shot.mp4']);
  });

  it('keeps spacing and lanes, and lands on the playhead', () => {
    const payload = buildClipboard(source, ['c1', 'c3'])!;
    const target = film();
    const { clips } = pasteInto(target, payload, 500, counter());
    assert.equal(clips.length, 3);
    // Earliest copied clip starts at 100; the playhead is 500.
    assert.deepEqual(
      clips.map((c) => c.start),
      [500, 510, 800]
    );
    assert.deepEqual(
      clips.map((c) => c.trackId),
      ['V1_a', 'A1_a', 'V1_a']
    );
  });

  it('gives the pasted group a new id, so two pastes are not one group', () => {
    const payload = buildClipboard(source, ['c1'])!;
    const first = pasteInto(film(), payload, 0, counter()).clips;
    assert.equal(first[0].groupId, first[1].groupId);
    assert.notEqual(first[0].groupId, 'g1');
  });

  it('rescales frames into a film with a different rate', () => {
    const payload = buildClipboard(source, ['c3'])!;
    const target = film({ fps: 48 });
    const { clips, assets } = pasteInto(target, payload, 0, counter());
    // 48 source frames at 24fps is two seconds: 96 frames on a 48fps grid.
    assert.equal(clips[0].outFrame, 96);
    assert.equal(Object.values(assets)[0].timelineFrames, 192);
  });

  it('never asks an asset for more frames than it has', () => {
    const short = film({
      clips: [clip({ id: 'c1', outFrame: 96 })],
      assets: { a1: asset({ id: 'a1', url: '/shot.mp4', timelineFrames: 96 }) },
    });
    const payload = buildClipboard(short, ['c1'])!;
    // The same media is already in the target, at its own length.
    const target = film({ assets: { z9: asset({ id: 'z9', url: '/shot.mp4', timelineFrames: 96 }) } });
    const { clips, assets } = pasteInto(target, payload, 0, counter());
    assert.equal(clips[0].assetId, 'z9', 'the same url is not imported twice');
    assert.deepEqual(Object.keys(assets), ['z9']);
    assert.equal(clips[0].outFrame, 96);
  });

  it('stacks onto the last lane of the kind when the target has fewer', () => {
    const wide = film({
      tracks: [track('V1_a', 'video'), track('V2_a', 'video'), track('V3_a', 'video')],
      clips: [clip({ id: 'c1', trackId: 'V3_a' })],
      assets: { a1: asset({ id: 'a1', url: '/shot.mp4' }) },
    });
    const payload = buildClipboard(wide, ['c1'])!;
    const target = film({ tracks: [track('V1_b', 'video'), track('A1_b', 'audio')] });
    const { clips } = pasteInto(target, payload, 0, counter());
    assert.equal(clips[0].trackId, 'V1_b');
  });

  it('scales title type to the target frame height', () => {
    const titled = film({
      clips: [clip({ id: 'c1', assetId: '', text: { content: 'hi', size: 60, color: '#fff', strokeColor: '#000', strokeWidth: 2, x: 0.5, y: 0.8, align: 'center', fontWeight: 600 } })],
    });
    const payload = buildClipboard(titled, ['c1'])!;
    const { clips } = pasteInto(film({ height: 2160, width: 3840 }), payload, 0, counter());
    assert.equal(clips[0].text?.size, 120);
    assert.equal(clips[0].text?.strokeWidth, 4);
    assert.equal(clips[0].text?.y, 0.8, 'fractional placement is untouched');
  });
});
