import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  initModel,
  reduce,
  visibleRows,
  withMessage,
  withRows,
} from '../../../src/cli/tui/model.ts';
import type { TuiEffect, TuiModel } from '../../../src/cli/tui/model.ts';
import { NS_PER_MINUTE } from '../../../src/platform/time.ts';
import { buildList } from '../../../src/sessions/list.ts';
import type { ListRow } from '../../../src/sessions/list.ts';
import { S1, S2, S3, T0 } from '../../helpers/platform.ts';
import { listRow } from '../../helpers/rows.ts';

const MIN = NS_PER_MINUTE;
const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';
const URL1 = 'https://github.com/o/r/pull/1';

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

function open(): TuiModel {
  return initModel([R1, R2, R3], T0);
}

/** Feeds the keys one by one; returns the last result and every effect on the way. */
function press(
  start: TuiModel,
  ...keys: string[]
): { model: TuiModel; effect: TuiEffect; effects: TuiEffect[] } {
  let model = start;
  let effect: TuiEffect = { kind: 'none' };
  const effects: TuiEffect[] = [];
  for (const key of keys) {
    ({ model, effect } = reduce(model, key));
    effects.push(effect);
  }
  return { model, effect, effects };
}

const typed = (text: string): string[] => [...text];
const ids = (rows: readonly ListRow[]): string[] => rows.map((row) => row.id);

// --- opening ---------------------------------------------------------------------------------------

test('initModel: the order is the order of buildList with everything listed; done rows are hidden', () => {
  const model = open();
  const expected = buildList([R1, R2, R3], { showAll: true, filter: '', nowNs: T0 });
  assert.deepEqual(
    model.order,
    expected.groups.map((group) => ({ name: group.name, ids: group.rows.map((row) => row.id) })),
  );
  assert.deepEqual(model.order, [
    { name: 'A', ids: [S1, S2] },
    { name: null, ids: [S3] },
  ]);
  assert.deepEqual(ids(visibleRows(model)), [S1, S2]);
  assert.equal(model.selected, S1);
  assert.equal(model.mode, 'list');
  assert.equal(model.showAll, false);
  assert.equal(model.filter, '');
  assert.equal(model.input, null);
  assert.equal(model.message, null);
  assert.equal(model.scroll, 0);
  assert.equal(model.nowNs, T0);
  assert.equal(model.rows.get(S3), R3);
});

test('initModel: no rows, nothing selected', () => {
  const model = initModel([], T0);
  assert.equal(model.selected, null);
  assert.deepEqual(model.order, []);
  assert.deepEqual(visibleRows(model), []);
});

test('initModel: a row that is never listed (an expired one with nothing of the user) is not in the order', () => {
  const expired = listRow({ id: S2, marks: ['expired'] });
  const model = initModel([R1, expired], T0);
  assert.deepEqual(model.order, [{ name: 'A', ids: [S1] }]);
});

// --- group order -----------------------------------------------------------------------------------

test('groups are ranked by their listed members: a done row does not lift its group (design 7.4)', () => {
  const a = listRow({ id: 'a1', group: 'A', lastActivityNs: T0 - 60n * MIN });
  const b1 = listRow({ id: 'b1', group: 'B', lastActivityNs: T0 - 180n * MIN });
  const b2 = listRow({ id: 'b2', group: 'B', done: true, lastActivityNs: T0 - 5n * MIN });
  const model = initModel([a, b1, b2], T0);
  assert.deepEqual(model.order, [
    { name: 'A', ids: ['a1'] },
    { name: 'B', ids: ['b2', 'b1'] },
  ]);
  assert.deepEqual(ids(visibleRows(model)), ['a1', 'b1']);
  // With the done rows shown, B has the most recent row, as in `skydeck ls --all`.
  const all = press(model, 'a').model;
  assert.deepEqual(
    all.order.map((group) => group.name),
    ['B', 'A'],
  );
  assert.deepEqual(
    press(all, 'a').model.order.map((group) => group.name),
    ['A', 'B'],
  );
});

