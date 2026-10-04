import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWardrobeSwapPrompt } from './wardrobeSwap';

test('wardrobe prompt fixes the two reference roles', () => {
  const prompt = buildWardrobeSwapPrompt();
  assert.match(prompt, /<图1> is the immutable master image/);
  assert.match(prompt, /Replace only the clothing/);
  assert.match(prompt, /Do not transfer the person.*from <图2>/);
  assert.doesNotMatch(prompt, /Additional wardrobe adjustment/);
});

test('optional detail cannot replace the preservation contract', () => {
  const prompt = buildWardrobeSwapPrompt('keep the jacket open');
  assert.match(prompt, /immutable master image/);
  assert.match(prompt, /Additional wardrobe adjustment: keep the jacket open/);
});
