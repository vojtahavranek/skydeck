import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPrLine, formatRow } from '../../../src/cli/row.ts';
import { initModel, reduce, withMessage } from '../../../src/cli/tui/model.ts';
import type { TuiModel } from '../../../src/cli/tui/model.ts';
import { render, scrolled } from '../../../src/cli/tui/render.ts';
import { NS_PER_MINUTE } from '../../../src/platform/time.ts';
import type { PrView } from '../../../src/sessions/list.ts';
import { S1, S2, S3, T0 } from '../../helpers/platform.ts';
import { listRow } from '../../helpers/rows.ts';

const MIN = NS_PER_MINUTE;
const SIZE = { columns: 80, rows: 10 };
const URL1 = 'https://github.com/o/r/pull/1';
const HELP =
  'j/k move  enter detail  l label  g group  n note  d done  p PR  R resume  / filter  a all  r refresh  q quit';

const R1 = listRow({
  id: S1,
  group: 'A',
  state: 'waiting',
  label: 'alpha',
  lastActivityNs: T0,
});
const R2 = listRow({
  id: S2,
  group: 'A',
  state: 'not-running',
  title: 'beta',
  lastActivityNs: T0 - MIN,
});
const R3 = listRow({ id: S3, group: null, done: true });

function press(start: TuiModel, ...keys: string[]): TuiModel {
  let model = start;
  for (const key of keys) {
    ({ model } = reduce(model, key));
  }
  return model;
}

const open = (): TuiModel => initModel([R1, R2, R3], T0);

function pull(over: Partial<PrView>): PrView {
  return {
    url: URL1,
    repo: 'o/r',
    number: 1,
    title: 'A pull request',
    state: 'draft',
    review: null,
    checks: null,
    okAtNs: T0,
    error: null,
    level: 'draft',
    ...over,
  };
}

// --- shape -----------------------------------------------------------------------------------------

test('render returns exactly `rows` lines, none longer than `columns`, no escape character', () => {
  const lines = render(open(), SIZE);
  assert.equal(lines.length, 10);
  for (const line of lines) {
    assert.ok(line.length <= 80, line);
    assert.ok(!line.includes('\x1b'), line);
  }
});

test('render fits any size: exactly `rows` lines of at most `columns`, in every mode', () => {
  const models = [
    open(),
    press(open(), 'enter'),
    press(open(), '/', 'b'),
    press(open(), 'l', 'x'),
    withMessage(open(), 'saved'),
  ];
  for (const model of models) {
    for (const [columns, rows] of [
      [80, 24],
      [20, 5],
      [10, 3],
      [3, 2],
      [1, 1],
      [0, 0],
    ] as const) {
      const lines = render(model, { columns, rows });
      assert.equal(lines.length, rows, `${model.mode} ${columns}x${rows}`);
      for (const line of lines) {
        assert.ok(line.length <= columns, `${model.mode} ${columns}x${rows}: ${line}`);
      }
    }
  }
});

// --- title line ------------------------------------------------------------------------------------

test('line 0 names the program and counts the visible rows', () => {
  assert.equal(render(open(), SIZE)[0], 'skydeck  2 sessions');
});

test('line 0 shows the filter and "(all)"; the count is the visible rows', () => {
  const model = press(open(), '/', 'b', 'e', 'enter', 'a');
  assert.equal(render(model, SIZE)[0], 'skydeck  1 sessions  filter: be  (all)');
});

test('line 0 shows "(all)" without a filter', () => {
  assert.equal(render(press(open(), 'a'), SIZE)[0], 'skydeck  3 sessions  (all)');
});

// --- list body -------------------------------------------------------------------------------------

test('the list: a line per group, the selected row marked, blank lines to the end', () => {
  const lines = render(open(), SIZE);
  assert.equal(lines[1], 'A');
  assert.equal(lines[2], '> ' + formatRow(R1, T0, 78));
  assert.equal(lines[3], '  ' + formatRow(R2, T0, 78));
  assert.deepEqual(lines.slice(4, 9), ['', '', '', '', '']);
});

