import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { charswapRequest } from './charswapRequest';

const A = '/uploads/a.mp4';
const B = '/uploads/b.png';

describe('charswapRequest', () => {
  it('sends the H3 engine with the 8-step speed LoRA at the source size by default', () => {
    const req = charswapRequest(A, B, 7, {});
    assert.equal(req.engine, 'h3');
    assert.equal(req.mode, 'person');
    assert.equal(req.h3_accel, 'turbo8');
    assert.equal(req.h3_size, 'source');
    assert.equal(req.pose, 'auto');
    assert.equal(req.face_frame_seconds, -1);
    assert.equal(req.seed, 7);
    assert.equal(charswapRequest(A, B, 7, { swapPose: 'upright' }).pose, 'upright');
    assert.equal(charswapRequest(A, B, 7, { swapPose: 'x' }).pose, 'auto');
  });

  it('opens a node saved with the removed Viggle fields as the H3 person swap and sends none of them', () => {
    const req = charswapRequest(A, B, 7, {
      swapEngine: 'viggle', swapMode: 'reference', length: 100, megapixels: 0.5, faceReferenceUrl: '/uploads/q.png',
    });
    assert.equal(req.engine, 'h3');
    assert.equal(req.mode, 'person');
    for (const stale of ['length', 'megapixels', 'swapEngine', 'faceReferenceUrl']) {
      assert.equal(stale in req, false, stale);
    }
  });

  it('knows person and head and falls back to person for anything else', () => {
    for (const [swapMode, mode] of [['person', 'person'], ['head', 'head'], ['reference', 'person'], [undefined, 'person'], ['face', 'person'], ['nonsense', 'person']] as const) {
      assert.equal(charswapRequest(A, B, 7, { swapMode }).mode, mode, String(swapMode));
    }
  });

  it('sends the chosen frame only with points; the prompt, trimmed, always', () => {
    const noPoints = charswapRequest(A, B, 7, { faceFrameSeconds: 3.5, facePrompt: '  Replace ... ' });
    assert.equal(noPoints.face_frame_seconds, -1);
    assert.equal(noPoints.face_prompt, 'Replace ...');
    const pointed = charswapRequest(A, [B], 7, { faceFrameSeconds: 3.5, swapTargets: [{ x: 0.5, y: 0.5 }] });
    assert.equal(pointed.face_frame_seconds, 3.5);
  });

  it('pairs the pointed people with the photos in the order wired', () => {
    const req = charswapRequest(A, ['/uploads/p1.png', '/uploads/p2.png'], 7, {
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
    const onePhoto = charswapRequest(A, ['/uploads/p1.png'], 7, {
      swapTargets: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.4 }],
    });
    assert.equal(onePhoto.targets?.length, 1);
    const noPoints = charswapRequest(A, ['/uploads/p1.png', '/uploads/p2.png'], 7, {});
    assert.equal(noPoints.targets, undefined);
  });

  it('pins the frame to the start when there are points and no time is set', () => {
    const req = charswapRequest(A, ['/uploads/p1.png'], 7, { swapTargets: [{ x: 0.5, y: 0.5 }] });
    assert.equal(req.face_frame_seconds, 0);
  });

  it('ignores unusable points and points in head mode', () => {
    const data = { swapTargets: [{ x: 2, y: 0.5 }, { x: 'a', y: 1 }, null, { x: 0.5, y: 0.5 }] };
    assert.equal(charswapRequest(A, ['/uploads/p1.png', '/uploads/p2.png'], 7, data).targets?.length, 1);
    assert.equal(charswapRequest(A, ['/uploads/p1.png'], 7, { ...data, swapMode: 'head' }).targets, undefined);
  });

  it('combines the H3 speed and size', () => {
    for (const [h3Accel, h3Size] of [['turbo8', 'small'], ['taomate3', 'small'], ['turbo8', 'source'], ['x', 'y']] as const) {
      const req = charswapRequest(A, B, 7, { h3Accel, h3Size });
      assert.equal(req.h3_accel, h3Accel === 'x' ? 'turbo8' : h3Accel);
      assert.equal(req.h3_size, h3Size === 'y' ? 'source' : h3Size);
    }
  });
});
