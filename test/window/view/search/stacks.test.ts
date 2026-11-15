import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stackRows } from '../../../../src/window/view/search/stacks.ts';
import type { StackEntry, StackPayload } from '../../../../src/window/view/search/stacks.ts';

/** A plain entry, with one field of its own to show that `stackRows` hands back the caller's objects. */
interface Entry extends StackEntry {
  readonly own: string;
}

function entry(id: string, group: string | null, held = false): Entry {
  return { id, group, held, own: `own-${id}` };
}

/** `view.opened` of a page that draws stacks and has opened none. */
const NONE: readonly string[] = [];

/** The drawn rows as `id` (in no stack), `id^` (a head) or `id<` (a member), in order. */
function shape(drawn: readonly { entry: Entry; stack: StackPayload | null }[]): string[] {
  return drawn.map(({ entry: row, stack }) =>
    stack === null ? row.id : `${row.id}${stack.role === 'head' ? '^' : '<'}`,
  );
}

// --- what stacks ---------------------------------------------------------------------------------

test('stackRows: two rows of one group stack under the first; closed, the second is left out', () => {
  const rows = [entry('a1', 'ORB-2107'), entry('a2', 'ORB-2107')];
  const drawn = stackRows(rows, NONE, null);
  assert.deepEqual(shape(drawn), ['a1^']);
  assert.deepEqual(drawn[0]?.stack, {
    group: 'ORB-2107',
    size: 2,
    open: false,
    role: 'head',
    head: 'a1',
  });
});

test('stackRows: the head is the first of its group in the section (the newest)', () => {
  const rows = [entry('x', null), entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G')];
  const drawn = stackRows(rows, NONE, null);
  assert.deepEqual(shape(drawn), ['x', 'a1^']);
  assert.equal(drawn[1]?.stack?.head, 'a1');
  assert.equal(drawn[1]?.stack?.size, 3);
});

test('stackRows: one row of a group is no stack', () => {
  const drawn = stackRows([entry('a1', 'G'), entry('b1', 'H')], NONE, null);
  assert.deepEqual(shape(drawn), ['a1', 'b1']);
  assert.equal(drawn[0]?.stack, null);
  assert.equal(drawn[1]?.stack, null);
});

test('stackRows: rows without a group never stack, however many', () => {
  const rows = [entry('x1', null), entry('x2', null), entry('x3', null)];
  const drawn = stackRows(rows, NONE, null);
  assert.deepEqual(shape(drawn), ['x1', 'x2', 'x3']);
  assert.ok(drawn.every(({ stack }) => stack === null));
});

test('stackRows: a group is text, whatever it spells; rows and opened name it exactly', () => {
  // Names an object's prototype has: a group is no property name.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const rows = [entry('a1', name), entry('x', null), entry('a2', name)];
    assert.deepEqual(shape(stackRows(rows, NONE, null)), ['a1^', 'x'], name);
    assert.deepEqual(shape(stackRows(rows, [name], null)), ['a1^', 'a2<', 'x'], name);
    assert.deepEqual(
      shape(stackRows([entry('a1', name), entry('b1', 'B')], NONE, 'a1')),
      ['a1', 'b1'],
      name,
    );
  }
  // Not folded, not trimmed, not normalised: between two rows, and between a row and `opened`.
  const twins: [string, string][] = [
    ['ORB-1', 'orb-1'],
    ['ORB-1', 'ORB-1 '],
    ['caf\u00e9', 'cafe\u0301'], // NFC and NFD
  ];
  for (const [one, other] of twins) {
    const why = `${one} / ${other}`;
    const apart = stackRows([entry('a1', one), entry('a2', other)], NONE, null);
    assert.deepEqual(shape(apart), ['a1', 'a2'], why);
    const same = [entry('a1', one), entry('a2', one)];
    assert.deepEqual(shape(stackRows(same, [other], null)), ['a1^'], why);
  }
});

test('stackRows: three groups interleaved give three heads at their places, the others at theirs', () => {
  const rows = [
    entry('a1', 'A'),
    entry('x1', null),
    entry('b1', 'B'),
    entry('a2', 'A'),
    entry('c1', 'C'),
    entry('y1', 'Y'),
    entry('b2', 'B'),
    entry('c2', 'C'),
    entry('x2', null),
    entry('c3', 'C'),
  ];
  const drawn = stackRows(rows, NONE, null);
  assert.deepEqual(shape(drawn), ['a1^', 'x1', 'b1^', 'c1^', 'y1', 'x2']);
  assert.deepEqual(
    drawn.map(({ stack }) => (stack === null ? null : [stack.group, stack.size])),
    [['A', 2], null, ['B', 2], ['C', 3], null, null],
  );
});