test('the group of no name is called "no group", and comes after the named ones', () => {
  const lines = render(press(open(), 'a'), SIZE);
  assert.equal(lines[4], 'no group');
  assert.equal(lines[5], '  ' + formatRow(R3, T0, 78));
});

test('the cursor mark follows the selection into the next group', () => {
  const lines = render(press(open(), 'a', 'j', 'j'), SIZE);
  assert.equal(lines[2], '  ' + formatRow(R1, T0, 78));
  assert.equal(lines[5], '> ' + formatRow(R3, T0, 78));
});

test('a group whose rows are all hidden has no header', () => {
  const lines = render(open(), SIZE);
  assert.ok(!lines.includes('no group'));
});

test('the rows are cut to the width: the title gets the ellipsis', () => {
  const wide = listRow({ id: S1, title: 'T'.repeat(200), state: 'working' });
  const lines = render(initModel([wide], T0), { columns: 50, rows: 6 });
  assert.equal(lines[2], '> ' + formatRow(wide, T0, 48));
  assert.ok(lines[2]?.length === 50);
  assert.match(lines[2] ?? '', /…/);
});

test('no rows: "no sessions"', () => {
  const lines = render(initModel([], T0), SIZE);
  assert.equal(lines[0], 'skydeck  0 sessions');
  assert.equal(lines[1], 'no sessions');
});

test('a filter that matches nothing also says "no sessions"', () => {
  const lines = render(press(open(), '/', 'z', 'enter'), SIZE);
  assert.equal(lines[1], 'no sessions');
});

// --- the last line ---------------------------------------------------------------------------------

test('the last line is the key help, cut to the width', () => {
  assert.equal(render(open(), SIZE)[9], HELP.slice(0, 80));
  assert.equal(render(open(), { columns: 200, rows: 10 })[9], HELP);
});

test('the last line: the input, the filter, or the message', () => {
  assert.equal(
    render(
      press(open(), 'l', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'x'),
      SIZE,
    )[9],
    'label: x_',
  );
  // The group input starts with the group the user set (R1: 'A').
  assert.equal(render(press(open(), 'g', 'G'), SIZE)[9], 'group: AG_');
  assert.equal(render(press(open(), 'p', 'h'), SIZE)[9], 'pr: h_');
  assert.equal(render(press(open(), '/', 'b', 'e'), SIZE)[9], '/be_');
  assert.equal(render(withMessage(open(), 'saved'), SIZE)[9], 'saved');
});

test('the input and the filter come before a message', () => {
  const typing = withMessage(press(open(), '/', 'b'), 'saved');
  assert.equal(render(typing, SIZE)[9], '/b_');
});

test('a long input line shows the end of the text and the cursor, not the start', () => {
  const model = press(open(), 'g', ...'x'.repeat(90), 'y', 'z');
  const line = render(model, SIZE)[9] ?? '';
  assert.equal(line.length, 80);
  assert.equal(line, 'group: …' + 'x'.repeat(69) + 'yz_');
});

test('a long filter shows the end of the text and the cursor', () => {
  const line = render(press(open(), '/', ...'x'.repeat(100), 'q'), SIZE)[9] ?? '';
  assert.equal(line, '/…' + 'x'.repeat(76) + 'q_');
});

test('a long input made of two-unit characters is cut between characters', () => {
  const line = render(press(open(), 'g', ...'😀'.repeat(60)), SIZE)[9] ?? '';
  assert.ok(line.length <= 80, String(line.length));
  assert.match(line, /^group: …(?:😀)+_$/u);
});

test('a long input that fits is shown whole, with the cursor', () => {
  const text = 'x'.repeat(75);
  assert.equal(render(press(open(), 'p', ...text), SIZE)[9], `pr: ${text}_`);
});

test('a message is one line without escape sequences or control characters', () => {
  const model = withMessage(open(), 'bad \x1b[31mred\x1b[0m\nline two\x07');
  const line = render(model, SIZE)[9] ?? '';
  assert.equal(line, 'bad red line two');
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(line));
});

