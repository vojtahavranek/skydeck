import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clip } from '../../src/cli/clip.ts';

test('clip: text that fits is returned as it is', () => {
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('', 5), '');
});

test('clip: longer text is cut to the width', () => {
  assert.equal(clip('abcdef', 3), 'abc');
});

test('clip: a width of zero or less gives an empty string', () => {
  assert.equal(clip('abc', 0), '');
  assert.equal(clip('abc', -3), '');
  assert.equal(clip('abc', Number.NaN), '');
});

test('clip: never ends inside a surrogate pair', () => {
  assert.equal(clip('a😀b', 2), 'a');
  assert.equal(clip('a😀b', 3), 'a😀');
  assert.equal(clip('😀', 1), '');
});

test('clip: a lone surrogate in the text is kept as it is', () => {
  assert.equal(clip('a\ud800b', 2), 'a');
  assert.equal(clip('a\ud800b', 3), 'a\ud800b');
});
