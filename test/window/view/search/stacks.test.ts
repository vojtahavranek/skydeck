import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stackRows } from '../../../../src/window/view/search/stacks.ts';
import type { ClosedBlock, SectionPayload, StackPayload } from '../../../../src/window/protocol.ts';
import type { StackEntry } from '../../../../src/window/view/search/stacks.ts';

/** A plain entry, with one field of its own to show that `stackRows` hands back the caller's objects. */
interface Entry extends StackEntry {
  readonly own: string;
}

function entry(id: string, group: string | null, needsYou = false, unreported = false): Entry {
  return { id, group, needsYou, unreported, own: `own-${id}` };
}

type Section = SectionPayload['name'];
const SECTIONS: readonly Section[] = ['open', 'week', 'earlier'];

/** `view.closed` of a page that closed nothing. */
const NONE: readonly ClosedBlock[] = [];

function shut(section: Section, ...groups: string[]): ClosedBlock[] {
  return groups.map((group) => ({ section, group }));
}

/** The drawn rows as `id` (in no block), `id^` (a head) or `id<` (a member), in order. */
function shape(drawn: readonly { entry: Entry; stack: StackPayload | null }[]): string[] {
  return drawn.map(({ entry: row, stack }) =>
    stack === null ? row.id : `${row.id}${stack.role === 'head' ? '^' : '<'}`,
  );
}

// --- G1: what forms a block, in every section ----------------------------------------------------

test('stackRows: two rows of one group form a block, OPEN by default: the head, then the member (G1, G4)', () => {
  const rows = [entry('a1', 'ORB-2107'), entry('a2', 'ORB-2107')];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, NONE, null);
    assert.deepEqual(shape(drawn), ['a1^', 'a2<'], section);
    const head: StackPayload = {
      group: 'ORB-2107',
      size: 2,
      open: true,
      role: 'head',
      head: 'a1',
      hiddenNeedYou: 0,
    };
    assert.deepEqual(
      drawn.map(({ stack }) => stack),
      [head, { ...head, role: 'member' }],
      section,
    );
  }
});

