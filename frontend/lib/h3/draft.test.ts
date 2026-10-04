import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { compileDirectorSpec } from './compile';
import { DraftError, mergeDraftIntoEmpty, specFromDraft } from './draft';
import { lintSpec } from './lint';
import { createShot, createSpec, emptyAssets } from './spec';

const assets = emptyAssets({
  images: [{ nodeId: 'img-a' }, { nodeId: 'img-b' }],
  totalFrames: 243,
  fps: 24,
});

function draft(overrides: Record<string, unknown> = {}) {
  return {
    taskType: '[reference generation]',
    summary: 'Two shots in a stone hall.',
    world: 'Live-action, cinematic, cold daylight.',
    subjects: [
      {
        kind: 'person',
        picture: 1,
        definition: 'is the courier in <Picture 1>, in a soaked canvas jacket',
        retention: 'fully_preserved',
        retentionNote: 'her face and jacket carry through',
        appearsIn: [1, 2],
      },
      {
        kind: 'environment',
        picture: 2,
        definition: 'is the stone hall in <Picture 2>, granite columns and iron sconces',
        retention: 'fully_preserved',
        retentionNote: 'same materials throughout',
        appearsIn: [1, 2],
      },
    ],
    shots: [
      {
        frames: 124,
        firstFrameOccupancy: '<Subject 1> is in frame from the first moment',
        blocking: '<Subject 1> stands at screen left in the midground',
        sightLine: 'Her eyes and the arch lie on one line across the frame',
        camera: {
          token: 'Push In',
          amplitude: 'small',
          speed: 'slow',
          subject: 'her face',
          from: 'a wide framing',
          to: 'a chest-up framing',
        },
        layers: { foreground: 'wet flagstone', midground: '<Subject 1> walking', background: 'flat haze' },
        action: 'She sets her heel down and her weight transfers forward',
        lighting: { sourceCount: 1, description: 'a single sconce on the west wall' },
        diegetic: 'Boots on wet stone',
        dialogue: [],
      },
      {
        frames: 119,
        blocking: '<Subject 1> is at screen right',
        sightLine: 'Her eyes and the sconce lie on one line',
        camera: { token: 'Static Shot', amplitude: 'small', speed: 'slow', subject: 'the arch' },
        layers: { foreground: 'arch stone', midground: '<Subject 1> stopping', background: 'open door' },
        action: 'She stops dead',
        lighting: { sourceCount: 1, description: 'the same sconce' },
        diegetic: 'The footfalls stop',
        dialogue: [
          {
            subject: 1,
            delivery: 'in a low, tight voice matching <Subject 1>',
            lang: 'Chinese',
            line: '门开着。',
          },
        ],
      },
    ],
    sound: { soundscape: 'Wet stone and long reverb.', music: 'N/A' },
    ...overrides,
  };
}

describe('draft → spec', () => {
  it('lands every value in a typed slot', () => {
    const { spec } = specFromDraft(draft(), assets);

    assert.equal(spec.subjects.length, 2);
    assert.equal(spec.shots.length, 2);
    assert.equal(spec.taskType, '[reference generation]');
    assert.equal(spec.shots[0].camera.token, 'Push In');
    assert.equal(spec.sound.music, '');
  });

  it('binds subjects to real nodes and rewrites their citation as {ref}', () => {
    const { spec } = specFromDraft(draft(), assets);
    assert.equal(spec.subjects[0].sourceNodeId, 'img-a');
    assert.ok(spec.subjects[0].definition.includes('{ref}'));
    assert.ok(!spec.subjects[0].definition.includes('<Picture 1>'));
  });

  it('rewrites the model-written labels in prose into id placeholders', () => {
    const { spec } = specFromDraft(draft(), assets);
    const id = spec.subjects[0].id;
    assert.ok(spec.shots[0].blocking.includes(`{s:${id}}`));
    assert.ok(!spec.shots[0].blocking.includes('<Subject 1>'));
  });

  it('resolves a dialogue speaker to a real subject', () => {
    const { spec } = specFromDraft(draft(), assets);
    assert.equal(spec.shots[1].dialogue[0].subjectId, spec.subjects[0].id);
  });

  it('keeps the delivery and rewrites the labels inside it', () => {
    const { spec } = specFromDraft(draft(), assets);
    const id = spec.subjects[0].id;
    assert.equal(spec.shots[1].dialogue[0].delivery, `in a low, tight voice matching {s:${id}}`);
  });

  it('produces a spec the compiler and the QA board both accept', () => {
    const { spec } = specFromDraft(draft(), assets);
    const compiled = compileDirectorSpec(spec, assets);
    assert.deepEqual(compiled.warnings, []);
    assert.deepEqual(
      lintSpec(spec, assets, compiled).filter((f) => f.severity === 'error'),
      [],
    );
  });
});

