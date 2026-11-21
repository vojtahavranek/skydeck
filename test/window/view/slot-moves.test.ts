// Follow-up F37 (S2 12.9, 7.6): a session of Open moves one place up or down; blocks stay together,
// and the slots of Open's terminals are given out again so that the numbers ascend top to bottom.
// The rows are built through `buildListMessage`'s inputs, so the blocks are the real ones.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY } from '../../../src/platform/time.ts';
import type { DerivedSession, Holder, Mark } from '../../../src/sessions/types.ts';
import type { SessionMeta } from '../../../src/store/types.ts';
import type { TerminalInfo } from '../../../src/window/hub.ts';
import type { RowPayload } from '../../../src/window/protocol.ts';
import { buildListMessage, openRows } from '../../../src/window/view/build.ts';
import type { ViewInput } from '../../../src/window/view/build.ts';
import {
  assignSlots,
  planReorder,
  REORDER_REFUSALS,
  reorderedRows,
} from '../../../src/window/view/slot-moves.ts';
import type { ReorderDirection } from '../../../src/window/view/slot-moves.ts';
import { planMove } from '../../../src/window/reorder.ts';
import { ds, meta, rows } from '../../helpers/derived.ts';
import { BOOT_A, SEC, T0 } from '../../helpers/platform.ts';

const DAY = NS_PER_DAY;

/** Session `n`'s id. */
function sid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function termId(n: number): string {
  return n.toString(16).padStart(12, '0');
}

/** One session of the test's world. */
interface Spec {
  n: number;
  /** A terminal of the window with this slot (null: one without a slot). */
  slot?: number | null;
  group?: string;
  /** Running outside the window: in another terminal, or in Claude Code's background. */
  elsewhere?: 'other' | 'background';
  /** Not running: its terminal (when `slot` is given) ended; Recent or Earlier by its age. */
  ended?: 'week' | 'earlier';
  /** An empty copy (of session 99) running elsewhere, which only Show done lists. */
  emptyCopy?: boolean;
  /** A second terminal of the window showing the session too (a `/resume` inside a terminal),
   *  with this slot. */
  twin?: number;
}

function holder(sessionId: string, pid: number, background = false): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart: 500 + pid },
    sinceNs: T0,
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

/** The view model's input for `specs`, every terminal running unless its session ended. */
function world(specs: readonly Spec[]): Omit<ViewInput, 'view' | 'selected'> {
  const sessions: DerivedSession[] = [];
  const metas: SessionMeta[] = [];
  const terminals: TerminalInfo[] = [];
  const elsewhere = new Map<string, { pid: number; tty: string | null }>();
  for (const spec of specs) {
    const id = sid(spec.n);
    if (spec.group !== undefined) {
      metas.push(meta(id, { group: spec.group }));
    }
    if (spec.ended !== undefined) {
      const age = spec.ended === 'week' ? DAY : 30n * DAY;
      sessions.push(ds({ id, lastActivityNs: T0 - age - BigInt(spec.n) * SEC }));
    } else if (spec.elsewhere !== undefined) {
      const pid = 9000 + spec.n;
      const copy =
        spec.emptyCopy === true
          ? {
              marks: ['continued', 'empty-copy'] as Mark[],
              continuedFrom: sid(99),
              copyOf: sid(99),
              transcript: { aiTitle: 'made-up title', lastUserNs: null, lastTurnRole: null },
            }
          : {};
      sessions.push(
        ds({
          id,
          state: 'running',
          holders: [holder(id, pid, spec.elsewhere === 'background')],
          ...copy,
        }),
      );
      elsewhere.set(id, { pid, tty: null });
    } else {
      sessions.push(ds({ id, state: 'working', holders: [holder(id, 4000 + spec.n)] }));
    }
    if (spec.twin !== undefined) {
      terminals.push({
        id: termId(100 + spec.n),
        slot: spec.twin,
        state: 'running',
        sessionId: id,
        expectedSessionId: id,
        kind: 'resume',
        label: null,
        dir: '/home/dev/projects/demo',
        program: { pid: 4100 + spec.n, procStart: 4600 + spec.n },
        openedNs: T0 - DAY + BigInt(100 + spec.n) * SEC,
        cols: 80,
        rows: 24,
        exit: null,
        notReported: false,
      });
    }
    if (spec.slot !== undefined) {
      terminals.push({
        id: termId(spec.n),
        slot: spec.slot,
        state: spec.ended === undefined ? 'running' : 'ended',
        sessionId: id,
        expectedSessionId: id,
        kind: 'resume',
        label: null,
        dir: '/home/dev/projects/demo',
        program: { pid: 4000 + spec.n, procStart: 4500 + spec.n },
        openedNs: T0 - DAY + BigInt(spec.n) * SEC,
        cols: 80,
        rows: 24,
        exit: null,
        notReported: false,
      });
    }
  }
  if (specs.some((spec) => spec.emptyCopy === true)) {
    sessions.push(ds({ id: sid(99), transcript: { aiTitle: 'made-up title' } }));
  }
  return { rows: rows(sessions, { metas }), terminals, elsewhere, nowNs: T0 };
}

