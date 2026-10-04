import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promptDialogue } from './promptDialogue';

test('names speakers from subject_definitions and strips tags', () => {
  const p = [
    '<Subject 1> is Anna, a girl.',
    '<Subject 3> is Ben, his brother.',
    '[Shot 1] Ben, low, <Subject 3> (S2) says: <d>[English]Holy <pause>hell.</d>',
    'then <Subject 1> (S1) says: <d>[English]Are we sick?</d>',
  ].join('\n');
  assert.deepEqual(promptDialogue(p), [
    { speaker: 'Ben', text: 'Holy hell.' },
    { speaker: 'Anna', text: 'Are we sick?' },
  ]);
});

test('empty prompt and unknown speaker', () => {
  assert.deepEqual(promptDialogue(''), []);
  assert.deepEqual(promptDialogue('a voice says: <d>[English]Hi</d>'), [{ speaker: '', text: 'Hi' }]);
});

test('an off-screen voice without a Subject label keeps its own speaker', () => {
  // C1 as written: Ben is not a subject, only "(S2)" after a description.
  // Looking for the nearest <Subject N> (Sx) gave his line to Anna.
  const p = [
    '<Subject 1> is Anna, a twelve-year-old girl.',
    'Beat two: <Subject 1> (S1), in a croaky voice, says: <d>[English] Hello?</d>',
    'Beat three: a tinny voice comes out of the earpiece: the man on the phone (S2), off-screen, says: <d>[English] Anna, honey.</d>',
    'Later <Subject 1> (S1) says: <d>[English] Uncle Ben?</d>',
  ].join('\n');
  assert.deepEqual(promptDialogue(p), [
    { speaker: 'Anna', text: 'Hello?' },
    { speaker: 'the man on the phone', text: 'Anna, honey.' },
    { speaker: 'Anna', text: 'Uncle Ben?' },
  ]);
});

test('a bare speaker id is named by its subject pairing elsewhere', () => {
  const p = [
    '<Subject 2> is Mark, her father.',
    '<Subject 2> (S2) says: <d>[English]Hey.</d>',
    'then off-screen (S2) says: <d>[English]Go to bed.</d>',
  ].join('\n');
  assert.deepEqual(promptDialogue(p).map((l) => l.speaker), ['Mark', 'Mark']);
});

test("a line without its own id does not borrow the previous speaker's", () => {
  // C13a: "then Mark ... calls out: <d>Sam!</d>" carries no (Sx); the nearest
  // id is Anna's (S1) on the line before, which would name the wrong person.
  const p = [
    '<Subject 1> is Anna, a girl.',
    '<Subject 2> is Mark, her father.',
    'Anna (S1), in a whisper, says: <d>[English]It is okay...</d>',
    'Beat three: then Mark, gripping Anna\'s hand, calls out: <d>[English]Sam!</d>',
  ].join('\n');
  assert.deepEqual(promptDialogue(p).map((l) => l.speaker), ['Anna', '']);
});

test('a line with no id and nobody named is the previous speaker going on', () => {
  // C16b: Ben asks, then "and then he turns his head ... and says:" again.
  const p = [
    '<Subject 3> is Ben, his brother.',
    '<Subject 3> (S1), rattled, says: <d>[English]Some sort of parasite.</d>',
    'and then he turns his head a little to the right, and, pointed, says: <d>[English]You gonna tell me?</d>',
  ].join('\n');
  assert.deepEqual(promptDialogue(p).map((l) => l.speaker), ['Ben', 'Ben']);
});
