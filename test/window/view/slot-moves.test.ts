// Follow-up F37 (S2 12.9, 7.6): a session of Open moves one place up or down; blocks stay together,
// and the slots of Open's terminals are given out again so that the numbers ascend top to bottom.
// F42: any row of Open moves, and the numbers are handed out again from the top among the window's
// terminals (a terminal can gain one, another lose its own). The rows are built through
// `buildListMessage`'s inputs, so the blocks are the real ones.
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
  /** F42: not running; the process with this pid held it last and went on with another session
   *  (`/clear`), and still runs. */
  left?: number;
  /** F42: the pid of the process a session running elsewhere runs in (default 9000 + n). */
  pid?: number;
  /** A group from the title (`<titleGroup> …`), not from meta: an empty copy so grouped stays one
   *  the list hides (a group set by hand keeps it). */
  titleGroup?: string;
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
    if (spec.left !== undefined) {
      const lastHolding = {
        process: { bootId: BOOT_A, pid: spec.left, procStart: 500 + spec.left },
        alive: true,
        endedAtNs: T0 - SEC,
        endDetail: 'clear' as const,
      };
      sessions.push(ds({ id, lastActivityNs: T0 - SEC, lastHolding }));
    } else if (spec.ended !== undefined) {
      const age = spec.ended === 'week' ? DAY : 30n * DAY;
      sessions.push(ds({ id, lastActivityNs: T0 - age - BigInt(spec.n) * SEC }));
    } else if (spec.elsewhere !== undefined) {
      const pid = spec.pid ?? 9000 + spec.n;
      const copy =
        spec.emptyCopy === true
          ? {
              marks: ['continued', 'empty-copy'] as Mark[],
              continuedFrom: sid(99),
              copyOf: sid(99),
              transcript: {
                aiTitle:
                  spec.titleGroup === undefined ? 'made-up title' : `${spec.titleGroup} copy`,
                lastUserNs: null,
                lastTurnRole: null,
              },
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
      sessions.push(
        ds({
          id,
          state: 'working',
          holders: [holder(id, 4000 + spec.n)],
          ...(spec.titleGroup === undefined
            ? {}
            : { transcript: { aiTitle: `${spec.titleGroup} work` } }),
        }),
      );
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

/** `input` with the slots of `changes` (by terminal id; null: none) applied. */
function applied(
  input: Omit<ViewInput, 'view' | 'selected'>,
  changes: ReadonlyMap<string, number | null>,
): Omit<ViewInput, 'view' | 'selected'> {
  return {
    ...input,
    terminals: input.terminals.map((terminal) => ({
      ...terminal,
      slot: changes.has(terminal.id) ? (changes.get(terminal.id) ?? null) : terminal.slot,
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

/** Move session `n` and return Open as drawn afterwards (or the refusal): the plan's order kept
 *  (F42) and its slots applied. */
function move(
  input: Omit<ViewInput, 'view' | 'selected'>,
  n: number,
  direction: ReorderDirection,
): string[] | string {
  const plan = planReorder(openRows(input), sid(n), direction);
  if (!plan.ok) {
    return plan.error;
  }
  return drawn(applied({ ...input, openOrder: plan.rows.map((row) => row.id) }, plan.slots));
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

  test('F42: inside a block a slotted row trades places with a slotless one below it (F37 carried the whole block)', () => {
    const input = world([
      { n: 1, slot: 1, group: 'G' },
      { n: 5, elsewhere: 'other', group: 'G' },
      { n: 3, slot: 2 },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '5:-', '3:2']);
    assert.deepEqual(move(input, 1, 'down'), ['5:-', '1:1', '3:2']);
    assert.deepEqual(move(input, 5, 'down'), ['3:1', '1:2', '5:-']);
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

  test('F42 (was refused): a terminal of the window without a slot (a tenth) moves, and the numbers follow', () => {
    const specs: Spec[] = [];
    for (let n = 1; n <= 9; n += 1) {
      specs.push({ n, slot: n });
    }
    specs.push({ n: 10, slot: null });
    const input = world(specs);
    assert.equal(drawn(input).at(-1), '10:-');
    const moved = ['1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '10:9', '9:-'];
    assert.deepEqual(move(input, 10, 'up'), moved);
    assert.deepEqual(move(input, 9, 'down'), moved);
  });

  test('F42 (was refused): a session running in another terminal, or in the background, moves', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, elsewhere: 'other' },
      { n: 3, elsewhere: 'background' },
    ]);
    assert.deepEqual(move(input, 2, 'up'), ['2:-', '1:1', '3:-']);
    assert.deepEqual(move(input, 3, 'up'), ['1:1', '3:-', '2:-']);
  });

  test('F42 (was refused): an empty copy running elsewhere that only Show done lists moves on a Show done page', () => {
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
    assert.deepEqual(move(input, 2, 'up'), ['2:-', '1:1']);
  });

  test('the first row upward, the last row downward (F42: the last row, not the last slotted one)', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2 },
      { n: 3, elsewhere: 'other' },
    ]);
    assert.equal(move(input, 1, 'up'), REORDER_REFUSALS.top);
    assert.deepEqual(move(input, 2, 'down'), ['1:1', '3:-', '2:2']);
    assert.equal(move(input, 3, 'down'), REORDER_REFUSALS.last);
    assert.equal(REORDER_REFUSALS.last, 'already at the bottom of Open');
  });

  test('the last slotted row of a block with a slotless tail: F42, it trades with the row below it in the block', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2, group: 'G' },
      { n: 5, elsewhere: 'other', group: 'G' },
      { n: 6, elsewhere: 'other' },
    ]);
    assert.deepEqual(drawn(input), ['1:1', '2:2', '5:-', '6:-']);
    assert.deepEqual(move(input, 2, 'down'), ['1:1', '5:-', '2:2', '6:-']);
    assert.equal(move(input, 6, 'down'), REORDER_REFUSALS.last);
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

type Input = Omit<ViewInput, 'view' | 'selected'>;

/** The server's move (`planMove`) of session `n`, applied as the server applies it: Open's new kept
 *  order and the slots. The new input, or the refusal. */
function moveOn(
  input: Input,
  n: number,
  direction: ReorderDirection,
  showDone = true,
): Input | string {
  const plan = planMove(input, showDone, sid(n), direction);
  if (!plan.ok) return plan.error;
  return applied({ ...input, openOrder: plan.order }, plan.slots);
}

/** `moveOn`, then Open as drawn (done ones shown). */
function movedTo(input: Input, n: number, direction: ReorderDirection, showDone = true): string[] {
  const after = moveOn(input, n, direction, showDone);
  assert.ok(typeof after !== 'string', String(after));
  return drawn(after);
}

/** Nine numbered terminals, 5 and 6 a block, and `last` below them. */
function nineWith(last: Spec): Input {
  const specs: Spec[] = [];
  for (let n = 1; n <= 9; n += 1) {
    specs.push(n === 5 || n === 6 ? { n, slot: n, group: 'G' } : { n, slot: n });
  }
  return world([...specs, last]);
}

describe('F42: any row of Open moves, and the numbers follow the order', () => {
  test('a tenth terminal: up alone, across a numbered row (it takes 9, the ninth none), across a block; and down again', () => {
    let input = nineWith({ n: 10, slot: null });
    assert.deepEqual(drawn(input).slice(-3), ['8:8', '9:9', '10:-']);
    const up = moveOn(input, 10, 'up');
    assert.ok(typeof up !== 'string');
    input = up;
    assert.deepEqual(drawn(input).slice(-3), ['8:8', '10:9', '9:-']);
    for (let step = 0; step < 3; step += 1) {
      const next = moveOn(input, 10, 'up');
      assert.ok(typeof next !== 'string');
      input = next;
    }
    // Past 8, 7 and then the block 5 + 6 as one unit.
    assert.deepEqual(drawn(input), [
      '1:1',
      '2:2',
      '3:3',
      '4:4',
      '10:5',
      '5:6',
      '6:7',
      '7:8',
      '8:9',
      '9:-',
    ]);
    // Down across the block, then across the numbered 7.
    assert.deepEqual(movedTo(input, 10, 'down'), [
      '1:1',
      '2:2',
      '3:3',
      '4:4',
      '5:5',
      '6:6',
      '10:7',
      '7:8',
      '8:9',
      '9:-',
    ]);
  });

  for (const kind of ['other', 'background'] as const) {
    test(`a session ${kind === 'other' ? 'in another terminal' : "in Claude Code's background"}: up alone, across a numbered row, across a block, and down; it never has a number and no number changes`, () => {
      let input = nineWith({ n: 10, elsewhere: kind });
      const plan = planMove(input, true, sid(10), 'up');
      assert.ok(plan.ok);
      assert.equal(plan.slots.size, 0, 'no number changes');
      for (let step = 0; step < 4; step += 1) {
        const next = moveOn(input, 10, 'up');
        assert.ok(typeof next !== 'string');
        input = next;
      }
      assert.deepEqual(drawn(input), [
        '1:1',
        '2:2',
        '3:3',
        '4:4',
        '10:-',
        '5:5',
        '6:6',
        '7:7',
        '8:8',
        '9:9',
      ]);
      assert.deepEqual(movedTo(input, 10, 'down'), [
        '1:1',
        '2:2',
        '3:3',
        '4:4',
        '5:5',
        '6:6',
        '10:-',
        '7:7',
        '8:8',
        '9:9',
      ]);
    });
  }

  test('a block that draws a terminal without a number above numbered ones: a move of an unrelated row hands every number out again', () => {
    // G = T2 + T10 (no number), drawn at T2's place; E another terminal's row at the bottom.
    const specs: Spec[] = [];
    for (let n = 1; n <= 9; n += 1)
      specs.push(n === 2 ? { n, slot: n, group: 'G' } : { n, slot: n });
    const input = world([
      ...specs,
      { n: 10, slot: null, group: 'G' },
      { n: 20, elsewhere: 'other' },
    ]);
    assert.deepEqual(drawn(input).slice(0, 4), ['1:1', '2:2', '10:-', '3:3']);
    assert.deepEqual(movedTo(input, 20, 'up'), [
      '1:1',
      '2:2',
      '10:3',
      '3:4',
      '4:5',
      '5:6',
      '6:7',
      '7:8',
      '8:9',
      '20:-',
      '9:-',
    ]);
  });

  test('inside a block rows of any kind trade places; at its edge the whole block passes; the last row downward is refused', () => {
    const input = world([
      { n: 1, slot: 1 },
      { n: 2, slot: null, group: 'G' },
      { n: 3, elsewhere: 'other', group: 'G' },
      { n: 4, elsewhere: 'background', group: 'G' },
      { n: 5, slot: 2 },
    ]);
    // The block G sits at T2's place: after the numbered terminals.
    assert.deepEqual(drawn(input), ['1:1', '5:2', '2:-', '3:-', '4:-']);
    assert.deepEqual(movedTo(input, 4, 'up'), ['1:1', '5:2', '2:-', '4:-', '3:-']);
    assert.deepEqual(movedTo(input, 3, 'down'), ['1:1', '5:2', '2:-', '4:-', '3:-']);
    assert.deepEqual(movedTo(input, 2, 'down'), ['1:1', '5:2', '3:-', '2:-', '4:-']);
    // At the block's top edge the whole block passes T5: T2 takes 2, T5 loses it.
    assert.deepEqual(movedTo(input, 2, 'up'), ['1:1', '2:2', '3:-', '4:-', '5:-']);
    assert.deepEqual(movedTo(input, 5, 'down'), ['1:1', '2:2', '3:-', '4:-', '5:-']);
    assert.equal(moveOn(input, 4, 'down'), REORDER_REFUSALS.last);
  });

  test('a page without Show done: a move past a hidden empty copy is one visible step; the copy stays with its group, or after the row it followed', () => {
    // After the row it followed: kept T1 C T2, C an empty copy only Show done lists.
    const after = world([
      { n: 1, slot: 1 },
      { n: 3, elsewhere: 'other', emptyCopy: true },
      { n: 2, slot: 2 },
    ]);
    const kept = { ...after, openOrder: [sid(1), sid(3), sid(2)] };
    assert.deepEqual(drawn(kept), ['1:1', '3:-', '2:2']);
    assert.deepEqual(
      openRows(kept, false).map((row) => nOf(row)),
      [1, 2],
    );
    assert.deepEqual(movedTo(kept, 2, 'up', false), ['2:1', '1:2', '3:-']);
    // With its group: C in G with T2.
    const grouped = world([
      { n: 1, slot: 1 },
      { n: 2, slot: 2, group: 'G' },
      { n: 3, elsewhere: 'other', emptyCopy: true, group: 'G' },
    ]);
    assert.deepEqual(drawn(grouped), ['1:1', '2:2', '3:-']);
    assert.deepEqual(movedTo(grouped, 2, 'up', false), ['2:1', '3:-', '1:2']);
    // A Show done page moves the copy like any row.
    assert.deepEqual(movedTo(kept, 3, 'up', true), ['3:-', '1:1', '2:2']);
  });

  test('a hidden empty copy grouped by its title: a move on a page without Show done keeps it with its group', () => {
    // Kept C T1 T2, C a copy only Show done lists, in T1's group by its title; its block sits at
    // C's place on a Show done page.
    const input = {
      ...world([
        { n: 1, slot: 1, group: 'ABC-1' },
        { n: 3, elsewhere: 'other', emptyCopy: true, titleGroup: 'ABC-1' },
        { n: 2, slot: 2 },
      ]),
      openOrder: [sid(3), sid(1), sid(2)],
    };
    assert.deepEqual(drawn(input), ['3:-', '1:1', '2:2']);
    assert.deepEqual(
      openRows(input, false).map((row) => nOf(row)),
      [1, 2],
    );
    assert.deepEqual(movedTo(input, 1, 'down', false), ['2:1', '1:2', '3:-']);
  });

  test('a hidden empty copy whose predecessor closed: after the nearest earlier row still there; first when none is left', () => {
    const specs: Spec[] = [
      { n: 1, slot: 1 },
      { n: 3, elsewhere: 'other', emptyCopy: true },
      { n: 2, slot: 2 },
    ];
    // Kept T1 X C T2, X (session 7) closed.
    const closed = { ...world(specs), openOrder: [sid(1), sid(7), sid(3), sid(2)] };
    assert.deepEqual(movedTo(closed, 2, 'up', false), ['2:1', '1:2', '3:-']);
    // Kept X C T1 T2: nothing earlier is left.
    const first = { ...world(specs), openOrder: [sid(7), sid(3), sid(1), sid(2)] };
    assert.deepEqual(drawn(first), ['3:-', '1:1', '2:2']);
    assert.deepEqual(movedTo(first, 2, 'up', false), ['3:-', '2:1', '1:2']);
  });

  test("a held place survives a move: kept T1 A E T2 with A held, E up: the order keeps A after T1; then A's successor takes it", () => {
    const specs: Spec[] = [
      { n: 1, slot: 1 },
      { n: 5, left: 9005 },
      { n: 3, elsewhere: 'other' },
      { n: 2, slot: 2 },
    ];
    const input = { ...world(specs), openOrder: [sid(1), sid(5), sid(3), sid(2)] };
    assert.deepEqual(drawn(input), ['1:1', '3:-', '2:2']);
    const plan = planMove(input, true, sid(3), 'up');
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.order.map((id) => nOf({ id } as RowPayload)),
      [3, 1, 5, 2],
    );
    // The successor (session 6, held by the same process) shows, and is drawn at A's place.
    const shown = {
      ...world([...specs, { n: 6, elsewhere: 'other', pid: 9005 }]),
      openOrder: plan.order,
    };
    assert.deepEqual(drawn(shown), ['3:-', '1:1', '6:-', '2:2']);
  });

  test('a successor that showed before the next refresh and is made kept by a move takes the place in that move: the two are never both kept', () => {
    const specs: Spec[] = [
      { n: 1, slot: 1 },
      { n: 5, left: 9005 },
      { n: 3, elsewhere: 'other' },
      { n: 6, elsewhere: 'other', pid: 9005 },
    ];
    const input = { ...world(specs), openOrder: [sid(1), sid(5), sid(3)] };
    assert.deepEqual(drawn(input), ['1:1', '6:-', '3:-']);
    const plan = planMove(input, true, sid(3), 'up');
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.order.map((id) => nOf({ id } as RowPayload)),
      [1, 3, 6],
    );
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

test('F37, F42, a property over generated Opens: after a move (also after earlier ones, a kept order) the visible order is the one intended, the numbers are handed out from the top among the window terminals and the set of slots stays; with a session two terminals show, the move is refused instead when it would not be', () => {
  let moved = 0;
  let twinsRefused = 0;
  let slotlessMoved = 0;
  let groupedHidden = 0;
  for (let seed = 1; seed <= 1000; seed += 1) {
    const random = generator(seed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const specs: Spec[] = [];
    const count = 1 + Math.floor(random() * 14);
    for (let n = 1; n <= count; n += 1) {
      // Group texts a title can carry too (the default group pattern: two characters or more,
      // a dash, digits): the copies below are grouped by their title, so that they stay copies
      // the list hides (review of F42).
      const group = pick(['', '', 'GG-1', 'HH-1', 'KK-1']);
      const kind = pick([
        'slot',
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
        specs.push({
          n,
          ...(group === '' ? {} : { titleGroup: group }),
          elsewhere: 'other',
          emptyCopy: true,
        });
      } else if (free.length > 0) {
        const [slot] = free.splice(0, 1);
        specs.push({ ...base, slot: slot ?? null, ended: 'week' });
      }
    }
    let input = world(specs);
    // Earlier moves, each applied as the server applies it: a kept order and new slots.
    const earlier = Math.floor(random() * 4);
    for (let step = 0; step < earlier; step += 1) {
      const one = pick(specs);
      const plan = planMove(input, pick([true, false]), sid(one.n), pick(['up', 'down']));
      if (plan.ok) input = applied({ ...input, openOrder: plan.order }, plan.slots);
    }
    const showDone = pick([true, false]);
    const before = openRows(input, showDone);
    const beforeAll = openRows(input, true);
    // A copy the list hides without Show done, in a block with another row: the group rule's case.
    const visibleIds = new Set(openRows(input, false).map((row) => row.id));
    if (beforeAll.some((row) => !visibleIds.has(row.id) && row.stack !== null)) groupedHidden += 1;
    const chosen = pick(specs);
    const direction = pick<ReorderDirection>(['up', 'down']);
    const intended = reorderedRows(before, sid(chosen.n), direction);
    const plan = planMove(input, showDone, sid(chosen.n), direction);
    const label = `seed ${seed}: ${JSON.stringify(specs)} after ${earlier} moves, move ${chosen.n} ${direction}, showDone ${showDone}`;
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
    const after = applied({ ...input, openOrder: plan.order }, plan.slots);
    const shown = openRows(after, showDone);
    assert.deepEqual(
      shown.map((row) => row.id),
      intended.rows.map((row) => row.id),
      label,
    );
    // The numbers of Open's window terminals before, handed out from the top of the new Open.
    const numbers = (rows: readonly RowPayload[]): number[] =>
      rows.flatMap((row) => (row.terminal === null || row.slot === null ? [] : [row.slot]));
    const kept = [...numbers(beforeAll)].sort((a, b) => a - b);
    const windowRows = openRows(after, true).filter((row) => row.terminal !== null);
    assert.deepEqual(
      windowRows.map((row) => row.slot),
      windowRows.map((_, at) => kept[at] ?? null),
      label,
    );
    // No number on a row that does not run in the window.
    assert.ok(
      openRows(after, true).every((row) => row.terminal !== null || row.slot === null),
      label,
    );
    // Every terminal of the window: the same slots as before, none twice.
    const all = (terminals: readonly { slot: number | null }[]): number[] =>
      terminals.flatMap((term) => (term.slot === null ? [] : [term.slot])).sort((a, b) => a - b);
    const afterAll = all(after.terminals);
    assert.deepEqual(afterAll, all(input.terminals), label);
    assert.equal(new Set(afterAll).size, afterAll.length, label);
    const was = before.findIndex((row) => row.id === sid(chosen.n));
    const now = shown.findIndex((row) => row.id === sid(chosen.n));
    assert.ok(direction === 'up' ? now < was : now > was, label);
    // Every terminal outside Open keeps its slot.
    const inOpen = new Set(
      beforeAll.flatMap((row) => (row.terminal === null ? [] : [row.terminal])),
    );
    for (const id of plan.slots.keys()) {
      assert.ok(inOpen.has(id), label);
    }
    if (before[was]?.slot === null) slotlessMoved += 1;
  }
  assert.ok(moved > 300, `only ${moved} of the generated moves were made`);
  assert.ok(slotlessMoved > 100, `only ${slotlessMoved} moves of a row without a number`);
  assert.ok(groupedHidden > 50, `only ${groupedHidden} worlds with a hidden copy in a block`);
  assert.ok(twinsRefused > 0, 'the generator met a move that two terminals of a session refuse');
});