/** `input` with the slots of `changes` (by terminal id) applied. */
function applied(
  input: Omit<ViewInput, 'view' | 'selected'>,
  changes: ReadonlyMap<string, number>,
): Omit<ViewInput, 'view' | 'selected'> {
  return {
    ...input,
    terminals: input.terminals.map((terminal) => ({
      ...terminal,
      slot: changes.get(terminal.id) ?? terminal.slot,
    })),
  };
}

/** Open as drawn: "n:slot" per row (slot `-` for none). */
function drawn(input: Omit<ViewInput, 'view' | 'selected'>): string[] {
  return openRows(input).map((row) => `${nOf(row)}:${row.slot ?? '-'}`);
}

function nOf(row: RowPayload): number {
  return Number.parseInt(row.id.slice(-12), 16);
}

/** Move session `n` and return Open as drawn afterwards (or the refusal). */
function move(
  input: Omit<ViewInput, 'view' | 'selected'>,
  n: number,
  direction: ReorderDirection,
): string[] | string {
  const plan = planReorder(openRows(input), sid(n), direction);
  if (!plan.ok) {
    return plan.error;
  }
  return drawn(applied(input, plan.slots));
}

describe('F37: moving a session of Open', () => {
  test('a single row trades places with the one above or below; the numbers follow', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2 },
      { n: 3, slot: 3 },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '2:2', '3:3']);
    assert.deepEqual(move(input, 3, 'up'), ['1:1', '3:2', '2:3']);
    assert.deepEqual(move(input, 1, 'down'), ['2:1', '1:2', '3:3']);
    assert.deepEqual(move(input, 2, 'up'), ['2:1', '1:2', '3:3']);
  });

  test('only the terminals involved change their slot when Open read in order', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2 },
      { n: 3, slot: 3 },
    ]);
    const plan = planReorder(openRows(input), sid(3), 'up');
    assert.ok(plan.ok);
    assert.deepEqual([...plan.slots].sort(), [
      [termId(2), 3],
      [termId(3), 2],
    ]);
  });

  test('inside a block a row trades places with its neighbour of the block', () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, slot: 3 },
    ]);
    assert.deepEqual(move(input, 2, 'up'), ['2:1', '1:2', '3:3']);
    assert.deepEqual(move(input, 1, 'down'), ['2:1', '1:2', '3:3']);
    const shown = openRows(applied(input, assignSlots(openRows(input))));
    assert.deepEqual(
      shown.map((row) => row.stack?.role ?? null),
      ['head', 'member', null],
    );
  });

  test("at a block's top edge the whole block passes the row above", () => {
    const input = world([
      { n: 3, slot: 1 },
      { n: 1, slot: 2, group: 'G' },
      { n: 2, slot: 3, group: 'G' },
    ]);
    assert.deepEqual(drawn(input), ['3:1', '1:2', '2:3']);
    assert.deepEqual(move(input, 1, 'up'), ['1:1', '2:2', '3:3']);
  });

  test("at a block's bottom edge the whole block passes the row below", () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, slot: 3 },
    ]);
    assert.deepEqual(move(input, 2, 'down'), ['3:1', '1:2', '2:3']);
  });

  test("at a block's edge the whole block passes the next block", () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, slot: 3, group: 'H' },
      { n: 4, slot: 4, group: 'H' },
    ]);
    assert.deepEqual(move(input, 2, 'down'), ['3:1', '4:2', '1:3', '2:4']);
    assert.deepEqual(move(input, 3, 'up'), ['3:1', '4:2', '1:3', '2:4']);
  });

  test('a single row passes a whole block, down and up', () => {
    const below = world([
      { n: 3, slot: 1 },
      { n: 1, slot: 2, group: 'G' },
      { n: 2, slot: 3, group: 'G' },
    ]);
    assert.deepEqual(move(below, 3, 'down'), ['1:1', '2:2', '3:3']);
    const above = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, slot: 3 },
    ]);
    assert.deepEqual(move(above, 3, 'up'), ['3:1', '1:2', '2:3']);
  });

  test('a closed block is passed as one unit: the move does not depend on what the page closed', () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, slot: 3 },
    ]);
    const view = {
      filter: '',
      unfolded: [],
      showDone: false,
      selected: sid(3),
      closed: [{ section: 'open' as const, group: 'G' }],
    };
    const closed = buildListMessage({ ...input, selected: null, view });
    const open = closed.sections.find((section) => section.name === 'open');
    assert.deepEqual(
      open?.rows.map((row) => row.id),
      [sid(3)],
    );
    const plan = planReorder(openRows(input), sid(3), 'up');
    assert.ok(plan.ok);
    const after = buildListMessage({ ...applied(input, plan.slots), selected: null, view });
    const shown = after.sections.find((section) => section.name === 'open');
    assert.deepEqual(
      shown?.rows.map((row) => [row.id, row.slot]),
      [[sid(3), 1]],
    );
    assert.deepEqual(
      shown?.closedStacks.map((caption) => [caption.group, caption.at]),
      [['G', 1]],
    );
  });

  test("a block's last slotted row with slotless rows below it is the block's edge: Shift+↓ carries the whole block", () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 5, elsewhere: 'other', group: 'G' },
      { n: 3, slot: 2 },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '5:-', '3:2']);
    assert.deepEqual(move(input, 1, 'down'), ['3:1', '1:2', '5:-']);
    const shown = openRows(applied(input, assignSlots(openRows(input))));
    assert.ok(shown.every((row) => row.id !== sid(5) || row.stack?.role === 'member'));
  });

  test('the slots: the same set, gaps kept, ascending in drawn order; an ended terminal in Recent keeps its own', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 4 },
      { n: 3, slot: 7 },
      { n: 4, slot: 2, ended: 'week' },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '2:4', '3:7']);
    const plan = planReorder(openRows(input), sid(3), 'up');
    assert.ok(plan.ok);
    assert.equal(plan.slots.has(termId(4)), false);
    assert.deepEqual(drawn(applied(input, plan.slots)), ['1:1', '3:4', '2:7']);
  });

  test('a start whose numbers read out of order (a block) comes out ascending after one move', () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 2, slot: 5, group: 'G' },
      { n: 3, slot: 2 },
      { n: 4, slot: 3 },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '2:5', '3:2', '4:3']);
    assert.deepEqual(move(input, 4, 'up'), ['1:1', '2:2', '4:3', '3:5']);
  });
});