test('a group with only done members comes after the others, before "no group"', () => {
  const a = listRow({ id: 'a1', group: 'A', lastActivityNs: T0 - 60n * MIN });
  const c = listRow({ id: 'c1', group: 'C', done: true, lastActivityNs: T0 - MIN });
  const n = listRow({ id: 'n1', group: null, lastActivityNs: T0 });
  const model = initModel([a, c, n], T0);
  assert.deepEqual(
    model.order.map((group) => group.name),
    ['A', 'C', null],
  );
  assert.deepEqual(ids(visibleRows(model)), ['a1', 'n1']);
});

test('withRows with reorder ranks the groups under the current showAll', () => {
  const a = listRow({ id: 'a1', group: 'A', lastActivityNs: T0 - 60n * MIN });
  const b1 = listRow({ id: 'b1', group: 'B', lastActivityNs: T0 - 180n * MIN });
  const b2 = listRow({ id: 'b2', group: 'B', done: true, lastActivityNs: T0 - 5n * MIN });
  const next = withRows(initModel([a], T0), [a, b1, b2], T0, true);
  assert.deepEqual(
    next.order.map((group) => group.name),
    ['A', 'B'],
  );
});

// --- moving ----------------------------------------------------------------------------------------

test('j and k move the cursor and stop at the ends; the arrows do the same', () => {
  let { model } = press(open(), 'j');
  assert.equal(model.selected, S2);
  ({ model } = press(model, 'j'));
  assert.equal(model.selected, S2);
  ({ model } = press(model, 'k'));
  assert.equal(model.selected, S1);
  ({ model } = press(model, 'k'));
  assert.equal(model.selected, S1);
  ({ model } = press(model, 'down'));
  assert.equal(model.selected, S2);
  ({ model } = press(model, 'up'));
  assert.equal(model.selected, S1);
});

test('moving gives effect none', () => {
  assert.deepEqual(press(open(), 'j').effect, { kind: 'none' });
});

test('the cursor moves across groups in display order', () => {
  const { model } = press(initModel([R1, R2, R3], T0), 'a', 'j', 'j');
  assert.equal(model.selected, S3);
});

// --- detail ----------------------------------------------------------------------------------------

test('enter opens the detail, escape and enter and q close it with no effect', () => {
  let { model, effect } = press(open(), 'enter');
  assert.equal(model.mode, 'detail');
  assert.deepEqual(effect, { kind: 'none' });
  ({ model, effect } = press(model, 'escape'));
  assert.equal(model.mode, 'list');
  assert.deepEqual(effect, { kind: 'none' });
  ({ model } = press(model, 'enter'));
  ({ model } = press(model, 'enter'));
  assert.equal(model.mode, 'list');
  ({ model } = press(model, 'enter'));
  ({ model, effect } = press(model, 'q'));
  assert.equal(model.mode, 'list');
  assert.deepEqual(effect, { kind: 'none' });
});

test('q in the list quits; ctrl-c quits in every mode', () => {
  assert.deepEqual(press(open(), 'q').effect, { kind: 'quit' });
  assert.deepEqual(press(open(), '/', 'ctrl-c').effect, { kind: 'quit' });
  assert.deepEqual(press(open(), 'enter', 'ctrl-c').effect, { kind: 'quit' });
  assert.deepEqual(press(open(), 'l', 'ctrl-c').effect, { kind: 'quit' });
  assert.deepEqual(press(open(), 'ctrl-c').effect, { kind: 'quit' });
});

