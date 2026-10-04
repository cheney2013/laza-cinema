import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, setShownCanvasRevision } from './api';

// A save that names no base_revision (the "save before switching project"
// calls) must carry the revision on screen, so the backend can refuse it with
// 409 when an MCP edit landed in between instead of taking it as an overwrite.
test('saveCanvas fills base_revision from the canvas on screen', async () => {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: 'saved', project_id: 'p', revision: 8 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    setShownCanvasRevision('p_rev', 'main', 7);
    await api.saveCanvas('p_rev', { nodes: [], edges: [] }, 'default', 'main');
    await api.saveCanvas('p_rev', { nodes: [], edges: [], base_revision: 3 }, 'default', 'main');
    await api.saveCanvas('p_unseen', { nodes: [], edges: [] }, 'default', 'main');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies[0].base_revision, 7);
  assert.equal(bodies[1].base_revision, 3);
  assert.equal(bodies[2].base_revision, undefined);
});
