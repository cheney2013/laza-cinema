import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShotMarks, shotAt } from './shotTimeline';

const prompt = [
  'summary:',
  '[video continuation] [Shot 1] inside the car. [Shot 2] the man chases.',
  '<Subject 6> (appears in [Shot 1], [Shot 2])',
  'detailed_description:',
  '[Shot 1] The clip opens ...',
  '[Shot 2] At 00:06.500, the shot cuts ...',
  '[Shot 3] At 01:02.000, ...',
].join('\n');

test('reads cut points and ignores untimed mentions', () => {
  assert.deepEqual(parseShotMarks(prompt), [
    { shot: 1, start: 0 }, { shot: 2, start: 6.5 }, { shot: 3, start: 62 },
  ]);
});

test('offset shifts chained segments and clamps at 0', () => {
  const marks = parseShotMarks(prompt, 1);
  assert.equal(marks[1].start, 5.5);
  assert.equal(shotAt(marks, 0), 1);
  assert.equal(shotAt(marks, 5.49), 1);
  assert.equal(shotAt(marks, 5.5), 2);
  assert.equal(shotAt(marks, 100), 3);
});

test('no shots', () => {
  assert.deepEqual(parseShotMarks('just text'), []);
  assert.equal(shotAt([], 3), null);
});
