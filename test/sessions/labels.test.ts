import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UsageError } from '../../src/platform/errors.ts';
import { cleanGroup, cleanLabel } from '../../src/sessions/labels.ts';

const usageError = (error: unknown): boolean => error instanceof UsageError && error.exitCode === 2;

test('a label is trimmed', () => {
  assert.equal(cleanLabel('  fix retry '), 'fix retry');
  assert.equal(cleanLabel('fix  retry'), 'fix  retry');
});

test('a trailing line break is whitespace to trim, not a second line', () => {
  assert.equal(cleanLabel('fix retry\n'), 'fix retry');
  assert.equal(cleanLabel('\r\nfix retry\r\n'), 'fix retry');
});

test('a label with a line break inside is refused', () => {
  for (const text of [
    'a\nb',
    'a\rb',
    'a\r\nb',
    'a\u2028b',
    'a\u2029b',
    'a\u0085b',
    'a\vb',
    'a\fb',
  ]) {
    assert.throws(() => cleanLabel(text), usageError, JSON.stringify(text));
  }
});

test('an empty label is refused', () => {
  assert.throws(() => cleanLabel(''), usageError);
  assert.throws(() => cleanLabel('   '), usageError);
  assert.throws(() => cleanLabel(' \n '), usageError);
});

test('a label starting with a hyphen is refused, also after trimming', () => {
  assert.throws(() => cleanLabel('-x'), usageError);
  assert.throws(() => cleanLabel('  --dangerously-skip-permissions'), usageError);
  assert.equal(cleanLabel('x-y'), 'x-y');
});

test('the messages say what is wrong and do not repeat the text', () => {
  const message = (fn: () => string): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };
  assert.match(
    message(() => cleanLabel('a\nb')),
    /one line/,
  );
  assert.match(
    message(() => cleanLabel('  ')),
    /empty/,
  );
  assert.match(
    message(() => cleanLabel('-x')),
    /start with '-'/,
  );
  assert.doesNotMatch(
    message(() => cleanLabel('\x1b[2Jx\ny')),
    /\x1b/,
  );
});

test('a group is trimmed', () => {
  assert.equal(cleanGroup(' ABC-1 '), 'ABC-1');
  assert.equal(cleanGroup('-x'), '-x');
});

test('a group with a line break inside, or an empty one, is refused', () => {
  assert.throws(() => cleanGroup('a\rb'), usageError);
  assert.throws(() => cleanGroup('a\nb'), usageError);
  assert.throws(() => cleanGroup(''), usageError);
  assert.throws(() => cleanGroup('  \t '), usageError);
});
