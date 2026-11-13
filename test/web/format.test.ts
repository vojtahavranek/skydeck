import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatAge as serverFormatAge } from '../../src/text/age.ts';
import { ageBetween, formatAge } from '../../web/format.js';

const SEC = 1_000_000_000n;
const MIN = 60n * SEC;
const HOUR = 60n * MIN;
const DAY = 24n * HOUR;

describe('formatAge (web/format.js)', () => {
  // A18: the page's copy of design 7.4's rule must equal the server's on the same durations.
  const durations: ReadonlyArray<readonly [name: string, ns: bigint, expected: string]> = [
    ['0', 0n, '0s'],
    ['one nanosecond', 1n, '0s'],
    ['59 s', 59n * SEC, '59s'],
    ['just under 60 s', 60n * SEC - 1n, '59s'],
    ['60 s', 60n * SEC, '1m'],
    ['59 min', 59n * MIN, '59m'],
    ['just under 60 min', HOUR - 1n, '59m'],
    ['60 min', HOUR, '1h'],
    ['47 h', 47n * HOUR, '47h'],
    ['just under 48 h', 48n * HOUR - 1n, '47h'],
    ['48 h', 48n * HOUR, '2d'],
    ['400 days', 400n * DAY, '400d'],
    ['a negative duration', -5n * SEC, '0s'],
    ['a large negative duration', -400n * DAY, '0s'],
  ];
  for (const [name, ns, expected] of durations) {
    test(`${name} → ${expected}, as src/text/age.ts says`, () => {
      assert.equal(formatAge(ns), expected);
      assert.equal(formatAge(ns), serverFormatAge(ns));
    });
  }
});

describe('ageBetween', () => {
  // Times of the protocol are nanoseconds since the epoch as decimal strings, far above 2^53:
  // each case below gives a different answer when the strings are subtracted as Numbers.
  const then = 1_763_000_000_000_000_001n;
  const cases: ReadonlyArray<readonly [name: string, durationNs: bigint, expected: string]> = [
    ['just under a minute', MIN - 1n, '59s'],
    ['just under an hour', HOUR - 1n, '59m'],
    ['just under 48 hours', 48n * HOUR - 1n, '47h'],
  ];
  for (const [name, durationNs, expected] of cases) {
    test(`${name} between times above 2^53 → ${expected}`, () => {
      const now = then + durationNs;
      assert.ok(now > BigInt(Number.MAX_SAFE_INTEGER));
      assert.notEqual(
        serverFormatAge(BigInt(Number(now) - Number(then))),
        expected,
        'the case must catch an implementation that computes with Numbers',
      );
      assert.equal(ageBetween(String(now), String(then)), expected);
    });
  }

  test('a time after now counts as 0 (clocks of Windows and WSL differ)', () => {
    assert.equal(ageBetween(String(then), String(then + 2n * SEC)), '0s');
  });

  test('equal times → 0s', () => {
    assert.equal(ageBetween(String(then), String(then)), '0s');
  });

  test('400 days between real-sized times', () => {
    assert.equal(ageBetween(String(then + 400n * DAY), String(then)), '400d');
  });

  // Ruled 2026-11-13: a formatter that throws would break the whole list for one bad value, so
  // anything that is not two integer nanosecond times gives an empty age.
  const malformed: ReadonlyArray<readonly [name: string, value: string | null | undefined]> = [
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a hexadecimal number', '0x10'],
    ['surrounding blanks', ' 12 '],
    ['an exponent', '1e3'],
    ['a fraction', '1.5'],
    ['a word', 'never'],
    ['a trailing newline', '12\n'],
  ];
  for (const [name, value] of malformed) {
    test(`${name} as a time, on either side, gives an empty age and never throws`, () => {
      assert.equal(ageBetween(value, '1'), '');
      assert.equal(ageBetween('1', value), '');
    });
  }

  test('a value that is not a string gives an empty age', () => {
    assert.equal(ageBetween(5 as unknown as string, '1'), '');
    assert.equal(ageBetween('1', 5n as unknown as string), '');
  });

  test('a negative integer time is still a number: the age counts from it', () => {
    assert.equal(ageBetween('59000000000', '-1000000000'), '1m');
    assert.equal(ageBetween('-5', '1'), '0s');
  });
});
