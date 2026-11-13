import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatChip, formatPrLine, formatRow } from '../../src/cli/row.ts';
import { NS_PER_DAY, NS_PER_MINUTE } from '../../src/platform/time.ts';
import type { PrView } from '../../src/sessions/list.ts';
import { S1, T0 } from '../helpers/platform.ts';
import { listRow } from '../helpers/rows.ts';

const MIN = NS_PER_MINUTE;
const HOUR = 60n * MIN;

const URL1 = 'https://github.com/o/r/pull/1';

function pr(over: Partial<PrView>): PrView {
  return {
    url: URL1,
    repo: 'o/r',
    number: 1,
    title: 'A pull request',
    state: 'open',
    review: null,
    checks: null,
    okAtNs: T0,
    error: null,
    level: 'approved-green',
    ...over,
  };
}

// --- formatRow -------------------------------------------------------------------------------------

test('formatRow: every part, separated as the plan shows', () => {
  const row = listRow({
    id: S1,
    state: 'waiting',
    title: 'Fix retry loop',
    sinceNs: T0 - 12n * MIN,
    marks: [],
    chip: { level: 'checks-failing', count: 2 },
    hasNote: true,
  });
  assert.equal(
    formatRow(row, T0, 200),
    'waiting     Fix retry loop   12m  2pr:checks-failing  note  0b5f3c1e',
  );
});

test('formatRow: marks are joined by a comma; no chip and no note leave no gap', () => {
  const row = listRow({
    id: S1,
    state: 'not-running',
    title: 'Fix',
    sinceNs: T0 - 3n * HOUR,
    marks: ['ended-unexpectedly', 'was-working'],
    chip: null,
    hasNote: false,
  });
  assert.equal(
    formatRow(row, T0, 200),
    'not-running Fix    3h  ended-unexpectedly,was-working  0b5f3c1e',
  );
});

test('formatRow: a title that does not fit is cut and ends with an ellipsis; the line is `width` long', () => {
  const row = listRow({
    id: S1,
    state: 'working',
    title: 'A very long title that will not fit at all',
    sinceNs: T0 - 5n * MIN,
  });
  const line = formatRow(row, T0, 40);
  assert.equal(line, 'working     A very long…    5m  0b5f3c1e');
  assert.equal(line.length, 40);
});

test('formatRow: a title that fits exactly is not cut', () => {
  const row = listRow({ id: S1, state: 'working', title: 'A very long…', sinceNs: T0 - 5n * MIN });
  assert.equal(formatRow(row, T0, 40), 'working     A very long…    5m  0b5f3c1e');
});

test('formatRow: at least one title character is kept, however narrow the width', () => {
  const row = listRow({ id: S1, state: 'working', title: 'Title', sinceNs: T0 });
  const line = formatRow(row, T0, 5);
  assert.equal(line, 'working     T…    0s  0b5f3c1e');
});

test('formatRow: a one-character title is never replaced by something longer', () => {
  const row = listRow({ id: S1, state: 'working', title: 'T', sinceNs: T0 });
  assert.equal(formatRow(row, T0, 1), 'working     T    0s  0b5f3c1e');
});

test('formatRow: the cut never splits a surrogate pair', () => {
  const row = listRow({ id: S1, state: 'working', title: '😀😀😀😀😀😀😀😀😀😀', sinceNs: T0 });
  // Room for three title units: one whole emoji (two units) and the ellipsis.
  const line = formatRow(row, T0, 31);
  assert.ok(line.length <= 31, line);
  assert.doesNotMatch(line, /[\ud800-\udbff](?![\udc00-\udfff])/u);
  assert.doesNotMatch(line, /(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  assert.equal(line, 'working     😀…    0s  0b5f3c1e');
});

test('formatRow: a time in state in the future counts as 0s; days past two show as days', () => {
  const future = listRow({ id: S1, state: 'running', title: 'x', sinceNs: T0 + MIN });
  assert.equal(formatRow(future, T0, 200), 'running     x    0s  0b5f3c1e');
  const old = listRow({ id: S1, state: 'running', title: 'x', sinceNs: T0 - 3n * NS_PER_DAY });
  assert.equal(formatRow(old, T0, 200), 'running     x    3d  0b5f3c1e');
});

// --- formatChip ------------------------------------------------------------------------------------

test('formatChip: count, "pr:", level', () => {
  assert.equal(formatChip({ level: 'merged', count: 1 }), '1pr:merged');
  assert.equal(formatChip({ level: 'checks-failing', count: 2 }), '2pr:checks-failing');
});

// --- formatPrLine ----------------------------------------------------------------------------------

test('formatPrLine: the level after the url', () => {
  assert.equal(formatPrLine(pr({ level: 'draft' })), 'https://github.com/o/r/pull/1  draft');
});

test("formatPrLine: can't read shows the last good read and the error, never 'closed'", () => {
  assert.equal(
    formatPrLine(pr({ level: 'cant-read', okAtNs: T0, error: 'HTTP 401' })),
    "https://github.com/o/r/pull/1  can't read, last read 2026-11-12T09:00:00.000Z (HTTP 401)",
  );
});

test("formatPrLine: can't read with no earlier success says 'never'", () => {
  assert.equal(
    formatPrLine(pr({ level: 'cant-read', okAtNs: null, error: 'x' })),
    "https://github.com/o/r/pull/1  can't read, last read never (x)",
  );
});

test("formatPrLine: can't read without an error has no parentheses", () => {
  assert.equal(
    formatPrLine(pr({ level: 'cant-read', okAtNs: null, error: null })),
    "https://github.com/o/r/pull/1  can't read, last read never",
  );
});

test('formatPrLine: a pull request never fetched is "not fetched" (D11)', () => {
  assert.equal(
    formatPrLine(pr({ level: 'unfetched', state: null, okAtNs: null })),
    'https://github.com/o/r/pull/1  not fetched',
  );
});