test('stackRows: nothing of the input is changed in place', () => {
  const rows = Object.freeze(
    [entry('a1', 'G'), entry('h', 'G', true), entry('a2', 'G'), entry('x', null)].map((row) =>
      Object.freeze(row),
    ),
  );
  // Two names out of order: a sort in place would throw, or show.
  const opened = Object.freeze(['H', 'G']);
  assert.deepEqual(shape(stackRows(rows, opened, 'a2')), ['a1^', 'a2<', 'h', 'x']);
  assert.deepEqual(opened, ['H', 'G']);
});

test('stackRows: no rows, nothing to draw', () => {
  assert.deepEqual(stackRows([], ['G'], 'a1'), []);
});

test("stackRows: the entries drawn are the caller's own objects", () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('x', null)];
  const drawn = stackRows(rows, ['G'], null);
  assert.equal(drawn[0]?.entry, rows[0]);
  assert.equal(drawn[1]?.entry, rows[1]);
  assert.equal(drawn[2]?.entry, rows[2]);
  assert.equal(drawn[1]?.entry.own, 'own-a2');
  // Without `opened` too: every row comes back as the caller's object.
  const flat = stackRows(rows, undefined, null);
  assert.equal(flat.length, rows.length);
  rows.forEach((row, index) => assert.equal(flat[index]?.entry, row, row.id));
});

test('stackRows: a section without a stack is its rows in order, each with stack null', () => {
  // The shape a view without `opened` gets (below), and task 96 gives while filtering (E5).
  const rows = [
    entry('a1', 'A'),
    entry('x', null),
    entry('h0', null, true),
    entry('b1', 'B'),
    entry('h', 'A', true),
  ];
  assert.deepEqual(
    stackRows(rows, NONE, null),
    rows.map((row) => ({ entry: row, stack: null })),
  );
});

// --- a view without opened (ruled) ---------------------------------------------------------------

test('stackRows: opened absent (a page that cannot draw stacks) → no stacks: every row a row', () => {
  const rows = [
    entry('a1', 'G'),
    entry('x', null),
    entry('a2', 'G'),
    entry('h', 'G', true),
    entry('b1', 'H'),
    entry('b2', 'H'),
  ];
  const expected = rows.map((row) => ({ entry: row, stack: null }));
  assert.deepEqual(stackRows(rows, undefined, null), expected);
  // A selected member opens nothing either: there is no stack to open.
  assert.deepEqual(stackRows(rows, undefined, 'a2'), expected);
  assert.deepEqual(stackRows(rows, undefined, 'b1'), expected);
});

test('stackRows: opened empty (a page that draws stacks, none opened) → stacks, all closed', () => {
  const rows = [entry('a1', 'G'), entry('x', null), entry('a2', 'G'), entry('b1', 'H')];
  const drawn = stackRows(rows, [], null);
  assert.deepEqual(shape(drawn), ['a1^', 'x', 'b1']);
  assert.deepEqual(drawn[0]?.stack, { group: 'G', size: 2, open: false, role: 'head', head: 'a1' });
  assert.deepEqual(shape(stackRows(rows, [], 'a2')), ['a1^', 'a2<', 'x', 'b1']);
});

test('stackRows: opened as an array: each group it names is open, a repeated name as once', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('b2', 'H')];
  assert.deepEqual(shape(stackRows(rows, ['G', 'G'], null)), ['a1^', 'a2<', 'b1^']);
  assert.deepEqual(shape(stackRows(rows, ['H', 'G'], null)), ['a1^', 'a2<', 'b1^', 'b2<']);
});

// --- open and closed -----------------------------------------------------------------------------

test('stackRows: opened names the group → its members right after the head, open on all', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G'), entry('x', null)];
  const drawn = stackRows(rows, ['G'], null);
  assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'a3<', 'x']);
  const head: StackPayload = { group: 'G', size: 3, open: true, role: 'head', head: 'a1' };
  const member: StackPayload = { ...head, role: 'member' };
  assert.deepEqual(
    drawn.map(({ stack }) => stack),
    [head, member, member, null],
  );
});

