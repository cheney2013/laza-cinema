import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generationSpec, insertShotAt, MIN_SHOT_FRAMES, moveShotBoundary, removeShotAt, setShotFrames, setShotFramesAndSnapTotal } from './shots';
import { createShot, createSpec, createSubject, type H3DirectorSpec } from './spec';

function threeShots(): H3DirectorSpec {
  return createSpec({
    subjects: [
      createSubject({ id: 'her', appearsIn: [1, 3] }),
      createSubject({ id: 'hall', appearsIn: [] }),
    ],
    shots: [
      createShot({ id: 's1', frames: 60, firstFrameOccupancy: 'She is already in frame' }),
      createShot({ id: 's2', frames: 40, action: 'She stops' }),
      createShot({ id: 's3', frames: 24, action: 'The door closes' }),
    ],
  });
}

const total = (spec: H3DirectorSpec) => spec.shots.reduce((a, s) => a + s.frames, 0);

describe('穿插一个镜头', () => {
  it('puts the new shot at the asked-for position', () => {
    const next = insertShotAt(threeShots(), 1);
    assert.deepEqual(next.shots.map((s) => s.id.startsWith('shot') ? 'new' : s.id), [
      's1',
      'new',
      's2',
      's3',
    ]);
  });

  it('takes its frames from the shot it cuts into, and leaves the rest alone', () => {
    const before = threeShots();
    const next = insertShotAt(before, 1);

    assert.equal(next.shots[0].frames, 30);
    assert.equal(next.shots[1].frames, 30);
    // The shots it did not cut into keep the timing the director gave them.
    assert.equal(next.shots[2].frames, 40);
    assert.equal(next.shots[3].frames, 24);
    assert.equal(total(next), total(before));
  });

  it('takes from the displaced shot when inserted at the front', () => {
    const next = insertShotAt(threeShots(), 0);
    assert.equal(next.shots[0].frames, 30);
    assert.equal(next.shots[1].frames, 30);
    assert.equal(total(next), 124);
  });

  it('appends when asked for a position past the end', () => {
    const next = insertShotAt(threeShots(), 99);
    assert.equal(next.shots.length, 4);
    assert.equal(next.shots[2].frames, 12);
    assert.equal(next.shots[3].frames, 12);
    assert.equal(total(next), 124);
  });

  it('renumbers the shots a subject appears in', () => {
    // 出现镜头 is 1-based positions. Without this the subject silently moves.
    const next = insertShotAt(threeShots(), 1);
    assert.deepEqual(next.subjects[0].appearsIn, [1, 4]);
  });

  it('leaves "every shot" as every shot', () => {
    const next = insertShotAt(threeShots(), 1);
    assert.deepEqual(next.subjects[1].appearsIn, []);
  });

  it('never touches the spec it was given', () => {
    const before = threeShots();
    insertShotAt(before, 1);
    assert.equal(before.shots.length, 3);
    assert.deepEqual(before.subjects[0].appearsIn, [1, 3]);
  });
});

describe('change one shot by extending the batch', () => {
  it('keeps every other shot unchanged and snaps the total to 17k+5', () => {
    const next = setShotFramesAndSnapTotal(threeShots(), 1, 61);
    assert.deepEqual(next.shots.map((s) => s.frames), [60, 57, 24]);
    assert.equal(total(next), 141);
  });

  it('does not mutate the source spec', () => {
    const before = threeShots();
    setShotFramesAndSnapTotal(before, 0, 90);
    assert.deepEqual(before.shots.map((s) => s.frames), [60, 40, 24]);
  });
});

describe('drag a cut directly', () => {
  it('moves only the two shots touching that cut', () => {
    const next = moveShotBoundary(threeShots(), 1, 10);
    assert.deepEqual(next.shots.map((s) => s.frames), [70, 30, 24]);
    assert.equal(total(next), 124);
  });

  it('stops at the minimum shot length', () => {
    const next = moveShotBoundary(threeShots(), 2, 999);
    assert.deepEqual(next.shots.map((s) => s.frames), [60, 52, 12]);
  });
});

