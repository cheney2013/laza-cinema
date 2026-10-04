import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fileTag, pinIsElsewhere, pinnedSource, repin, togglePin } from './pinnedFrame';

const A = '/comfy_output/H3_Chunk_eb519eeb_00001_.mp4';
const B = '/comfy_output/H3_Chunk_fe146484_00001_.mp4';

describe('钉末帧 pin', () => {
  it('is off unless switched on', () => {
    assert.equal(pinnedSource({ generatedUrl: A }), undefined);
  });

  it('stays on the version it was set on when another one is shown', () => {
    const on = togglePin({ generatedUrl: A });
    const data = { ...on, generatedUrl: B };
    assert.equal(pinnedSource(data), A);
    assert.equal(pinIsElsewhere(data), true);
  });

  it('an old pin without a recorded version follows the shown one', () => {
    assert.equal(pinnedSource({ pinLastFrame: true, generatedUrl: B }), B);
    assert.equal(pinIsElsewhere({ pinLastFrame: true, generatedUrl: B }), false);
  });

  it('pressing again drops it, repin moves it', () => {
    const on = togglePin({ generatedUrl: A });
    assert.deepEqual(togglePin({ ...on, generatedUrl: A }), { pinLastFrame: false, pinLastFrameOf: undefined });
    assert.equal(repin({ ...on, generatedUrl: B }).pinLastFrameOf, B);
  });

  it('names the version', () => {
    assert.equal(fileTag(A), 'eb519eeb');
    assert.equal(fileTag(undefined), '');
  });
});
