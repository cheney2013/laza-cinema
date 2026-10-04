import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAudioLocks } from './audioLocks';

const nodes = [
  { id: 'va-sarah', data: { url: '/uploads/sarah.wav', mediaType: 'audio' } },
  { id: 'pass1', data: { generatedUrl: '/comfy_output/H3_Chunk_x_00001_.mp4' } },
  { id: 'empty', data: {} },
];

describe('resolveAudioLocks', () => {
  it('turns a canvas node into its url and fills the defaults', () => {
    assert.deepEqual(resolveAudioLocks([{ node: 'va-sarah', at: 5, text: 'There you are.' }], nodes), [
      { url: '/uploads/sarah.wav', at: 5, strength: 1, text: 'There you are.' },
    ]);
  });

  it('takes a rendered clip as the recording and keeps from/to', () => {
    assert.deepEqual(
      resolveAudioLocks([{ node: 'pass1', at: 0, strength: 0.5, from: 0.4, to: 6.5 }], nodes),
      [{ url: '/comfy_output/H3_Chunk_x_00001_.mp4', at: 0, strength: 0.5, text: '', from: 0.4, to: 6.5 }],
    );
  });

  it('accepts a url directly and returns nothing when there are no locks', () => {
    assert.equal(resolveAudioLocks([{ url: '/uploads/a.wav', at: 1 }], nodes)[0].url, '/uploads/a.wav');
    assert.deepEqual(resolveAudioLocks(undefined, nodes), []);
    assert.deepEqual(resolveAudioLocks([], nodes), []);
  });

  it('refuses what the backend would refuse, with the same reasons', () => {
    assert.throws(() => resolveAudioLocks([{ node: 'gone', at: 1 }], nodes), /not on the canvas/);
    assert.throws(() => resolveAudioLocks([{ node: 'empty', at: 1 }], nodes), /has no audio yet/);
    assert.throws(() => resolveAudioLocks([{ at: 1 }], nodes), /needs a "node"/);
    assert.throws(() => resolveAudioLocks([{ node: 'va-sarah' }], nodes), /needs "at"/);
    assert.throws(() => resolveAudioLocks(['x'], nodes), /must be an object/);
  });
});