test('in the detail, l g n d p R act as in the list, and j k do nothing', () => {
  const detail = press(open(), 'enter').model;
  assert.deepEqual(press(detail, 'n').effect, { kind: 'note', id: S1 });
  assert.deepEqual(press(detail, 'd').effect, { kind: 'done', id: S1, done: true });
  assert.deepEqual(press(detail, 'R').effect, { kind: 'resume', id: S1 });
  assert.equal(press(detail, 'l').model.mode, 'input');
  assert.equal(press(detail, 'g').model.mode, 'input');
  assert.equal(press(detail, 'p').model.mode, 'input');
  const moved = press(detail, 'j');
  assert.equal(moved.model.selected, S1);
  assert.equal(moved.model.mode, 'detail');
});

test('a note, done or resume taken from the detail leaves the detail open', () => {
  const detail = press(open(), 'enter').model;
  assert.equal(press(detail, 'n').model.mode, 'detail');
  assert.equal(press(detail, 'd').model.mode, 'detail');
  assert.equal(press(detail, 'R').model.mode, 'detail');
});

// --- show all --------------------------------------------------------------------------------------

test('a shows the done rows too, and shows them away again, moving the cursor off a hidden row', () => {
  let { model } = press(open(), 'a');
  assert.equal(model.showAll, true);
  assert.deepEqual(ids(visibleRows(model)), [S1, S2, S3]);
  ({ model } = press(model, 'j', 'j'));
  assert.equal(model.selected, S3);
  ({ model } = press(model, 'a'));
  assert.equal(model.showAll, false);
  assert.equal(model.selected, S1);
});

test('a recomputes the order from the rows it holds', () => {
  const waitingLater = withRows(
    open(),
    [R1, listRow({ id: S2, group: 'A', state: 'waiting', lastActivityNs: T0 + MIN }), R3],
    T0,
    false,
  );
  assert.deepEqual(waitingLater.order[0]?.ids, [S1, S2]);
  assert.deepEqual(press(waitingLater, 'a').model.order[0]?.ids, [S2, S1]);
});

// --- filter ----------------------------------------------------------------------------------------

test('the filter takes characters and backspace; enter keeps it and returns to the list', () => {
  const { model, effect } = press(open(), '/', 'b', 'e', 't', 'backspace', 'enter');
  assert.equal(model.filter, 'be');
  assert.equal(model.mode, 'list');
  assert.deepEqual(effect, { kind: 'none' });
  assert.deepEqual(ids(visibleRows(model)), [S2]);
  assert.equal(model.selected, S2);
});

test('escape in the filter clears it and returns to the list', () => {
  const { model } = press(open(), '/', 'b', 'escape');
  assert.equal(model.filter, '');
  assert.equal(model.mode, 'list');
  assert.deepEqual(ids(visibleRows(model)), [S1, S2]);
});

test('while typing a filter the selection follows the first match, in the filter mode', () => {
  const { model } = press(open(), '/', 'b', 'e');
  assert.equal(model.mode, 'filter');
  assert.equal(model.selected, S2);
});

test('keys that mean something in the list are text in the filter', () => {
  const { model, effect } = press(open(), '/', 'q', 'j', 'd');
  assert.equal(model.filter, 'qjd');
  assert.equal(model.mode, 'filter');
  assert.deepEqual(effect, { kind: 'none' });
});

test('a filter that matches nothing leaves no selection; clearing it brings the first row back', () => {
  let { model } = press(open(), '/', ...typed('zzz'));
  assert.equal(model.selected, null);
  assert.deepEqual(visibleRows(model), []);
  ({ model } = press(model, 'escape'));
  assert.equal(model.selected, S1);
});

test('a filter kept after enter stays when keys are pressed in the list; the order does not change under it', () => {
  const before = open().order;
  const { model } = press(open(), '/', 'b', 'e', 'enter');
  assert.deepEqual(model.order, before);
});

test('only printable keys are typed: names of other keys, a control character and an escape are ignored', () => {
  const { model } = press(open(), '/', 'up', 'down', 'x', '\t', '\x1b', '\x1b[A', 'tab', '');
  assert.equal(model.filter, 'x');
});

