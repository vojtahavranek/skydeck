import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sizeAfter } from '../../src/window/size.ts';
import type { SizeState } from '../../src/window/size.ts';

const EMPTY: SizeState = { owner: null, proposals: new Map() };

type Event = Parameters<typeof sizeAfter>[1];

/** Runs `events` from the empty state; `at` counts up from 1 unless an event gives its own. */
function run(events: Omit<Event, 'at'>[]): {
  state: SizeState;
  applied: ({ cols: number; rows: number } | null)[];
} {
  let state = EMPTY;
  const applied: ({ cols: number; rows: number } | null)[] = [];
  events.forEach((event, i) => {
    const next = sizeAfter(state, { ...event, at: i + 1 });
    state = next.state;
    applied.push(next.apply);
  });
  return { state, applied };
}

const attach = (page: string, cols: number, rows: number): Omit<Event, 'at'> => ({
  kind: 'attach',
  page,
  cols,
  rows,
});
const resize = (page: string, cols: number, rows: number): Omit<Event, 'at'> => ({
  kind: 'resize',
  page,
  cols,
  rows,
});
const input = (page: string): Omit<Event, 'at'> => ({ kind: 'input', page });
const detach = (page: string): Omit<Event, 'at'> => ({ kind: 'detach', page });

test('sizeAfter: the first page to attach owns the size, and its proposal applies', () => {
  const { state, applied } = run([attach('a', 80, 24)]);
  assert.equal(state.owner, 'a');
  assert.deepEqual(applied, [{ cols: 80, rows: 24 }]);
  assert.deepEqual(state.proposals.get('a'), { cols: 80, rows: 24, attachedAt: 1, inputAt: null });
});

test("sizeAfter: a later page's attach and resize are only remembered", () => {
  const { state, applied } = run([attach('a', 80, 24), attach('b', 100, 30), resize('b', 90, 31)]);
  assert.equal(state.owner, 'a');
  assert.deepEqual(applied, [{ cols: 80, rows: 24 }, null, null]);
  assert.deepEqual(state.proposals.get('b'), { cols: 90, rows: 31, attachedAt: 2, inputAt: null });
});

test("sizeAfter: the owner's resize applies", () => {
  const { state, applied } = run([attach('a', 80, 24), resize('a', 100, 40)]);
  assert.equal(state.owner, 'a');
  assert.deepEqual(applied, [
    { cols: 80, rows: 24 },
    { cols: 100, rows: 40 },
  ]);
});

test('sizeAfter: input makes a page the owner and applies its remembered proposal', () => {
  const { state, applied } = run([
    attach('a', 80, 24),
    attach('b', 100, 30),
    resize('b', 90, 31),
    input('b'),
  ]);
  assert.equal(state.owner, 'b');
  assert.deepEqual(applied.at(-1), { cols: 90, rows: 31 });
  assert.equal(state.proposals.get('b')?.inputAt, 4);
});

test("sizeAfter: the owner's own input changes nothing but its input time", () => {
  const { state, applied } = run([attach('a', 80, 24), input('a'), input('a')]);
  assert.equal(state.owner, 'a');
  assert.deepEqual(applied, [{ cols: 80, rows: 24 }, null, null]);
  assert.equal(state.proposals.get('a')?.inputAt, 3);
});

test('sizeAfter: when the owner detaches, the page that sent input last takes over', () => {
  const { state, applied } = run([
    attach('a', 80, 24),
    attach('b', 100, 30),
    attach('c', 120, 40),
    input('b'),
    input('a'),
    detach('a'),
  ]);
  assert.equal(state.owner, 'b');
  assert.deepEqual(applied.at(-1), { cols: 100, rows: 30 });
  assert.equal(state.proposals.has('a'), false);
});

test('sizeAfter: without input from the others, the page that attached last takes over', () => {
  const { state, applied } = run([
    attach('a', 80, 24),
    attach('b', 100, 30),
    attach('c', 120, 40),
    input('a'),
    detach('a'),
  ]);
  assert.equal(state.owner, 'c');
  assert.deepEqual(applied.at(-1), { cols: 120, rows: 40 });
});

test('sizeAfter: a page that sent input wins over one that attached later', () => {
  const { state } = run([
    attach('a', 80, 24),
    attach('b', 100, 30),
    input('b'),
    input('a'),
    attach('c', 120, 40),
    detach('a'),
  ]);
  assert.equal(state.owner, 'b');
});

test('sizeAfter: a page that is not the owner detaches and nothing applies', () => {
  const { state, applied } = run([attach('a', 80, 24), attach('b', 100, 30), detach('b')]);
  assert.equal(state.owner, 'a');
  assert.deepEqual(applied.at(-1), null);
  assert.deepEqual([...state.proposals.keys()], ['a']);
});

test('sizeAfter: with nobody attached there is no owner and nothing applies', () => {
  const { state, applied } = run([attach('a', 80, 24), detach('a')]);
  assert.equal(state.owner, null);
  assert.equal(state.proposals.size, 0);
  assert.deepEqual(applied.at(-1), null);
});

test('sizeAfter: a page that attaches to a terminal without an owner becomes it', () => {
  const { state, applied } = run([attach('a', 80, 24), detach('a'), attach('b', 100, 30)]);
  assert.equal(state.owner, 'b');
  assert.deepEqual(applied.at(-1), { cols: 100, rows: 30 });
});

test('sizeAfter: resize, input and detach of a page that is not attached change nothing', () => {
  const before = run([attach('a', 80, 24)]).state;
  for (const event of [resize('x', 10, 10), input('x'), detach('x')]) {
    const after = sizeAfter(before, { ...event, at: 9 });
    assert.deepEqual(after, { state: before, apply: null }, event.kind);
  }
});

test('sizeAfter: an attached page that attaches again proposes anew and keeps its input time', () => {
  const owner = run([attach('a', 80, 24), input('a'), attach('a', 90, 30)]);
  assert.equal(owner.state.owner, 'a');
  assert.deepEqual(owner.applied.at(-1), { cols: 90, rows: 30 });
  assert.deepEqual(owner.state.proposals.get('a'), {
    cols: 90,
    rows: 30,
    attachedAt: 3,
    inputAt: 2,
  });

  const other = run([attach('a', 80, 24), attach('b', 100, 30), attach('b', 110, 35)]);
  assert.equal(other.state.owner, 'a');
  assert.deepEqual(other.applied.at(-1), null);
  assert.deepEqual(other.state.proposals.get('b')?.cols, 110);
});

test('sizeAfter: is pure (the state given is never changed)', () => {
  const start = run([attach('a', 80, 24), attach('b', 100, 30)]).state;
  const copy = { owner: start.owner, proposals: new Map(start.proposals) };
  sizeAfter(start, { kind: 'input', page: 'b', at: 7 });
  sizeAfter(start, { kind: 'detach', page: 'a', at: 8 });
  sizeAfter(start, { kind: 'resize', page: 'a', cols: 1, rows: 1, at: 9 });
  assert.deepEqual(start, copy);
});

test('sizeAfter: attach and resize without a size are refused', () => {
  assert.throws(() => sizeAfter(EMPTY, { kind: 'attach', page: 'a', at: 1 }), RangeError);
  const owned = run([attach('a', 80, 24)]).state;
  assert.throws(() => sizeAfter(owned, { kind: 'resize', page: 'a', cols: 80, at: 2 }), RangeError);
});