test('stackRows: Open forms blocks as the other sections do (G1: in every section)', () => {
  const rows = [entry('r1', 'test'), entry('r2', 'test'), entry('r3', 'test'), entry('x', null)];
  assert.deepEqual(shape(stackRows(rows, 'open', NONE, null)), ['r1^', 'r2<', 'r3<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'open', shut('open', 'test'), null)), ['r1^', 'x']);
});

test('stackRows: the head is the first of its group in the section, the size all its rows', () => {
  const rows = [entry('x', null), entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G')];
  const drawn = stackRows(rows, 'week', NONE, null);
  assert.deepEqual(shape(drawn), ['x', 'a1^', 'a2<', 'a3<']);
  assert.ok(drawn.slice(1).every(({ stack }) => stack?.head === 'a1' && stack.size === 3));
});

test('stackRows: one row of a group is no block, drawn as it is', () => {
  const rows = [entry('a1', 'G'), entry('b1', 'H')];
  for (const closed of [NONE, shut('week', 'G', 'H')]) {
    assert.deepEqual(
      stackRows(rows, 'week', closed, null),
      rows.map((row) => ({ entry: row, stack: null })),
    );
  }
});

test('stackRows: rows without a group never form a block, however many', () => {
  const rows = [entry('x1', null), entry('x2', null), entry('x3', null)];
  assert.deepEqual(
    stackRows(rows, 'open', NONE, 'x2'),
    rows.map((row) => ({ entry: row, stack: null })),
  );
});

test('stackRows: a group is text, whatever it spells; rows and closed entries name it exactly', () => {
  // Names an object's prototype has: a group is no property name.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const rows = [entry('a1', name), entry('x', null), entry('a2', name)];
    assert.deepEqual(shape(stackRows(rows, 'week', NONE, null)), ['a1^', 'a2<', 'x'], name);
    assert.deepEqual(shape(stackRows(rows, 'week', shut('week', name), null)), ['a1^', 'x'], name);
    assert.deepEqual(
      shape(stackRows([entry('a1', name), entry('b1', 'B')], 'week', NONE, 'a1')),
      ['a1', 'b1'],
      name,
    );
  }
  // Not folded, not trimmed, not normalised: between two rows, and between a row and `closed`.
  const twins: [string, string][] = [
    ['ORB-1', 'orb-1'],
    ['ORB-1', 'ORB-1 '],
    ['caf\u00e9', 'cafe\u0301'], // NFC and NFD
  ];
  for (const [one, other] of twins) {
    const why = `${one} / ${other}`;
    const apart = stackRows([entry('a1', one), entry('a2', other)], 'week', NONE, null);
    assert.deepEqual(shape(apart), ['a1', 'a2'], why);
    const same = [entry('a1', one), entry('a2', one)];
    assert.deepEqual(
      shape(stackRows(same, 'week', shut('week', other), null)),
      ['a1^', 'a2<'],
      why,
    );
    assert.deepEqual(shape(stackRows(same, 'week', shut('week', one), null)), ['a1^'], why);
  }
});

// --- G2: no row is left out ----------------------------------------------------------------------

test('stackRows: a row that needs you is a member like any other, and a head like any other (G2)', () => {
  const rows = [entry('n1', 'G', true), entry('a1', 'G'), entry('n2', 'G', true), entry('x', null)];
  assert.deepEqual(shape(stackRows(rows, 'open', NONE, null)), ['n1^', 'a1<', 'n2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'open', shut('open', 'G'), null)), ['n1^', 'x']);
  // Every row of the group needs you: still one block.
  const all = [entry('n1', 'G', true), entry('n2', 'G', true)];
  assert.deepEqual(shape(stackRows(all, 'week', NONE, null)), ['n1^', 'n2<']);
});

// --- G3: the order -------------------------------------------------------------------------------

test("stackRows: a block sits at its first member's place, its members right after it in the section's order (G3)", () => {
  const rows = [
    entry('a1', 'G'),
    entry('x1', null),
    entry('b1', 'H'),
    entry('a2', 'G'),
    entry('x2', null),
    entry('a3', 'G'),
  ];
  assert.deepEqual(shape(stackRows(rows, 'open', NONE, null)), [
    'a1^',
    'a2<',
    'a3<',
    'x1',
    'b1',
    'x2',
  ]);
});

test('stackRows: three groups interleaved give three blocks at their first places, the others at theirs', () => {
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
  assert.deepEqual(shape(stackRows(rows, 'week', NONE, null)), [
    'a1^',
    'a2<',
    'x1',
    'b1^',
    'b2<',
    'c1^',
    'c2<',
    'c3<',
    'y1',
    'x2',
  ]);
  const closed = stackRows(rows, 'week', shut('week', 'A', 'B', 'C'), null);
  assert.deepEqual(shape(closed), ['a1^', 'x1', 'b1^', 'c1^', 'y1', 'x2']);
  assert.deepEqual(
    closed.map(({ stack }) => (stack === null ? null : [stack.group, stack.size, stack.open])),
    [['A', 2, false], null, ['B', 2, false], ['C', 3, false], null, null],
  );
});

// --- G4: closed entries, per section and group ---------------------------------------------------

test('stackRows: a closed entry names its section and its group: only that block of that section is closed (G4)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('b2', 'H')];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, shut(section, 'G'), null);
    assert.deepEqual(shape(drawn), ['a1^', 'b1^', 'b2<'], section);
    assert.equal(drawn[0]?.stack?.open, false, section);
    assert.equal(drawn[1]?.stack?.open, true, section);
    // The same group closed in another section closes nothing here.
    for (const other of SECTIONS.filter((name) => name !== section)) {
      const why = `${section}, closed in ${other}`;
      assert.deepEqual(
        shape(stackRows(rows, section, shut(other, 'G', 'H'), null)),
        ['a1^', 'a2<', 'b1^', 'b2<'],
        why,
      );
    }
  }
});

test('stackRows: a closed block draws its head only, with its size; its members are left out', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G'), entry('x', null)];
  const drawn = stackRows(rows, 'earlier', shut('earlier', 'G'), null);
  assert.deepEqual(shape(drawn), ['a1^', 'x']);
  assert.deepEqual(drawn[0]?.stack, {
    group: 'G',
    size: 3,
    open: false,
    role: 'head',
    head: 'a1',
    hiddenNeedYou: 0,
  });
});

test('stackRows: a view without `closed`, and an empty one, close nothing: every block open', () => {
  const rows = [entry('a1', 'G'), entry('x', null), entry('a2', 'G'), entry('b1', 'H')];
  for (const closed of [undefined, NONE]) {
    for (const section of SECTIONS) {
      const drawn = stackRows(rows, section, closed, null);
      assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'x', 'b1'], `${section}, ${String(closed)}`);
      assert.ok(drawn.every(({ stack }) => stack === null || stack.open));
    }
  }
});