test("stackRows: an open stack's members follow the head, before the rows between them", () => {
  const rows = [
    entry('a1', 'G'),
    entry('x1', null),
    entry('b1', 'H'),
    entry('a2', 'G'),
    entry('x2', null),
    entry('a3', 'G'),
  ];
  const drawn = stackRows(rows, ['G'], null);
  assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'a3<', 'x1', 'b1', 'x2']);
});

test('stackRows: opened naming another group leaves the stack closed', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('b2', 'H')];
  const drawn = stackRows(rows, ['H'], null);
  assert.deepEqual(shape(drawn), ['a1^', 'b1^', 'b2<']);
  assert.equal(drawn[0]?.stack?.open, false);
  assert.equal(drawn[1]?.stack?.open, true);
});

test('stackRows: opened naming a group of one row, or one no row has, changes nothing', () => {
  const rows = [entry('a1', 'G'), entry('x', null)];
  const drawn = stackRows(rows, ['G', 'NOPE'], null);
  assert.deepEqual(drawn, [
    { entry: rows[0], stack: null },
    { entry: rows[1], stack: null },
  ]);
});

test('stackRows: a selected member opens its stack, whatever opened says', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G'), entry('b1', 'H')];
  for (const selected of ['a2', 'a3']) {
    for (const opened of [NONE, ['H'], ['G']]) {
      const why = `${selected}, opened ${opened.join()}`;
      const drawn = stackRows(rows, opened, selected);
      assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'a3<', 'b1'], why);
      assert.ok(
        drawn.slice(0, 3).every(({ stack }) => stack?.open === true),
        why,
      );
    }
  }
});

test('stackRows: a selected head leaves its stack as opened says', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G')];
  const closed = stackRows(rows, NONE, 'a1');
  assert.deepEqual(shape(closed), ['a1^']);
  assert.equal(closed[0]?.stack?.open, false);
  const open = stackRows(rows, ['G'], 'a1');
  assert.deepEqual(shape(open), ['a1^', 'a2<']);
  assert.equal(open[0]?.stack?.open, true);
});

test('stackRows: a selected row of another group or of none opens no stack', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('x', null)];
  assert.deepEqual(shape(stackRows(rows, NONE, 'b1')), ['a1^', 'b1', 'x']);
  assert.deepEqual(shape(stackRows(rows, NONE, 'x')), ['a1^', 'b1', 'x']);
  assert.deepEqual(shape(stackRows(rows, NONE, 'not-in-this-section')), ['a1^', 'b1', 'x']);
});

test('stackRows: the selection opens only the stack it is in', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('b2', 'H')];
  const drawn = stackRows(rows, NONE, 'b2');
  assert.deepEqual(shape(drawn), ['a1^', 'b1^', 'b2<']);
  assert.equal(drawn[0]?.stack?.open, false);
});

// --- held rows -----------------------------------------------------------------------------------

test('stackRows: a held row is drawn on its own at its place, never in the stack, not counted', () => {
  // `held`: a terminal of the window holds the row, or it needs you (stage B's attention).
  const rows = [entry('a1', 'G'), entry('h', 'G', true), entry('a2', 'G'), entry('a3', 'G')];
  const closed = stackRows(rows, NONE, null);
  assert.deepEqual(shape(closed), ['a1^', 'h']);
  assert.equal(closed[0]?.stack?.size, 3);
  assert.equal(closed[1]?.stack, null);
  const open = stackRows(rows, ['G'], null);
  assert.deepEqual(shape(open), ['a1^', 'a2<', 'a3<', 'h']);
  assert.equal(open[3]?.stack, null);
});

test('stackRows: with one row of the group left beside a held one, no stack', () => {
  const rows = [entry('h', 'G', true), entry('a1', 'G')];
  const drawn = stackRows(rows, ['G'], 'a1');
  assert.deepEqual(drawn, [
    { entry: rows[0], stack: null },
    { entry: rows[1], stack: null },
  ]);
});

