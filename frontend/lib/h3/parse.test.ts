import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { compileDirectorSpec } from './compile';
import { fixture } from './compile.test';
import { diffLines, diffSpecs, summarizeLineDiff } from './diff';
import { isStructuredH3Prompt, parseH3Prompt } from './parse';
import { emptyAssets } from './spec';

describe('importing an existing prompt', () => {
  const { spec: original, assets } = fixture();
  const prompt = compileDirectorSpec(original, assets).prompt;

  it('recognises a structured prompt', () => {
    assert.ok(isStructuredH3Prompt(prompt));
    assert.ok(!isStructuredH3Prompt('一个女人走过石厅，镜头缓缓推进'));
  });

  it('recovers the sections that can be recovered exactly', () => {
    const { spec } = parseH3Prompt(prompt, assets);

    assert.equal(spec.mode, 'ref2va');
    assert.equal(spec.taskType, '[reference generation]');
    assert.equal(
      spec.summary,
      original.summary.replace('{s:sub-hall}', `{s:${spec.subjects[1].id}}`),
    );
    assert.equal(spec.world, original.world);
    assert.equal(spec.sound.soundscape, original.sound.soundscape);
    assert.equal(spec.subjects.length, 2);
    assert.equal(spec.shots.length, 2);
  });

  it('turns emitted numbers back into placeholders', () => {
    const { spec } = parseH3Prompt(prompt, assets);

    // The subject's own picture becomes {ref}; everything else addresses by id.
    assert.ok(spec.subjects[0].definition.includes('{ref}'));
    assert.equal(spec.subjects[0].sourceNodeId, 'img-a');
    assert.equal(spec.subjects[1].sourceNodeId, 'img-b');
    assert.ok(spec.shots[0].action.includes(`{s:${spec.subjects[0].id}}`));
    assert.ok(!spec.shots[0].action.includes('<Subject 1>'));
  });

  it('keeps the retention markers and shot scoping', () => {
    const { spec } = parseH3Prompt(prompt, assets);
    assert.equal(spec.subjects[0].retention, 'fully_preserved');
    assert.deepEqual(spec.subjects[0].appearsIn, [1, 2]);
    assert.equal(spec.subjects[1].retentionNote, original.subjects[1].retentionNote);
  });

  it('recovers the camera token out of its sentence', () => {
    const { spec } = parseH3Prompt(prompt, assets);
    assert.equal(spec.shots[0].camera.token, 'Push In');
    assert.equal(spec.shots[0].camera.amplitude, 'small');
    assert.equal(spec.shots[0].camera.speed, 'slow');
    assert.equal(spec.shots[0].camera.subject, 'her face');
    assert.equal(spec.shots[0].camera.from, 'a wide two-column framing');
    assert.equal(spec.shots[0].camera.to, 'a chest-up framing');
    assert.equal(spec.shots[1].camera.token, 'Static Shot');
  });

  it('says plainly that shot prose was not decomposed', () => {
    const { notes } = parseH3Prompt(prompt, assets);
    assert.ok(notes.some((n) => n.includes('动作')));
  });

  it('splits the frame budget across the recovered shots', () => {
    const { spec } = parseH3Prompt(prompt, assets);
    assert.equal(spec.shots.reduce((a, s) => a + s.frames, 0), 243);
  });

  it('parks unstructured text in the override instead of pretending to parse it', () => {
    const { spec, notes } = parseH3Prompt('一个女人走过石厅', emptyAssets());
    assert.equal(spec.rawOverride, '一个女人走过石厅');
    assert.equal(notes.length, 1);
  });

  it('flags an illegal retention marker rather than adopting it', () => {
    const broken = prompt.replace('fully_preserved - her face', 'fully_replaced - her face');
    const { spec, notes } = parseH3Prompt(broken, assets);
    assert.equal(spec.subjects[0].retention, 'fully_preserved');
    assert.ok(notes.some((n) => n.includes('fully_replaced')));
  });
});

describe('spec diff', () => {
  it('names the one field that changed', () => {
    const a = fixture().spec;
    const b = fixture().spec;
    b.shots[0].blocking = 'She stands dead centre at the far end';

    const changes = diffSpecs(a, b);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'shots.0.blocking');
    assert.equal(changes[0].label, '[Shot 1] 空间调度');
  });

  it('sees a camera token swap', () => {
    const a = fixture().spec;
    const b = fixture().spec;
    b.shots[0].camera.token = 'Pull Out';
    const changes = diffSpecs(a, b);
    assert.deepEqual(changes.map((c) => c.path), ['shots.0.camera']);
    assert.equal(changes[0].after, 'Pull Out / small / slow');
  });

  it('is empty for identical specs', () => {
    assert.deepEqual(diffSpecs(fixture().spec, fixture().spec), []);
  });
});

describe('prompt line diff', () => {
  it('reports exactly which prompt lines a field edit moves', () => {
    const { spec, assets } = fixture();
    const before = compileDirectorSpec(spec, assets).prompt;
    spec.shots[0].action = 'She breaks into a run';
    const after = compileDirectorSpec(spec, assets).prompt;

    const summary = summarizeLineDiff(diffLines(before, after));
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 1);
    assert.equal(summary.touched.length, 1);
  });

  it('reports nothing when nothing changed', () => {
    const { spec, assets } = fixture();
    const p = compileDirectorSpec(spec, assets).prompt;
    assert.deepEqual(summarizeLineDiff(diffLines(p, p)), { added: 0, removed: 0, touched: [] });
  });
});
