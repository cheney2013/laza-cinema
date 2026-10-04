import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { subtitleText } from './types';

describe('subtitleText', () => {
  it('drops a closing full stop, Chinese or English', () => {
    assert.equal(subtitleText('我们走吧。'), '我们走吧');
    assert.equal(subtitleText('Let us go. '), 'Let us go');
    assert.equal(subtitleText('好的．'), '好的');
  });
  it('keeps stops inside the line, ellipses, and ? / !', () => {
    assert.equal(subtitleText('等等。我来了'), '等等。我来了');
    assert.equal(subtitleText('我不知道……'), '我不知道……');
    assert.equal(subtitleText('Well...'), 'Well...');
    assert.equal(subtitleText('真的吗？'), '真的吗？');
    assert.equal(subtitleText('Run!'), 'Run!');
  });
  it('works line by line', () => {
    assert.equal(subtitleText('第一行。\n第二行.'), '第一行\n第二行');
  });
});