test('with one row there is only the last line; with two, the title line and the last line', () => {
  assert.deepEqual(render(open(), { columns: 80, rows: 1 }), [HELP.slice(0, 80)]);
  const two = render(open(), { columns: 80, rows: 2 });
  assert.equal(two[0], 'skydeck  2 sessions');
  assert.equal(two[1], HELP.slice(0, 80));
});

// --- scrolling -------------------------------------------------------------------------------------

function manyRows(count: number): TuiModel {
  const rows = Array.from({ length: count }, (_, n) =>
    listRow({
      id: `row-${String(n).padStart(2, '0')}-0000`,
      title: `row ${n}`,
      group: 'A',
      lastActivityNs: T0 - BigInt(n) * MIN,
    }),
  );
  return initModel(rows, T0);
}

const down = (n: number): string[] => Array.from({ length: n }, () => 'j');

test('the selected row is always on screen, once, with the mark', () => {
  for (const n of [0, 1, 7, 8, 19, 28, 29]) {
    const lines = render(press(manyRows(30), ...down(n)), SIZE);
    const marked = lines.filter((line) => line.startsWith('> '));
    assert.equal(marked.length, 1, `row ${n}`);
    assert.match(marked[0] ?? '', new RegExp(`row ${n} `), `row ${n}`);
    assert.equal(lines.length, 10);
  }
});

test('scrolled to the end, the body is full: no blank lines under the last row', () => {
  const lines = render(press(manyRows(30), ...down(29)), SIZE);
  const body = lines.slice(1, 9);
  assert.ok(body.every((line) => line !== ''));
  assert.match(body[7] ?? '', /row 29 /);
});

test('at the top the group header shows', () => {
  const lines = render(manyRows(30), SIZE);
  assert.equal(lines[1], 'A');
  assert.match(lines[2] ?? '', /^> .*row 0 /);
});

test('a scroll offset in the model is kept while the selected row is inside the window', () => {
  const model = { ...press(manyRows(30), ...down(5)), scroll: 3 };
  const lines = render(model, SIZE);
  // Body line 3 is the row "row 2" (line 0 is the header, line n is row n-1).
  assert.match(lines[1] ?? '', /row 2 /);
  assert.match(lines.find((line) => line.startsWith('> ')) ?? '', /row 5 /);
});

test('a scroll offset that is out of range, or hides the selected row, is corrected', () => {
  const far = { ...press(manyRows(30), ...down(2)), scroll: 500 };
  assert.match(render(far, SIZE).find((line) => line.startsWith('> ')) ?? '', /row 2 /);
  const negative = { ...press(manyRows(30), ...down(2)), scroll: -4 };
  assert.match(render(negative, SIZE).find((line) => line.startsWith('> ')) ?? '', /row 2 /);
});

test('the short list is not scrolled', () => {
  const model = { ...open(), scroll: 4 };
  assert.equal(render(model, SIZE)[1], 'A');
});

/** What a terminal wrapper does after every key: reduce, then keep the window with `scrolled`. */
function walk(start: TuiModel, keys: string[], size = SIZE): TuiModel[] {
  const states = [scrolled(start, size)];
  for (const key of keys) {
    states.push(scrolled(reduce(states[states.length - 1] ?? start, key).model, size));
  }
  return states;
}

/** Three groups of ten rows, in the order of their names. */
function groups3(): TuiModel {
  const rows = Array.from({ length: 30 }, (_, n) =>
    listRow({
      id: `row-${String(n).padStart(2, '0')}-0000`,
      title: `row ${n}`,
      group: `G${Math.floor(n / 10)}`,
      lastActivityNs: T0 - BigInt(n) * MIN,
    }),
  );
  return initModel(rows, T0);
}

test('scrolled: the window moves by the least that keeps the selected row in view', () => {
  const states = walk(manyRows(30), down(12));
  // The body is 8 lines and row n is on line n + 1: row 6 is the last one in view from the top.
  assert.deepEqual(
    states.map((state) => state.scroll),
    [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6],
  );
});

