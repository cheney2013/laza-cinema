import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import type { Node } from '@xyflow/react';

import { migrateAbsoluteAssetUrls, migrateEditModeNodes, migrateGaussianSourceHandles, migrateRemovedImageNodes, migrateRetiredGenerators } from './migrations';

const node = (data: Record<string, unknown>): Node =>
  ({ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data }) as Node;

test('strips the host from our own asset paths', () => {
  const result = migrateAbsoluteAssetUrls([
    node({ url: 'http://localhost:8003/uploads/pose_snapshot_ab.png' }),
  ]);
  assert.equal(result.migrated, 1);
  assert.equal((result.nodes[0].data as any).url, '/uploads/pose_snapshot_ab.png');
});

test('handles every host the studio is reached through', () => {
  const hosts = [
    'http://localhost:8003',
    'http://127.0.0.1:8003',
    'http://192.168.1.42:8003',
    'http://100.67.10.59:8003',
  ];
  for (const host of hosts) {
    const result = migrateAbsoluteAssetUrls([node({ url: `${host}/comfy_output/H3_Video_1_.mp4` })]);
    assert.equal((result.nodes[0].data as any).url, '/comfy_output/H3_Video_1_.mp4', host);
  }
});

test('leaves genuinely external URLs alone', () => {
  const url = 'https://example.com/uploads/not-ours.png';
  const result = migrateAbsoluteAssetUrls([node({ url: 'https://example.com/reference.png' })]);
  assert.equal(result.migrated, 0);
  // Same host, but the path looks like ours — the host is what decides.
  const looksLikeOurs = migrateAbsoluteAssetUrls([node({ url })]);
  assert.equal((looksLikeOurs.nodes[0].data as any).url, '/uploads/not-ours.png');
});

test('reaches into arrays and nested objects', () => {
  const result = migrateAbsoluteAssetUrls([
    node({
      refImageUrls: ['http://localhost:8003/uploads/a.png', '/uploads/b.png'],
      submittedResources: { first_frame: 'http://localhost:8003/uploads/c.png' },
    }),
  ]);
  const data = result.nodes[0].data as any;
  assert.deepEqual(data.refImageUrls, ['/uploads/a.png', '/uploads/b.png']);
  assert.equal(data.submittedResources.first_frame, '/uploads/c.png');
});

test('a clean canvas is returned untouched', () => {
  const nodes = [node({ url: '/uploads/already-relative.png', prompt: 'a shot' })];
  const result = migrateAbsoluteAssetUrls(nodes);
  assert.equal(result.migrated, 0);
  assert.equal(result.nodes, nodes);
});

describe('migrateEditModeNodes', () => {
  const node = (id: string, editMode?: string) =>
    ({ id, type: 'videoEdit', position: { x: 0, y: 0 }, width: 340, height: 380, data: editMode ? { editMode, prompt: 'p' } : { prompt: 'p' } }) as any;

  it('gives each edit operation its own node type and keeps data and edges', () => {
    const nodes = [node('a', 'temporal_reshot'), node('b', 'av_bridge'), node('c', 'continuation'), node('d', 'fl2va'), node('e', 'edit')];
    const { nodes: out, migrated } = migrateEditModeNodes(nodes, []);
    assert.equal(migrated, 4);
    assert.deepEqual(out.map((n) => n.type), ['videoReshot', 'videoBridge', 'videoContinue', 'videoFrames', 'videoEdit']);
    assert.equal((out[0].data as any).editMode, undefined);
    assert.equal((out[0].data as any).prompt, 'p');
    assert.equal(out[1].width, 420);
    assert.equal((out[4].data as any).editMode, 'edit');
  });

  it('reads an unset mode the way the old node did', () => {
    const edges = [
      { id: '1', source: 'x', target: 'a', targetHandle: 'in-first-frame' },
      { id: '2', source: 'y', target: 'a', targetHandle: 'in-last-frame' },
      { id: '3', source: 'z', target: 'b', targetHandle: 'in-first-frame' },
    ] as any;
    const { nodes: out } = migrateEditModeNodes([node('a'), node('b')], edges);
    assert.deepEqual(out.map((n) => n.type), ['videoFrames', 'videoEdit']);
  });

  it('is a no-op on an already migrated canvas', () => {
    const nodes = [{ ...node('a'), type: 'videoBridge' }];
    const result = migrateEditModeNodes(nodes, []);
    assert.equal(result.migrated, 0);
    assert.equal(result.nodes, nodes);
  });
});

describe('migrateRemovedImageNodes', () => {
  it('keeps a FLUX still and a style capsule as asset nodes and drops wires into them', () => {
    const nodes = [
      { id: 's', type: 'scene', position: { x: 0, y: 0 }, data: { generatedUrl: '/comfy_output/a.png', prompt: 'a room', width: 1024, height: 768 } },
      { id: 'y', type: 'style', position: { x: 0, y: 0 }, data: { label: 'Style', previewUrl: '/uploads/b.png' } },
      { id: 'p', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'x' } },
      { id: 'v', type: 'video', position: { x: 0, y: 0 }, data: {} },
    ] as any;
    const edges = [
      { id: 'e1', source: 'p', target: 's', targetHandle: 'in-prompt' },
      { id: 'e2', source: 'y', target: 's', sourceHandle: 'out-style', targetHandle: 'in-style' },
      { id: 'e3', source: 's', target: 'v', sourceHandle: 'out-image', targetHandle: 'in-image' },
      { id: 'e4', source: 'y', target: 'v', sourceHandle: 'out-style', targetHandle: 'in-ref-image' },
    ] as any;
    const out = migrateRemovedImageNodes(nodes, edges);
    assert.equal(out.migrated, 2);
    assert.deepEqual(out.nodes.map((n) => n.type), ['image', 'image', 'prompt', 'video']);
    assert.deepEqual(out.nodes[0].data, { url: '/comfy_output/a.png', mediaType: 'image', width: 1024, height: 768, label: 'a room', prompt: 'a room' });
    assert.deepEqual(out.nodes[1].data, { url: '/uploads/b.png', mediaType: 'image' });
    assert.deepEqual(out.edges.map((e) => [e.id, e.sourceHandle]), [['e3', 'out-image'], ['e4', 'out-image']]);
  });
});

