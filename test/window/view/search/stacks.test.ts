import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stackRows } from '../../../../src/window/view/search/stacks.ts';
import type {
  ClosedBlock,
  ClosedStackPayload,
  SectionPayload,
  StackPayload,
} from '../../../../src/window/protocol.ts';
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

type Drawn = ReturnType<typeof stackRows<Entry>>;

/**
 * What the section draws, in order: a row as `id` (in no block), `id^` (an open block's first row)
 * or `id<` (its other rows), a closed block's caption as `[group]` at its place (`at`).
 */
function shape(drawn: Drawn): string[] {
  const lines: string[] = [];
  const captions = (at: number) => {
    for (const caption of drawn.closed.filter((one) => one.at === at)) {
      lines.push(`[${caption.group}]`);
    }
  };
  drawn.rows.forEach(({ entry: row, stack }, at) => {
    captions(at);
    lines.push(stack === null ? row.id : `${row.id}${stack.role === 'head' ? '^' : '<'}`);
  });
  captions(drawn.rows.length);
  return lines;
}

// --- G1: what forms a block, in every section ----------------------------------------------------

test('stackRows: two rows of one group form a block, OPEN by default: the first, then the other (G1, G4)', () => {
  const rows = [entry('a1', 'ORB-2107'), entry('a2', 'ORB-2107')];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, NONE, null);
    assert.deepEqual(shape(drawn), ['a1^', 'a2<'], section);
    const head: StackPayload = { group: 'ORB-2107', size: 2, role: 'head', head: 'a1' };
    assert.deepEqual(
      drawn.rows.map(({ stack }) => stack),
      [head, { ...head, role: 'member' }],
      section,
    );
    assert.deepEqual(drawn.closed, [], section);
  }
});