describe('F37: what does not move', () => {
  test('a row of Recent or Earlier: only a session under Open moves', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2, ended: 'week' },
      { n: 3, ended: 'earlier' },
    ]);
    assert.equal(move(input, 2, 'up'), REORDER_REFUSALS.notOpen);
    assert.equal(move(input, 3, 'down'), REORDER_REFUSALS.notOpen);
  });

  test('a terminal of the window without a slot (a tenth)', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 9; n += 1) {
      specs.push({ n, slot: n });
    }
    specs.push({ n: 10, slot: null });
    const input = world(specs);
    assert.equal(drawn(input).at(-1), '10:-');
    assert.equal(move(input, 10, 'up'), REORDER_REFUSALS.noSlot);
    assert.equal(move(input, 9, 'down'), REORDER_REFUSALS.last);
  });

  test('a session running in another terminal, or in the background', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, elsewhere: 'other' },
      { n: 3, elsewhere: 'background' },
    ]);
    assert.equal(move(input, 2, 'up'), REORDER_REFUSALS.elsewhere);
    assert.equal(move(input, 3, 'up'), REORDER_REFUSALS.background);
  });

  test('an empty copy running elsewhere that only Show done lists: the elsewhere line, not "only under Open"', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, elsewhere: 'other', emptyCopy: true },
    ]);
    const hidden = buildListMessage({
      ...input,
      selected: null,
      view: { filter: '', unfolded: [], showDone: false, selected: null },
    });
    assert.deepEqual(
      hidden.sections.find((section) => section.name === 'open')?.rows.map((row) => row.id),
      [sid(1)],
    );
    assert.equal(move(input, 2, 'up'), REORDER_REFUSALS.elsewhere);
  });

  test('the first row upward, the last slotted row downward', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2 },
      { n: 3, elsewhere: 'other' },
    ]);
    assert.equal(move(input, 1, 'up'), REORDER_REFUSALS.top);
    assert.equal(move(input, 2, 'down'), REORDER_REFUSALS.last);
  });

  test('the last slotted row of a block with a slotless tail and nothing slotted after it', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2, group: 'G' },
      { n: 5, elsewhere: 'other', group: 'G' },
      { n: 6, elsewhere: 'other' },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '2:2', '5:-', '6:-']);
    assert.equal(move(input, 2, 'down'), REORDER_REFUSALS.last);
    assert.deepEqual(move(input, 2, 'up'), ['2:1', '5:-', '1:2', '6:-']);
  });

  test('a session no row shows', () => {
    const input = world([{ n: 1, slot: 1 }]);
    assert.deepEqual(planReorder(openRows(input), sid(42), 'up'), {
      ok: false,
      error: REORDER_REFUSALS.notOpen,
    });
  });
});

