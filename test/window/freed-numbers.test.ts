// Issue #189 (S2 7.6, 12.1): a free number goes to the first terminal on a row of Open that has
// none. Pure: who waits (Open's drawn order, blocks gathered; a terminal on no row of Open waits
// for one), and where the row goes once it has a number (its number's place, as a new terminal
// with that number is placed). The server's glue with fakes: when nothing is read, what is written
// with and without a kept order, a write that fails, a run inside the change it announces.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY } from '../../src/platform/time.ts';
import {
  createFill,
  HELD_LINE,
  orderAfterFill,
  persistFill,
  waitingTerminals,
} from '../../src/window/freed-numbers.ts';
import type { FillDeps, FillInput } from '../../src/window/freed-numbers.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import type { Registry } from '../../src/window/terminals.ts';
import { ds, meta, rows } from '../helpers/derived.ts';
import { BOOT_A, SEC, T0 } from '../helpers/platform.ts';

/** Session `n` of these tests. */
function nth(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** The terminal of session `n` (opened in the order of `n`), with `slot`. */
function terminal(n: number, slot: number | null, over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: `t${n.toString(16).padStart(11, '0')}`,
    slot,
    state: 'running',
    sessionId: nth(n),
    expectedSessionId: nth(n),
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4000 + n, procStart: 100 + n },
    openedNs: T0 - NS_PER_DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

function running(n: number) {
  return ds({
    id: nth(n),
    state: 'working',
    holders: [
      {
        process: { bootId: BOOT_A, pid: 4000 + n, procStart: 100 + n },
        sinceNs: T0,
        live: null,
        scripted: false,
      },
    ],
  });
}

/** Terminals 1–9 with numbers 1–9 but those in `ended` (their sessions not running, the terminal
 *  ended, no number), and terminals 10 to `last` without one; every other session running. */
function issue(
  last: number,
  options: {
    ended?: readonly number[];
    groups?: ReadonlyMap<number, string>;
    kept?: number[];
  } = {},
): FillInput {
  const ended = new Set(options.ended ?? []);
  const terminals: TerminalInfo[] = [];
  const sessions = [];
  for (let n = 1; n <= last; n += 1) {
    if (ended.has(n)) {
      terminals.push(terminal(n, null, { state: 'ended', program: null }));
      sessions.push(ds({ id: nth(n), lastActivityNs: T0 - SEC }));
    } else {
      terminals.push(terminal(n, n <= 9 ? n : null));
      sessions.push(running(n));
    }
  }
  const metas = [...(options.groups ?? new Map<number, string>())].map(([n, group]) =>
    meta(nth(n), { group }),
  );
  return {
    rows: rows(sessions, { metas }),
    terminals,
    elsewhere: new Map(),
    nowNs: T0,
    openOrder: (options.kept ?? []).map(nth),
  };
}

const term = (n: number): string => terminal(n, null).id;
const names = (ids: readonly string[]): number[] =>
  ids.map((id) => Number.parseInt(id.slice(-12), 16));
const termNames = (ids: readonly string[]): number[] =>
  ids.map((id) => Number.parseInt(id.slice(1), 16));

describe('who waits for a free number (#189)', () => {
  test("the terminals on rows of Open without a number, in Open's order: computed, kept, and with a block that draws one higher", () => {
    assert.deepEqual(termNames(waitingTerminals(issue(12, { ended: [6, 8] }))), [10, 11, 12]);
    const kept = [1, 2, 3, 4, 5, 7, 9, 12, 10, 11];
    assert.deepEqual(termNames(waitingTerminals(issue(12, { ended: [6, 8], kept }))), [12, 10, 11]);
    // Terminal 11 shares a group with terminal 2: the block draws it right after 2.
    const groups = new Map([
      [2, 'G'],
      [11, 'G'],
    ]);
    assert.deepEqual(
      termNames(waitingTerminals(issue(12, { ended: [6, 8], groups }))),
      [11, 10, 12],
    );
  });

  test('not a terminal on no row of Open: its twin has the row, or its row is under Recent; not an ended one, not one with a number', () => {
    const input = issue(11, { ended: [6] });
    // Terminal 12 shows session 10 too (a `/resume` inside it): terminal 10, opened first, has the row.
    const twin = terminal(12, null, { sessionId: nth(10), expectedSessionId: nth(10) });
    // Terminal 13 still runs, but its session ended a moment before its program: under Recent.
    const recent = terminal(13, null);
    const sessions = [
      ...[1, 2, 3, 4, 5, 7, 8, 9, 10, 11].map(running),
      ds({ id: nth(6), lastActivityNs: T0 - SEC }),
      ds({ id: nth(13), lastActivityNs: T0 - SEC }),
    ];
    const withBoth = {
      ...input,
      rows: rows(sessions),
      terminals: [...input.terminals, twin, recent],
    };
    assert.deepEqual(termNames(waitingTerminals(withBoth)), [10, 11]);
  });
});

describe('where the row goes once it has a number (#189)', () => {
  test("a kept order: each row that got a number goes to its number's place, every other row keeps its own (rows moved out of their numbers' order too)", () => {
    const given = new Map([
      [term(10), 6],
      [term(11), 8],
    ]);
    // The user moved 3 above 1 and 12 above 10 before; 6 and 8 ended.
    const kept = [3, 1, 2, 4, 5, 6, 7, 8, 9, 12, 10, 11];
    const input = issue(12, { ended: [6, 8], kept });
    assert.deepEqual(names(orderAfterFill(input, given)), [3, 1, 2, 4, 5, 10, 7, 11, 9, 12]);
  });

  test('a block the row heads goes with it; a block it is in but does not head stays where it is', () => {
    const groups = new Map([
      [10, 'G'],
      [12, 'G'],
    ]);
    const kept = [1, 2, 3, 4, 5, 7, 8, 9, 10, 12, 11];
    const input = issue(12, { ended: [6], groups, kept });
    assert.deepEqual(
      names(orderAfterFill(input, new Map([[term(10), 6]]))),
      [1, 2, 3, 4, 5, 10, 12, 7, 8, 9, 11],
    );
    const under2 = new Map([
      [2, 'G'],
      [10, 'G'],
    ]);
    const second = issue(11, {
      ended: [6],
      groups: under2,
      kept: [1, 2, 10, 3, 4, 5, 7, 8, 9, 11],
    });
    assert.deepEqual(
      names(orderAfterFill(second, new Map([[term(10), 6]]))),
      [1, 2, 10, 3, 4, 5, 7, 8, 9, 11],
    );
  });
});

/** The registry as the fill sees it: `list`, `nextSlot` and `giveSlots`, recorded. */
function glue(
  input: FillInput | null,
  options: { kept?: readonly string[]; free?: number | null } = {},
): {
  fill: ReturnType<typeof createFill>;
  deps: FillDeps;
  calls: string[][];
  events: string[];
  logs: string[];
  persisted: { moved: Map<string, number | null>; order: readonly string[] | null }[];
  kept: () => readonly string[];
  inputs: () => number;
  failWith: (error: unknown) => void;
  inside: (run: (() => void) | null) => void;
  setFree: (slot: number | null) => void;
  setFinding: (on: boolean) => void;
} {
  const calls: string[][] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const persisted: { moved: Map<string, number | null>; order: readonly string[] | null }[] = [];
  let kept: readonly string[] = options.kept ?? [];
  let failure: unknown = null;
  let nested: (() => void) | null = null;
  let read = 0;
  let free = options.free === undefined ? 6 : options.free;
  let finding = false;
  const registry: Pick<Registry, 'list' | 'nextSlot' | 'giveSlots'> = {
    list: () => input?.terminals ?? [],
    nextSlot: () => free,
    giveSlots(candidates, write) {
      calls.push([...candidates]);
      if (finding) return 'finding';
      const first = candidates[0];
      if (first === undefined || free === null) return 'ok';
      const given = new Map([[first, free]]);
      write(new Map(given), given);
      events.push('changed');
      nested?.();
      return 'ok';
    },
  };
  const deps: FillDeps = {
    registry,
    input: () => {
      read += 1;
      return input === null ? null : { ...input, openOrder: kept };
    },
    openOrder: {
      ids: () => kept,
      adopt: (ids) => {
        events.push('adopt');
        kept = ids;
      },
    },
    persist: (moved, order) => {
      if (failure !== null) throw failure;
      events.push('persist');
      persisted.push({ moved: new Map(moved), order });
    },
    remember: () => {
      events.push('remember');
    },
    log: (line) => {
      logs.push(line);
    },
    stopping: () => false,
  };
  return {
    fill: createFill(deps),
    deps,
    calls,
    events,
    logs,
    persisted,
    kept: () => kept,
    inputs: () => read,
    failWith: (error) => {
      failure = error;
    },
    inside: (run) => {
      nested = run;
    },
    setFree: (slot) => {
      free = slot;
    },
    setFinding: (on) => {
      finding = on;
    },
  };
}

const busy = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

describe("the fill's glue on the server (#189)", () => {
  test('nothing is read while no number is free or no terminal may take one, nor before the first refresh', () => {
    const none = glue(issue(12, { ended: [6] }), { free: null });
    none.fill.run();
    assert.deepEqual([none.inputs(), none.calls.length], [0, 0]);
    const all = issue(9, { ended: [] });
    const numbered = glue(all);
    numbered.fill.run();
    assert.deepEqual([numbered.inputs(), numbered.calls.length], [0, 0], 'every terminal has one');
    const ended = issue(10, { ended: [6] });
    const lostOnly = glue({
      ...ended,
      terminals: ended.terminals.map((one) =>
        one.slot === null ? { ...one, state: 'lost' as const } : one,
      ),
    });
    lostOnly.fill.run();
    assert.deepEqual([lostOnly.inputs(), lostOnly.calls.length], [0, 0], 'no program may run');
    const early = glue(null);
    early.deps.registry = {
      ...early.deps.registry,
      list: () => issue(12, { ended: [6] }).terminals,
    };
    createFill(early.deps).run();
    assert.deepEqual(early.calls, [], 'Open is not known before the first refresh');
  });

  test("without a kept order: the waiting terminals in Open's order go to the registry; the numbers are written alone, nothing adopted; the restore memory after", () => {
    const { fill, calls, events, persisted } = glue(issue(12, { ended: [6, 8] }));
    fill.run();
    assert.deepEqual(calls.map(termNames), [[10, 11, 12]]);
    assert.deepEqual(events, ['persist', 'changed', 'remember']);
    assert.deepEqual(persisted, [{ moved: new Map([[term(10), 6]]), order: null }]);
  });

  test('with a kept order: the new order is written with the numbers, adopted before the registry announces the change; the restore memory after', () => {
    const kept = [1, 2, 3, 4, 5, 7, 8, 9, 12, 10, 11].map(nth);
    const { fill, calls, events, persisted } = glue(issue(12, { ended: [6] }), { kept });
    fill.run();
    assert.deepEqual(calls.map(termNames), [[12, 10, 11]]);
    assert.deepEqual(events, ['persist', 'adopt', 'changed', 'remember']);
    // 12 waited first and takes 6: its row goes to 6's place, the others keep theirs.
    assert.deepEqual(names(persisted[0]?.order ?? []), [1, 2, 3, 4, 5, 12, 7, 8, 9, 10, 11]);
    assert.deepEqual(persisted[0]?.moved, new Map([[term(12), 6]]));
  });

  test('a write that fails: nothing adopted or remembered, logged once by kind, written at a later run', () => {
    const kept = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].map(nth);
    const { fill, events, logs, failWith, kept: now } = glue(issue(12, { ended: [6] }), { kept });
    failWith(busy());
    fill.run();
    fill.run();
    assert.deepEqual(events, []);
    assert.deepEqual(now(), kept);
    assert.deepEqual(logs, ['freed numbers: a free number was not given (the database is busy)']);
    failWith(null);
    fill.run();
    assert.deepEqual(events, ['persist', 'adopt', 'changed', 'remember']);
    assert.deepEqual(names(now()), [1, 2, 3, 4, 5, 10, 7, 8, 9, 11, 12]);
    failWith(new TypeError('boom'));
    fill.run();
    assert.equal(logs.length, 2, 'another kind is logged again');
  });

  test('a run inside the change it announces does nothing; once the server stops nothing runs', () => {
    const { fill, calls, inside, deps } = glue(issue(12, { ended: [6] }));
    inside(() => fill.run());
    fill.run();
    assert.equal(calls.length, 1);
    const stopped = createFill({ ...deps, stopping: () => true });
    stopped.run();
    assert.equal(calls.length, 1);
  });
});

