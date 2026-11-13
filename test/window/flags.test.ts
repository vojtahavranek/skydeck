import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitFlags } from '../../src/window/flags.ts';

function words(text: string): string[] {
  const result = splitFlags(text);
  assert.equal(result.ok, true, `${JSON.stringify(text)}: ${result.ok ? '' : result.error}`);
  return result.ok ? result.flags : [];
}

function error(text: string): string {
  const result = splitFlags(text);
  assert.equal(result.ok, false, JSON.stringify(text));
  return result.ok ? '' : result.error;
}

test('splitFlags: words separated by a space', () => {
  assert.deepEqual(words('--model opus'), ['--model', 'opus']);
});

test("splitFlags: '…' groups words into one", () => {
  assert.deepEqual(words("--append-system-prompt 'a b'"), ['--append-system-prompt', 'a b']);
});

test('splitFlags: "…" groups words into one, and single quotes inside it are kept', () => {
  assert.deepEqual(words(`"a 'b' c"`), ["a 'b' c"]);
});

test("splitFlags: double quotes inside '…' are kept", () => {
  assert.deepEqual(words(`'say "hi"'`), ['say "hi"']);
});

test("splitFlags: an unclosed ' is an error", () => {
  assert.match(error("'unclosed"), /unclosed '/);
  assert.match(error("--model 'opus"), /unclosed '/);
});

test('splitFlags: an unclosed " is an error', () => {
  assert.match(error('--x "a b'), /unclosed "/);
});

test('splitFlags: empty text gives no words', () => {
  assert.deepEqual(words(''), []);
  assert.deepEqual(words('   '), []);
});

test('splitFlags: several spaces collapse, and leading and trailing ones are ignored', () => {
  assert.deepEqual(words('  --model    opus   --verbose  '), ['--model', 'opus', '--verbose']);
});

test('splitFlags: tabs and line breaks separate words as spaces do', () => {
  assert.deepEqual(words('--model\topus\n--verbose\r\n-c'), ['--model', 'opus', '--verbose', '-c']);
});

test('splitFlags: spaces inside quotes are kept exactly', () => {
  assert.deepEqual(words("'  a   b  '"), ['  a   b  ']);
});

test('splitFlags: quoted and unquoted parts next to each other form one word', () => {
  assert.deepEqual(words(`--x='a b'`), ['--x=a b']);
  assert.deepEqual(words(`a"b c"'d e'f`), ['ab cd ef']);
});

test('splitFlags: an empty quoted word is a word', () => {
  assert.deepEqual(words(`--append-system-prompt ''`), ['--append-system-prompt', '']);
  assert.deepEqual(words(`"" x`), ['', 'x']);
});

test('splitFlags: no escapes — a backslash is an ordinary character', () => {
  assert.deepEqual(words('a\\ b'), ['a\\', 'b']);
  assert.deepEqual(words(`'a\\'`), ['a\\']);
  assert.deepEqual(words(`"a\\"`), ['a\\']);
});

test('splitFlags: no variables — a dollar sign is an ordinary character', () => {
  assert.deepEqual(words('--x $HOME "$PATH"'), ['--x', '$HOME', '$PATH']);
});

test('splitFlags: a NUL is refused, quoted or not (no program can be given it)', () => {
  assert.match(error('a\u0000b'), /NUL/);
  assert.match(error("--append-system-prompt 'a\u0000b'"), /NUL/);
  assert.match(error('"\u0000"'), /NUL/);
});

test('splitFlags: any whitespace outside quotes separates words, a pasted no-break space too', () => {
  assert.deepEqual(words('--model\u00a0opus'), ['--model', 'opus']);
  for (const space of ['\u2003', '\u3000', '\u2028', '\v', '\f', '\ufeff']) {
    assert.deepEqual(words(`a${space}b`), ['a', 'b'], JSON.stringify(space));
  }
});

test('splitFlags: whitespace inside quotes is kept as it is', () => {
  assert.deepEqual(words("'a\u00a0b\tc'"), ['a\u00a0b\tc']);
});