test('a character outside the basic plane is one key and is typed', () => {
  const { model } = press(open(), '/', '😀', 'é');
  assert.equal(model.filter, '😀é');
});

// --- label and group -------------------------------------------------------------------------------

test('l opens the label input with the current label; the edited text goes out with enter', () => {
  const opened = press(open(), 'l').model;
  assert.equal(opened.mode, 'input');
  assert.deepEqual(opened.input, { purpose: 'label', text: 'alpha' });
  const { model, effect } = press(opened, ...Array(5).fill('backspace'), 'x', 'enter');
  assert.deepEqual(effect, { kind: 'label', id: S1, text: 'x' });
  assert.equal(model.mode, 'list');
  assert.equal(model.input, null);
});

test('l on a row without a label starts with empty text; enter on empty text clears (text "")', () => {
  const { effect } = press(open(), 'j', 'l', 'enter');
  assert.deepEqual(effect, { kind: 'label', id: S2, text: '' });
});

test('escape cancels the input', () => {
  const { model, effect } = press(open(), 'l', 'escape');
  assert.deepEqual(effect, { kind: 'none' });
  assert.equal(model.mode, 'list');
  assert.equal(model.input, null);
});

test('g opens the group input with the group the user set; the edited text goes out with enter', () => {
  const opened = press(open(), 'g').model;
  assert.deepEqual(opened.input, { purpose: 'group', text: 'A' });
  const { effect } = press(opened, 'backspace', 'G', 'enter');
  assert.deepEqual(effect, { kind: 'group', id: S1, text: 'G' });
});

test('g then enter changes nothing; clearing the group takes a deliberate delete', () => {
  assert.deepEqual(press(open(), 'g', 'enter').effect, { kind: 'group', id: S1, text: 'A' });
  assert.deepEqual(press(open(), 'g', 'backspace', 'enter').effect, {
    kind: 'group',
    id: S1,
    text: '',
  });
});

test('g starts empty when the group was only taken from the title, or there is none', () => {
  const fromTitle = listRow({ id: S1, group: 'DE-1', groupSource: 'title', title: 'DE-1 fix' });
  const none = listRow({ id: S2 });
  assert.deepEqual(press(initModel([fromTitle], T0), 'g').model.input, {
    purpose: 'group',
    text: '',
  });
  assert.deepEqual(press(initModel([none], T0), 'g').model.input, { purpose: 'group', text: '' });
});

test('t (F18) opens the ticket input with the address set, or empty; the text goes out with enter', () => {
  const ticket = { url: 'https://example.com/browse/ABC-1', text: 'ABC-1' };
  const withTicket = initModel([listRow({ id: S1, ticket })], T0);
  assert.deepEqual(press(withTicket, 't').model.input, { purpose: 'ticket', text: ticket.url });
  assert.deepEqual(press(withTicket, 't', 'enter').effect, {
    kind: 'ticket',
    id: S1,
    text: ticket.url,
  });
  assert.deepEqual(press(open(), 't').model.input, { purpose: 'ticket', text: '' });
  assert.deepEqual(press(open(), 't', ...'ABC-9', 'enter').effect, {
    kind: 'ticket',
    id: S1,
    text: 'ABC-9',
  });
  assert.equal(press(open(), 't', 'escape').model.input, null);
});

test('t in the detail opens the ticket input too', () => {
  const detail = press(open(), 'enter').model;
  assert.equal(press(detail, 't').model.mode, 'input');
});

test('backspace on empty input text does nothing', () => {
  const { model } = press(open(), 'p', 'backspace', 'backspace');
  assert.deepEqual(model.input, { purpose: 'pr', text: '' });
});

test('backspace removes a whole character outside the basic plane', () => {
  const { model } = press(open(), 'p', '😀', 'backspace');
  assert.deepEqual(model.input, { purpose: 'pr', text: '' });
});

