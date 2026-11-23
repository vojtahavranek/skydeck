// Follow-up F42 (S2 12.1, 12.9): Open's order once a move made it the server's — kept per session,
// new rows placed by today's rule and then frozen where they were first drawn, and the place of a
// session whose process went on with another one held for that next session.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Ns } from '../../../src/platform/types.ts';
import type { DerivedSession, Holder, LastHolding, Mark } from '../../../src/sessions/types.ts';
import type { EndDetail, SessionMeta } from '../../../src/store/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload } from '../../../src/window/protocol.ts';
import { buildListMessage, heldPlaces, keptNow, openRows } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import { frozenOrder, openSequence, withPutBack } from '../../../src/window/view/open-sequence.ts';
import type { SequenceEntry } from '../../../src/window/view/open-sequence.ts';
import { NS_PER_DAY } from '../../../src/platform/time.ts';
import { ds, meta, rows } from '../../helpers/derived.ts';
import { BOOT_A, SEC, T0 } from '../../helpers/platform.ts';

const DAY = NS_PER_DAY;

type Input = Omit<ViewInput, 'view' | 'selected'>;

/** Session `n`'s id. */
function sid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function termId(n: number): string {
  return n.toString(16).padStart(12, '0');
}

function nOf(id: string): number {
  return Number.parseInt(id.slice(-12), 16);
}

/** One session of the test's world. */
interface Spec {
  n: number;
  /** A terminal of the window showing it, with this slot (null: one without a slot). */
  slot?: number | null;
  group?: string;
  /** It has a note (the chip `note`). */
  note?: boolean;
  /** Running outside the window: in another terminal, or in Claude Code's background. */
  elsewhere?: 'other' | 'background';
  /** An empty copy (of session 99) running elsewhere, which only Show done lists. */
  emptyCopy?: boolean;
  /** The pid of the process that runs it (default: 4000 + n in the window, 9000 + n elsewhere). */
  pid?: number;
  /** When its holder's process had its latest event (default T0). */
  sinceNs?: Ns;
  /** Not running: the process `pid` held it last, and that holding ended so. */
  left?: { pid: number; detail: EndDetail | 'moved-on'; endedAtNs?: Ns; alive?: boolean };
  /** Its latest `clear`, `fork` or `copy` link names this session (`continuedFrom`). */
  from?: number;
}

function process(pid: number): Holder['process'] {
  return { bootId: BOOT_A, pid, procStart: 500 + pid };
}

function holder(sessionId: string, pid: number, sinceNs: Ns, background: boolean): Holder {
  return {
    process: process(pid),
    sinceNs,
    live: background
      ? {
          pid,
          sessionId,
          cwd: null,
          procStart: 500 + pid,
          entrypoint: 'cli',
          name: null,
          status: 'idle',
          waitingFor: null,
          updatedAtNs: null,
          statusUpdatedAtNs: null,
          background: true,
          mtimeNs: T0,
        }
      : null,
    scripted: false,
  };
}

function terminal(n: number, sessionId: string, slot: number | null, pid: number): TerminalInfo {
  return {
    id: termId(n),
    slot,
    state: 'running',
    sessionId,
    expectedSessionId: sessionId,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid, procStart: 500 + pid },
    openedNs: T0 - DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
  };
}