/** A small seeded generator (mulberry32), so that a failure can be run again. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('F37, a property over generated Opens: after a move the order is the one intended, the numbers ascend and the set of slots stays; with a session two terminals show, the move is refused instead when it would not be', () => {
  let moved = 0;
  let twinsRefused = 0;
  for (let seed = 1; seed <= 1000; seed += 1) {
    const random = generator(seed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const specs: Spec[] = [];
    const count = 1 + Math.floor(random() * 12);
    for (let n = 1; n <= count; n += 1) {
      const group = pick(['', '', 'G', 'H', 'K']);
      const kind = pick([
        'slot',
        'slot',
        'slot',
        'slotless',
        'other',
        'background',
        'copy',
        'ended',
        'twin',
      ]);
      const base: Spec = group === '' ? { n } : { n, group };
      if (kind === 'slot' && free.length > 0) {
        const at = Math.floor(random() * free.length);
        const [slot] = free.splice(at, 1);
        specs.push({ ...base, slot: slot ?? null });
      } else if (kind === 'slot' || kind === 'slotless') {
        specs.push({ ...base, slot: null });
      } else if (kind === 'other' || kind === 'background') {
        specs.push({ ...base, elsewhere: kind });
      } else if (kind === 'twin' && free.length >= 2) {
        const [slot, twin] = [
          free.splice(Math.floor(random() * free.length), 1)[0],
          free.splice(Math.floor(random() * free.length), 1)[0],
        ];
        specs.push({ ...base, slot: slot ?? null, ...(twin === undefined ? {} : { twin }) });
      } else if (kind === 'twin') {
        specs.push({ ...base, slot: null });
      } else if (kind === 'copy') {
        specs.push({ ...base, elsewhere: 'other', emptyCopy: true });
      } else if (free.length > 0) {
        const [slot] = free.splice(0, 1);
        specs.push({ ...base, slot: slot ?? null, ended: 'week' });
      }
    }
    const input = world(specs);
    const before = openRows(input);
    const chosen = pick(specs);
    const direction = pick<ReorderDirection>(['up', 'down']);
    const intended = reorderedRows(before, sid(chosen.n), direction);
    const plan = planMove(input, sid(chosen.n), direction);
    const label = `seed ${seed}: ${JSON.stringify(specs)} move ${chosen.n} ${direction}`;
    if (!plan.ok && plan.error === REORDER_REFUSALS.twins) {
      // Refused, nothing changed: only where a session has two terminals of the window.
      assert.ok(intended.ok, label);
      assert.ok(
        specs.some((spec) => spec.twin !== undefined),
        label,
      );
      twinsRefused += 1;
      continue;
    }
    assert.equal(plan.ok, intended.ok, label);
    if (!plan.ok || !intended.ok) {
      continue;
    }
    moved += 1;
    const after = openRows(applied(input, plan.slots));
    assert.deepEqual(
      after.map((row) => row.id),
      intended.rows.map((row) => row.id),
      label,
    );
    const slots = after.flatMap((row) => (row.slot === null ? [] : [row.slot]));
    assert.deepEqual(
      slots,
      [...slots].sort((a, b) => a - b),
      label,
    );
    // Every terminal of the window: the same slots as before, none twice.
    const all = (terminals: readonly { slot: number | null }[]): number[] =>
      terminals.flatMap((term) => (term.slot === null ? [] : [term.slot])).sort((a, b) => a - b);
    const afterAll = all(applied(input, plan.slots).terminals);
    assert.deepEqual(afterAll, all(input.terminals), label);
    assert.equal(new Set(afterAll).size, afterAll.length, label);
    const was = before.findIndex((row) => row.id === sid(chosen.n));
    const now = after.findIndex((row) => row.id === sid(chosen.n));
    assert.ok(direction === 'up' ? now < was : now > was, label);
    // Every terminal outside Open keeps its slot.
    const inOpen = new Set(before.flatMap((row) => (row.terminal === null ? [] : [row.terminal])));
    for (const id of plan.slots.keys()) {
      assert.ok(inOpen.has(id), label);
    }
  }
  assert.ok(moved > 150, `only ${moved} of the generated moves were made`);
  assert.ok(twinsRefused > 0, 'the generator met a move that two terminals of a session refuse');
});