test('stackRows: a repeated closed entry is as once; one naming a group of one row, or none, changes nothing', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H')];
  assert.deepEqual(shape(stackRows(rows, 'week', shut('week', 'G', 'G'), null)), ['a1^', 'b1']);
  assert.deepEqual(
    stackRows([entry('b1', 'H'), entry('x', null)], 'week', shut('week', 'H', 'NOPE'), null),
    [
      {
        entry: { id: 'b1', group: 'H', needsYou: false, unreported: false, own: 'own-b1' },
        stack: null,
      },
      {
        entry: { id: 'x', group: null, needsYou: false, unreported: false, own: 'own-x' },
        stack: null,
      },
    ],
  );
});

// --- G5: a closed block never hides that a session needs you, or the selection -------------------

test('stackRows: a closed block counts its hidden members that need you; the head is not counted (G5)', () => {
  const rows = [
    entry('h', 'G', true),
    entry('m1', 'G', true),
    entry('m2', 'G'),
    entry('m3', 'G', true),
    entry('x', null, true),
  ];
  const closed = stackRows(rows, 'open', shut('open', 'G'), null);
  assert.deepEqual(shape(closed), ['h^', 'x']);
  assert.equal(closed[0]?.stack?.hiddenNeedYou, 2);
  // Open: nothing is hidden, so nothing is counted, on the head or a member.
  const open = stackRows(rows, 'open', NONE, null);
  assert.ok(open.every(({ stack }) => (stack?.hiddenNeedYou ?? 0) === 0));
  // Only the head needs you: closed, its line counts none (its own mark is on its row).
  const headOnly = [entry('h', 'G', true), entry('m', 'G')];
  assert.equal(stackRows(headOnly, 'week', shut('week', 'G'), null)[0]?.stack?.hiddenNeedYou, 0);
});

test('stackRows: a selected member opens its closed block, whatever closed says (G5)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G', true), entry('a3', 'G'), entry('b1', 'H')];
  for (const selected of ['a2', 'a3']) {
    for (const closed of [NONE, shut('week', 'H'), shut('week', 'G')]) {
      const why = `${selected}, closed ${closed.map((one) => one.group).join()}`;
      const drawn = stackRows(rows, 'week', closed, selected);
      assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'a3<', 'b1'], why);
      assert.ok(
        drawn.slice(0, 3).every(({ stack }) => stack?.open === true && stack.hiddenNeedYou === 0),
        why,
      );
    }
  }
});

test('stackRows: a selected head leaves its block as closed says', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G', true)];
  const closed = stackRows(rows, 'week', shut('week', 'G'), 'a1');
  assert.deepEqual(shape(closed), ['a1^']);
  assert.equal(closed[0]?.stack?.open, false);
  assert.equal(closed[0]?.stack?.hiddenNeedYou, 1);
  assert.deepEqual(shape(stackRows(rows, 'week', NONE, 'a1')), ['a1^', 'a2<']);
});

test('stackRows: the selection opens only the block it is in; a row of another group or none opens nothing', () => {
  const rows = [
    entry('a1', 'G'),
    entry('a2', 'G'),
    entry('b1', 'H'),
    entry('b2', 'H'),
    entry('x', null),
  ];
  const closed = shut('week', 'G', 'H');
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'b2')), ['a1^', 'b1^', 'b2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'x')), ['a1^', 'b1^', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'not-in-this-section')), [
    'a1^',
    'b1^',
    'x',
  ]);
});

test('stackRows: a member whose terminal has not reported a session opens its closed block, whatever closed says (ruled 2026-11-16, review 2 of F3)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('u', 'G', false, true), entry('x', null)];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, shut(section, 'G'), null);
    assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'u<', 'x'], section);
    assert.ok(
      drawn.slice(0, 3).every(({ stack }) => stack?.open === true && stack.hiddenNeedYou === 0),
    );
  }
  // The head unreported opens nothing: it is drawn anyway.
  const head = [entry('u', 'G', false, true), entry('a1', 'G')];
  assert.deepEqual(shape(stackRows(head, 'week', shut('week', 'G'), null)), ['u^']);
  // Another block's unreported member opens only its own block.
  const two = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('u', 'H', false, true)];
  assert.deepEqual(shape(stackRows(two, 'open', shut('open', 'G', 'H'), null)), [
    'a1^',
    'b1^',
    'u<',
  ]);
});

// --- the input -----------------------------------------------------------------------------------

test('stackRows: nothing of the input is changed in place', () => {
  const rows = Object.freeze(
    [entry('a1', 'G'), entry('h', 'G', true), entry('a2', 'G'), entry('x', null)].map((row) =>
      Object.freeze(row),
    ),
  );
  // Two entries out of order: a sort in place would throw, or show.
  const closed = Object.freeze([
    Object.freeze({ section: 'week' as const, group: 'H' }),
    Object.freeze({ section: 'open' as const, group: 'G' }),
    Object.freeze({ section: 'week' as const, group: 'G' }),
  ]);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'a2')), ['a1^', 'h<', 'a2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, null)), ['a1^', 'x']);
  assert.deepEqual(closed, [
    { section: 'week', group: 'H' },
    { section: 'open', group: 'G' },
    { section: 'week', group: 'G' },
  ]);
});

