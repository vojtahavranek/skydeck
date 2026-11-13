import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeKeys } from '../../../src/cli/tui/keys.ts';

const cases: [string, string[]][] = [
  ['j', ['j']],
  ['jk', ['j', 'k']],
  ['\x1b[A\x1b[B', ['up', 'down']],
  ['\x1bOA', ['up']],
  ['\x1bOB', ['down']],
  ['\r', ['enter']],
  ['\n', ['enter']],
  ['\x7f', ['backspace']],
  ['\b', ['backspace']],
  ['\x03', ['ctrl-c']],
  ['\x1b', ['escape']],
  ['\x1b[5~x', ['x']],
  ['é', ['é']],
];

for (const [chunk, keys] of cases) {
  test(`${JSON.stringify(chunk)} → ${JSON.stringify(keys)}`, () => {
    assert.deepEqual(decodeKeys(chunk), keys);
  });
}

test('an empty chunk is no key', () => {
  assert.deepEqual(decodeKeys(''), []);
});

test('a character outside the basic plane is one key', () => {
  assert.deepEqual(decodeKeys('a😀b'), ['a', '😀', 'b']);
});

test('arrows with a modifier and the other cursor keys are dropped', () => {
  assert.deepEqual(decodeKeys('\x1b[1;5A\x1b[C\x1b[D\x1bOC\x1b[3~'), []);
});

test('an escape sequence cut off at the end of the chunk is dropped, not read as keys', () => {
  assert.deepEqual(decodeKeys('j\x1b['), ['j']);
  assert.deepEqual(decodeKeys('j\x1b[1;'), ['j']);
  assert.deepEqual(decodeKeys('j\x1bO'), ['j']);
});

test('ESC with another character (Alt plus a key) is dropped together with it', () => {
  assert.deepEqual(decodeKeys('\x1bdj'), ['j']);
});

test('CR LF, as a paste can bring it, is one enter', () => {
  assert.deepEqual(decodeKeys('ab\r\n'), ['a', 'b', 'enter']);
  assert.deepEqual(decodeKeys('\r\r'), ['enter', 'enter']);
});

test('other control characters, C1 ones included, are no key', () => {
  assert.deepEqual(decodeKeys('\t\x00\x1f\x85\x9fAa'), ['A', 'a']);
});