test('stackRows: Open forms blocks as the other sections do (G1: in every section)', () => {
  const rows = [entry('r1', 'test'), entry('r2', 'test'), entry('r3', 'test'), entry('x', null)];
  assert.deepEqual(shape(stackRows(rows, 'open', NONE, null)), ['r1^', 'r2<', 'r3<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'open', shut('open', 'test'), null)), ['[test]', 'x']);
});

test('stackRows: the first row is the first of its group in the section, the size all its rows', () => {
  const rows = [entry('x', null), entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G')];
  const drawn = stackRows(rows, 'week', NONE, null);
  assert.deepEqual(shape(drawn), ['x', 'a1^', 'a2<', 'a3<']);
  assert.ok(drawn.rows.slice(1).every(({ stack }) => stack?.head === 'a1' && stack.size === 3));
});

test('stackRows: one row of a group is no block, drawn as it is', () => {
  const rows = [entry('a1', 'G'), entry('b1', 'H')];
  for (const closed of [NONE, shut('week', 'G', 'H')]) {
    assert.deepEqual(stackRows(rows, 'week', closed, null), {
      rows: rows.map((row) => ({ entry: row, stack: null })),
      closed: [],
    });
  }
});

test('stackRows: rows without a group never form a block, however many', () => {
  const rows = [entry('x1', null), entry('x2', null), entry('x3', null)];
  assert.deepEqual(stackRows(rows, 'open', NONE, 'x2'), {
    rows: rows.map((row) => ({ entry: row, stack: null })),
    closed: [],
  });
});

test('stackRows: a group is text, whatever it spells; rows and closed entries name it exactly', () => {
  // Names an object's prototype has: a group is no property name.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const rows = [entry('a1', name), entry('x', null), entry('a2', name)];
    assert.deepEqual(shape(stackRows(rows, 'week', NONE, null)), ['a1^', 'a2<', 'x'], name);
    assert.deepEqual(
      shape(stackRows(rows, 'week', shut('week', name), null)),
      [`[${name}]`, 'x'],
      name,
    );
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
    assert.deepEqual(shape(stackRows(same, 'week', shut('week', one), null)), [`[${one}]`], why);
  }
});

// --- G2: no row is left out ----------------------------------------------------------------------

test('stackRows: a row that needs you is in its block like any other, the first one too (G2)', () => {
  const rows = [entry('n1', 'G', true), entry('a1', 'G'), entry('n2', 'G', true), entry('x', null)];
  assert.deepEqual(shape(stackRows(rows, 'open', NONE, null)), ['n1^', 'a1<', 'n2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'open', shut('open', 'G'), null)), ['[G]', 'x']);
  // Every row of the group needs you: still one block.
  const all = [entry('n1', 'G', true), entry('n2', 'G', true)];
  assert.deepEqual(shape(stackRows(all, 'week', NONE, null)), ['n1^', 'n2<']);
});

// --- G3: the order -------------------------------------------------------------------------------

test("stackRows: a block sits at its first row's place, its other rows right after it in the section's order (G3)", () => {
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
  assert.deepEqual(shape(closed), ['[A]', 'x1', '[B]', '[C]', 'y1', 'x2']);
  assert.deepEqual(closed.closed, [
    { group: 'A', size: 2, needYou: 0, head: 'a1', at: 0 },
    { group: 'B', size: 2, needYou: 0, head: 'b1', at: 1 },
    { group: 'C', size: 3, needYou: 0, head: 'c1', at: 1 },
  ]);
});

// --- G4: closed entries, per section and group ---------------------------------------------------

test('stackRows: a closed entry names its section and its group: only that block of that section is closed (G4)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('b2', 'H')];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, shut(section, 'G'), null);
    assert.deepEqual(shape(drawn), ['[G]', 'b1^', 'b2<'], section);
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

test('stackRows: a closed block draws NO row, its first neither (F9): its caption alone, with its size, its first row and its place', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('a3', 'G'), entry('x', null)];
  const drawn = stackRows(rows, 'earlier', shut('earlier', 'G'), null);
  assert.deepEqual(shape(drawn), ['[G]', 'x']);
  assert.deepEqual(
    drawn.rows.map(({ entry: row }) => row.id),
    ['x'],
  );
  const caption: ClosedStackPayload = { group: 'G', size: 3, needYou: 0, head: 'a1', at: 0 };
  assert.deepEqual(drawn.closed, [caption]);
  // A closed block after every drawn row has its place past the last.
  const last = stackRows(
    [entry('x', null), entry('a1', 'G'), entry('a2', 'G')],
    'week',
    shut('week', 'G'),
    null,
  );
  assert.deepEqual(shape(last), ['x', '[G]']);
  assert.equal(last.closed[0]?.at, 1);
  // A section of closed blocks only.
  const only = stackRows(
    [entry('a1', 'G'), entry('b1', 'H'), entry('a2', 'G'), entry('b2', 'H')],
    'open',
    shut('open', 'H', 'G'),
    null,
  );
  assert.deepEqual(shape(only), ['[G]', '[H]']);
  assert.deepEqual(
    only.closed.map((one) => one.at),
    [0, 0],
  );
});

test('stackRows: a view without `closed`, and an empty one, close nothing: every block open', () => {
  const rows = [entry('a1', 'G'), entry('x', null), entry('a2', 'G'), entry('b1', 'H')];
  for (const closed of [undefined, NONE]) {
    for (const section of SECTIONS) {
      const drawn = stackRows(rows, section, closed, null);
      assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'x', 'b1'], `${section}, ${String(closed)}`);
      assert.deepEqual(drawn.closed, []);
    }
  }
});

test('stackRows: a repeated closed entry is as once; one naming a group of one row, or none, changes nothing', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H')];
  const twice = stackRows(rows, 'week', shut('week', 'G', 'G'), null);
  assert.deepEqual(shape(twice), ['[G]', 'b1']);
  assert.equal(twice.closed.length, 1);
  assert.deepEqual(
    stackRows([entry('b1', 'H'), entry('x', null)], 'week', shut('week', 'H', 'NOPE'), null),
    {
      rows: [
        {
          entry: { id: 'b1', group: 'H', needsYou: false, unreported: false, own: 'own-b1' },
          stack: null,
        },
        {
          entry: { id: 'x', group: null, needsYou: false, unreported: false, own: 'own-x' },
          stack: null,
        },
      ],
      closed: [],
    },
  );
});

