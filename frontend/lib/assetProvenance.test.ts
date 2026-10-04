import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type AssetProvenance, describeRestored, restoredNodeData } from './assetProvenance';
import { projectConnectedNode } from './connectedInput';

/**
 * The requirement, as an assertion: a shot re-placed from the asset library must
 * present downstream EXACTLY what the node that generated it presented.
 *
 * Both fixtures are real shapes — the live one is what a `video` node holds in a
 * saved canvas, the provenance one is what the backend reads back out of the
 * same file's embedded ComfyUI graph.
 */

const REFS = [
  'style_a0b4daec6df8443d9d4d3aad32ce5187.png',
  'style_3f10421ef1c84e2bae43fd7d6cba004c.png',
  'style_c531f48dd15c44bdbaf701bb3b9fc30d.jpg',
];

/** A generation node still sitting on the canvas. */
const liveNode = {
  id: 'video-1787466785007',
  type: 'video',
  data: {
    generatedUrl: '/comfy_output/H3_Video_b094672c_00001_.mp4',
    latentFilename: 'H3_Latent_b094672c_00001_.safetensors',
    width: 768,
    height: 1376,
    length: 311,
    steps: 4,
    seed: 81000,
    prompt: 'integrated_multimodal_description: …',
    status: 'done',
    submittedResources: {
      first_frame: null,
      last_frame: null,
      reference_images: REFS.map((comfy_filename) => ({
        url: `/uploads/${comfy_filename}`,
        comfy_filename,
      })),
    },
  },
};

/** What the backend recovers from that same mp4. */
const recovered: AssetProvenance = {
  found: true,
  name: 'H3_Video_b094672c_00001_.mp4',
  prompt: 'integrated_multimodal_description: …',
  seed: 81000,
  width: 768,
  height: 1376,
  length: 311,
  reference_images: REFS,
  reference_videos: [],
  reference_audios: [],
  first_frame: null,
  last_frame: null,
  latent_filename: 'H3_Latent_b094672c_00001_.safetensors',
  model: 'minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors',
  loras: [],
};

const restoredNode = (provenance = recovered) => ({
  id: 'image-1788400000000',
  type: 'image',
  data: {
    url: '/comfy_output/H3_Video_b094672c_00001_.mp4',
    mediaType: 'video',
    ...restoredNodeData(provenance, { width: 768, height: 1376, duration: 12.96 }),
  },
});

/** Everything a downstream upscale actually consumes from its source. */
function upscaleInputs(node: Parameters<typeof projectConnectedNode>[0]) {
  const projected = projectConnectedNode(node);
  return {
    // The upscale node reads `generatedUrl || url`, so the field differs by node
    // kind while the value must not.
    sourceUrl: projected.generatedUrl || projected.url,
    latentFilename: projected.latentFilename,
    referenceImages: projected.referenceImages,
    firstFrame: projected.firstFrame,
    lastFrame: projected.lastFrame,
    width: projected.width,
    height: projected.height,
  };
}

describe('re-placing a shot from the library', () => {
  it('presents the upscale with exactly what the generating node presented', () => {
    assert.deepEqual(upscaleInputs(restoredNode()), upscaleInputs(liveNode));
  });

  it('keeps the reference order, which is what decides <Picture 1>', () => {
    assert.deepEqual(projectConnectedNode(restoredNode()).referenceImages, REFS);
  });

  it('carries the latent by its real name, not the stem of the video', () => {
    // `H3_Video_x` and `H3_Latent_x` are different stems. Deriving one from the
    // other misses, and a miss silently downgrades the run from the latent
    // refiner to a generic restorer.
    const { latentFilename } = projectConnectedNode(restoredNode());
    assert.equal(latentFilename, 'H3_Latent_b094672c_00001_.safetensors');
    assert.notEqual(latentFilename, 'H3_Video_b094672c_00001_.safetensors');
  });

  it('carries an I2V shot’s guide frames, exactly as its live node would', () => {
    // An I2V shot has no references at all, so its first frame is the only image
    // anchoring the refine pass can be given. Both paths must hand over the same
    // one: this is what keeps the upscale identical whether the generating node
    // is still on the canvas or was deleted a month ago.
    const liveI2V = {
      id: 'video-1787558517089',
      type: 'video',
      data: {
        generatedUrl: '/comfy_output/H3_Video_0a107ed1_00001_.mp4',
        latentFilename: 'H3_Latent_0a107ed1_00001_.safetensors',
        width: 1376,
        height: 768,
        submittedResources: {
          first_frame: {
            url: '/uploads/style_shot2_firstframe.png',
            comfy_filename: 'style_shot2_firstframe.png',
          },
          last_frame: null,
          reference_images: [],
        },
      },
    };
    const restoredI2V = {
      id: 'image-1788400000001',
      type: 'image',
      data: {
        url: '/comfy_output/H3_Video_0a107ed1_00001_.mp4',
        mediaType: 'video',
        ...restoredNodeData(
          {
            found: true,
            name: 'H3_Video_0a107ed1_00001_.mp4',
            reference_images: [],
            first_frame: 'style_shot2_firstframe.png',
            last_frame: null,
            latent_filename: 'H3_Latent_0a107ed1_00001_.safetensors',
          },
          { width: 1376, height: 768 }
        ),
      },
    };

    assert.deepEqual(upscaleInputs(restoredI2V), upscaleInputs(liveI2V));
    assert.equal(
      projectConnectedNode(restoredI2V).firstFrame,
      'style_shot2_firstframe.png'
    );
    assert.deepEqual(projectConnectedNode(restoredI2V).referenceImages, []);
  });

  it('prefers the file’s real pixels over the size the graph asked for', () => {
    // A clip re-encoded or replaced since generation is no longer the size it
    // was requested at, and the node box has to match what is on screen.
    const data = restoredNodeData(recovered, { width: 1376, height: 768 });
    assert.equal(data.width, 1376);
    assert.equal(data.height, 768);
  });

  it('falls back to a plain node when the file carries no history', () => {
    const none: AssetProvenance = { found: false, name: 'hand_upload.mp4' };
    const data = restoredNodeData(none, { width: 1920, height: 1080, duration: 4 });
    assert.deepEqual(data, { width: 1920, height: 1080, duration: 4 });
    assert.equal(describeRestored(none), '');
  });

  it('says what came back, and says nothing when nothing did', () => {
    assert.equal(describeRestored(recovered), ' · 已带回3 张参考图、潜空间');
    assert.equal(
      describeRestored({ found: true, name: 'x.mp4', reference_images: [] }),
      ''
    );
  });
});