test('scrolled: going up, the window does not move until the cursor reaches its top, then one line per row', () => {
  const down20 = walk(manyRows(30), down(20));
  const end = down20[down20.length - 1] ?? manyRows(30);
  assert.equal(end.scroll, 14);
  const states = walk(
    end,
    Array.from({ length: 12 }, () => 'k'),
  );
  // Rows 20 down to 13 stay in the window that starts at line 14; then one line per row.
  assert.deepEqual(
    states.map((state) => state.scroll),
    [14, 14, 14, 14, 14, 14, 14, 14, 13, 12, 11, 10, 9],
  );
});

test('scrolled: no move of the window is ever bigger than one line inside a group', () => {
  const keys = [...down(29), ...Array.from({ length: 29 }, () => 'k')];
  const states = walk(manyRows(30), keys);
  for (let i = 1; i < states.length; i += 1) {
    const move = Math.abs((states[i]?.scroll ?? 0) - (states[i - 1]?.scroll ?? 0));
    // The one exception: arriving at the first row brings its group header into view too.
    assert.ok(move <= (states[i]?.selected === 'row-00-0000' ? 2 : 1), `step ${i}`);
  }
});

test('scrolled: the header of a group shows when its first row is selected, and the window is stable across groups', () => {
  const keys = [...down(29), ...Array.from({ length: 29 }, () => 'k')];
  const states = walk(groups3(), keys);
  for (const [i, state] of states.entries()) {
    const lines = render(state, SIZE);
    const at = lines.findIndex((line) => line.startsWith('> '));
    assert.ok(at >= 1 && at <= 8, `step ${i}: the selected row is on screen`);
    const row = state.rows.get(state.selected ?? '');
    if (['row 0', 'row 10', 'row 20'].includes(row?.title ?? '')) {
      assert.match(lines[at - 1] ?? '', /^G\d$/, `step ${i}: header above ${row?.title}`);
    }
    if (i > 0) {
      const before = states[i - 1]?.scroll ?? 0;
      assert.ok(Math.abs(state.scroll - before) <= 2, `step ${i}`);
    }
  }
});

test('scrolled: render shows what scroll says while the selected row is in view', () => {
  const states = walk(manyRows(30), down(12));
  const model = states[12] as TuiModel;
  assert.equal(model.scroll, 6);
  const lines = render(model, SIZE);
  // Body line 6 is "row 5" (line 0 is the group header); row 12, the selected one, is the last line.
  assert.match(lines[1] ?? '', /row 5 /);
  assert.match(lines[8] ?? '', /^> .*row 12 /);
});

test('scrolled: a smaller list, or a taller screen, pulls the window back; it never leaves blank lines under a full list', () => {
  const atEnd = walk(manyRows(30), down(29)).pop() as TuiModel;
  assert.equal(atEnd.scroll, 23);
  const taller = scrolled(atEnd, { columns: 80, rows: 20 });
  assert.equal(taller.scroll, 31 - 18);
  const few = scrolled({ ...open(), scroll: 20 }, SIZE);
  assert.equal(few.scroll, 0);
});

test('scrolled: a negative or odd scroll is made a valid one', () => {
  assert.equal(scrolled({ ...manyRows(30), scroll: -5 }, SIZE).scroll, 0);
  assert.equal(scrolled({ ...manyRows(30), scroll: Number.NaN }, SIZE).scroll, 0);
});

test('scrolled: the detail keeps the window of the list, and a model without rows needs none', () => {
  const states = walk(manyRows(30), down(12));
  const detail = reduce(states[12] as TuiModel, 'enter').model;
  assert.equal(scrolled(detail, SIZE), detail);
  assert.equal(scrolled(initModel([], T0), SIZE).scroll, 0);
});

test('scrolled: a screen with no room for a body still gives a valid model', () => {
  for (const rows of [0, 1, 2, 3]) {
    const model = scrolled(press(manyRows(30), ...down(5)), { columns: 80, rows });
    assert.ok(model.scroll >= 0, String(rows));
  }
});