describe('migrateRetiredGenerators', () => {
  it('keeps rendered clips as video asset nodes and drops wires into the retired nodes', () => {
    const nodes = [
      { id: 'm', type: 'performerMask', position: { x: 0, y: 0 }, data: { status: 'idle', shots: null } },
      { id: 'r', type: 'recast', position: { x: 0, y: 0 }, data: { generatedUrl: '/uploads/recast_1.mp4', prompt: 'swap her', width: 1376, height: 768, editMode: 'recast' } },
      { id: 't', type: 'motionTransfer', position: { x: 0, y: 0 }, data: { generatedUrl: null, label: 'dance' } },
      { id: 'src', type: 'image', position: { x: 0, y: 0 }, data: { url: '/uploads/src.mp4', mediaType: 'video' } },
      { id: 'cut', type: 'preview', position: { x: 0, y: 0 }, data: {} },
    ] as any;
    const edges = [
      { id: 'e1', source: 'src', target: 'm', sourceHandle: 'out-video', targetHandle: 'in-video' },
      { id: 'e2', source: 'm', target: 'r', sourceHandle: 'out-masked', targetHandle: 'in-masked' },
      { id: 'e3', source: 'r', target: 'cut', sourceHandle: 'out-video', targetHandle: 'in-video' },
    ] as any;
    const out = migrateRetiredGenerators(nodes, edges);
    assert.equal(out.migrated, 3);
    assert.deepEqual(out.nodes.map((n) => n.type), ['image', 'image', 'image', 'image', 'preview']);
    assert.deepEqual(out.nodes[0].data, { url: null, mediaType: 'video' });
    assert.deepEqual(out.nodes[1].data, { url: '/uploads/recast_1.mp4', mediaType: 'video', width: 1376, height: 768, label: 'swap her', prompt: 'swap her' });
    assert.deepEqual(out.nodes[2].data, { url: null, mediaType: 'video', label: 'dance' });
    assert.deepEqual(out.edges.map((e) => [e.id, e.sourceHandle]), [['e3', 'out-video']]);
  });

  it('sends videoEdit nodes left in a retired mode back to a plain edit', () => {
    const nodes = [
      { id: 'a', type: 'videoEdit', position: { x: 0, y: 0 }, data: { editMode: 'recast', prompt: 'p' } },
      { id: 'b', type: 'videoEdit', position: { x: 0, y: 0 }, data: { editMode: 'motion_transfer' } },
      { id: 'c', type: 'videoEdit', position: { x: 0, y: 0 }, data: { editMode: 'continuation' } },
    ] as any;
    const edges = [{ id: 'e', source: 'x', target: 'a', targetHandle: 'in-video' }] as any;
    const out = migrateRetiredGenerators(nodes, edges);
    assert.equal(out.migrated, 2);
    assert.deepEqual(out.nodes.map((n) => (n.data as any).editMode), ['edit', 'edit', 'continuation']);
    assert.equal((out.nodes[0].data as any).prompt, 'p');
    assert.equal(out.edges, edges);
  });

  it('returns a clean canvas untouched', () => {
    const nodes = [{ id: 'v', type: 'video', position: { x: 0, y: 0 }, data: {} }] as any;
    const edges = [] as any;
    const out = migrateRetiredGenerators(nodes, edges);
    assert.equal(out.migrated, 0);
    assert.equal(out.nodes, nodes);
    assert.equal(out.edges, edges);
  });
});

describe('migrateGaussianSourceHandles', () => {
  const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, data: {} }) as any;
  it('moves wires from the old single output to the screenshot port, except into a viewer', () => {
    const nodes = [node('g', 'gaussian'), node('q', 'qwenImage'), node('v', 'gaussianViewer')];
    const edges = [
      { id: '1', source: 'g', target: 'q', sourceHandle: 'out-gaussian', targetHandle: 'in-ref' },
      { id: '2', source: 'g', target: 'q', targetHandle: 'in-ref' },
      { id: '3', source: 'g', target: 'v', sourceHandle: 'out-gaussian', targetHandle: 'in-gaussian' },
      { id: '4', source: 'g', target: 'q', sourceHandle: 'out-image', targetHandle: 'in-ref' },
    ] as any;
    const out = migrateGaussianSourceHandles(nodes, edges);
    assert.deepEqual(out.edges.map((e: any) => e.sourceHandle), ['out-image', 'out-image', 'out-gaussian', 'out-image']);
    assert.equal(out.migrated, 2);
  });
  it('changes nothing when there is nothing to move', () => {
    const edges = [{ id: '1', source: 'a', target: 'b' }] as any;
    assert.equal(migrateGaussianSourceHandles([node('a', 'image'), node('b', 'qwenImage')], edges).edges, edges);
  });
});