/** The view model's input for `specs`, every terminal running. */
function world(specs: readonly Spec[], openOrder: readonly number[] = []): Input {
  const sessions: DerivedSession[] = [];
  const metas: SessionMeta[] = [];
  const terminals: TerminalInfo[] = [];
  const elsewhere = new Map<string, { pid: number; tty: string | null }>();
  for (const spec of specs) {
    const id = sid(spec.n);
    if (spec.group !== undefined || spec.note === true) {
      metas.push(
        meta(id, {
          ...(spec.group === undefined ? {} : { group: spec.group }),
          ...(spec.note === true ? { note: 'a note' } : {}),
        }),
      );
    }
    const continuedFrom = spec.from === undefined ? null : sid(spec.from);
    if (spec.left !== undefined) {
      const lastHolding: LastHolding = {
        process: process(spec.left.pid),
        alive: spec.left.alive ?? true,
        endedAtNs: spec.left.endedAtNs ?? T0 - SEC,
        endDetail: spec.left.detail,
      };
      sessions.push(ds({ id, lastActivityNs: T0 - SEC, lastHolding, continuedFrom }));
      continue;
    }
    const pid = spec.pid ?? (spec.elsewhere === undefined ? 4000 : 9000) + spec.n;
    const held = [holder(id, pid, spec.sinceNs ?? T0, spec.elsewhere === 'background')];
    if (spec.elsewhere !== undefined) {
      const copy =
        spec.emptyCopy === true
          ? {
              marks: ['continued', 'empty-copy'] as Mark[],
              continuedFrom: sid(99),
              copyOf: sid(99),
              transcript: { aiTitle: 'made-up title', lastUserNs: null, lastTurnRole: null },
            }
          : {};
      sessions.push(ds({ id, state: 'running', holders: held, continuedFrom, ...copy }));
      elsewhere.set(id, { pid, tty: null });
    } else {
      sessions.push(ds({ id, state: 'working', holders: held, continuedFrom }));
    }
    if (spec.slot !== undefined) {
      terminals.push(terminal(spec.n, id, spec.slot, pid));
    }
  }
  if (specs.some((spec) => spec.emptyCopy === true)) {
    sessions.push(ds({ id: sid(99), transcript: { aiTitle: 'made-up title' } }));
  }
  return {
    rows: rows(sessions, { metas }),
    terminals,
    elsewhere,
    nowNs: T0,
    openOrder: openOrder.map(sid),
  };
}

/** Open as drawn, done ones shown: the session numbers. */
function drawn(input: Input): number[] {
  return openRows(input).map((row: RowPayload) => nOf(row.id));
}

/** What the server's freeze keeps for `input` (its `openOrder` the kept order): numbers. */
function frozen(input: Input): number[] {
  return keptNow(input).map(nOf);
}

function nineAnd(extra: readonly Spec[]): Spec[] {
  const specs: Spec[] = [];
  for (let n = 1; n <= 9; n += 1) specs.push({ n, slot: n });
  return [...specs, ...extra];
}

describe('F42: openSequence', () => {
  const entries: SequenceEntry[] = [
    { id: 't1', window: true, slot: 1 },
    { id: 't2', window: true, slot: 2 },
    { id: 't4', window: true, slot: 4 },
    { id: 'tx', window: true, slot: null },
    { id: 'ty', window: true, slot: null },
    { id: 'e1', window: false, slot: null },
    { id: 'e2', window: false, slot: null },
  ];

  test("nothing kept: today's order", () => {
    assert.deepEqual(
      openSequence(entries, [], new Map()),
      entries.map((entry) => entry.id),
    );
  });

  test('kept rows in kept order whatever their kind; ids not under Open left out; the rest by the rule', () => {
    // t2 goes before the first window terminal with a higher number (t4), ty after the last
    // window terminal (t1), e1 last.
    assert.deepEqual(openSequence(entries, ['e2', 'gone', 'tx', 't4', 't1'], new Map()), [
      'e2',
      'tx',
      't2',
      't4',
      't1',
      'ty',
      'e1',
    ]);
  });

  test('a new numbered terminal before the first window terminal with a higher number or none', () => {
    const today: SequenceEntry[] = [
      { id: 't1', window: true, slot: 1 },
      { id: 't2', window: true, slot: 2 },
      { id: 't3', window: true, slot: 3 },
      { id: 't4', window: true, slot: 4 },
      { id: 'e', window: false, slot: null },
    ];
    assert.deepEqual(openSequence(today, ['t1', 't2', 'e', 't4'], new Map()), [
      't1',
      't2',
      'e',
      't3',
      't4',
    ]);
  });

  test('a new numbered terminal with no higher number placed: after the last numbered one, above the numberless ones', () => {
    const today: SequenceEntry[] = [
      { id: 't1', window: true, slot: 1 },
      { id: 't2', window: true, slot: 2 },
      { id: 't3', window: true, slot: 3 },
      { id: 'tx', window: true, slot: null },
      { id: 'ty', window: true, slot: null },
    ];
    assert.deepEqual(openSequence(today, ['t1', 't2', 'tx', 'ty'], new Map()), [
      't1',
      't2',
      't3',
      'tx',
      'ty',
    ]);
    // Only numberless window terminals placed: before the first of them.
    assert.deepEqual(openSequence(today.slice(2), ['tx', 'ty'], new Map()), ['t3', 'tx', 'ty']);
  });

  test('no window terminal placed: a new window terminal goes first, numbered or not', () => {
    const today: SequenceEntry[] = [
      { id: 't3', window: true, slot: 3 },
      { id: 'tx', window: true, slot: null },
      { id: 'e', window: false, slot: null },
    ];
    assert.deepEqual(openSequence(today, ['e'], new Map()), ['t3', 'tx', 'e']);
    assert.deepEqual(openSequence(today.slice(1), ['e'], new Map()), ['tx', 'e']);
  });

  test("a held id that a successor takes: the successor at the held id's place", () => {
    const today: SequenceEntry[] = [
      { id: 't1', window: true, slot: 1 },
      { id: 'b', window: false, slot: null },
      { id: 'e', window: false, slot: null },
    ];
    assert.deepEqual(openSequence(today, ['a', 't1', 'e'], new Map([['a', 'b']])), [
      'b',
      't1',
      'e',
    ]);
  });
});