test('scrolled: returns the same model when nothing moves', () => {
  const model = scrolled(manyRows(30), SIZE);
  assert.equal(scrolled(model, SIZE), model);
});

// --- detail ----------------------------------------------------------------------------------------

test('the detail of a row: the fields, the pull requests, the note', () => {
  const row = listRow({
    id: S1,
    group: 'A',
    state: 'waiting',
    title: 'Fix retry loop',
    marks: ['was-working'],
    hasNote: true,
    note: 'a\nb',
    prs: [pull({})],
    sinceNs: T0 - 5n * MIN,
  });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 14 });
  assert.deepEqual(lines.slice(1, 11), [
    'title: Fix retry loop',
    'id: ' + S1,
    'state: waiting',
    'since: 2026-11-12T08:55:00.000Z',
    'dir: /home/dev/projects/demo',
    'group: A',
    'marks: was-working',
    'pr: https://github.com/o/r/pull/1  draft',
    'note:',
    '  a',
  ]);
  assert.equal(lines[1], 'title: Fix retry loop');
});

test('the detail: the body contains the id, the state, the pull request line and the note lines', () => {
  const row = listRow({
    id: S1,
    state: 'waiting',
    hasNote: true,
    note: 'a\nb',
    prs: [pull({})],
  });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 20 });
  assert.ok(lines.includes('id: ' + S1));
  assert.ok(lines.includes('state: waiting'));
  assert.ok(lines.includes('pr: https://github.com/o/r/pull/1  draft'));
  assert.ok(lines.includes('note:'));
  assert.ok(lines.includes('  a'));
  assert.ok(lines.includes('  b'));
});

test("the detail: a pull request that can't be read is shown as formatPrLine shows it", () => {
  const bad = pull({ level: 'cant-read', error: 'HTTP 401', state: null });
  const row = listRow({ id: S1, prs: [bad] });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 120, rows: 20 });
  assert.ok(lines.includes('pr: ' + formatPrLine(bad)));
  assert.ok(lines.some((line) => line.includes("can't read")));
});

test('the detail: one line per pull request, in the order of the row', () => {
  const second = pull({ url: 'https://github.com/o/r/pull/2', number: 2, level: 'merged' });
  const row = listRow({ id: S1, prs: [pull({}), second] });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 100, rows: 20 });
  const at = lines.findIndex((line) => line.startsWith('pr: '));
  assert.equal(lines[at], 'pr: https://github.com/o/r/pull/1  draft');
  assert.equal(lines[at + 1], 'pr: https://github.com/o/r/pull/2  merged');
});

test('the detail: absent things show as "-"; the state detail is in parentheses', () => {
  const row = listRow({
    id: S1,
    state: 'working',
    stateDetail: 'tool: Bash',
    dir: null,
    group: null,
    marks: [],
  });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 20 });
  assert.ok(lines.includes('state: working (tool: Bash)'));
  assert.ok(lines.includes('dir: -'));
  assert.ok(lines.includes('group: -'));
  assert.ok(lines.includes('marks: -'));
  assert.ok(!lines.some((line) => line.startsWith('pr: ')));
  assert.ok(!lines.includes('note:'));
});

test('the detail: marks are a comma list', () => {
  const row = listRow({ id: S1, marks: ['ended-unexpectedly', 'was-working'] });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 20 });
  assert.ok(lines.includes('marks: ended-unexpectedly,was-working'));
});

test('the detail: a note is printed line by line, each sanitised, with the breaks kept', () => {
  const note = 'first\x1b[31m red\x1b[0m\r\n\x1b]0;title\x07second\twith tab\n\nlast\x07\n';
  const row = listRow({ id: S1, hasNote: true, note });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 20 });
  const at = lines.indexOf('note:');
  assert.deepEqual(lines.slice(at, at + 5), [
    'note:',
    '  first red',
    '  second with tab',
    '  ',
    '  last',
  ]);
  for (const line of lines) {
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(line), JSON.stringify(line));
  }
});