test('stackRows: a held newest row is no head: the first row that is not held is', () => {
  const rows = [entry('h', 'G', true), entry('a1', 'G'), entry('a2', 'G')];
  const drawn = stackRows(rows, NONE, null);
  assert.deepEqual(shape(drawn), ['h', 'a1^']);
  assert.equal(drawn[1]?.stack?.head, 'a1');
  assert.equal(drawn[1]?.stack?.size, 2);
});

test('stackRows: several held rows of one group are all drawn on their own', () => {
  const rows = [entry('h1', 'G', true), entry('h2', 'G', true), entry('h3', 'G', true)];
  const drawn = stackRows(rows, ['G'], 'h2');
  assert.deepEqual(shape(drawn), ['h1', 'h2', 'h3']);
});

test('stackRows: a selected held row opens no stack', () => {
  const rows = [entry('a1', 'G'), entry('h', 'G', true), entry('a2', 'G')];
  const drawn = stackRows(rows, NONE, 'h');
  assert.deepEqual(shape(drawn), ['a1^', 'h']);
  assert.equal(drawn[0]?.stack?.open, false);
});

// --- the order of the section --------------------------------------------------------------------

/** A small deterministic generator (mulberry32), so that a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("stackRows: the section's order is kept, a member right after its head; nothing twice", () => {
  const groups = ['A', 'B', 'C', 'D', null];
  const seen = { closed: 0, members: 0, held: 0, bySelection: 0 };
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = random(seed);
    const count = Math.floor(next() * 14);
    const rows = Array.from({ length: count }, (_, i) =>
      entry(`s${i}`, groups[Math.floor(next() * groups.length)] ?? null, next() < 0.2),
    );
    const opened = groups.filter((group): group is string => group !== null && next() < 0.4);
    const selected = count > 0 && next() < 0.5 ? `s${Math.floor(next() * count)}` : null;
    const drawn = stackRows(rows, opened, selected);
    const at = (id: string): number => rows.findIndex((row) => row.id === id);
    const why = `seed ${seed}`;

    // A view without `opened`: no stacks at all.
    assert.deepEqual(
      stackRows(rows, undefined, selected),
      rows.map((row) => ({ entry: row, stack: null })),
      why,
    );

    // Nothing is drawn twice.
    const ids = drawn.map(({ entry: row }) => row.id);
    assert.equal(new Set(ids).size, ids.length, why);

    // The rows that are not members are in the section's order.
    const placed = drawn
      .filter(({ stack }) => stack?.role !== 'member')
      .map(({ entry: r }) => r.id);
    assert.deepEqual(
      placed,
      [...placed].sort((a, b) => at(a) - at(b)),
      why,
    );

    // Every row in no stack, every held row and every head is drawn; a member only when open.
    for (const [index, row] of rows.entries()) {
      const group = row.held ? null : row.group;
      const kin = rows.filter((other) => !other.held && group !== null && other.group === group);
      const isMember = kin.length >= 2 && kin[0] !== row;
      const open =
        group !== null && (opened.includes(group) || kin.slice(1).some((m) => m.id === selected));
      assert.equal(ids.includes(row.id), !isMember || open, `${why}, row ${index}`);
    }

    // An open stack's members follow its head at once, in the section's order.
    for (const [index, { entry: row, stack }] of drawn.entries()) {
      if (stack?.role !== 'head' || !stack.open) {
        continue;
      }
      const members = drawn.slice(index + 1, index + stack.size).map(({ entry: r, stack: s }) => {
        assert.equal(s?.role, 'member', why);
        assert.equal(s?.head, row.id, why);
        return at(r.id);
      });
      assert.equal(members.length, stack.size - 1, why);
      assert.deepEqual(
        members,
        [...members].sort((a, b) => a - b),
        why,
      );
      assert.ok(
        members.every((m) => m > at(row.id)),
        why,
      );
    }
    seen.closed += drawn.filter(({ stack }) => stack?.role === 'head' && !stack.open).length;
    seen.members += drawn.filter(({ stack }) => stack?.role === 'member').length;
    seen.held += drawn.filter(({ entry: row }) => row.held && row.group !== null).length;
    seen.bySelection += drawn.some(
      ({ entry: row, stack }) =>
        stack?.role === 'member' && row.id === selected && !opened.includes(stack.group),
    )
      ? 1
      : 0;
  }
  // The generated sections hold every kind of row the rule tells apart.
  assert.ok(seen.closed > 0 && seen.members > 0 && seen.held > 0 && seen.bySelection > 0);
});