describe('disabled shots', () => {
  it('keeps disabled content in the source but removes it from the generation batch', () => {
    const before = threeShots();
    before.shots[1].enabled = false;
    const generated = generationSpec(before);
    assert.deepEqual(generated.spec.shots.map((shot) => shot.id), ['s1', 's3']);
    assert.equal(generated.totalFrames, 124);
    assert.equal(generated.spec.shots[1].frames, 64);
    assert.equal(before.shots.length, 3);
  });

  it('renumbers subject shot scopes around disabled shots', () => {
    const before = threeShots();
    before.shots[1].enabled = false;
    assert.deepEqual(generationSpec(before).spec.subjects[0].appearsIn, [1, 2]);
  });

  it('removes subjects used only by disabled shots from the generation batch', () => {
    const before = threeShots();
    before.subjects.push({
      ...before.subjects[0],
      id: 'disabled-only',
      definition: 'an unused muscle car',
      appearsIn: [2],
    });
    before.shots[1].enabled = false;

    const generated = generationSpec(before).spec;
    assert.ok(!generated.subjects.some((subject) => subject.id === 'disabled-only'));
    assert.ok(!JSON.stringify(generated).includes('unused muscle car'));
  });

  it('keeps a scoped subject when enabled prompt text still references it', () => {
    const before = threeShots();
    before.subjects.push({
      ...before.subjects[0],
      id: 'still-referenced',
      definition: 'a red warning beacon',
      appearsIn: [2],
    });
    before.shots[1].enabled = false;
    before.summary = 'The camera reveals {s:still-referenced}.';

    assert.ok(generationSpec(before).spec.subjects.some((subject) => subject.id === 'still-referenced'));
  });
});

describe('删除一个镜头', () => {
  it('gives its frames to the shot before it', () => {
    const next = removeShotAt(threeShots(), 1);
    assert.deepEqual(next.shots.map((s) => s.frames), [100, 24]);
    assert.equal(total(next), 124);
  });

  it('gives them to the new first shot when the first is removed', () => {
    const next = removeShotAt(threeShots(), 0);
    assert.deepEqual(next.shots.map((s) => s.frames), [100, 24]);
  });

  it('drops the removed shot from 出现镜头 and pulls the later ones back', () => {
    const next = removeShotAt(threeShots(), 1);
    assert.deepEqual(next.subjects[0].appearsIn, [1, 2]);
  });

  it('drops a subject reference to the removed shot itself', () => {
    const spec = threeShots();
    spec.subjects[0].appearsIn = [2];
    assert.deepEqual(removeShotAt(spec, 1).subjects[0].appearsIn, []);
  });

  it('refuses to remove the only shot', () => {
    const spec = createSpec({ shots: [createShot({ id: 'only', frames: 124 })] });
    assert.equal(removeShotAt(spec, 0), spec);
  });
});

describe('改一镜的长度', () => {
  it('takes the extra frames from the next shot, not from everyone', () => {
    const before = threeShots();
    const next = setShotFrames(before, 0, 70);
    assert.deepEqual(next.shots.map((s) => s.frames), [70, 30, 24]);
    assert.equal(total(next), total(before));
  });

  it('walks outward when the next shot has nothing left to give', () => {
    const next = setShotFrames(threeShots(), 1, 90);
    // Shot 3 gives down to the floor first, then shot 1 covers the rest.
    assert.deepEqual(next.shots.map((s) => s.frames), [22, 90, MIN_SHOT_FRAMES]);
    assert.equal(total(next), 124);
  });

  it('hands the freed frames to the following shot when a shot shrinks', () => {
    const next = setShotFrames(threeShots(), 0, 40);
    assert.deepEqual(next.shots.map((s) => s.frames), [40, 60, 24]);
  });

  it('will not push a neighbour below the floor', () => {
    const next = setShotFrames(threeShots(), 0, 999);
    assert.equal(next.shots[1].frames, MIN_SHOT_FRAMES);
    assert.equal(next.shots[2].frames, MIN_SHOT_FRAMES);
    assert.equal(total(next), 124);
  });

  it('keeps the total when the request cannot be met', () => {
    const spec = threeShots();
    const next = setShotFrames(spec, 2, 5);
    assert.equal(next.shots[2].frames, MIN_SHOT_FRAMES);
    assert.equal(total(next), 124);
  });

  it('leaves a single-shot batch to the frame-budget rule', () => {
    const spec = createSpec({ shots: [createShot({ frames: 124 })] });
    assert.equal(setShotFrames(spec, 0, 90).shots[0].frames, 90);
  });
});
