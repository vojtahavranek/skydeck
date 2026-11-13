import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatChip,
  formatNoteLines,
  formatPrLine,
  formatPrStatus,
  formatRow,
  stateDetailSuffix,
} from '../../src/cli/row.ts';
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

test('formatRow: a title that does not fit is cut; the time in state goes before the title shrinks below 24', () => {
  const row = listRow({
    id: S1,
    state: 'working',
    title: 'A very long title that will not fit at all',
    sinceNs: T0 - 5n * MIN,
  });
  // Even without the time in state the title has only 18 characters here: it is cut to them.
  const line = formatRow(row, T0, 40);
  assert.equal(line, 'working     A very long title…  0b5f3c1e');
  assert.equal(line.length, 40);
});

test('formatRow: a title that fits exactly is not cut, and keeps the time in state', () => {
  const row = listRow({ id: S1, state: 'working', title: 'A very long…', sinceNs: T0 - 5n * MIN });
  assert.equal(formatRow(row, T0, 40), 'working     A very long…    5m  0b5f3c1e');
});

test('formatRow: a short title is never cut to make room for a column that fits', () => {
  const row = listRow({ id: S1, state: 'working', title: 'Fix', sinceNs: T0 - 5n * MIN });
  assert.equal(formatRow(row, T0, 28 + 3), 'working     Fix    5m  0b5f3c1e');
});

test('formatRow: at least one title character is kept, however narrow the width; the id stays', () => {
  const row = listRow({ id: S1, state: 'working', title: 'Title', sinceNs: T0 });
  assert.equal(formatRow(row, T0, 5), 'working     T…  0b5f3c1e');
});

test('formatRow: a one-character title is never replaced by something longer', () => {
  const row = listRow({ id: S1, state: 'working', title: 'T', sinceNs: T0 });
  assert.equal(formatRow(row, T0, 1), 'working     T  0b5f3c1e');
});

test('formatRow: a title the ellipsis would not make shorter is kept whole', () => {
  const row = listRow({ id: S1, state: 'working', title: 'ab', sinceNs: T0 });
  assert.equal(formatRow(row, T0, 1), 'working     ab  0b5f3c1e');
});

test('formatRow: the cut never splits a surrogate pair', () => {
  const row = listRow({ id: S1, state: 'working', title: '😀😀😀😀😀😀😀😀😀😀', sinceNs: T0 });
  // Room for eight title units: three whole emoji (six units) and the ellipsis, one unit unused.
  const line = formatRow(row, T0, 30);
  assert.equal(line, 'working     😀😀😀…  0b5f3c1e');
  assert.ok(line.length <= 30, line);
});

// Optional columns are dropped, in this order, until the title has 24 characters (or all of it):
// the note mark, the time in state, all marks but the first (shown as "+n"), the pull-request
// count. The state, the title and the short id are never dropped.
const BUSY = listRow({
  id: S1,
  state: 'waiting',
  title: 'abcdefghijklmnopqrstuvwxyz0123456789',
  sinceNs: T0 - 12n * MIN,
  marks: ['ended-unexpectedly', 'was-working'],
  chip: { level: 'checks-failing', count: 2 },
  hasNote: true,
});

for (const [width, expected] of [
  [
    122,
    'waiting     abcdefghijklmnopqrstuvwxyz0123456789   12m  ended-unexpectedly,was-working  2pr:checks-failing  note  0b5f3c1e',
  ],
  [
    110,
    'waiting     abcdefghijklmnopqrstuvw…   12m  ended-unexpectedly,was-working  2pr:checks-failing  note  0b5f3c1e',
  ],
  [
    109,
    'waiting     abcdefghijklmnopqrstuvwxyz01…   12m  ended-unexpectedly,was-working  2pr:checks-failing  0b5f3c1e',
  ],
  [
    104,
    'waiting     abcdefghijklmnopqrstuvw…   12m  ended-unexpectedly,was-working  2pr:checks-failing  0b5f3c1e',
  ],
  [
    103,
    'waiting     abcdefghijklmnopqrstuvwxyz01…  ended-unexpectedly,was-working  2pr:checks-failing  0b5f3c1e',
  ],
  [
    97,
    'waiting     abcdefghijklmnopqrstuvwxyz012345…  ended-unexpectedly+1  2pr:checks-failing  0b5f3c1e',
  ],
  [88, 'waiting     abcdefghijklmnopqrstuvw…  ended-unexpectedly+1  2pr:checks-failing  0b5f3c1e'],
  [87, 'waiting     abcdefghijklmnopqrstuvw…  ended-unexpectedly+1  pr:checks-failing  0b5f3c1e'],
  [86, 'waiting     abcdefghijklmnopqrstuv…  ended-unexpectedly+1  pr:checks-failing  0b5f3c1e'],
] as const) {
  test(`formatRow: a busy row at width ${width} drops columns in the agreed order`, () => {
    const line = formatRow(BUSY, T0, width);
    assert.equal(line, expected);
    assert.ok(line.length <= width);
  });
}

