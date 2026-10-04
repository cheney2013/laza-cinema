import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { compileDirectorSpec } from './compile';
import { fixture } from './compile.test';
import { applyFix, hasBlockingErrors, lintSpec, type LintFinding } from './lint';
import { createShot, createSpec, createSubject, emptyAssets } from './spec';

function codes(findings: LintFinding[]): string[] {
  return findings.map((f) => f.code);
}

function lintFixture(mutate: (f: ReturnType<typeof fixture>) => void = () => {}): LintFinding[] {
  const f = fixture();
  mutate(f);
  return lintSpec(f.spec, f.assets, compileDirectorSpec(f.spec, f.assets));
}

describe('a well-formed shot design is silent', () => {
  it('reports nothing on the golden fixture', () => {
    // If this ever starts firing, the rule that fired is too eager. A light board
    // that cries on correct work stops being read, and then it stops working.
    assert.deepEqual(codes(lintFixture()), []);
  });

  it('does not flag "comes no further" as a negation', () => {
    // Negating a degree summons nothing. Only a negated *thing* is the failure.
    const findings = lintFixture();
    assert.equal(findings.filter((f) => f.code === 'negation').length, 0);
  });
});

describe('reference count', () => {
  it('blocks at four references and offers a split', () => {
    const findings = lintFixture((f) => {
      f.assets.images = [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }];
      f.assets.videos = [{ nodeId: 'd' }];
    });
    const hit = findings.find((f) => f.code === 'ref-overflow');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.equal(hit.fix?.kind, 'split-batch');
    assert.ok(hasBlockingErrors(findings));
  });

  it('stays quiet at three', () => {
    const findings = lintFixture((f) => {
      f.assets.images = [{ nodeId: 'img-a' }, { nodeId: 'img-b' }];
      f.assets.videos = [{ nodeId: 'vid' }];
    });
    assert.ok(!codes(findings).includes('ref-overflow'));
  });
});

describe('frames', () => {
  it('flags an off-grid batch length and offers the nearest legal one', () => {
    const findings = lintFixture((f) => {
      f.assets.totalFrames = 250;
    });
    const hit = findings.find((f) => f.code === 'off-grid-frames');
    assert.equal(hit?.fix?.frames, 243);
  });

  it('flags a shot budget that does not add up to the batch', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[1].frames = 60;
    });
    assert.ok(codes(findings).includes('frames-mismatch'));
  });

  it('rebalances the shot budget mechanically', () => {
    const f = fixture();
    f.spec.shots[1].frames = 60;
    const finding = lintSpec(f.spec, f.assets).find((x) => x.code === 'frames-mismatch');
    const next = applyFix(f.spec, finding!, { totalFrames: 243, fps: 24 });
    assert.deepEqual(
      next.shots.map((s) => s.frames),
      [121, 122],
    );
    assert.equal(next.shots.reduce((a, s) => a + s.frames, 0), 243);
  });
});

describe('language rules', () => {
  it('catches an optics clause and can delete it', () => {
    const f = fixture();
    f.spec.shots[0].layers.background =
      'the far arch sits in shallow depth of field behind her';
    const finding = lintSpec(f.spec, f.assets).find((x) => x.code === 'optics-term');
    assert.ok(finding);
    assert.equal(finding.fix?.kind, 'delete-span');

    const next = applyFix(f.spec, finding, { totalFrames: 243, fps: 24 });
    assert.ok(!next.shots[0].layers.background.includes('depth of field'));
  });

  it('catches a focal length', () => {
    const findings = lintFixture((f) => {
      f.spec.world = 'Shot on a 85mm lens, cold daylight.';
    });
    assert.ok(codes(findings).includes('optics-term'));
  });

  it('catches a negated object', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].action = 'She walks with no umbrella and no crowd around her';
    });
    assert.ok(codes(findings).includes('negation'));
  });

  it('catches orientation phrasing that has no composition to lean on', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].sightLine = 'She faces the arch and holds it';
    });
    assert.ok(codes(findings).includes('orientation-phrasing'));
  });

  it('excuses orientation phrasing when the line is stated as composition', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].sightLine =
        'She faces the arch; her eyes, the sconce and the arch lie on one straight line across the frame';
    });
    assert.ok(!codes(findings).includes('orientation-phrasing'));
  });

  it('catches an impact written as a single event', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[1].action = 'The gust knocks her flying into the far wall';
    });
    assert.ok(codes(findings).includes('single-event-impact'));
  });

  it('catches a camera move hidden in prose', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].blocking = 'The camera pans left across the columns as she walks';
    });
    assert.ok(codes(findings).includes('camera-in-prose'));
  });

  it('catches a hard-coded label that will go stale on reorder', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].action = '<Subject 1> sets her heel down';
    });
    assert.ok(codes(findings).includes('literal-label'));
  });
});