describe('F42: Open drawn from a kept order', () => {
  test("no kept order: Open is drawn by today's rule for a mixed world, and nothing is held", () => {
    const specs: Spec[] = [
      { n: 5, elsewhere: 'background' },
      { n: 3, slot: null },
      { n: 4, elsewhere: 'other' },
      { n: 2, slot: 2 },
      { n: 1, slot: 1 },
      { n: 6, elsewhere: 'other', emptyCopy: true },
      { n: 7, left: { pid: 4001, detail: 'clear' } },
    ];
    const input = world(specs);
    // slots by number, the slotless terminal, then the rest by the start of their process
    assert.deepEqual(drawn(input), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(drawn({ ...input, openOrder: [] }), drawn(input));
    const { openOrder: _, ...without } = input;
    assert.deepEqual(drawn(without), drawn(input));
    assert.deepEqual(heldPlaces(input), { held: [], takes: new Map() });
  });

  test('kept rows keep their relative order whatever their kind; a kept id not under Open is not drawn', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, slot: 2 },
        { n: 3, slot: null },
        { n: 4, elsewhere: 'other' },
        { n: 5, elsewhere: 'background' },
      ],
      [5, 3, 42, 1, 4, 2],
    );
    assert.deepEqual(drawn(input), [5, 3, 1, 4, 2]);
  });

  test("new rows: a numbered terminal at its number's place, a slotless one after the window's terminals, another terminal's last", () => {
    const base: Spec[] = [
      { n: 1, slot: 1 },
      { n: 2, slot: 2 },
      { n: 5, elsewhere: 'other' },
      { n: 4, slot: 4 },
    ];
    assert.deepEqual(drawn(world([...base, { n: 3, slot: 3 }], [1, 2, 5, 4])), [1, 2, 5, 3, 4]);
    assert.deepEqual(drawn(world([...base, { n: 6, slot: null }], [1, 2, 5, 4])), [1, 2, 5, 4, 6]);
    assert.deepEqual(
      drawn(world([...base, { n: 7, elsewhere: 'other' }], [4, 5, 1, 2])),
      [4, 5, 1, 2, 7],
    );
    assert.deepEqual(
      drawn(
        world(
          [
            { n: 5, elsewhere: 'other' },
            { n: 3, slot: 3 },
          ],
          [5],
        ),
      ),
      [3, 5],
    );
  });

  test("a block that draws a numberless terminal above numbered ones: a new numbered terminal still lands at its number's place", () => {
    // T1…T9 without T7; G = T2 + T10 (no number), drawn at T2's place.
    const specs: Spec[] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9])
      specs.push(n === 2 ? { n, slot: n, group: 'G' } : { n, slot: n });
    specs.push({ n: 10, slot: null, group: 'G' });
    const before = world(specs);
    assert.deepEqual(drawn(before), [1, 2, 10, 3, 4, 5, 6, 8, 9]);
    const kept = drawn(before);
    const opened = [...specs, { n: 11, slot: 7 }];
    // T11 opens with 7: between 6 and 8, as without a kept order.
    assert.deepEqual(drawn(world(opened)), [1, 2, 10, 3, 4, 5, 6, 11, 8, 9]);
    assert.deepEqual(drawn(world(opened, kept)), [1, 2, 10, 3, 4, 5, 6, 11, 8, 9]);
  });

  test('through buildListMessage: the kept order orders Open and the switcher alike; chips keep it on the subset', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, slot: 2, group: 'G', note: true },
        { n: 3, elsewhere: 'other', note: true },
        { n: 4, slot: null, group: 'G' },
      ],
      [3, 1, 2, 4],
    );
    const message = buildListMessage({
      ...input,
      selected: null,
      view: { filter: '', unfolded: [], showDone: false, selected: null, switcher: '' },
    });
    const open = message.sections.find((section) => section.name === 'open');
    assert.deepEqual(
      open?.rows.map((row) => nOf(row.id)),
      [3, 1, 2, 4],
    );
    assert.deepEqual(
      message.switcher?.items
        .filter((item) => item.rank === 'open')
        .map((item) => nOf(item.row.id)),
      [3, 1, 2, 4],
    );
    // A chip that leaves two rows of the four: in the kept order.
    const chipped = buildListMessage({
      ...input,
      selected: null,
      view: {
        filter: '',
        unfolded: [],
        showDone: false,
        selected: null,
        chips: ['note'],
      },
    });
    const shown = chipped.sections.find((section) => section.name === 'open')?.rows ?? [];
    assert.deepEqual(
      shown.map((row) => nOf(row.id)),
      [3, 2],
    );
  });

  test('a kept order equal to the drawn one draws the same, blocks and all', () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2 },
      { n: 3, slot: 3, group: 'G' },
      { n: 4, elsewhere: 'other', group: 'H' },
      { n: 5, slot: null, group: 'H' },
    ]);
    const today = openRows(input);
    const kept = openRows({ ...input, openOrder: today.map((row) => row.id) });
    assert.deepEqual(kept, today);
  });

  test("a new row of a group whose block was moved: drawn by the block rule, at the block's place", () => {
    // Kept: E above the block G = T1 + T3; T2 below. A new terminal of G with no number joins it.
    const specs: Spec[] = [
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2 },
      { n: 3, slot: 3, group: 'G' },
      { n: 9, elsewhere: 'other' },
    ];
    const kept = [9, 1, 3, 2];
    assert.deepEqual(drawn(world(specs, kept)), [9, 1, 3, 2]);
    assert.deepEqual(
      drawn(world([...specs, { n: 10, slot: null, group: 'G' }], kept)),
      [9, 1, 3, 10, 2],
    );
  });
});