// --- G5: a closed block never hides that a session needs you, or the selection -------------------

test('stackRows: a closed caption counts EVERY row of its block that needs you, the first too: all are hidden (G5, F9)', () => {
  const rows = [
    entry('h', 'G', true),
    entry('m1', 'G', true),
    entry('m2', 'G'),
    entry('m3', 'G', true),
    entry('x', null, true),
  ];
  const closed = stackRows(rows, 'open', shut('open', 'G'), null);
  assert.deepEqual(shape(closed), ['[G]', 'x']);
  assert.equal(closed.closed[0]?.needYou, 3);
  // Only the first row needs you: the caption counts it (its row is not drawn).
  const headOnly = [entry('h', 'G', true), entry('m', 'G')];
  assert.equal(stackRows(headOnly, 'week', shut('week', 'G'), null).closed[0]?.needYou, 1);
  // None needs you: 0.
  const none = [entry('h', 'G'), entry('m', 'G')];
  assert.equal(stackRows(none, 'week', shut('week', 'G'), null).closed[0]?.needYou, 0);
});

test('stackRows: a selected row opens its closed block, whatever closed says — ANY of its rows, the first too (G5, F9 K5)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G', true), entry('a3', 'G'), entry('b1', 'H')];
  for (const selected of ['a1', 'a2', 'a3']) {
    for (const closed of [NONE, shut('week', 'H'), shut('week', 'G')]) {
      const why = `${selected}, closed ${closed.map((one) => one.group).join()}`;
      const drawn = stackRows(rows, 'week', closed, selected);
      assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'a3<', 'b1'], why);
      assert.deepEqual(drawn.closed, [], why);
    }
  }
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
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'b2')), ['[G]', 'b1^', 'b2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'b1')), ['[G]', 'b1^', 'b2<', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'x')), ['[G]', '[H]', 'x']);
  assert.deepEqual(shape(stackRows(rows, 'week', closed, 'not-in-this-section')), [
    '[G]',
    '[H]',
    'x',
  ]);
});

test('stackRows: a row whose terminal has not reported a session opens its closed block, whatever closed says — the first row too (ruled 2026-11-16, (c2); F9)', () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('u', 'G', false, true), entry('x', null)];
  for (const section of SECTIONS) {
    const drawn = stackRows(rows, section, shut(section, 'G'), null);
    assert.deepEqual(shape(drawn), ['a1^', 'a2<', 'u<', 'x'], section);
    assert.deepEqual(drawn.closed, [], section);
  }
  // The first row unreported: it would be hidden, so it opens its block too (F9).
  const head = [entry('u', 'G', false, true), entry('a1', 'G')];
  assert.deepEqual(shape(stackRows(head, 'week', shut('week', 'G'), null)), ['u^', 'a1<']);
  // Another block's unreported row opens only its own block.
  const two = [entry('a1', 'G'), entry('a2', 'G'), entry('b1', 'H'), entry('u', 'H', false, true)];
  assert.deepEqual(shape(stackRows(two, 'open', shut('open', 'G', 'H'), null)), [
    '[G]',
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
  assert.deepEqual(shape(stackRows(rows, 'week', closed, null)), ['[G]', 'x']);
  assert.deepEqual(closed, [
    { section: 'week', group: 'H' },
    { section: 'open', group: 'G' },
    { section: 'week', group: 'G' },
  ]);
});

test('stackRows: no rows, nothing to draw', () => {
  assert.deepEqual(stackRows([], 'open', shut('open', 'G'), 'a1'), { rows: [], closed: [] });
});

