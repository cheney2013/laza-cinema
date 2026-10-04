import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { namesLiveOnCanvases, namesUsedByTimelines, ownedByProject, unusedLibraryItems } from './unusedAssets';
import { defaultClip, emptyTimeline, type EditorAsset, type Timeline } from './types';

const asset = (id: string, url: string, extra: Partial<EditorAsset> = {}): EditorAsset => ({
  id, nodeId: '', url, title: id, kind: 'video', width: 1376, height: 768, fps: 24, frames: 100, timelineFrames: 100,
  hasAudio: true, ...extra,
});

function film(assets: EditorAsset[], used: string[]): Timeline {
  const timeline = emptyTimeline();
  timeline.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
  timeline.clips = used.map((assetId, i) => defaultClip({ id: `c${i}`, trackId: 'V1', assetId, start: i * 100, outFrame: 100 }));
  return timeline;
}

describe('namesUsedByTimelines', () => {
  it('counts only assets a clip is on, not everything the asset table remembers', () => {
    const t = film([asset('a', '/comfy_output/H3_Chunk_aaa_00001_.mp4'), asset('b', '/comfy_output/H3_Chunk_bbb_00001_.mp4')], ['a']);
    assert.deepEqual([...namesUsedByTimelines([t])], ['H3_Chunk_aaa_00001_.mp4']);
  });

  it('keeps the trimmed output and the rough cut behind a used asset', () => {
    const t = film([
      asset('a', '/comfy_output/H3_Full_aaa.mp4', {
        chainHead: { trimmedUrl: '/comfy_output/H3_Chunk_aaa.mp4', frames: 22 },
        roughUrl: '/comfy_output/H3_Chunk_rough.mp4',
      }),
    ], ['a']);
    const names = namesUsedByTimelines([t]);
    for (const name of ['H3_Full_aaa.mp4', 'H3_Chunk_aaa.mp4', 'H3_Chunk_rough.mp4']) assert.ok(names.has(name), name);
  });

  it('unions every sequence and keeps a cover, ignoring a cache-busting query', () => {
    const one = film([asset('a', '/uploads/one.mp4?v=3')], ['a']);
    const two = film([asset('b', '/uploads/two.mp4')], ['b']);
    two.cover = { url: '/uploads/cover.png', title: 'cover' };
    assert.deepEqual([...namesUsedByTimelines([one, two])].sort(), ['cover.png', 'one.mp4', 'two.mp4']);
  });
});

describe('unusedLibraryItems', () => {
  it('lists the library files no sequence uses', () => {
    const one = film([asset('a', '/uploads/one.mp4')], ['a']);
    const library = [{ name: 'one.mp4' }, { name: 'two.mp4' }, { name: 'three.wav' }];
    assert.deepEqual(unusedLibraryItems(library, [one]).map((i) => i.name), ['two.mp4', 'three.wav']);
  });

  it('with no timelines read, everything would look unused: callers must not ask that', () => {
    assert.equal(unusedLibraryItems([{ name: 'x.mp4' }], []).length, 1);
  });
});

describe('namesLiveOnCanvases', () => {
  it('keeps what a node shows now, not the takes it only remembers', () => {
    const nodes = [
      { data: { generatedUrl: '/comfy_output/H3_Chunk_now_00001_.mp4', takes: [{ url: '/comfy_output/H3_Chunk_old_00001_.mp4' }] } },
      { data: { url: '/uploads/ref.png' } },
    ];
    assert.deepEqual([...namesLiveOnCanvases(nodes)].sort(), ['H3_Chunk_now_00001_.mp4', 'ref.png']);
  });

  it('a library file a node shows is kept even when no timeline uses it', () => {
    const library = [{ name: 'H3_Chunk_now_00001_.mp4' }, { name: 'H3_Chunk_old_00001_.mp4' }];
    const keep = namesLiveOnCanvases([{ data: { generatedUrl: '/comfy_output/H3_Chunk_now_00001_.mp4' } }]);
    assert.deepEqual(unusedLibraryItems(library, [emptyTimeline()], keep).map((i) => i.name), ['H3_Chunk_old_00001_.mp4']);
  });
});

describe('ownedByProject', () => {
  const p = (...ids: string[]) => ids.map((id) => ({ id }));
  it('is true for a file made here, or referenced only here when no origin is recorded', () => {
    assert.equal(ownedByProject({ origin_project: 'a', projects: [] }, 'a'), true);
    assert.equal(ownedByProject({ origin_project: null, projects: p('a') }, 'a'), true);
  });

  it('is false for a file of another project, a shared one, or one nobody owns', () => {
    assert.equal(ownedByProject({ origin_project: 'b', projects: [] }, 'a'), false);
    assert.equal(ownedByProject({ origin_project: 'b', projects: p('a') }, 'a'), false);
    assert.equal(ownedByProject({ origin_project: 'a', projects: p('a', 'b') }, 'a'), false);
    assert.equal(ownedByProject({ origin_project: null, projects: [] }, 'a'), false);
  });
});
