import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applySeamPlan, planAllSeamDissolves, planSeamDissolve } from './seam';
import { type Clip, type EditorAsset, type Timeline, clipGain } from './types';

const asset = (patch: Partial<EditorAsset> & { id: string }): EditorAsset => ({
  nodeId: 'n', url: `/${patch.id}.mp4`, title: patch.id, kind: 'video', width: 1376, height: 768,
  fps: 24, frames: 300, timelineFrames: 300, hasAudio: true, ...patch,
});

const clip = (patch: Partial<Clip> & { id: string }): Clip => ({
  trackId: 'V1', assetId: 'a1', start: 0, inFrame: 0, outFrame: 100, speed: 1, volume: 1,
  muted: false, fadeIn: 0, fadeOut: 0, ...patch,
} as Clip);

const timeline = (assets: EditorAsset[], clips: Clip[]): Timeline => ({
  fps: 24, width: 1376, height: 768, tracks: [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false }],
  clips, assets: Object.fromEntries(assets.map((a) => [a.id, a])),
} as unknown as Timeline);

// shot A plays its whole 100 frames; shot B's file begins with 22 overlap frames and is cut in at frame 22
const base = () => timeline(
  [asset({ id: 'a1', timelineFrames: 100 }), asset({ id: 'a2', chainHead: { trimmedUrl: '/t.mp4', frames: 22 } })],
  [clip({ id: 'A', assetId: 'a1', start: 0, inFrame: 0, outFrame: 100 }),
   clip({ id: 'B', assetId: 'a2', start: 100, inFrame: 22, outFrame: 122 })],
);

// the same, with the overlap already revealed (B starts 22 frames early) and a dissolve set by hand over its first `frames`
const withHandDissolve = (frames = 10) => {
  const tl = base();
  tl.clips[1] = clip({ id: 'B', assetId: 'a2', start: 78, inFrame: 0, outFrame: 122, transitionIn: { type: 'dissolve', frames } });
  return tl;
};

type Doing = Extract<ReturnType<typeof planSeamDissolve>, { ok: true }>;

describe('planSeamDissolve, nothing handled by hand', () => {
  it('reveals the overlap and starts the clip that much earlier, so the seam frame stays put', () => {
    const plan = planSeamDissolve(base(), 'B');
    assert.deepEqual(plan, { ok: true, kind: 'full', inFrame: 0, start: 78, frames: 22 });
    // frame 22 of the file played at 100 before and still does: 78 + (22 - 0)
    assert.equal(78 + (22 - 0), 100);
  });

  it('marks the dissolve automatic and mutes the whole overlap', () => {
    const plan = planSeamDissolve(base(), 'B') as Doing;
    const made = applySeamPlan(base().clips[1], plan);
    assert.deepEqual(made.transitionIn, { type: 'dissolve', frames: 22, seam: true });
    assert.deepEqual(made.seamMute, { from: 0, to: 22 });
  });

  it('gives the same plan when it has already been applied', () => {
    const tl = base();
    tl.clips[1] = clip({
      id: 'B', assetId: 'a2', start: 78, inFrame: 0, outFrame: 122,
      transitionIn: { type: 'dissolve', frames: 22, seam: true }, seamMute: { from: 0, to: 22 },
    });
    assert.deepEqual(planSeamDissolve(tl, 'B'), { ok: true, kind: 'full', inFrame: 0, start: 78, frames: 22 });
  });

  it('is limited by how much the previous shot can spare', () => {
    const tl = timeline(
      [asset({ id: 'a1', timelineFrames: 10 }), asset({ id: 'a2', chainHead: { trimmedUrl: '/t.mp4', frames: 22 } })],
      [clip({ id: 'A', assetId: 'a1', outFrame: 10 }), clip({ id: 'B', assetId: 'a2', start: 10, inFrame: 22, outFrame: 60 })],
    );
    assert.deepEqual(planSeamDissolve(tl, 'B'), { ok: true, kind: 'full', inFrame: 13, start: 1, frames: 9 });
  });

  it('refuses, with a reason, when the alignment does not hold', () => {
    const noOverlap = base(); noOverlap.assets.a2 = asset({ id: 'a2' });
    const fast = base(); fast.clips[1] = { ...fast.clips[1], speed: 2 };
    const gap = base(); gap.clips[1] = { ...gap.clips[1], start: 130 };
    const cutShort = base(); cutShort.clips[0] = { ...cutShort.clips[0], outFrame: 90 }; cutShort.clips[1] = { ...cutShort.clips[1], start: 90 };
    const pastOverlap = base(); pastOverlap.clips[1] = { ...pastOverlap.clips[1], inFrame: 30 };
    const first = base(); first.clips = [first.clips[1]];
    for (const tl of [noOverlap, fast, gap, cutShort, pastOverlap, first]) {
      const plan = planSeamDissolve(tl, 'B');
      assert.equal(plan.ok, false);
      assert.ok(!plan.ok && plan.reason.length > 0);
    }
  });
});