test('in the input, keys that act in the list are text', () => {
  const { model, effect } = press(open(), 'p', 'q', 'j', 'R');
  assert.deepEqual(model.input, { purpose: 'pr', text: 'qjR' });
  assert.deepEqual(effect, { kind: 'none' });
});

// --- note, done, resume, refresh -------------------------------------------------------------------

test('n, d, R, r and q give their effects', () => {
  assert.deepEqual(press(open(), 'n').effect, { kind: 'note', id: S1 });
  assert.deepEqual(press(open(), 'd').effect, { kind: 'done', id: S1, done: true });
  assert.deepEqual(press(open(), 'R').effect, { kind: 'resume', id: S1 });
  assert.deepEqual(press(open(), 'r').effect, { kind: 'refresh' });
  assert.deepEqual(press(open(), 'q').effect, { kind: 'quit' });
});

test('d on a done row asks to undo it', () => {
  const { effect } = press(open(), 'a', 'j', 'j', 'd');
  assert.deepEqual(effect, { kind: 'done', id: S3, done: false });
});

test('an unknown key gives effect none and changes nothing but the message', () => {
  const start = open();
  const { model, effect } = press(start, 'x');
  assert.deepEqual(effect, { kind: 'none' });
  assert.deepEqual(model, start);
});

// --- pull requests ---------------------------------------------------------------------------------

test('p then a url adds it; a leading dash removes it', () => {
  const opened = press(open(), 'p').model;
  assert.deepEqual(opened.input, { purpose: 'pr', text: '' });
  assert.deepEqual(press(opened, ...typed(URL1), 'enter').effect, {
    kind: 'pr-add',
    id: S1,
    url: URL1,
  });
  assert.deepEqual(press(opened, '-', ...typed(URL1), 'enter').effect, {
    kind: 'pr-rm',
    id: S1,
    url: URL1,
  });
});

test('pull-request text is trimmed; with nothing left the effect is none and the input closes', () => {
  assert.deepEqual(press(open(), 'p', ' ', ...typed(URL1), ' ', 'enter').effect, {
    kind: 'pr-add',
    id: S1,
    url: URL1,
  });
  for (const text of ['', ' ', '-', '- ']) {
    const { model, effect } = press(open(), 'p', ...typed(text), 'enter');
    assert.deepEqual(effect, { kind: 'none' }, JSON.stringify(text));
    assert.equal(model.mode, 'list');
    assert.equal(model.input, null);
  }
});

// --- no rows ---------------------------------------------------------------------------------------

test('with no visible rows, the action keys give none and nothing throws', () => {
  const empty = initModel([], T0);
  for (const key of ['j', 'k', 'up', 'down', 'enter', 'l', 'g', 'n', 't', 'd', 'p', 'R']) {
    const { model, effect } = press(empty, key);
    assert.deepEqual(effect, { kind: 'none' }, key);
    assert.equal(model.selected, null, key);
    assert.equal(model.mode, 'list', key);
  }
});

test('with no visible rows the keys that do not act on a row still work', () => {
  const empty = initModel([], T0);
  assert.deepEqual(press(empty, 'r').effect, { kind: 'refresh' });
  assert.deepEqual(press(empty, 'q').effect, { kind: 'quit' });
  assert.equal(press(empty, '/').model.mode, 'filter');
  assert.equal(press(empty, 'a').model.showAll, true);
});

test('a filter that hides every row blocks the action keys too, but not the filter key', () => {
  const { model } = press(open(), '/', ...typed('zzz'), 'enter');
  assert.deepEqual(press(model, 'd').effect, { kind: 'none' });
  assert.equal(press(model, '/').model.mode, 'filter');
});

// --- messages --------------------------------------------------------------------------------------