test('formatRow: below the last step the id and the first mark are still there; only the title shrinks', () => {
  const line = formatRow(BUSY, T0, 60);
  assert.equal(line, 'waiting     a…  ended-unexpectedly+1  pr:checks-failing  0b5f3c1e');
});

test('formatRow: a single mark is not shortened; the pull-request count goes last', () => {
  const row = listRow({
    id: S1,
    state: 'working',
    title: 'abcdefghijklmnopqrstuvwxyz0123456789',
    marks: ['expired'],
    chip: { level: 'merged', count: 1 },
    sinceNs: T0,
  });
  assert.equal(
    formatRow(row, T0, 60),
    'working     abcdefghijklmnopq…  expired  pr:merged  0b5f3c1e',
  );
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

// --- formatPrStatus --------------------------------------------------------------------------------

test('formatPrStatus: the level, "not fetched", or "can\'t read" with the last read and the error', () => {
  assert.equal(formatPrStatus(pr({ level: 'checks-failing' })), 'checks-failing');
  assert.equal(formatPrStatus(pr({ level: 'unfetched', state: null })), 'not fetched');
  assert.equal(
    formatPrStatus(pr({ level: 'cant-read', okAtNs: T0, error: 'HTTP 401' })),
    "can't read, last read 2026-11-12T09:00:00.000Z (HTTP 401)",
  );
  assert.equal(
    formatPrStatus(pr({ level: 'cant-read', okAtNs: null, error: null })),
    "can't read, last read never",
  );
});

test('formatPrLine is the url, two spaces and formatPrStatus', () => {
  for (const level of ['draft', 'unfetched', 'cant-read', 'merged'] as const) {
    const view = pr({ level, okAtNs: T0, error: level === 'cant-read' ? 'x' : null });
    assert.equal(formatPrLine(view), `${view.url}  ${formatPrStatus(view)}`, level);
  }
});

// --- formatNoteLines -------------------------------------------------------------------------------

test('formatNoteLines: every line break is one, a lone carriage return too; lines are indented by two spaces', () => {
  assert.deepEqual(formatNoteLines('a\nb'), ['  a', '  b']);
  assert.deepEqual(formatNoteLines('a\r\nb'), ['  a', '  b']);
  assert.deepEqual(formatNoteLines('a\rb'), ['  a', '  b']);
  assert.deepEqual(formatNoteLines('a\r\rb'), ['  a', '', '  b']);
});

test('formatNoteLines: each line is sanitised on its own', () => {
  const note =
    'one \x1b[31mred\x1b[0m\ntwo\twith tab\x07\r\nthree \x1b]8;;http://x\x07link\x1b]8;;\x07';
  assert.deepEqual(formatNoteLines(note), ['  one red', '  two with tab', '  three link']);
});

test('formatNoteLines: an empty line inside stays empty, without trailing spaces; those at the edges go', () => {
  assert.deepEqual(formatNoteLines('a\n\nb'), ['  a', '', '  b']);
  assert.deepEqual(formatNoteLines('a\n  \nb'), ['  a', '', '  b']);
  assert.deepEqual(formatNoteLines('\n\x1b[0m\n\na\nb\n\n'), ['  a', '  b']);
});

test('formatNoteLines: a note that is nothing once sanitised has no lines', () => {
  assert.deepEqual(formatNoteLines(''), []);
  assert.deepEqual(formatNoteLines('\x1b[2J\n\x07'), []);
});

// --- stateDetailSuffix -----------------------------------------------------------------------------

test('stateDetailSuffix: the detail in brackets after a space; nothing for none or for nothing', () => {
  assert.equal(stateDetailSuffix('tool: Bash'), ' (tool: Bash)');
  assert.equal(stateDetailSuffix(null), '');
  assert.equal(stateDetailSuffix(''), '');
  assert.equal(stateDetailSuffix('  '), '');
});