describe('draft → spec refuses rather than guesses', () => {
  it('throws when there are no shots', () => {
    assert.throws(() => specFromDraft(draft({ shots: [] }), assets), DraftError);
  });

  it('throws when a subject has no definition', () => {
    assert.throws(
      () => specFromDraft(draft({ subjects: [{ kind: 'person', definition: '' }] }), assets),
      DraftError,
    );
  });

  it('throws when the payload is not an object', () => {
    assert.throws(() => specFromDraft('subject_definitions: ...', assets), DraftError);
  });

  it('corrects an invented camera token instead of adopting it, and says so', () => {
    const bad = draft();
    (bad.shots[0] as Record<string, unknown>).camera = { token: 'Bullet Time' };
    const { spec, notes } = specFromDraft(bad, assets);
    assert.equal(spec.shots[0].camera.token, 'Static Shot');
    assert.ok(notes.some((n) => n.includes('Bullet Time')));
  });

  it('corrects an invented retention marker', () => {
    const bad = draft();
    (bad.subjects[0] as Record<string, unknown>).retention = 'fully_replaced';
    const { spec, notes } = specFromDraft(bad, assets);
    assert.equal(spec.subjects[0].retention, 'fully_preserved');
    assert.ok(notes.some((n) => n.includes('fully_replaced')));
  });

  it('drops a picture binding the wiring cannot support', () => {
    const bad = draft();
    (bad.subjects[0] as Record<string, unknown>).picture = 7;
    const { spec, notes } = specFromDraft(bad, assets);
    assert.equal(spec.subjects[0].sourceNodeId, null);
    assert.ok(notes.some((n) => n.includes('<Picture 7>')));
  });
});

describe('the batch length belongs to the node, not the model', () => {
  it('rescales drafted shot lengths to the node’s frame count', () => {
    const { spec, notes } = specFromDraft(draft(), emptyAssets({ totalFrames: 175, fps: 24 }));
    assert.equal(spec.shots.reduce((a, s) => a + s.frames, 0), 175);
    assert.ok(notes.some((n) => n.includes('175')));
  });

  it('splits evenly when the draft gave no lengths at all', () => {
    const d = draft();
    d.shots.forEach((s) => delete (s as Record<string, unknown>).frames);
    const { spec } = specFromDraft(d, assets);
    assert.deepEqual(spec.shots.map((s) => s.frames), [121, 122]);
  });
});

describe('merging a draft into work already done', () => {
  it('fills only the empty fields', () => {
    const { spec: drafted } = specFromDraft(draft(), assets);
    const current = createSpec({
      world: '导演已经写好的世界块',
      shots: [createShot({ blocking: '已经调好的走位', action: '' })],
    });

    const merged = mergeDraftIntoEmpty(current, drafted);
    assert.equal(merged.world, '导演已经写好的世界块');
    assert.equal(merged.shots[0].blocking, '已经调好的走位');
    assert.equal(merged.shots[0].action, drafted.shots[0].action);
  });

  it('appends shots the current spec does not have yet', () => {
    const { spec: drafted } = specFromDraft(draft(), assets);
    const merged = mergeDraftIntoEmpty(createSpec({ shots: [createShot()] }), drafted);
    assert.equal(merged.shots.length, 2);
  });
});
