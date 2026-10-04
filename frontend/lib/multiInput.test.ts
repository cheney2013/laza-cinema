import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMultiInputHandle } from './multiInput';

describe('isMultiInputHandle', () => {
  it('lets 生成图片 take several references', () => {
    assert.equal(isMultiInputHandle('qwenImage', 'in-ref'), true);
  });
  it('keeps prompt and style ports multi on any node', () => {
    assert.equal(isMultiInputHandle('inpaint', 'in-prompt'), true);
    assert.equal(isMultiInputHandle('pose', 'in-style'), true);
  });
  it('leaves other ports single', () => {
    assert.equal(isMultiInputHandle('qwenImage', 'in-other'), false);
    assert.equal(isMultiInputHandle('inpaint', 'in-image'), false);
    assert.equal(isMultiInputHandle(undefined, 'in-ref'), false);
  });
});