test('stackRows: no rows, nothing to draw', () => {
  assert.deepEqual(stackRows([], 'open', shut('open', 'G'), 'a1'), []);
});

test("stackRows: the entries drawn are the caller's own objects", () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('x', null)];
  const drawn = stackRows(rows, 'week', undefined, null);
  assert.equal(drawn.length, rows.length);
  rows.forEach((row, index) => assert.equal(drawn[index]?.entry, row, row.id));
  assert.equal(drawn[1]?.entry.own, 'own-a2');
});

// --- the order of the section, over many sections ------------------------------------------------

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

test("stackRows: the section's order is kept, a member right after its head; nothing twice, nothing lost unseen", () => {
  const groups = ['A', 'B', 'C', 'D', null];
  const seen = {
    closed: 0,
    members: 0,
    needing: 0,
    bySelection: 0,
    byUnreported: 0,
    otherSection: 0,
  };
  for (let seed = 1; seed <= 400; seed += 1) {
    const next = random(seed);
    const count = Math.floor(next() * 14);
    const rows = Array.from({ length: count }, (_, i) =>
      entry(
        `s${i}`,
        groups[Math.floor(next() * groups.length)] ?? null,
        next() < 0.3,
        next() < 0.1,
      ),
    );
    const section = SECTIONS[Math.floor(next() * SECTIONS.length)] ?? 'open';
    const closed: ClosedBlock[] = [];
    for (const group of groups) {
      if (group === null) continue;
      if (next() < 0.5) closed.push({ section, group });
      if (next() < 0.3) closed.push({ section: section === 'open' ? 'week' : 'open', group });
    }
    const selected = count > 0 && next() < 0.5 ? `s${Math.floor(next() * count)}` : null;
    const drawn = stackRows(rows, section, closed, selected);
    const at = (id: string): number => rows.findIndex((row) => row.id === id);
    const why = `seed ${seed}`;
    const closedHere = (group: string): boolean =>
      closed.some((one) => one.section === section && one.group === group);

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

    // Every row in no block and every head is drawn; a member only while its block is open, which
    // it is unless the section's closed entries name its group and no member of it is selected.
    for (const [index, row] of rows.entries()) {
      const kin = rows.filter((other) => row.group !== null && other.group === row.group);
      const isMember = kin.length >= 2 && kin[0] !== row;
      const open =
        row.group === null ||
        !closedHere(row.group) ||
        kin.slice(1).some((member) => member.id === selected || member.unreported);
      assert.equal(ids.includes(row.id), !isMember || open, `${why}, row ${index}`);
    }

    // A block's members follow its head at once, in the section's order; a closed one counts the
    // hidden members that need you, and the hidden and the drawn add up to every row.
    let hidden = 0;
    for (const [index, { entry: row, stack }] of drawn.entries()) {
      if (stack?.role !== 'head') {
        continue;
      }
      const kin = rows.filter((other) => other.group === stack.group);
      assert.equal(stack.size, kin.length, why);
      if (!stack.open) {
        hidden += stack.size - 1;
        assert.equal(stack.hiddenNeedYou, kin.slice(1).filter((m) => m.needsYou).length, why);
        continue;
      }
      assert.equal(stack.hiddenNeedYou, 0, why);
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
    assert.equal(drawn.length + hidden, rows.length, why);

    seen.closed += drawn.filter(({ stack }) => stack?.role === 'head' && !stack.open).length;
    seen.members += drawn.filter(({ stack }) => stack?.role === 'member').length;
    seen.needing += drawn.filter(({ stack }) => (stack?.hiddenNeedYou ?? 0) > 0).length;
    seen.bySelection += drawn.some(
      ({ entry: row, stack }) =>
        stack?.role === 'member' && row.id === selected && closedHere(stack.group),
    )
      ? 1
      : 0;
    seen.byUnreported += drawn.some(
      ({ entry: row, stack }) =>
        stack?.role === 'member' &&
        row.unreported &&
        row.id !== selected &&
        closedHere(stack.group),
    )
      ? 1
      : 0;
    seen.otherSection += closed.some((one) => one.section !== section) ? 1 : 0;
  }
  // The generated sections hold every kind of row the rule tells apart.
  assert.ok(
    Object.values(seen).every((n) => n > 0),
    JSON.stringify(seen),
  );
});
