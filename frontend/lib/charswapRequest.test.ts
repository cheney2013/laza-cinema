import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { charswapRequest } from './charswapRequest';

describe('charswapRequest', () => {
  it('swaps the whole person unless face mode is chosen', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, {});
    assert.equal(req.mode, 'person');
    assert.equal(req.face_frame_seconds, -1);
    assert.equal(req.length, 0);
    assert.equal(req.megapixels, 0.8);
  });

  it('knows the three modes and falls back to person for anything else', () => {
    for (const [swapMode, mode] of [['person', 'person'], ['head', 'head'], ['reference', 'reference'], [undefined, 'person'], ['face', 'person'], ['nonsense', 'person']] as const) {
      assert.equal(charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapMode }).mode, mode, String(swapMode));
    }
  });

  it('sends the frame and prompt in head mode too', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapMode: 'head', faceFrameSeconds: 2, facePrompt: ' p ' });
    assert.equal(req.face_frame_seconds, 2);
    assert.equal(req.face_prompt, 'p');
  });

  it('sends the chosen frame', () => {
    for (const swapMode of ['person', 'head'] as const) {
      const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapMode, faceFrameSeconds: 3.5 });
      assert.equal(req.mode, swapMode);
      assert.equal(req.face_frame_seconds, 3.5, swapMode);
    }
  });

  it('takes the middle of the clip when no frame is chosen, or the value is unusable', () => {
    for (const faceFrameSeconds of [undefined, null, '', 'x', -2, NaN]) {
      const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapMode: 'face', faceFrameSeconds });
      assert.equal(req.face_frame_seconds, -1, String(faceFrameSeconds));
    }
  });

  it('sends the prompt, trimmed, in every mode', () => {
    for (const swapMode of ['person', 'head'] as const) {
      const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapMode, facePrompt: '  Edit <image 1> ... ' });
      assert.equal(req.face_prompt, 'Edit <image 1> ...', swapMode);
    }
  });

  it('sends a ready-made reference as it is, and never as a repaint', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/ref.png', 7, { swapMode: 'reference' });
    assert.equal(req.mode, 'reference');
    assert.equal(req.character_image_url, '/uploads/ref.png');
  });

  it('pairs the pointed people with the photos in the order wired', () => {
    const req = charswapRequest('/uploads/a.mp4', ['/uploads/p1.png', '/uploads/p2.png'], 7, {
      faceFrameSeconds: 1.5,
      swapTargets: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.4 }],
    });
    assert.deepEqual(req.targets, [
      { x: 0.3, y: 0.5, image_url: '/uploads/p1.png' },
      { x: 0.7, y: 0.4, image_url: '/uploads/p2.png' },
    ]);
    assert.equal(req.character_image_url, '/uploads/p1.png');
    assert.equal(req.face_frame_seconds, 1.5);
  });

  it('leaves out a point with no photo and a photo with no point', () => {
    const onePhoto = charswapRequest('/uploads/a.mp4', ['/uploads/p1.png'], 7, {
      swapTargets: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.4 }],
    });
    assert.equal(onePhoto.targets?.length, 1);
    const noPoints = charswapRequest('/uploads/a.mp4', ['/uploads/p1.png', '/uploads/p2.png'], 7, {});
    assert.equal(noPoints.targets, undefined);
  });

  it('pins the frame when there are points, since a point means something only on its own frame', () => {
    const req = charswapRequest('/uploads/a.mp4', ['/uploads/p1.png'], 7, { swapTargets: [{ x: 0.5, y: 0.5 }] });
    assert.equal(req.face_frame_seconds, 0);
  });

  it('ignores unusable points and points in the head and reference modes', () => {
    const data = { swapTargets: [{ x: 2, y: 0.5 }, { x: 'a', y: 1 }, null, { x: 0.5, y: 0.5 }] };
    assert.equal(charswapRequest('/uploads/a.mp4', ['/uploads/p1.png', '/uploads/p2.png'], 7, data).targets?.length, 1);
    for (const swapMode of ['head', 'reference']) {
      assert.equal(charswapRequest('/uploads/a.mp4', ['/uploads/p1.png'], 7, { ...data, swapMode }).targets, undefined, swapMode);
    }
  });

  it('stays on Viggle and sends no H3 fields unless the node says h3', () => {
    for (const swapEngine of [undefined, 'viggle', 'x']) {
      const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine });
      assert.equal(req.engine, undefined);
      assert.equal(req.h3_accel, undefined);
    }
  });

  it('sends the H3 engine with the 8-step speed LoRA at the source size by default', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine: 'h3' });
    assert.equal(req.engine, 'h3');
    assert.equal(req.h3_accel, 'turbo8');
    assert.equal(req.h3_size, 'source');
    assert.equal(req.pose, 'auto');
    assert.equal(charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine: 'h3', swapPose: 'upright' }).pose, 'upright');
    assert.equal(charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine: 'h3', swapPose: 'x' }).pose, 'auto');
  });

  it('combines the H3 speed and size', () => {
    for (const [h3Accel, h3Size] of [['turbo8', 'small'], ['taomate3', 'small'], ['turbo8', 'source'], ['x', 'y']] as const) {
      const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine: 'h3', h3Accel, h3Size });
      assert.equal(req.h3_accel, h3Accel === 'x' ? 'turbo8' : h3Accel);
      assert.equal(req.h3_size, h3Size === 'y' ? 'source' : h3Size);
    }
  });

  it('swaps whole people only in the H3 engine, whatever mode the node keeps from Viggle', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/p1.png', 7, { swapEngine: 'h3', swapMode: 'head', faceFrameSeconds: 3 });
    assert.equal(req.mode, 'person');
    assert.equal(req.targets, undefined);
    assert.equal(req.face_frame_seconds, -1);      // no points: no frame to pick
  });

  it('sends the pointed people and their frame in the H3 engine too', () => {
    const req = charswapRequest('/uploads/a.mp4', ['/uploads/p1.png', '/uploads/p2.png'], 7, {
      swapEngine: 'h3', faceFrameSeconds: 1.5, swapTargets: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.4 }],
    });
    assert.equal(req.engine, 'h3');
    assert.deepEqual(req.targets, [
      { x: 0.3, y: 0.5, image_url: '/uploads/p1.png' },
      { x: 0.7, y: 0.4, image_url: '/uploads/p2.png' },
    ]);
    assert.equal(req.face_frame_seconds, 1.5);
  });

  it('sends a hand-written H3 prompt as the prompt', () => {
    const req = charswapRequest('/uploads/a.mp4', '/uploads/b.png', 7, { swapEngine: 'h3', facePrompt: ' subject_definitions: ' });
    assert.equal(req.face_prompt, 'subject_definitions:');
  });
});

