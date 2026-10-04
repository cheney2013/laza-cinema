import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveChain } from './chainContext';

const rendered = { latentFilename: 'H3_Latent_a_00001_.safetensors', generatedUrl: '/comfy_output/H3_Chunk_a_00001_.mp4' };

describe('resolveChain', () => {
  it('carries on from the latent by default', () => {
    assert.deepEqual(resolveChain(rendered, '', undefined), { motion_context_latent: 'H3_Latent_a_00001_.safetensors' });
  });

  it('falls back to the manual latent and to a trim\'s pictures', () => {
    assert.deepEqual(resolveChain(undefined, 'H3_Latent_m.safetensors', 0), { motion_context_latent: 'H3_Latent_m.safetensors' });
    assert.deepEqual(resolveChain({ type: 'videoTrim', generatedUrl: '/comfy_output/t.mp4' }, '', 0),
      { motion_context_video: '/comfy_output/t.mp4' });
    assert.deepEqual(resolveChain({ type: 'video' }, '', 0), {});
  });

  it('carries on from an uploaded clip or an edit by its pictures, as the canvas server does', () => {
    assert.deepEqual(resolveChain({ type: 'image', url: '/uploads/clip_c23a_bc709d65.mp4' }, '', 0),
      { motion_context_video: '/uploads/clip_c23a_bc709d65.mp4' });
    assert.deepEqual(resolveChain({ type: 'videoEdit', generatedUrl: '/comfy_output/H3_EditWindow_aa.mp4' }, '', 0),
      { motion_context_video: '/comfy_output/H3_EditWindow_aa.mp4' });
    // a rendered clip with a latent still prefers the latent
    assert.deepEqual(resolveChain({ ...rendered, url: '/uploads/x.mp4' }, '', 0), { motion_context_latent: 'H3_Latent_a_00001_.safetensors' });
  });

  it('a picture or a file with no extension gives nothing to continue from', () => {
    assert.deepEqual(resolveChain({ type: 'image', url: '/uploads/plate.png' }, '', 0), {});
    assert.deepEqual(resolveChain({ type: 'image', url: '/uploads/noext' }, '', 0), {});
  });

  it('a frame number sends the clip\'s pictures cut at that frame, even when a latent exists', () => {
    assert.deepEqual(resolveChain(rendered, '', 132),
      { motion_context_video: '/comfy_output/H3_Chunk_a_00001_.mp4', motion_context_end_frame: 132 });
    assert.deepEqual(resolveChain(rendered, '', '132.4'),
      { motion_context_video: '/comfy_output/H3_Chunk_a_00001_.mp4', motion_context_end_frame: 132 });
  });

  it('a frame number with nothing to read starts the clip on its own, like an unrendered parent', () => {
    assert.deepEqual(resolveChain({ type: 'video' }, '', 132), {});
  });

  it('refuses a negative frame', () => {
    assert.throws(() => resolveChain(rendered, '', -3), /above 0/);
  });
});