test('withMessage sets the message; the next key clears it, whatever it is', () => {
  const shown = withMessage(open(), 'saved');
  assert.equal(shown.message, 'saved');
  assert.equal(press(shown, 'j').model.message, null);
  assert.equal(press(shown, 'x').model.message, null);
  assert.equal(press(shown, 'q').model.message, null);
  assert.equal(withMessage(shown, null).message, null);
});

test('a message is cleared in every mode', () => {
  for (const keys of [['/'], ['l'], ['enter']]) {
    const base = press(open(), ...keys).model;
    assert.equal(press(withMessage(base, 'saved'), 'x').model.message, null, keys.join());
  }
});

test('reduce and the builders do not change the model they are given', () => {
  const start = open();
  const snapshot = structuredClone({ ...start, rows: [...start.rows.keys()] });
  press(start, 'j', 'a', '/', 'x', 'enter', 'l', 'x', 'enter');
  withRows(start, [R1], T0, true);
  withMessage(start, 'm');
  assert.deepEqual(structuredClone({ ...start, rows: [...start.rows.keys()] }), snapshot);
});

// --- new rows --------------------------------------------------------------------------------------

test('withRows without reorder keeps the order and puts a new row at the end of its group', () => {
  const m = open();
  const R2b = listRow({
    id: S2,
    group: 'A',
    state: 'waiting',
    title: 'beta',
    lastActivityNs: T0 + MIN,
  });
  const R4 = listRow({ id: S4, group: 'A' });
  const next = withRows(m, [R1, R2b, R3, R4], T0, false);
  assert.deepEqual(next.order, [
    { name: 'A', ids: [S1, S2, S4] },
    { name: null, ids: [S3] },
  ]);
  assert.equal(next.rows.get(S2), R2b);
  assert.equal(next.selected, S1);
});

test('withRows without reorder drops a vanished row; the last one gone, the cursor goes to the one before it', () => {
  const m = press(open(), 'j').model;
  assert.equal(m.selected, S2);
  const next = withRows(m, [R1, R3], T0, false);
  assert.deepEqual(next.order, [
    { name: 'A', ids: [S1] },
    { name: null, ids: [S3] },
  ]);
  assert.equal(next.selected, S1);
});

// Three listed rows in group A, in this order: R1 (waiting), R2, R4.
const R4 = listRow({ id: S4, group: 'A', title: 'delta', lastActivityNs: T0 - 2n * MIN });
const three = (): TuiModel => initModel([R1, R2, R3, R4], T0);

test('when the selected row goes, the cursor goes to the row that takes its place, not to the first', () => {
  const onR2 = press(three(), 'j').model;
  assert.deepEqual(ids(visibleRows(onR2)), [S1, S2, S4]);

  assert.equal(withRows(onR2, [R1, R3, R4], T0, false).selected, S4, 'the next one');
  const hidden = { ...R2, done: true };
  assert.equal(withRows(onR2, [R1, hidden, R3, R4], T0, false).selected, S4, 'hidden as done');
  assert.equal(withRows(onR2, [R1, R3], T0, false).selected, S1, 'no next one: the one before');
  const onR4 = press(three(), 'j', 'j').model;
  assert.equal(withRows(onR4, [R1, R2, R3], T0, false).selected, S2, 'the last: the one before');
});

test('with reorder too, the cursor goes to the row after the old one in the order that was shown', () => {
  const onR2 = press(three(), 'j').model;
  // A new row S5 is ranked first by the new order; R4 is still the row that came after R2.
  const S5 = '4f9d7a5c-2b6e-4daf-9071-6c5d4e3f2a1b';
  const R5 = listRow({ id: S5, group: 'A', state: 'waiting', lastActivityNs: T0 + MIN });
  const next = withRows(onR2, [R1, R3, R4, R5], T0, true);
  assert.deepEqual(ids(visibleRows(next)), [S5, S1, S4]);
  assert.equal(next.selected, S4);
});

