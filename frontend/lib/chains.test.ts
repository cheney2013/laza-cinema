import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findChains } from './chains';

const shot = (id: string, label = id, x = 0) => ({ id, type: 'video', position: { x, y: 0 }, data: { label } });
const mc = (source: string, target: string) => ({ source, target, targetHandle: 'in-motion-context' });
const ref = (target: string) => ({ source: 'board', target, targetHandle: 'in-ref-image' });
const board = { id: 'board', type: 'image', data: { label: 'board' } };

describe('findChains', () => {
  it('walks a chain from its head in order, with HD progress', () => {
    const nodes = [
      board, shot('b', 'C2'), shot('a', 'C1'), shot('c', 'C3'),
      { id: 'up', type: 'videoUpscale', data: { status: 'done', generatedUrl: '/x.mp4' } },
      { id: 'up2', type: 'videoUpscale', data: { status: 'running' } },
    ];
    const edges = [ref('a'), mc('a', 'b'), mc('b', 'c'), { source: 'a', target: 'up' }, { source: 'b', target: 'up2' }];
    const [chain, ...rest] = findChains(nodes, edges);
    assert.equal(rest.length, 0);
    assert.equal(chain.head.label, 'C1');
    assert.equal(chain.from, null);
    assert.deepEqual(chain.segments.map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual(chain.segments.map((s) => s.hd), [true, false, false]);
    assert.equal(chain.nextHd?.id, 'b');
  });

  it('runs through a trim instead of splitting the chain there', () => {
    const nodes = [board, shot('c9', 'C9'), shot('c10', 'C10'), { id: 'cut', type: 'videoTrim', data: {} }, shot('c11', 'C11')];
    const edges = [ref('c9'), mc('c9', 'c10'), { source: 'c10', target: 'cut', targetHandle: 'in-video' }, mc('cut', 'c11')];
    const chains = findChains(nodes, edges);
    assert.equal(chains.length, 1);
    assert.deepEqual(chains[0].segments.map((s) => s.label), ['C9', 'C10', 'C11']);
  });

  it('reports a carried-in clip as where the chain comes from, not as a shot', () => {
    const nodes = [
      { id: 'carrier', type: 'video', data: { label: '链头接点 · 场3 C16b' } },
      { id: 'import', type: 'image', data: { label: '定版合成' } },
      shot('x', 'C17'), shot('y', 'C24'),
    ];
    const edges = [mc('carrier', 'x'), mc('import', 'y')];
    const chains = findChains(nodes, edges);
    assert.deepEqual(chains.map((c) => [c.head.label, c.from?.label, c.segments.length]), [
      ['C17', '链头接点 · 场3 C16b', 1],
      ['C24', '定版合成', 1],
    ]);
  });

  it('flags a shot continued twice and orders heads naturally', () => {
    const nodes = [board, shot('h2', '场1 C10'), shot('x'), shot('h1', '场1 C9'), shot('y'), shot('z')];
    const edges = [ref('h1'), ref('h2'), mc('h2', 'x'), mc('h1', 'y'), mc('h1', 'z')];
    const chains = findChains(nodes, edges);
    assert.deepEqual(chains.map((c) => c.head.label), ['场1 C9', '场1 C10']);
    assert.equal(chains[0].branched, true);
    assert.equal(chains[0].segments.length, 3);
  });
  it('does not count an HD made from an older take of the shot', () => {
    const clip = (tag: string) => `/comfy_output/H3_Chunk_${tag}_00001_.mp4`;
    const nodes = [
      board,
      { ...shot('a', 'C1'), data: { label: 'C1', generatedUrl: clip('bbbb2222') } },
      { ...shot('b', 'C2'), data: { label: 'C2', generatedUrl: clip('cccc3333') } },
      { id: 'up1', type: 'videoUpscale', data: { status: 'done', generatedUrl: '/hd1.mp4', compareUrl: clip('aaaa1111') } },
      { id: 'up2', type: 'videoUpscale', data: { status: 'done', generatedUrl: '/hd2.mp4', compareUrl: clip('cccc3333') } },
    ];
    const edges = [ref('a'), mc('a', 'b'), { source: 'a', target: 'up1' }, { source: 'b', target: 'up2' }];
    const [chain] = findChains(nodes, edges);
    assert.deepEqual(chain.segments.map((s) => s.hd), [false, true]);
    assert.equal(chain.nextHd?.id, 'a');
  });
  it('counts an HD made of the shot cut by a trim, only for the shown take', () => {
    const clip = (tag: string) => `/comfy_output/H3_Video_${tag}_00001_.mp4`;
    const make = (cutFrom: string, hdOf: string) => {
      const nodes = [
        board,
        { ...shot('c10', 'C10'), data: { label: 'C10', generatedUrl: clip('c1d59ff8') } },
        { id: 'cut', type: 'videoTrim', data: { generatedUrl: '/comfy_output/H3_Trim_aa.mp4', sourceUrl: clip(cutFrom) } },
        shot('c11', 'C11'),
        { id: 'up', type: 'videoUpscale', data: { status: 'done', generatedUrl: '/hd.mp4', compareUrl: hdOf } },
      ];
      const edges = [ref('c10'), { source: 'c10', target: 'cut', targetHandle: 'in-video' }, mc('cut', 'c11'),
        { source: 'cut', target: 'up', targetHandle: 'in-video' }];
      return findChains(nodes, edges)[0].segments.map((s) => s.hd);
    };
    assert.deepEqual(make('c1d59ff8', '/comfy_output/H3_Trim_aa.mp4'), [true, false]);
    assert.deepEqual(make('0123abcd', '/comfy_output/H3_Trim_aa.mp4'), [false, false]);
    assert.deepEqual(make('c1d59ff8', '/comfy_output/H3_Trim_zz.mp4'), [false, false]);
  });
  it('does not take the HD of a dead-end edit for the shot (C22a, 2026-10-03)', () => {
    const make = (editType: string, continued: boolean) => {
      const nodes = [
        board,
        { ...shot('c22a', 'C22a'), data: { label: 'C22a', generatedUrl: '/comfy_output/H3_Chunk_5412b3b3_00001_.mp4' } },
        shot('c22b', 'C22b'),
        { id: 'e', type: editType, data: { generatedUrl: '/comfy_output/H3_EditWindow_aa.mp4' } },
        { id: 'up', type: 'videoUpscale', data: { status: 'done', generatedUrl: '/hd.mp4', compareUrl: '/comfy_output/H3_EditWindow_aa.mp4' } },
      ];
      const edges = [ref('c22a'), { source: 'c22a', target: 'e', targetHandle: 'in-video' },
        { source: 'e', target: 'up', targetHandle: 'in-video' }, ...(continued ? [mc('c22a', 'c22b')] : [mc('e', 'c22b')])];
      return findChains(nodes, edges)[0].segments.map((s) => s.hd);
    };
    assert.deepEqual(make('videoEdit', true), [false, false]);   // the film goes on from the shot: the edit is a try
    assert.deepEqual(make('videoEdit', false), [true, false]);   // the film goes on from the edit: its HD is the shot's
  });
});