describe('a seam partly handled by hand', () => {
  it('leaves the hand-set 10 frames alone and takes over only the 12 after them', () => {
    const tl = withHandDissolve(10);
    const plan = planSeamDissolve(tl, 'B');
    assert.deepEqual(plan, { ok: true, kind: 'rest', from: 10, to: 22 });
    const before = tl.clips[1];
    const after = applySeamPlan(before, plan as Doing);
    assert.deepEqual(after.seamMute, { from: 10, to: 22 });
    assert.equal(after.start, before.start);
    assert.equal(after.inFrame, before.inFrame);
    assert.deepEqual(after.transitionIn, { type: 'dissolve', frames: 10 });   // still his, no automatic flag
  });

  it('mutes only those 12 frames: his 10 keep their sound, the rest of the clip plays', () => {
    const made = { ...withHandDissolve(10).clips[1], seamMute: { from: 10, to: 22 } };
    for (const local of [0, 5, 9]) assert.equal(clipGain(made, made.start + local), 1, `frame ${local}`);
    for (const local of [10, 15, 21]) assert.equal(clipGain(made, made.start + local), 0, `frame ${local}`);
    assert.equal(clipGain(made, made.start + 22), 1);
  });

  it('has nothing to take over when his dissolve already covers every overlap frame', () => {
    const plan = planSeamDissolve(withHandDissolve(22), 'B');
    assert.equal(plan.ok && plan.kind, 'none');
  });

  it('only counts the overlap frames that are showing: with 15 revealed and 10 his, it takes the 5 between', () => {
    const tl = withHandDissolve(10);
    tl.clips[1] = { ...tl.clips[1], inFrame: 7, start: 85 };      // 15 overlap frames revealed
    assert.deepEqual(planSeamDissolve(tl, 'B'), { ok: true, kind: 'rest', from: 10, to: 15 });
  });
});

describe('planAllSeamDissolves', () => {
  // A (plain first shot, 100 frames) -> B (22 overlap frames) -> C (22 overlap frames), then a speed-changed D
  const chain = () => timeline(
    [asset({ id: 'a1', timelineFrames: 100 }),
     asset({ id: 'a2', timelineFrames: 144, chainHead: { trimmedUrl: '/b.mp4', frames: 22 } }),
     asset({ id: 'a3', timelineFrames: 144, chainHead: { trimmedUrl: '/c.mp4', frames: 22 } })],
    [clip({ id: 'A', assetId: 'a1', start: 0, inFrame: 0, outFrame: 100 }),
     clip({ id: 'B', assetId: 'a2', start: 100, inFrame: 22, outFrame: 144 }),
     clip({ id: 'C', assetId: 'a3', start: 222, inFrame: 22, outFrame: 144 }),
     clip({ id: 'D', assetId: 'a3', start: 344, inFrame: 22, outFrame: 144, speed: 2 })],
  );

  it('does every chained seam, leaves the first shot alone and reports what it could not do', () => {
    const batch = planAllSeamDissolves(chain());
    assert.deepEqual(batch.applied, ['B', 'C']);
    assert.deepEqual(batch.blocked.map((b) => b.clipId), ['D']);
    const by = Object.fromEntries(batch.timeline.clips.map((c) => [c.id, c]));
    assert.deepEqual([by.B.start, by.B.inFrame, by.B.transitionIn?.frames, by.B.transitionIn?.seam], [78, 0, 22, true]);
    assert.deepEqual([by.C.start, by.C.inFrame, by.C.transitionIn?.frames], [200, 0, 22]);
    assert.deepEqual(by.B.seamMute, { from: 0, to: 22 });
    assert.equal(by.A.transitionIn, undefined);
    assert.equal(by.A.seamMute, undefined);
    assert.equal(by.D.start, 344);
  });

  it('keeps the end of every shot where it was, so nothing downstream moves', () => {
    const before = chain();
    const after = planAllSeamDissolves(before).timeline;
    const end = (tl: Timeline, id: string) => {
      const c = tl.clips.find((x) => x.id === id)!;
      return c.start + (c.outFrame - c.inFrame);
    };
    for (const id of ['A', 'B', 'C']) assert.equal(end(after, id), end(before, id));
  });

  it('is idempotent: a second run applies nothing and counts them as already done', () => {
    const first = planAllSeamDissolves(chain());
    const second = planAllSeamDissolves(first.timeline);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.already, ['B', 'C']);
    assert.equal(second.timeline, first.timeline);
  });

  it('never moves or replaces what was set by hand: it takes over the frames after it, once', () => {
    const tl = chain();
    tl.clips[1] = { ...tl.clips[1], start: 78, inFrame: 0, transitionIn: { type: 'dissolve', frames: 10 } };
    const first = planAllSeamDissolves(tl);
    const b = first.timeline.clips.find((c) => c.id === 'B')!;
    assert.deepEqual([b.start, b.inFrame, b.transitionIn], [78, 0, { type: 'dissolve', frames: 10 }]);
    assert.deepEqual(b.seamMute, { from: 10, to: 22 });
    assert.deepEqual(first.applied, ['B', 'C']);
    assert.deepEqual(planAllSeamDissolves(first.timeline).already, ['B', 'C']);
  });
});

describe('clipGain with the automatic mark', () => {
  it('a clip without the mark is untouched, a hand dissolve does not silence anything', () => {
    const manual = clip({ id: 'B', start: 78, transitionIn: { type: 'dissolve', frames: 22 } });
    assert.equal(clipGain(manual, 78), 1);
    assert.equal(clipGain(manual, 90), 1);
  });
});
