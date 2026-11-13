import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jsonText } from '../../src/cli/json.ts';

test('jsonText is JSON.stringify with two spaces of indent and a newline at the end', () => {
  const value = { version: 1, list: [1, 'two', null], nested: { a: true } };
  assert.equal(jsonText(value), `${JSON.stringify(value, null, 2)}\n`);
});

test('jsonText leaves ordinary text alone, Unicode included', () => {
  const value = { title: 'Fix the retry — ünïcode ✓ 日本語 😀', dir: '/home/dev/a b' };
  assert.equal(jsonText(value), `${JSON.stringify(value, null, 2)}\n`);
});

test('jsonText writes no control character on the terminal, and the text still parses back to the value', () => {
  // C0 (escaped by JSON.stringify), DEL, C1 (U+009B is a one-character CSI) and the bidirectional controls.
  const hostile =
    'a\x1b[2J b\x07 c\x7f d\u009b31m e\u0085 f\u202e g\u2066 h\u009d0;t\u009c i\u2069 j\t';
  const text = jsonText({ note: hostile, list: [hostile] });
  assert.ok(
    !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text),
    JSON.stringify(text),
  );
  assert.deepEqual(JSON.parse(text), { note: hostile, list: [hostile] });
});

test('jsonText escapes a control character in a key as well', () => {
  const text = jsonText({ 'k\u009bey': 1 });
  assert.ok(!text.includes('\u009b'), JSON.stringify(text));
  assert.deepEqual(JSON.parse(text), { 'k\u009bey': 1 });
});

test('jsonText uses the four-digit lower-case form of JSON', () => {
  assert.equal(jsonText('\u009b'), '"\\u009b"\n');
  assert.equal(jsonText('\u202e'), '"\\u202e"\n');
});
