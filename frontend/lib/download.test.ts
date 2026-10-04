import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeProgress, nativeDownloadUrl, readResponse, writeResponse } from './download';

const pieces = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])];

function responseOf(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(c));
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

describe('readResponse', () => {
  it('reports progress after every piece and returns all the bytes', async () => {
    const seen: Array<[number, number]> = [];
    const blob = await readResponse(
      responseOf(pieces, { 'content-length': '9', 'content-type': 'video/mp4' }),
      (done, total) => seen.push([done, total]),
    );
    assert.deepEqual(seen, [[3, 9], [6, 9], [9, 9]]);
    assert.equal(blob.size, 9);
    assert.equal(blob.type, 'video/mp4');
  });

  it('says the total is unknown (0) when the server sent no length', async () => {
    const seen: Array<[number, number]> = [];
    await readResponse(responseOf(pieces), (done, total) => seen.push([done, total]));
    assert.deepEqual(seen.at(-1), [9, 0]);
  });
});

describe('writeResponse', () => {
  it('writes every piece to the file in order, then closes it, without keeping them', async () => {
    const written: number[][] = [];
    let closed = 0;
    const seen: number[] = [];
    const bytes = await writeResponse(
      responseOf(pieces, { 'content-length': '9' }),
      { write: async (c) => { written.push([...c]); }, close: async () => { closed += 1; } },
      (done) => seen.push(done),
    );
    assert.equal(bytes, 9);
    assert.deepEqual(written, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    assert.equal(closed, 1);
    assert.deepEqual(seen, [3, 6, 9]);
  });

  it('does not close the file when the stream breaks midway', async () => {
    let closed = 0;
    const broken = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pieces[0]);
        controller.error(new Error('connection reset'));
      },
    }));
    await assert.rejects(
      writeResponse(broken, { write: async () => {}, close: async () => { closed += 1; } }),
      /connection reset/,
    );
    assert.equal(closed, 0);
  });
});

describe('describeProgress', () => {
  it('shows percent and megabytes, or megabytes alone without a size', () => {
    assert.equal(describeProgress(172 * 1048576, 400 * 1048576), '43% · 172 / 400 MB');
    assert.equal(describeProgress(3 * 1048576, 0), '3.0 MB');
    assert.equal(describeProgress(500 * 1048576, 400 * 1048576), '100% · 500 / 400 MB');
  });
});

describe('nativeDownloadUrl', () => {
  const backend = 'https://host.ts.net:8443';
  it('points a served file at the attachment route', () => {
    assert.equal(
      nativeDownloadUrl(`${backend}/uploads/cut_1.mp4?v=3`, 'film 1.mp4', backend),
      `${backend}/download?src=%2Fuploads%2Fcut_1.mp4&name=film%201.mp4`,
    );
    assert.equal(
      nativeDownloadUrl('/comfy_output/a.mp4', 'a.mp4', backend),
      `${backend}/download?src=%2Fcomfy_output%2Fa.mp4&name=a.mp4`,
    );
  });
  it('leaves everything else to the caller', () => {
    assert.equal(nativeDownloadUrl('https://elsewhere.com/uploads/a.mp4', 'a.mp4', backend), null);
    assert.equal(nativeDownloadUrl(`${backend}/media/poster?src=x`, 'a.jpg', backend), null);
    assert.equal(nativeDownloadUrl('blob:https://x/1', 'a.mp4', backend), null);
  });
});