describe('the fill: what it says in the log, and its writes (#189)', () => {
  test('held back while a keeper is being found: said once, and again only after a run that gave or had nothing to give', () => {
    const { fill, logs, setFinding, setFree, events } = glue(issue(12, { ended: [6] }));
    setFinding(true);
    fill.run();
    fill.run();
    assert.deepEqual(logs, [HELD_LINE]);
    assert.deepEqual(events, [], 'nothing given meanwhile');
    setFinding(false);
    fill.run();
    assert.deepEqual(events, ['persist', 'changed', 'remember'], 'given once the finding is over');
    setFinding(true);
    fill.run();
    assert.deepEqual(logs, [HELD_LINE, HELD_LINE], 'held again after a give: said again');
    setFree(null);
    fill.run(); // nothing to give
    setFree(6);
    fill.run();
    assert.equal(logs.length, 3, 'and after a run with nothing to give');
  });

  test('a write that fails, then nothing to give (the waiting terminal ended): a later failure of the same kind is logged again', () => {
    const { fill, logs, failWith, setFree } = glue(issue(12, { ended: [6] }));
    failWith(busy());
    fill.run();
    setFree(null);
    fill.run();
    setFree(6);
    fill.run();
    assert.deepEqual(logs, [
      'freed numbers: a free number was not given (the database is busy)',
      'freed numbers: a free number was not given (the database is busy)',
    ]);
  });

  test('persistFill: the numbers alone without a kept order; with one, both in one transaction', () => {
    const events: string[] = [];
    const store = {
      transaction<T>(run: () => T): T {
        events.push('begin');
        const result = run();
        events.push('commit');
        return result;
      },
      setKv: (key: string) => {
        events.push(`set ${key}`);
      },
      deleteKv: (key: string) => {
        events.push(`delete ${key}`);
      },
    };
    persistFill(store, new Map([[term(10), 6]]), null);
    assert.deepEqual(events, ['set window_slots'], 'no kept order: nothing of one is written');
    events.length = 0;
    persistFill(store, new Map([[term(10), 6]]), [nth(1), nth(10)]);
    assert.deepEqual(events, ['begin', 'set window_slots', 'set window_open_order', 'commit']);
  });
});
