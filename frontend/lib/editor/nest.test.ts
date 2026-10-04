import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flattenTimeline, referenceMismatch, referencesSequence, sequenceLength } from './nest';
import { type Clip, type Timeline, canMergeClips, defaultClip, emptyTimeline } from './types';

const clip = (patch: Partial<Clip> & { id: string; trackId: string }): Clip =>
  defaultClip({ assetId: 'a', ...patch });

const film = (clips: Clip[]): Timeline => ({ ...emptyTimeline(), clips });

describe('flattenTimeline', () => {
  const inner = film([
    clip({ id: 'x', trackId: 'V1', start: 0, inFrame: 0, outFrame: 48 }),
    clip({ id: 'y', trackId: 'V1', start: 48, inFrame: 0, outFrame: 48, transitionIn: { type: 'dissolve', frames: 6 } }),
    clip({ id: 'm', trackId: 'A1', start: 0, inFrame: 0, outFrame: 96, volume: 0.5 }),
  ]);
  const resolve = (id: string) => (id === 'inner' ? inner : null);

  it('returns a timeline without references unchanged', () => {
    const plain = film([clip({ id: 'p', trackId: 'V1' })]);
    assert.equal(flattenTimeline(plain, resolve), plain);
  });

  it('expands a trimmed reference in place, with its lanes above the host lane', () => {
    const host = film([
      clip({ id: 'before', trackId: 'V1', start: 0, outFrame: 24 }),
      clip({ id: 'r', trackId: 'V1', assetId: '', seqRef: 'inner', start: 24, inFrame: 24, outFrame: 72, volume: 0.5 }),
    ]);
    const flat = flattenTimeline(host, resolve);
    assert.deepEqual(flat.tracks.map((t) => t.id), ['V1', 'V1/V1', 'V1/V2', 'V2', 'A1', 'V1/A1']);
    assert.ok(!flat.clips.some((c) => c.seqRef));
    const x = flat.clips.find((c) => c.id === 'r/x')!;
    const y = flat.clips.find((c) => c.id === 'r/y')!;
    const m = flat.clips.find((c) => c.id === 'r/m')!;
    assert.deepEqual([x.start, x.inFrame, x.outFrame], [24, 24, 48]);
    assert.deepEqual([y.start, y.inFrame, y.outFrame], [48, 0, 24]);
    assert.deepEqual(y.transitionIn, { type: 'dissolve', frames: 6 });
    assert.deepEqual([m.start, m.inFrame, m.outFrame, m.volume], [24, 24, 72, 0.25]);
  });

  it('drops a reference back into a film already being expanded', () => {
    const a = film([clip({ id: 'ra', trackId: 'V1', assetId: '', seqRef: 'b', outFrame: 10 })]);
    const b = film([clip({ id: 'rb', trackId: 'V1', assetId: '', seqRef: 'a', outFrame: 10 })]);
    const cyc = (id: string) => (id === 'a' ? a : id === 'b' ? b : null);
    assert.equal(referencesSequence('b', 'a', cyc), true);
    const flat = flattenTimeline(a, cyc, new Set(['a']));
    assert.equal(flat.clips.length, 0);
  });

  it('measures a referenced film by its expanded length', () => {
    assert.equal(sequenceLength('inner', resolve), 96);
    assert.equal(sequenceLength('missing', resolve), 0);
  });
});

describe('canMergeClips with references', () => {
  it('never joins references to different films', () => {
    const left = clip({ id: 'l', trackId: 'V1', assetId: '', seqRef: 'a', start: 0, outFrame: 10 });
    const right = clip({ id: 'r', trackId: 'V1', assetId: '', seqRef: 'b', start: 10, inFrame: 10, outFrame: 20 });
    assert.equal(canMergeClips(left, right), false);
    assert.equal(canMergeClips(left, { ...right, seqRef: 'a' }), true);
  });
});

describe('referencing a film of another size', () => {
  const sized = (width: number, height: number, fps = 24, clips: Clip[] = []): Timeline => ({ ...emptyTimeline(fps, width, height), clips });

  it('only the frame rate has to match', () => {
    assert.equal(referenceMismatch(sized(2730, 1536), sized(1920, 1080)), null);
    assert.equal(referenceMismatch(sized(2730, 1536), sized(1080, 1920)), null);   // even a portrait film in a landscape one
    assert.deepEqual(referenceMismatch(sized(2730, 1536, 24), sized(1920, 1080, 30)), { hostFps: 24, nestedFps: 30 });
  });

  it('scales the titles of the referenced film by the height ratio, and leaves the rest alone', () => {
    const title = clip({
      id: 't', trackId: 'V1', start: 0, outFrame: 48,
      text: { content: 'hi', size: 54, strokeWidth: 3, color: '#fff', strokeColor: '#000', fontWeight: 700, align: 'center', x: 0.5, y: 0.8 },
    });
    const shot = clip({ id: 's', trackId: 'V1', start: 0, outFrame: 48, offsetX: 0.1, zoom: 1.2 });
    const inner = sized(1920, 1080, 24, [title, shot]);
    const host = sized(3840, 2160, 24, [clip({ id: 'r', trackId: 'V1', assetId: '', seqRef: 'inner', start: 0, inFrame: 0, outFrame: 48 })]);
    const flat = flattenTimeline(host, (id) => (id === 'inner' ? inner : null));
    const t = flat.clips.find((c) => c.id === 'r/t')!;
    const s = flat.clips.find((c) => c.id === 'r/s')!;
    assert.deepEqual([t.text?.size, t.text?.strokeWidth], [108, 6]);         // twice the height: twice the pixels
    assert.deepEqual([s.offsetX, s.zoom], [0.1, 1.2]);                       // fractions of the frame carry over as they are
    assert.equal(t.text?.x, 0.5);
  });

  it('leaves titles as they are when the heights match', () => {
    const title = clip({
      id: 't', trackId: 'V1', start: 0, outFrame: 48,
      text: { content: 'hi', size: 54, strokeWidth: 3, color: '#fff', strokeColor: '#000', fontWeight: 700, align: 'center', x: 0.5, y: 0.8 },
    });
    const inner = sized(1920, 1536, 24, [title]);       // another width, the same height
    const host = sized(2730, 1536, 24, [clip({ id: 'r', trackId: 'V1', assetId: '', seqRef: 'inner', start: 0, inFrame: 0, outFrame: 48 })]);
    const flat = flattenTimeline(host, (id) => (id === 'inner' ? inner : null));
    assert.deepEqual([flat.clips.find((c) => c.id === 'r/t')?.text?.size], [54]);
  });
});