test('the detail: a note that is empty has the heading and no lines', () => {
  const row = listRow({ id: S1, hasNote: true, note: '' });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 80, rows: 20 });
  const at = lines.indexOf('note:');
  assert.ok(at > 0);
  assert.equal(lines[at + 1], '');
});

test('the detail: lines are cut to the width, and a body that is too long is cut at the bottom', () => {
  const note = Array.from({ length: 40 }, (_, n) => `line ${n}`).join('\n');
  const row = listRow({ id: S1, title: 'T'.repeat(200), hasNote: true, note });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 30, rows: 12 });
  assert.equal(lines.length, 12);
  assert.ok(lines.every((line) => line.length <= 30));
  assert.equal(lines[1], 'title: ' + 'T'.repeat(23));
});

test('the detail: a body that is cut ends with a line of "…"; one that fits has none', () => {
  const note = Array.from({ length: 40 }, (_, n) => `line ${n}`).join('\n');
  const long = listRow({ id: S1, hasNote: true, note });
  const cut = render(press(initModel([long], T0), 'enter'), { columns: 40, rows: 12 });
  assert.equal(cut[10], '…');
  // Seven fields, the heading, then the note: the ninth body line is the first note line.
  assert.equal(cut[9], '  line 0');
  const fits = listRow({ id: S1, hasNote: true, note: 'a\nb' });
  const whole = render(press(initModel([fits], T0), 'enter'), { columns: 40, rows: 12 });
  assert.ok(!whole.includes('…'));
});

test('the detail: a body exactly as long as the screen is not marked as cut', () => {
  const row = listRow({ id: S1 });
  // title, id, state, since, dir, group, marks: seven lines.
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 60, rows: 9 });
  assert.ok(!lines.includes('…'));
  assert.equal(lines[7], 'marks: -');
});

test('the detail: with room for one body line, that line is the title and not a bare "…"', () => {
  const row = listRow({ id: S1, hasNote: true, note: 'x' });
  const lines = render(press(initModel([row], T0), 'enter'), { columns: 60, rows: 3 });
  assert.equal(lines[1], 'title: t');
});

test('the detail follows the selected row', () => {
  const lines = render(press(open(), 'j', 'enter'), SIZE);
  assert.equal(lines[1], 'title: beta');
  assert.ok(lines.includes('id: ' + S2));
});

test('the detail uses the last line like the list: help, or the message', () => {
  const detail = press(open(), 'enter');
  assert.equal(render(detail, SIZE)[9], HELP.slice(0, 80));
  assert.equal(render(withMessage(detail, 'saved'), SIZE)[9], 'saved');
});

test('the detail with no row selected shows nothing but the frame', () => {
  const lines = render({ ...initModel([], T0), mode: 'detail' }, SIZE);
  assert.equal(lines.length, 10);
  assert.equal(lines[1], 'no sessions');
});

// --- input and filter modes show the list ---------------------------------------------------------

test('while typing, the body is the list', () => {
  const lines = render(press(open(), 'l'), SIZE);
  assert.equal(lines[1], 'A');
  assert.equal(lines[2], '> ' + formatRow(R1, T0, 78));
  assert.equal(lines[9], 'label: alpha_');
});

test('while typing a filter, the body is the filtered list', () => {
  const lines = render(press(open(), '/', 'b', 'e'), SIZE);
  assert.equal(lines[2], '> ' + formatRow(R2, T0, 78));
  assert.equal(lines[3], '');
});

// --- hostile text from the model -------------------------------------------------------------------

test('text typed by the user cannot reach the screen as an escape sequence', () => {
  // The reducer refuses such keys; a model built by hand with one must still print safely.
  const model = { ...open(), mode: 'filter' as const, filter: 'a\x1b[2Jb' };
  for (const line of render(model, SIZE)) {
    assert.ok(!line.includes('\x1b'), JSON.stringify(line));
  }
  const input = {
    ...open(),
    mode: 'input' as const,
    input: { purpose: 'label' as const, text: 'x\x1b[2Jy' },
  };
  for (const line of render(input, SIZE)) {
    assert.ok(!line.includes('\x1b'), JSON.stringify(line));
  }
});
