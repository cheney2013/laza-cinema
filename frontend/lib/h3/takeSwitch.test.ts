import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { H3Take } from './takes';
import { currentTakeIndex, dirtyKeys, inputIssues, switchPatch, takeLatent } from './takeSwitch';

const take = (over: Partial<H3Take>): H3Take => ({
  id: 'j1', createdAt: 0, spec: null, prompt: 'p1', seed: 1, width: 1376, height: 768, length: 124,
  url: '/comfy_output/H3_Chunk_88439393_00001_.mp4', ...over,
});

describe('takeSwitch', () => {
  it('finds the version on display by url', () => {
    const takes = [take({ id: 'b', url: '/b.mp4' }), take({ id: 'a', url: '/a.mp4' })];
    assert.equal(currentTakeIndex(takes, '/a.mp4'), 1);
    assert.equal(currentTakeIndex(takes, '/x.mp4'), -1);
  });

  it('restores params and outputs, and clears outputs the take did not record', () => {
    const tk = take({ params: { prompt: 'old', seed: 7 }, outputs: { latentFilename: 'L.safetensors' } });
    const patch = switchPatch(tk, { prompt: 'new', promptFile: 'x.txt', compiledPrompt: 'stale' });
    assert.equal(patch.prompt, 'old');
    assert.equal(patch.seed, 7);
    assert.equal(patch.generatedUrl, tk.url);
    assert.equal(patch.latentFilename, 'L.safetensors');
    assert.equal(patch.compiledPrompt, undefined);
    assert.ok('promptFile' in patch && patch.promptFile === undefined);
  });

  it('infers the latent of an old take from its clip name', () => {
    assert.deepEqual(takeLatent(take({})), { name: 'H3_Latent_88439393_00001_.safetensors', inferred: true });
    assert.equal(takeLatent(take({ outputs: { latentFilename: null } })).name, null);
  });

  it('marks changed parameters as dirty', () => {
    const tk = take({ params: { prompt: 'a', seed: 1 } });
    assert.deepEqual(dirtyKeys(tk, { prompt: 'a', seed: 1 }), []);
    assert.deepEqual(dirtyKeys(tk, { prompt: 'b', seed: 1 }), ['prompt']);
    // an old take's prompt is the compiled text: not compared
    const legacy = take({ prompt: 'compiled', seed: 3 });
    assert.deepEqual(dirtyKeys(legacy, { prompt: 'mine', seed: 3, width: 1376, height: 768, length: 124 }), []);
  });

  it('reports deleted, unwired, changed and extra inputs', () => {
    const tk = take({
      inputs: [
        { source: 'gone', targetHandle: 'in-ref-image', url: '/g.png' },
        { source: 'unwired', targetHandle: 'in-ref-image', url: '/u.png' },
        { source: 'changed', targetHandle: 'in-ref-audio', url: '/old.wav' },
      ],
    });
    const kinds = inputIssues(tk, [
      { source: 'changed', targetHandle: 'in-ref-audio', url: '/new.wav' },
      { source: 'extra', targetHandle: 'in-ref-image', url: '/e.png' },
    ], new Set(['unwired', 'changed', 'extra'])).map((i) => `${i.kind}:${i.source ?? ''}`);
    assert.deepEqual(kinds, ['missing-node:gone', 'removed:unwired', 'changed:changed', 'added:extra']);
  });

  it('says an old take cannot be checked instead of claiming it is fine', () => {
    assert.deepEqual(inputIssues(take({}), [], new Set()).map((i) => i.kind), ['unrecorded']);
  });
});
