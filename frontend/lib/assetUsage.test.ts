import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { basenameOf, buildUsageIndex, liveCount, namesIn } from './assetUsage';
import { type Timeline, emptyTimeline } from './editor/types';

describe('namesIn', () => {
  it('finds media under any key, at any depth, and reduces to a basename', () => {
    const found = namesIn({
      url: '/uploads/H3_Video_0001.mp4',
      nested: { frames: [{ imageUrl: 'comfy_output\\sub\\shot.png' }] },
      plyUrl: '/uploads/scan.ply',
    });
    assert.deepEqual([...found.keys()].sort(), ['H3_Video_0001.mp4', 'scan.ply', 'shot.png']);
  });

  it('calls a direct field live and anything nested a record', () => {
    // The shape a generation node actually has: current output at the top, and
    // underneath it every past take plus the inputs that run was given.
    const found = namesIn({
      generatedUrl: '/comfy_output/new.mp4',
      takes: [{ url: '/comfy_output/old.mp4' }, { url: '/comfy_output/older.mp4' }],
      submittedResources: { reference_images: [{ url: '/uploads/ref.png' }] },
    });
    assert.equal(found.get('new.mp4')?.live, true);
    assert.equal(found.get('old.mp4')?.live, false);
    assert.deepEqual([...(found.get('old.mp4')?.fields ?? [])], ['takes']);
    assert.equal(found.get('ref.png')?.live, false);
    assert.deepEqual([...(found.get('ref.png')?.fields ?? [])], ['submittedResources']);
  });

  it('counts a file as live when it is both the current output and an old take', () => {
    const found = namesIn({
      generatedUrl: '/comfy_output/a.mp4',
      takes: [{ url: '/comfy_output/a.mp4' }],
    });
    assert.equal(found.get('a.mp4')?.live, true);
  });

  it('ignores prose and survives a cycle', () => {
    assert.equal(namesIn({ prompt: 'a woman walks into frame, no cuts' }).size, 0);
    const cyclic: Record<string, unknown> = { url: '/uploads/a.mp4' };
    cyclic.self = cyclic;
    assert.deepEqual([...namesIn(cyclic).keys()], ['a.mp4']);
  });

  it('skips strings too long to be a path', () => {
    assert.equal(namesIn({ screenshot: `data:image/png;base64,${'A'.repeat(4000)}.png` }).size, 0);
  });
});

describe('buildUsageIndex', () => {
  const nodes = [
    { id: 'video-1', type: 'video', data: { generatedUrl: '/uploads/shot.mp4' } },
    { id: 'image-1', type: 'image', data: { url: '/uploads/shot.mp4', alias: '主角特写' } },
    { id: 'prompt-1', type: 'prompt', data: { text: '一个人走进画面' } },
  ];

  it('lists every node pointing at a file, and prefers an alias as the label', () => {
    const index = buildUsageIndex(nodes, null);
    const usages = index.get('shot.mp4') ?? [];
    assert.deepEqual(usages.map((u) => [u.id, u.label]), [
      ['video-1', '视频镜头'],
      ['image-1', '主角特写'],
    ]);
    assert.equal(index.has('一个人走进画面'), false);
  });

  it('puts a node that only remembers the file after the ones still using it', () => {
    const withHistory = [
      { id: 'video-9', type: 'video', data: { takes: [{ url: '/comfy_output/shot.mp4' }] } },
      ...nodes,
    ];
    const usages = buildUsageIndex(withHistory, null).get('shot.mp4') ?? [];
    assert.deepEqual(usages.map((u) => u.live), [true, true, false]);
    assert.equal(liveCount(usages), 2);
    assert.equal(usages[2].detail, '这个节点的历史版本');
  });

  it('adds cut-room clips, which are matched by asset id rather than by string', () => {
    const timeline: Timeline = {
      ...emptyTimeline(),
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false }],
      assets: {
        a1: {
          id: 'a1',
          nodeId: '',
          url: '/uploads/shot.mp4',
          title: '镜头 3',
          kind: 'video',
          width: 1920,
          height: 1080,
          fps: 24,
          frames: 96,
          timelineFrames: 96,
          hasAudio: false,
        },
      },
      clips: [
        {
          id: 'clip-1',
          trackId: 'v1',
          assetId: 'a1',
          start: 48,
          inFrame: 0,
          outFrame: 48,
          speed: 1,
          volume: 1,
          muted: false,
          fadeIn: 0,
          fadeOut: 0,
        },
      ],
    };
    const usages = buildUsageIndex(nodes, timeline).get('shot.mp4') ?? [];
    assert.equal(usages.length, 3);
    const clip = usages[2];
    assert.equal(clip.kind, 'clip');
    assert.equal(clip.start, 48);
    assert.match(clip.detail ?? '', /V1 · 00:00:02:00 · 48 帧/);
  });

  it('reports nothing for a file nobody points at', () => {
    assert.equal(buildUsageIndex(nodes, null).get('orphan.mp4'), undefined);
  });
});

describe('basenameOf', () => {
  it('handles both separators and a bare name', () => {
    assert.equal(basenameOf('/uploads/a.mp4'), 'a.mp4');
    assert.equal(basenameOf('C:\\out\\b.png'), 'b.png');
    assert.equal(basenameOf('c.wav'), 'c.wav');
  });
});