describe('F42: the freeze — a row keeps the place it was first drawn at', () => {
  test('kept T1 E T2: T3 opens (frozen), then T2 closes: T1 E T3, not T1 T3 E', () => {
    const t1 = { n: 1, slot: 1 };
    const e = { n: 5, elsewhere: 'other' as const };
    const t2 = { n: 2, slot: 2 };
    const t3 = { n: 3, slot: 3 };
    const opened = world([t1, e, t2, t3], [1, 5, 2]);
    assert.deepEqual(drawn(opened), [1, 5, 2, 3]);
    const kept = frozen(opened);
    assert.deepEqual(kept, [1, 5, 2, 3]);
    assert.deepEqual(drawn(world([t1, e, t3], kept)), [1, 5, 3]);
    // Without the freeze in between, the new terminal would be placed again against the kept rows
    // left, and the close would move E: the reason for the freeze.
    assert.deepEqual(drawn(world([t1, e, t3], [1, 5, 2])), [1, 3, 5]);
  });

  test('kept T1 … T9 E T10: T11 (no number) opens, frozen; T10 closes: … E T11', () => {
    const e = { n: 20, elsewhere: 'other' as const };
    const t10 = { n: 10, slot: null };
    const t11 = { n: 11, slot: null };
    const keptBefore = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 10];
    const opened = world(nineAnd([e, t10, t11]), keptBefore);
    assert.deepEqual(drawn(opened), [...keptBefore, 11]);
    const kept = frozen(opened);
    assert.deepEqual(drawn(world(nineAnd([e, t11]), kept)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 11]);
  });

  test('keptNow is frozenOrder over Open drawn with done ones shown and the held places', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'clear' } },
        { n: 3, elsewhere: 'other', emptyCopy: true },
        { n: 4, slot: 2 },
      ],
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      keptNow(input),
      frozenOrder(
        input.openOrder ?? [],
        openRows(input, true).map((row) => row.id),
        heldPlaces(input),
      ),
    );
    // The held session 2 is put back after 1; the copy only Show done draws is kept too.
    assert.deepEqual(keptNow(input).map(nOf), [1, 2, 3, 4]);
  });

  test('the kept order ends: Open empty and nothing held → []; Open empty and a place held → [it]', () => {
    assert.deepEqual(frozen(world([{ n: 1, left: { pid: 4001, detail: 'exit' } }], [1])), []);
    assert.deepEqual(frozen(world([{ n: 1, left: { pid: 4001, detail: 'clear' } }], [1])), [1]);
  });
});

