import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractTokens, hasDrift, looksChinese, tokenDrift } from './translate';

describe('token extraction', () => {
  it('finds placeholders and labels, and nothing else', () => {
    const text = 'In {ref}, {s:sub1} stands left of <Subject 2> holding <Picture 1>.';
    assert.deepEqual(extractTokens(text), ['{ref}', '{s:sub1}', '<Subject 2>', '<Picture 1>']);
  });

  it('does not mistake prose punctuation for a label', () => {
    assert.deepEqual(extractTokens('she is 2 < 3 metres from the arch'), []);
  });
});

describe('round-trip drift', () => {
  it('is silent when every token survives', () => {
    const before = '{s:sub1} walks toward <Picture 1>';
    const after = '{s:sub1} 走向 <Picture 1>';
    assert.equal(hasDrift(tokenDrift(before, after)), false);
  });

  it('catches a label the translator turned into words', () => {
    const drift = tokenDrift('{s:sub1} walks toward <Picture 1>', '主体1 走向 第一张图');
    assert.deepEqual(drift.missing, ['{s:sub1}', '<Picture 1>']);
    assert.deepEqual(drift.added, []);
    assert.ok(hasDrift(drift));
  });

  it('catches a second mention quietly collapsed into one', () => {
    const drift = tokenDrift('{s:sub1} lifts {s:sub1} own hand', '{s:sub1} 抬起自己的手');
    assert.deepEqual(drift.missing, ['{s:sub1}']);
  });

  it('catches a label the translator invented', () => {
    const drift = tokenDrift('she walks toward the arch', '<Subject 1> 走向拱门');
    assert.deepEqual(drift.added, ['<Subject 1>']);
  });
});

describe('language detection', () => {
  it('reads a Chinese line as Chinese', () => {
    assert.equal(looksChinese('她走到拱门前停住，靴子在湿石头上打滑'), true);
  });

  it('reads an English line as not Chinese', () => {
    assert.equal(looksChinese('She stops at the arch and comes no further'), false);
  });

  it('ignores the tokens when deciding', () => {
    // Nothing but a label is neither language, and must not be sent off to translate.
    assert.equal(looksChinese('{s:sub1} <Picture 1>'), false);
  });

  it('calls a mostly-English line with one Chinese word English', () => {
    assert.equal(looksChinese('She stops at the 拱门 and comes no further'), false);
  });
});
