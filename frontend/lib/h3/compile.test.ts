import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildCameraSentence,
  compileDirectorSpec,
  formatTimecode,
} from './compile';
import {
  createShot,
  createSpec,
  createSubject,
  emptyAssets,
  H3_FRAME_GRID,
  isOnFrameGrid,
  snapToFrameGrid,
  type H3DirectorSpec,
} from './spec';

/* ────────────────────────────────────────────────────────────────────────── *
 * Fixture — a two-shot Ref2VA batch with a person, an environment and a plate
 * ────────────────────────────────────────────────────────────────────────── */

export function fixture(): { spec: H3DirectorSpec; assets: ReturnType<typeof emptyAssets> } {
  const her = createSubject({
    id: 'sub-her',
    kind: 'person',
    sourceNodeId: 'img-a',
    definition:
      'is the young woman in {ref}, a courier in a soaked canvas jacket with her hair pulled back',
    retention: 'fully_preserved',
    retentionNote: 'her face, hair, build and jacket carry through unchanged',
    appearsIn: [1, 2],
  });

  const hall = createSubject({
    id: 'sub-hall',
    kind: 'environment',
    sourceNodeId: 'img-b',
    definition:
      'is the stone hall in {ref}, with rough granite columns, a flagstone floor, iron sconces and a high timber ceiling',
    retention: 'fully_preserved',
    retentionNote: 'the same materials and fixtures are present throughout',
    appearsIn: [1, 2],
  });

  const shot1 = createShot({
    id: 'shot-1',
    frames: 124,
    firstFrameOccupancy:
      '{s:sub-her} is in this frame from the first moment, standing at the near end of the hall',
    blocking:
      'The hall runs north to south and the camera looks north, so its far end sits at screen centre; {s:sub-her} stands one metre inside the south door at screen left',
    sightLine:
      "Her eyes, the sconce she is walking toward and the far arch lie on one straight line across the frame, and that line is held in every frame of this shot",
    camera: {
      token: 'Push In',
      amplitude: 'small',
      speed: 'slow',
      subject: 'her face',
      from: 'a wide two-column framing',
      to: 'a chest-up framing',
      secondary: null,
    },
    layers: {
      foreground: 'a wet flagstone edge catches the sconce light and stays dark and out of the action',
      midground: '{s:sub-her} walks the centre of the hall, the only moving thing at this depth',
      background: 'the far arch sits in flat unlit haze with no detail competing for attention',
    },
    action:
      'She sets her heel down, her weight transfers forward, and the soaked canvas of her jacket swings a beat behind her shoulder',
    lighting: { sourceCount: 1, description: 'a single iron sconce on the west wall, throwing light from screen left' },
    diegetic: 'Her boots strike wet stone and the sound returns off the columns a moment later',
    dialogue: [],
  });

  const shot2 = createShot({
    id: 'shot-2',
    frames: 119,
    blocking:
      'The camera is now at the far arch looking back south along the same axis, and {s:sub-her} is at screen right in the midground',
    sightLine: 'Her eyes and the sconce lie on one line running from screen right to screen left',
    camera: {
      token: 'Static Shot',
      amplitude: 'small',
      speed: 'slow',
      subject: 'the arch and the hall behind it',
      from: '',
      to: '',
      secondary: null,
    },
    layers: {
      foreground: 'the arch stone fills the left third and holds still',
      midground: '{s:sub-her} stops walking and turns her head',
      background: 'the south door stands open on flat grey daylight',
    },
    action: 'She stops dead and comes no further; her own momentum, not the stone, is what halts her',
    lighting: { sourceCount: 1, description: 'the same sconce, now behind the camera' },
    diegetic: 'The footfalls stop and only the drip off her sleeve continues',
    dialogue: [],
  });

  const spec = createSpec({
    mode: 'ref2va',
    taskType: '[reference generation]',
    subjects: [her, hall],
    assetDeclarations: [],
    summary:
      'The target video is two shots in {s:sub-hall}, a courier walking its length and stopping at the far arch.',
    world:
      'Live-action, cinematic, cold daylight and warm sconce light, muted greens and greys, fine 35mm grain.',
    shots: [shot1, shot2],
    sound: {
      soundscape: 'Wet stone underfoot, a long room reverb, and a steady drip from the timber ceiling.',
      music: 'N/A',
    },
  });

  const assets = emptyAssets({
    images: [{ nodeId: 'img-a' }, { nodeId: 'img-b' }],
    totalFrames: 243,
    fps: 24,
  });

  return { spec, assets };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Golden output
 * ────────────────────────────────────────────────────────────────────────── */

const GOLDEN = `subject_definitions:
<Subject 1> is the young woman in <Picture 1>, a courier in a soaked canvas jacket with her hair pulled back.
<Subject 2> is the stone hall in <Picture 2>, with rough granite columns, a flagstone floor, iron sconces and a high timber ceiling.

summary:
[reference generation] The target video is two shots in <Subject 2>, a courier walking its length and stopping at the far arch.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her face, hair, build and jacket carry through unchanged
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the same materials and fixtures are present throughout

detailed_description:
Live-action, cinematic, cold daylight and warm sconce light, muted greens and greys, fine 35mm grain.
[Shot 1] <Subject 1> is in this frame from the first moment, standing at the near end of the hall. The hall runs north to south and the camera looks north, so its far end sits at screen centre; <Subject 1> stands one metre inside the south door at screen left. In the foreground, a wet flagstone edge catches the sconce light and stays dark and out of the action. In the midground, <Subject 1> walks the centre of the hall, the only moving thing at this depth. In the background, the far arch sits in flat unlit haze with no detail competing for attention. Her eyes, the sconce she is walking toward and the far arch lie on one straight line across the frame, and that line is held in every frame of this shot. The camera pushes in with small amplitude at slow speed toward her face, moving continuously from a wide two-column framing until a chest-up framing. She sets her heel down, her weight transfers forward, and the soaked canvas of her jacket swings a beat behind her shoulder. There is exactly 1 light source in this shot: a single iron sconce on the west wall, throwing light from screen left. Her boots strike wet stone and the sound returns off the columns a moment later.
[Shot 2] At 00:05.167, the shot cuts. The camera is now at the far arch looking back south along the same axis, and <Subject 1> is at screen right in the midground. In the foreground, the arch stone fills the left third and holds still. In the midground, <Subject 1> stops walking and turns her head. In the background, the south door stands open on flat grey daylight. Her eyes and the sconce lie on one line running from screen right to screen left. The camera is locked off on a tripod and does not move at all, holding the arch and the hall behind it in frame. She stops dead and comes no further; her own momentum, not the stone, is what halts her. There is exactly 1 light source in this shot: the same sconce, now behind the camera. The footfalls stop and only the drip off her sleeve continues.
There is no spoken dialogue anywhere in this video; every character stays silent with lips closed and communicates through physical movement and facial expression alone.

overall_soundscape:
Wet stone underfoot, a long room reverb, and a steady drip from the timber ceiling.

non_diegetic_music:
N/A`;

/* ────────────────────────────────────────────────────────────────────────── *
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

describe('compileDirectorSpec — Ref2VA', () => {
  it('compiles the fixture to the golden prompt, byte for byte', () => {
    const { spec, assets } = fixture();
    const { prompt, warnings } = compileDirectorSpec(spec, assets);
    assert.equal(prompt, GOLDEN);
    assert.deepEqual(warnings, []);
  });

  it('is deterministic', () => {
    const a = fixture();
    const b = fixture();
    assert.equal(
      compileDirectorSpec(a.spec, a.assets).prompt,
      compileDirectorSpec(b.spec, b.assets).prompt,
    );
  });

  it('a one-field edit changes exactly one line of the prompt', () => {
    const { spec, assets } = fixture();
    const before = compileDirectorSpec(spec, assets).prompt.split('\n');

    spec.shots[0].action = 'She breaks into a run and the jacket snaps taut behind her';
    const after = compileDirectorSpec(spec, assets).prompt.split('\n');

    assert.equal(before.length, after.length);
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i != null);
    assert.deepEqual(changed, [before.findIndex((l) => l.startsWith('[Shot 1]'))]);
  });
});

describe('reference numbering', () => {
  it('resolves asset tags in lighting and non-diegetic music', () => {
    const { spec, assets } = fixture();
    assets.audios = [{ nodeId: 'music-a' }];
    spec.shots[0].lighting.description = 'warm light reflected from {a:img-b}';
    spec.sound.music = 'Fully preserve the music from {a:music-a}';

    const { prompt } = compileDirectorSpec(spec, assets);
    assert.ok(prompt.includes('warm light reflected from <Picture 2>'));
    assert.ok(prompt.includes('Fully preserve the music from <Audio 1>'));
  });

  it('omits subjects that the final prompt never uses', () => {
    const { spec, assets } = fixture();
    spec.subjects.push({
      ...spec.subjects[0],
      id: 'unused-object',
      definition: 'a muscle car parked outside',
      retentionNote: 'keep its paint unchanged',
      appearsIn: [1],
    });

    const { prompt } = compileDirectorSpec(spec, assets);
    assert.ok(!prompt.includes('muscle car'));
    assert.ok(!prompt.includes('keep its paint unchanged'));
    assert.ok(!prompt.includes('<Subject 3>'));
  });

  it('follows the wiring order, not anything stored on the spec', () => {
    const { spec, assets } = fixture();
    assets.images = [{ nodeId: 'img-b' }, { nodeId: 'img-a' }];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.match(prompt, /<Subject 1> is the young woman in <Picture 2>/);
    assert.match(prompt, /<Subject 2> is the stone hall in <Picture 1>/);
  });

  it('renumbers subjects in prose when the subject order changes', () => {
    const { spec, assets } = fixture();
    spec.subjects.reverse();
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.match(prompt, /<Subject 2> is in this frame from the first moment/);
    assert.ok(!prompt.includes('<Subject 1> is in this frame'));
  });

  it('reports an unresolved token instead of silently dropping it', () => {
    const { spec, assets } = fixture();
    spec.shots[0].blocking = '{s:sub-ghost} stands at screen left';
    const { prompt, warnings } = compileDirectorSpec(spec, assets);

    assert.ok(prompt.includes('{s:sub-ghost}'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'unresolved-token');
    assert.equal(warnings[0].severity, 'error');
    assert.equal(warnings[0].shotId, 'shot-1');
  });

  it('warns and appends the citation when a definition has no {ref} slot', () => {
    const { spec, assets } = fixture();
    spec.subjects[0].definition = 'is the young woman, a courier in a soaked canvas jacket';
    const { prompt, warnings } = compileDirectorSpec(spec, assets);

    assert.match(prompt, /a soaked canvas jacket, as seen in <Picture 1>\./);
    assert.equal(warnings[0].code, 'ref-placeholder-missing');
    assert.equal(warnings[0].subjectId, 'sub-her');
  });

  it('errors when a subject points at a disconnected asset', () => {
    const { spec, assets } = fixture();
    assets.images = [{ nodeId: 'img-b' }];
    const { warnings } = compileDirectorSpec(spec, assets);

    assert.equal(warnings.filter((w) => w.code === 'missing-ref').length, 1);
  });
});

describe('base modes', () => {
  const baseSpec = (mode: H3DirectorSpec['mode']) =>
    createSpec({
      mode,
      world: 'Live-action, cinematic, overcast daylight.',
      shots: [
        createShot({
          id: 'b1',
          blocking: 'She stands at screen left in the midground',
          camera: {
            token: 'Tracking Shot',
            amplitude: 'small',
            speed: 'slow',
            subject: 'her',
            from: '',
            to: '',
            secondary: null,
          },
          layers: { foreground: '', midground: '', background: '' },
          lighting: { sourceCount: 0, description: '' },
        }),
      ],
      sound: { soundscape: 'Room tone.', music: '' },
    });

  // These headers must stay byte-identical to backend/h3_prompt_builder.py.
  it('I2VA emits the first-frame alignment header', () => {
    const { prompt } = compileDirectorSpec(baseSpec('i2va'), emptyAssets({ totalFrames: 124 }));
    assert.ok(
      prompt.startsWith(
        'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description:\n',
      ),
    );
  });

  it('FL2VA states both marks with the batch duration', () => {
    const { prompt } = compileDirectorSpec(baseSpec('fl2va'), emptyAssets({ totalFrames: 124 }));
    assert.ok(
      prompt.startsWith(
        'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.17-second mark of the target video.',
      ),
    );
  });

  it('L2VA converges on the last frame at the batch duration', () => {
    const { prompt } = compileDirectorSpec(baseSpec('l2va'), emptyAssets({ totalFrames: 175 }));
    assert.ok(
      prompt.startsWith(
        'How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 7.29-second mark of the target video.',
      ),
    );
  });

  it('T2VA starts straight at the description and has no six-section header', () => {
    const { prompt } = compileDirectorSpec(baseSpec('t2va'), emptyAssets({ totalFrames: 124 }));
    assert.ok(prompt.startsWith('integrated_multimodal_description:\n'));
    assert.ok(!prompt.includes('subject_definitions:'));
  });
});

describe('camera', () => {
  it('places camera direction before action and physics in each shot', () => {
    const { spec, assets } = fixture();
    const { prompt } = compileDirectorSpec(spec, assets);
    assert.ok(prompt.indexOf('The camera pushes in') < prompt.indexOf('She sets her heel down'));
  });

  it('omits camera instructions when camera movement is disabled', () => {
    assert.equal(buildCameraSentence({ ...base, token: 'Push In', enabled: false }), '');
  });

  it('continues the previous shot while retaining an official camera token', () => {
    const sentence = buildCameraSentence({
      token: 'Tracking Shot',
      amplitude: 'small',
      speed: 'slow',
      subject: 'the escaping car',
      from: '',
      to: '',
      secondary: null,
      continuesPrevious: true,
    });
    assert.match(sentence, /continues seamlessly from the previous shot/);
    assert.match(sentence, /tracks with small amplitude at slow speed with the escaping car/);
  });

  const base = { amplitude: 'small', speed: 'slow', subject: '', from: '', to: '', secondary: null } as const;

  it('writes the move inside the sentence, not as a stacked label', () => {
    assert.equal(
      buildCameraSentence({ ...base, token: 'Push In', subject: 'her face' }),
      'The camera pushes in with small amplitude at slow speed toward her face.',
    );
  });

  it('describes the endpoint as continuous motion instead of ending on it', () => {
    const sentence = buildCameraSentence({
      ...base,
      token: 'Push In',
      subject: 'her face',
      from: 'a wide framing',
      to: 'her face fills the frame',
    });
    assert.match(sentence, /moving continuously from a wide framing until her face fills the frame/);
    assert.ok(!sentence.includes('starting on'));
    assert.ok(!sentence.includes('ending on'));
  });

  it('uses the right preposition per move family', () => {
    assert.match(buildCameraSentence({ ...base, token: 'Pull Out', subject: 'the hall' }), /away from the hall/);
    assert.match(buildCameraSentence({ ...base, token: 'Arc Shot', subject: 'the table' }), /arcs .* around the table/);
    assert.match(buildCameraSentence({ ...base, token: 'Pan Left', subject: 'the colonnade' }), /pans left .* on the colonnade/);
  });

  it('states a locked-off shot plainly instead of describing a move', () => {
    const s = buildCameraSentence({ ...base, token: 'Static Shot', subject: 'the door' });
    assert.equal(s, 'The camera is locked off on a tripod and does not move at all, holding the door in frame.');
    assert.ok(!s.includes('amplitude'));
  });

  it('adds at most one secondary move', () => {
    const s = buildCameraSentence({
      ...base,
      token: 'Push In',
      subject: 'her face',
      secondary: { token: 'Tilt Up', amplitude: 'small', speed: 'slow' },
    });
    assert.match(s, /The camera also tilts up with small amplitude at slow speed\.$/);
  });
});

describe('cuts and rules', () => {
  it('replaces the shot-cuts marker with not a cut on that shot', () => {
    const spec = createSpec({
      shots: [
        createShot({ id: 'a', frames: 48, blocking: 'She starts walking' }),
        createShot({
          id: 'b',
          frames: 52,
          blocking: 'She keeps walking',
          camera: { ...createShot().camera, enabled: false, notACut: true },
        }),
      ],
    });
    const { prompt } = compileDirectorSpec(spec, emptyAssets());
    assert.match(prompt, /At 00:02\.000, not a cut\./);
    assert.ok(!prompt.includes('the shot cuts'));
  });

  it('emits nothing outside the official sections', () => {
    const spec = createSpec({
      shots: [
        createShot({ id: 'a', frames: 48, blocking: 'She stands at screen left' }),
        createShot({ id: 'b', frames: 52, blocking: 'She turns away' }),
      ],
    });
    const { prompt } = compileDirectorSpec(spec, emptyAssets());
    assert.ok(!prompt.includes('RULES:'));
    assert.ok(!prompt.includes('PRIORITIES'));
    assert.ok(!prompt.includes('POSITIVE CONSTRAINTS:'));
  });

  it('formats timecodes as MM:SS.mmm', () => {
    assert.equal(formatTimecode(0), '00:00.000');
    assert.equal(formatTimecode(1200), '00:01.200');
    assert.equal(formatTimecode(72500), '01:12.500');
  });
});

describe('dialogue', () => {
  it('states silence once for the whole batch, not once per shot', () => {
    const { spec, assets } = fixture();
    const { prompt } = compileDirectorSpec(spec, assets);
    assert.equal(prompt.split('There is no spoken dialogue').length - 1, 1);
  });

  it('numbers speakers in first-spoken order and drops the silence statement', () => {
    const { spec, assets } = fixture();
    spec.shots[0].dialogue = [
      { subjectId: 'sub-her', delivery: '', lang: 'Chinese', line: '门开着。' },
    ];
    spec.shots[1].dialogue = [
      { subjectId: 'sub-hall', delivery: '', lang: 'Chinese', line: '没人来过。' },
      { subjectId: 'sub-her', delivery: '', lang: 'Chinese', line: '我知道。' },
    ];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.match(prompt, /<Subject 1> \(S1\) says: <d>\[Chinese\] 门开着。<\/d>/);
    assert.match(prompt, /<Subject 2> \(S2\) says: <d>\[Chinese\] 没人来过。<\/d>/);
    assert.ok(!prompt.includes('There is no spoken dialogue'));
  });

  it('puts the delivery outside <d> and leaves the words alone', () => {
    const { spec, assets } = fixture();
    spec.shots[0].dialogue = [
      {
        subjectId: 'sub-her',
        delivery: 'in a low, tight voice with a clipped pace',
        lang: 'Chinese',
        line: '门开着。',
      },
    ];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.ok(
      prompt.includes(
        '<Subject 1> (S1) says in a low, tight voice with a clipped pace: <d>[Chinese] 门开着。</d>',
      ),
    );
  });

  it('does not double the verb when the delivery already starts with "says"', () => {
    const { spec, assets } = fixture();
    spec.shots[0].dialogue = [
      { subjectId: 'sub-her', delivery: 'says quietly,', lang: 'Chinese', line: '门开着。' },
    ];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.ok(prompt.includes('<Subject 1> (S1) says quietly: <d>[Chinese] 门开着。</d>'));
    assert.ok(!prompt.includes('says says'));
  });

  it('states the lips stay closed after a voiceover line', () => {
    const { spec, assets } = fixture();
    spec.shots[0].dialogue = [
      {
        subjectId: 'sub-her',
        delivery: 'in an off-screen voiceover',
        lang: 'Chinese',
        line: '我记得那条路。',
      },
    ];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.ok(
      prompt.includes(
        "<Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese] 我记得那条路。</d> while <Subject 1>'s lips remain completely closed.",
      ),
    );
  });

  it('resolves subject and asset tokens inside the delivery', () => {
    const { spec, assets } = fixture();
    spec.shots[0].dialogue = [
      {
        subjectId: 'sub-her',
        delivery: 'using the voice timbre referenced from {a:img-a}',
        lang: 'Chinese',
        line: '门开着。',
      },
    ];
    const { prompt } = compileDirectorSpec(spec, assets);

    assert.ok(prompt.includes('says using the voice timbre referenced from <Picture 1>:'));
  });
});

describe('escape hatch', () => {
  it('hands a hand-written prompt through untouched', () => {
    const { spec, assets } = fixture();
    spec.rawOverride = 'subject_definitions:\n<Subject 1> is whatever I say it is.';
    const { prompt, warnings } = compileDirectorSpec(spec, assets);
    assert.equal(prompt, 'subject_definitions:\n<Subject 1> is whatever I say it is.');
    assert.deepEqual(warnings, []);
  });
});

describe('frame grid', () => {
  it('is 17k+5 from 124 to 430', () => {
    assert.equal(H3_FRAME_GRID[0], 124);
    assert.equal(H3_FRAME_GRID[H3_FRAME_GRID.length - 1], 430);
    assert.ok(H3_FRAME_GRID.every((n) => (n - 5) % 17 === 0));
  });

  it('snaps an off-grid count to the nearest legal one', () => {
    assert.equal(snapToFrameGrid(130), 124);
    assert.equal(snapToFrameGrid(148), 141);
    assert.equal(snapToFrameGrid(150), 158);
    assert.equal(snapToFrameGrid(9999), 430);
    assert.ok(isOnFrameGrid(175));
    assert.ok(!isOnFrameGrid(176));
  });
});