describe('F42: a held place (the process went on with another session)', () => {
  test('a slotless tenth terminal after /clear: A held and drawn by no page, then its successor at its place', () => {
    const e = { n: 20, elsewhere: 'other' as const };
    const keptBefore = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20];
    // The gap: A (session 10) ended with clear, its process (4010) runs no listed session yet.
    const gap = world(nineAnd([e, { n: 10, left: { pid: 4010, detail: 'clear' } }]), keptBefore);
    assert.deepEqual(drawn(gap), [1, 2, 3, 4, 5, 6, 7, 8, 9, 20]);
    assert.deepEqual(heldPlaces(gap).held, [sid(10)]);
    const kept = frozen(gap);
    assert.deepEqual(kept, keptBefore);
    // B (session 11) shows in the same terminal, held by the same process.
    const shown = world(
      nineAnd([
        e,
        { n: 10, left: { pid: 4010, detail: 'clear' } },
        { n: 11, slot: null, pid: 4010 },
      ]),
      kept,
    );
    assert.deepEqual(drawn(shown), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 20]);
    const next = frozen(shown);
    assert.deepEqual(next, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 20]);
    // From then B is a kept row, and A is gone.
    assert.deepEqual(heldPlaces({ ...shown, openOrder: next.map(sid) }), {
      held: [],
      takes: new Map(),
    });
  });

  test("a row of another terminal and one in Claude Code's background take the place too", () => {
    for (const kind of ['other', 'background'] as const) {
      const input = world(
        [
          { n: 1, slot: 1 },
          { n: 2, left: { pid: 9002, detail: 'clear' } },
          { n: 3, slot: 2 },
          { n: 4, elsewhere: kind, pid: 9002 },
        ],
        [1, 2, 3],
      );
      assert.deepEqual(drawn(input), [1, 4, 3], kind);
      assert.deepEqual(frozen(input), [1, 4, 3], kind);
    }
  });

  test('an in-session /resume (switch): the session switched to takes the place', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'switch' } },
        { n: 3, slot: 2 },
        { n: 4, elsewhere: 'other', pid: 9002 },
      ],
      [2, 1, 3],
    );
    assert.deepEqual(drawn(input), [4, 1, 3]);
  });

  test('a fork made in the same process is followed; a copy made in another process is not', () => {
    const fork = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'moved-on' } },
        { n: 3, slot: 2 },
        { n: 4, elsewhere: 'other', pid: 9002, from: 2 },
      ],
      [2, 1, 3],
    );
    assert.deepEqual(drawn(fork), [4, 1, 3]);
    const copy = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'moved-on' } },
        { n: 3, slot: 2 },
        { n: 4, elsewhere: 'other', pid: 9777, from: 2 },
      ],
      [2, 1, 3],
    );
    assert.deepEqual(drawn(copy), [1, 3, 4]);
    assert.deepEqual(heldPlaces(copy), { held: [sid(2)], takes: new Map() });
    assert.deepEqual(frozen(copy), [2, 1, 3, 4]);
  });

  test('a holding that ended with exit or other holds nothing: A goes at the freeze', () => {
    for (const detail of ['exit', 'other'] as const) {
      const input = world(
        [
          { n: 1, slot: 1 },
          { n: 2, left: { pid: 9002, detail } },
          { n: 4, elsewhere: 'other', pid: 9002 },
        ],
        [2, 1],
      );
      assert.deepEqual(heldPlaces(input).held, [], detail);
      assert.deepEqual(drawn(input), [1, 4], detail);
      assert.deepEqual(frozen(input), [1, 4], detail);
    }
  });

  test('a successor that already has a kept place keeps its own; A is not held', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9003, detail: 'clear' } },
        { n: 3, elsewhere: 'other', pid: 9003 },
        { n: 5, elsewhere: 'other' },
      ],
      [1, 2, 3, 5],
    );
    assert.deepEqual(heldPlaces(input).held, []);
    assert.deepEqual(drawn(input), [1, 3, 5]);
    assert.deepEqual(frozen(input), [1, 3, 5]);
  });

  test('two candidates in one process: only the one that ended later is held; its successor drawn once', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'clear', endedAtNs: T0 - 10n * SEC } },
        { n: 5, elsewhere: 'other' },
        { n: 3, left: { pid: 9002, detail: 'clear', endedAtNs: T0 - 5n * SEC } },
        { n: 6, slot: 2 },
        { n: 4, elsewhere: 'other', pid: 9002 },
      ],
      [2, 1, 5, 3, 6],
    );
    assert.deepEqual(heldPlaces(input).held, [sid(3)]);
    assert.deepEqual(drawn(input), [1, 5, 4, 6]);
    assert.deepEqual(frozen(input), [1, 5, 4, 6]);
  });

  test('two successors in the process: the one whose holder there is newest', () => {
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'clear' } },
        { n: 3, elsewhere: 'other', pid: 9002, sinceNs: T0 - SEC },
        { n: 4, elsewhere: 'other', pid: 9002, sinceNs: T0 },
      ],
      [2, 1],
    );
    assert.deepEqual(drawn(input), [4, 1, 3]);
  });

  test('P no longer alive, or A unknown: A goes at the freeze', () => {
    const dead = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'clear', alive: false } },
      ],
      [2, 1],
    );
    assert.deepEqual(frozen(dead), [1]);
    const unknown = world([{ n: 1, slot: 1 }], [42, 1]);
    assert.deepEqual(frozen(unknown), [1]);
  });

  test("a move plus two quick /clears before one refresh: A → X → Y, Y at A's place, X nowhere", () => {
    // Kept T1 A E F with A held; a move of E up gave E T1 A F (the plan's order, Step 4).
    const kept = [5, 1, 2, 6];
    const input = world(
      [
        { n: 1, slot: 1 },
        { n: 2, left: { pid: 9002, detail: 'clear', endedAtNs: T0 - 3n * SEC } },
        { n: 5, elsewhere: 'other' },
        { n: 3, left: { pid: 9002, detail: 'clear', endedAtNs: T0 - 2n * SEC } },
        { n: 4, elsewhere: 'other', pid: 9002 },
        { n: 6, elsewhere: 'other' },
      ],
      kept,
    );
    assert.deepEqual(drawn(input), [5, 1, 4, 6]);
    assert.deepEqual(frozen(input), [5, 1, 4, 6]);
  });
});

describe('F42: a put-back id goes after the nearest earlier id still there', () => {
  test('kept T1 T2 A E, A held, T2 closed in the same step: T1 A E; none earlier left: A first', () => {
    const a = { n: 3, left: { pid: 9003, detail: 'clear' as const } };
    const e = { n: 5, elsewhere: 'other' as const };
    assert.deepEqual(frozen(world([{ n: 1, slot: 1 }, a, e], [1, 2, 3, 5])), [1, 3, 5]);
    assert.deepEqual(frozen(world([a, e], [1, 2, 3, 5])), [3, 5]);
  });

  test('withPutBack, by itself', () => {
    assert.deepEqual(withPutBack(['a', 'b', 'c', 'd'], ['d', 'a'], ['c']), ['d', 'a', 'c']);
    assert.deepEqual(withPutBack(['a', 'b', 'c'], ['x', 'b'], ['a', 'c']), ['a', 'x', 'b', 'c']);
    assert.deepEqual(withPutBack(['a', 'b'], [], ['b']), ['b']);
  });
});