test('when nothing that was shown is left, the cursor goes to the first visible row', () => {
  const onR2 = press(three(), 'j').model;
  const R5 = listRow({ id: '4f9d7a5c-2b6e-4daf-9071-6c5d4e3f2a1b', group: 'B' });
  assert.equal(withRows(onR2, [R3, R5], T0, false).selected, R5.id);
});

test('withRows without reorder puts a group that did not exist after the named ones and before "no group"', () => {
  const R5 = listRow({ id: S4, group: 'Z', lastActivityNs: T0 + 10n * MIN });
  const next = withRows(open(), [R1, R2, R3, R5], T0, false);
  assert.deepEqual(
    next.order.map((group) => group.name),
    ['A', 'Z', null],
  );
});

test('withRows without reorder: several new groups keep the order buildList gives them, all before "no group"', () => {
  const R5 = listRow({ id: S4, group: 'Z', lastActivityNs: T0 + 10n * MIN });
  const R6 = listRow({
    id: '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b',
    group: 'Y',
    lastActivityNs: T0 + 20n * MIN,
  });
  const next = withRows(open(), [R1, R2, R3, R5, R6], T0, false);
  assert.deepEqual(
    next.order.map((group) => group.name),
    ['A', 'Y', 'Z', null],
  );
});

test('withRows without reorder: a new "no group" row joins the group of no name; a first one goes last', () => {
  const lone = withRows(initModel([R1, R2], T0), [R1, R2, R3], T0, false);
  assert.deepEqual(
    lone.order.map((group) => group.name),
    ['A', null],
  );
  const N = listRow({ id: S4, group: null });
  const next = withRows(open(), [R1, R2, R3, N], T0, false);
  assert.deepEqual(next.order[1], { name: null, ids: [S3, S4] });
});

test('withRows without reorder: several new rows are appended in the order buildList gives them', () => {
  const N1 = listRow({ id: S4, group: 'A', state: 'working', lastActivityNs: T0 });
  const N2 = listRow({
    id: '4f9d7a5c-2b6e-4d0f-9a7b-6c5d4e3f2a1b',
    group: 'A',
    state: 'waiting',
    lastActivityNs: T0,
  });
  const next = withRows(open(), [R1, R2, R3, N1, N2], T0, false);
  assert.deepEqual(next.order[0]?.ids, [S1, S2, N2.id, S4]);
});

test('withRows without reorder: a row whose group changed moves to the end of its new group', () => {
  const R1g = listRow({ id: S1, group: 'B', state: 'waiting', label: 'alpha' });
  const R5 = listRow({ id: S4, group: 'B' });
  const m = withRows(open(), [R1, R2, R3, R5], T0, false);
  assert.deepEqual(m.order[0], { name: 'A', ids: [S1, S2] });
  const next = withRows(m, [R1g, R2, R3, R5], T0, false);
  assert.deepEqual(next.order, [
    { name: 'A', ids: [S2] },
    { name: 'B', ids: [S4, S1] },
    { name: null, ids: [S3] },
  ]);
  assert.equal(next.selected, S1);
});

test('withRows without reorder drops a group that has become empty', () => {
  const next = withRows(open(), [R1, R2], T0, false);
  assert.deepEqual(next.order, [{ name: 'A', ids: [S1, S2] }]);
});

test('withRows without reorder: a row that stops being listed at all leaves the order; one that is listed again comes at the end', () => {
  // A group that only the title gave is not something the user attached (design 7.2).
  const expired = listRow({ id: S2, group: 'A', groupSource: 'title', marks: ['expired'] });
  const gone = withRows(open(), [R1, expired, R3], T0, false);
  assert.deepEqual(gone.order[0]?.ids, [S1]);
  const back = withRows(gone, [R1, R2, R3], T0, false);
  assert.deepEqual(back.order[0]?.ids, [S1, S2]);
});