describe('craft rules', () => {
  it('catches a light-source count the body contradicts', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].lighting = {
        sourceCount: 1,
        description: 'a sconce on the west wall and a window behind her',
      };
    });
    assert.ok(codes(findings).includes('light-count-mismatch'));
  });

  it('catches two depth layers doing the same job', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].layers.foreground = 'wet flagstone catching the sconce light';
      f.spec.shots[0].layers.midground = 'wet flagstone catching the sconce light too';
    });
    assert.ok(codes(findings).includes('layer-collision'));
  });

  it("warns when a speaker's first line has no delivery", () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].dialogue = [
        { subjectId: 'sub-her', delivery: '', lang: 'Chinese', line: '门开着。' },
      ];
    });
    assert.ok(codes(findings).includes('speaker-no-delivery'));
  });

  it('warns once per speaker, not once per line', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].dialogue = [
        { subjectId: 'sub-her', delivery: 'in a low, tight voice', lang: 'Chinese', line: '门开着。' },
      ];
      f.spec.shots[1].dialogue = [
        { subjectId: 'sub-her', delivery: '', lang: 'Chinese', line: '我知道。' },
        { subjectId: 'sub-hall', delivery: '', lang: 'Chinese', line: '没人来过。' },
      ];
    });
    assert.deepEqual(
      findings.filter((f) => f.code === 'speaker-no-delivery').length,
      1,
    );
  });

  it('catches the same attribute asserted in two places', () => {
    const findings = lintFixture((f) => {
      const line = 'she wears a soaked canvas courier jacket with a torn collar';
      f.spec.shots[0].blocking = `${f.spec.shots[0].blocking}, and ${line}`;
      f.spec.shots[1].action = `${line} as she stops`;
    });
    assert.ok(codes(findings).includes('duplicate-assertion'));
  });

});

describe('completeness', () => {
  it('blocks an empty subject definition', () => {
    const spec = createSpec({
      subjects: [createSubject({ id: 's1', definition: '' })],
      shots: [createShot({ blocking: 'She stands at screen left' })],
    });
    const findings = lintSpec(spec, emptyAssets());
    assert.ok(codes(findings).includes('empty-subject'));
  });

  it('blocks a shot with neither blocking nor action', () => {
    const spec = createSpec({ shots: [createShot({ id: 'x' })] });
    const findings = lintSpec(spec, emptyAssets());
    assert.ok(codes(findings).includes('empty-shot'));
  });

  it('warns that a later shot keeps first-frame text the prompt never sees', () => {
    // 穿插一镜到最前面之后，原来那句还在 spec 里，但只有第 1 镜的会被编译。
    const findings = lintFixture((f) => {
      f.spec.shots[1].firstFrameOccupancy = 'She is already in frame at the arch';
    });
    const hit = findings.find((x) => x.code === 'orphan-first-frame');
    assert.ok(hit);
    assert.equal(hit.fix?.kind, 'delete-span');
  });

  it('warns when the first frame has no stated occupancy', () => {
    const findings = lintFixture((f) => {
      f.spec.shots[0].firstFrameOccupancy = '';
    });
    assert.ok(codes(findings).includes('first-frame-occupancy'));
  });
});

describe('hand-written override', () => {
  it('skips the prose rules but still checks the closed marker set', () => {
    const findings = lintFixture((f) => {
      f.spec.rawOverride = [
        'subject_definitions:',
        '<Subject 1> is her.',
        '',
        'retention_analysis:',
        '<Subject 1> (appears in [Shot 1]): fully_replaced - swapped out',
      ].join('\n');
    });
    assert.ok(codes(findings).includes('bad-retention-marker'));
    assert.ok(!codes(findings).includes('first-frame-occupancy'));
  });

  it('accepts every legal marker', () => {
    const findings = lintFixture((f) => {
      f.spec.rawOverride = [
        '<Subject 1> (appears in [Shot 1]): attribute_transfer - motion carried over',
        '<Video 1> (cut and pacing structure): weak_reference - only the rhythm',
        '<Audio 1>: fully_copy - reused 1:1',
      ].join('\n');
    });
    assert.ok(!codes(findings).includes('bad-retention-marker'));
  });
});

describe('compile failures surface as findings', () => {
  it('promotes an unresolved placeholder to a blocking error', () => {
    const f = fixture();
    f.spec.shots[0].blocking = '{s:sub-ghost} stands at screen left';
    const findings = lintSpec(f.spec, f.assets, compileDirectorSpec(f.spec, f.assets));
    assert.ok(codes(findings).includes('unresolved-token'));
    assert.ok(hasBlockingErrors(findings));
  });
});