test("stackRows: the entries drawn are the caller's own objects", () => {
  const rows = [entry('a1', 'G'), entry('a2', 'G'), entry('x', null)];
  const drawn = stackRows(rows, 'week', undefined, null);
  assert.equal(drawn.rows.length, rows.length);
  rows.forEach((row, index) => assert.equal(drawn.rows[index]?.entry, row, row.id));
  assert.equal(drawn.rows[1]?.entry.own, 'own-a2');
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

test("stackRows: the section's order is kept, a block's rows together; nothing twice, nothing lost unseen", () => {
  const groups = ['A', 'B', 'C', 'D', null];
  const seen = {
    closed: 0,
    members: 0,
    needing: 0,
    bySelection: 0,
    byFirstSelected: 0,
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
    const kinOf = (group: string | null) =>
      rows.filter((other) => group !== null && other.group === group);

    // Nothing is drawn twice; a closed block's group has one caption.
    const ids = drawn.rows.map(({ entry: row }) => row.id);
    assert.equal(new Set(ids).size, ids.length, why);
    const captioned = drawn.closed.map((one) => one.group);
    assert.equal(new Set(captioned).size, captioned.length, why);

    // Every row in no block is drawn; a block's rows only while it is open, which it is unless the
    // section's closed entries name its group and none of its rows is selected or unreported.
    for (const [index, row] of rows.entries()) {
      const kin = kinOf(row.group);
      const inBlock = kin.length >= 2;
      const open =
        row.group === null ||
        !closedHere(row.group) ||
        kin.some((one) => one.id === selected || one.unreported);
      assert.equal(ids.includes(row.id), !inBlock || open, `${why}, row ${index}`);
      if (inBlock && !open) {
        assert.ok(captioned.includes(row.group ?? ''), `${why}, caption of row ${index}`);
      }
    }

    // The section's order: the rows that are not a block's later rows (each in no block, or an open
    // block's first) and the captions (at their first row's place) come in the section's order, and
    // an open block's other rows follow its first at once (below).
    const firsts = drawn.rows
      .filter(({ stack }) => stack?.role !== 'member')
      .map(({ entry: r }) => at(r.id));
    assert.deepEqual(
      firsts,
      [...firsts].sort((a, b) => a - b),
      why,
    );
    const captionsInOrder = drawn.closed.map((one) => at(one.head));
    assert.deepEqual(
      captionsInOrder,
      [...captionsInOrder].sort((a, b) => a - b),
      why,
    );

    let hidden = 0;
    for (const caption of drawn.closed) {
      const kin = kinOf(caption.group);
      assert.equal(caption.size, kin.length, why);
      assert.equal(caption.head, kin[0]?.id, why);
      assert.equal(caption.needYou, kin.filter((one) => one.needsYou).length, why);
      // Its place: the rows drawn before it — each row stands at its own place, or, in an open
      // block, at its first row's.
      const before = drawn.rows.filter(
        ({ entry: r, stack }) => at(stack === null ? r.id : stack.head) < at(caption.head),
      ).length;
      assert.equal(caption.at, before, why);
      hidden += caption.size;
    }
    for (const [index, { entry: row, stack }] of drawn.rows.entries()) {
      if (stack?.role !== 'head') {
        continue;
      }
      const kin = kinOf(stack.group);
      assert.equal(stack.size, kin.length, why);
      const members = drawn.rows
        .slice(index + 1, index + stack.size)
        .map(({ entry: r, stack: s }) => {
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
    assert.equal(drawn.rows.length + hidden, rows.length, why);

    seen.closed += drawn.closed.length;
    seen.members += drawn.rows.filter(({ stack }) => stack?.role === 'member').length;
    seen.needing += drawn.closed.filter((one) => one.needYou > 0).length;
    seen.bySelection += drawn.rows.some(
      ({ entry: row, stack }) => stack !== null && row.id === selected && closedHere(stack.group),
    )
      ? 1
      : 0;
    seen.byFirstSelected += drawn.rows.some(
      ({ entry: row, stack }) =>
        stack?.role === 'head' && row.id === selected && closedHere(stack.group),
    )
      ? 1
      : 0;
    seen.byUnreported += drawn.rows.some(
      ({ entry: row, stack }) =>
        stack !== null && row.unreported && row.id !== selected && closedHere(stack.group),
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