test('withRows without reorder: a done row stays in its place when showAll shows it', () => {
  const m = press(open(), 'a').model;
  const done2 = listRow({ id: S2, group: 'A', done: true, lastActivityNs: T0 - MIN });
  const next = withRows(m, [R1, done2, R3], T0, false);
  assert.deepEqual(next.order[0]?.ids, [S1, S2]);
  assert.deepEqual(ids(visibleRows(next)), [S1, S2, S3]);
});

test('withRows with reorder recomputes the order as buildList does', () => {
  const R2b = listRow({
    id: S2,
    group: 'A',
    state: 'waiting',
    title: 'beta',
    lastActivityNs: T0 + MIN,
  });
  const R4 = listRow({ id: S4, group: 'A' });
  const rows = [R1, R2b, R3, R4];
  const next = withRows(open(), rows, T0, true);
  assert.deepEqual(next.order, [
    { name: 'A', ids: [S2, S1, S4] },
    { name: null, ids: [S3] },
  ]);
});

test('withRows takes the new time and keeps the filter, showAll, the cursor and the message', () => {
  let m = press(open(), 'a', 'j').model;
  m = press(m, '/', 'b', 'e', 'enter').model;
  m = withMessage(m, 'saved');
  const next = withRows(m, [R1, R2, R3], T0 + 5n * MIN, false);
  assert.equal(next.nowNs, T0 + 5n * MIN);
  assert.equal(next.filter, 'be');
  assert.equal(next.showAll, true);
  assert.equal(next.selected, S2);
  assert.equal(next.message, 'saved');
});

test('withRows selects the first row when nothing was selected and one appears; and none when all go', () => {
  const empty = initModel([], T0);
  const next = withRows(empty, [R1, R2], T0, true);
  assert.equal(next.selected, S1);
  assert.equal(withRows(next, [], T0, false).selected, null);
  assert.deepEqual(withRows(next, [], T0, false).order, []);
});

test('a refresh that makes the open detail row vanish closes the detail', () => {
  const detail = press(open(), 'enter').model;
  const next = withRows(detail, [R2, R3], T0, false);
  assert.equal(next.mode, 'list');
  assert.equal(next.selected, S2);
});

test('a refresh that makes the row under a label input vanish cancels the input: it must not label another session', () => {
  const typing = press(open(), 'l', 'x').model;
  const next = withRows(typing, [R2, R3], T0, false);
  assert.equal(next.mode, 'list');
  assert.equal(next.input, null);
  assert.equal(next.selected, S2);
  assert.deepEqual(press(next, 'enter').effect, { kind: 'none' });
});

test('a refresh that only hides the row under the detail or an input (done, showAll off) closes it too', () => {
  // The row is still known, it is just not visible any more: what was open must not carry over to
  // the row the cursor moves to (a second `d` would mark a session the user did not choose).
  const hidden = listRow({ id: S1, group: 'A', state: 'waiting', label: 'alpha', done: true });
  for (const keys of [['enter'], ['l', 'x']]) {
    const next = withRows(press(open(), ...keys).model, [hidden, R2, R3], T0, false);
    assert.equal(next.mode, 'list', keys.join());
    assert.equal(next.input, null, keys.join());
    assert.equal(next.selected, S2, keys.join());
  }
});

test('a refresh that leaves the selected row alone leaves the detail and the input open', () => {
  const detail = press(open(), 'enter').model;
  assert.equal(withRows(detail, [R1, R2, R3], T0, false).mode, 'detail');
  const typing = press(open(), 'g', 'x').model;
  const next = withRows(typing, [R1, R2, R3], T0, false);
  assert.equal(next.mode, 'input');
  assert.deepEqual(next.input, { purpose: 'group', text: 'Ax' });
});

test('a filter being typed keeps its mode when the selection moves with it', () => {
  const typing = press(open(), '/', 'b', 'e').model;
  const next = withRows(typing, [R1, R2, R3], T0, false);
  assert.equal(next.mode, 'filter');
  assert.equal(next.selected, S2);
});
