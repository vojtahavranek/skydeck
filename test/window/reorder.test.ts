// Follow-up F37 (S2 12.9): `act reorder`'s glue on the server, with fakes — the page's view refuses
// a move while a filter or a chip is set; else the rule's plan goes to the registry's setSlots, and
// what the registry refuses is answered with its line; a store that cannot be written throws.
// F42: the plan's order is written with the moved slots (`persist`) inside setSlots' write, and
// adopted as Open's kept order last.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY } from '../../src/platform/time.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import type { ViewMessage } from '../../src/window/protocol.ts';
import type { KvKey } from '../../src/store/types.ts';
import { isBusy } from '../../src/window/busy.ts';
import { createReorder, persistMove, SERVER_STOPPING } from '../../src/window/reorder.ts';
import type { ReorderDeps } from '../../src/window/reorder.ts';
import { REORDER_REFUSALS } from '../../src/window/view/slot-moves.ts';
import { testDeck } from '../helpers/deck.ts';
import { ds, meta, rows } from '../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

function terminal(n: number, sessionId: string): TerminalInfo {
  return {
    id: n.toString(16).padStart(12, '0'),
    slot: n,
    state: 'running',
    sessionId,
    expectedSessionId: sessionId,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: { pid: 4000 + n, procStart: 100 + n },
    openedNs: T0 - NS_PER_DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
  };
}

function running(id: string, pid: number) {
  return ds({
    id,
    state: 'working',
    holders: [
      {
        process: { bootId: BOOT_A, pid, procStart: 100 },
        sinceNs: T0,
        live: null,
        scripted: false,
      },
    ],
  });
}

/** S1 in slot 1, S2 in slot 2; setSlots records its calls, runs the move's write (F42) and
 *  answers `answer`; `remembered` counts the calls of `remember`; `events` what happened, in order. */
function glue(answer: () => 'ok' | 'changed' | 'stopping' = () => 'ok'): {
  reorder: ReturnType<typeof createReorder>;
  calls: Map<string, number | null>[];
  remembered: () => number;
  events: string[];
  persisted: { moved: Map<string, number | null>; order: string[] }[];
  kept: () => readonly string[];
  failPersist: (error: unknown) => void;
} {
  const calls: Map<string, number | null>[] = [];
  const events: string[] = [];
  const persisted: { moved: Map<string, number | null>; order: string[] }[] = [];
  let kept: readonly string[] = [];
  let failWith: unknown = null;
  let remembered = 0;
  const deps: ReorderDeps = {
    registry: {
      list: () => [terminal(1, S1), terminal(2, S2)],
      setSlots(changes, write) {
        calls.push(new Map(changes));
        const outcome = answer();
        if (outcome !== 'ok') return outcome;
        write?.(new Map(changes));
        events.push('changed');
        return outcome;
      },
    },
    rows: () => rows([running(S1, 4001), running(S2, 4002)]),
    elsewhere: () => new Map(),
    nowNs: () => T0,
    openOrder: {
      ids: () => kept,
      adopt: (ids) => {
        events.push('adopt');
        kept = ids;
      },
    },
    persist: (moved, order) => {
      if (failWith !== null) throw failWith;
      events.push('persist');
      persisted.push({ moved: new Map(moved), order: [...order] });
    },
    remember: () => {
      remembered += 1;
    },
  };
  return {
    reorder: createReorder(deps),
    calls,
    remembered: () => remembered,
    events,
    persisted,
    kept: () => kept,
    failPersist: (error) => {
      failWith = error;
    },
  };
}

function view(over: Partial<ViewMessage> = {}): ViewMessage {
  return { t: 'view', filter: '', unfolded: [], showDone: false, selected: null, ...over };
}

describe('the reorder act on the server (F37)', () => {
  test('a move: the slots of the plan go to setSlots, then the restore order remembers them', () => {
    const { reorder, calls, remembered } = glue();
    assert.deepEqual(reorder.reorder(view(), S2, 'up'), { ok: true });
    assert.equal(remembered(), 1);
    assert.deepEqual(glue().reorder.reorder(view(), S1, 'up').ok, false);
    const refused = glue(() => 'changed');
    refused.reorder.reorder(view(), S2, 'up');
    assert.equal(refused.remembered(), 0, 'nothing moved: nothing remembered');
    assert.deepEqual(calls, [
      new Map([
        ['000000000002', 1],
        ['000000000001', 2],
      ]),
    ]);
  });

  test('words or a chip in the page’s view: the filter line, nothing changed; Show done is no filter', () => {
    for (const over of [
      { filter: 'demo' },
      { chips: ['running' as const] },
      { filter: ' ', chips: ['done' as const] },
    ]) {
      const { reorder, calls } = glue();
      assert.deepEqual(reorder.reorder(view(over), S2, 'up'), {
        ok: false,
        error: REORDER_REFUSALS.filter,
      });
      assert.deepEqual(calls, []);
    }
    const { reorder, calls } = glue();
    assert.deepEqual(reorder.reorder(view({ showDone: true, filter: '  ' }), S2, 'up'), {
      ok: true,
    });
    assert.equal(calls.length, 1);
  });

  test("the rule's refusal: nothing goes to the registry", () => {
    const { reorder, calls } = glue();
    assert.deepEqual(reorder.reorder(view(), S1, 'up'), {
      ok: false,
      error: REORDER_REFUSALS.top,
    });
    assert.deepEqual(calls, []);
  });

  test("the registry's refusals: the list changed meanwhile; the server is stopping", () => {
    assert.deepEqual(glue(() => 'changed').reorder.reorder(view(), S2, 'up'), {
      ok: false,
      error: REORDER_REFUSALS.changed,
    });
    assert.deepEqual(glue(() => 'stopping').reorder.reorder(view(), S2, 'up'), {
      ok: false,
      error: SERVER_STOPPING,
    });
  });

  test('F42: the plan’s order goes to persist with the moved slots; it is adopted last, before the registry announces the change', () => {
    const { reorder, events, persisted, kept } = glue();
    assert.deepEqual(reorder.reorder(view(), S2, 'up'), { ok: true });
    assert.deepEqual(events, ['persist', 'adopt', 'changed']);
    assert.deepEqual(persisted, [
      {
        moved: new Map([
          ['000000000002', 1],
          ['000000000001', 2],
        ]),
        order: [S2, S1],
      },
    ]);
    assert.deepEqual(kept(), [S2, S1]);
    // The next move reads the kept order: S1 up again.
    assert.deepEqual(reorder.reorder(view(), S1, 'up'), { ok: true });
    assert.deepEqual(kept(), [S1, S2]);
  });

  test('F42: a persist that throws: thrown, nothing adopted, no slot applied', () => {
    const { reorder, events, kept, failPersist } = glue();
    failPersist(
      Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
    );
    assert.throws(() => reorder.reorder(view(), S2, 'up'), /locked/);
    assert.deepEqual(events, []);
    assert.deepEqual(kept(), []);
  });

  test('a store that cannot be written: thrown, for the act to answer busy', () => {
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    const { reorder } = glue(() => {
      throw busy;
    });
    assert.throws(() => reorder.reorder(view(), S2, 'up'), /locked/);
  });
});

test('a session two terminals of the window show: a move of it, or of a row that would pass it, that would not read as intended is refused with its own line, nothing changed', () => {
  // S1 in slot 1 and, after a `/resume` inside a terminal, in slot 2 too; S2 and S3 a block in 3, 4.
  // Moved past the block S1 would get 4: its row would go to the terminal in slot 2, and the numbers
  // would read 1 3 2.
  const calls: Map<string, number | null>[] = [];
  let remembered = 0;
  const twin = { ...terminal(5, S1), slot: 2 };
  const reorder = createReorder({
    registry: {
      list: () => [terminal(1, S1), twin, { ...terminal(3, S2) }, { ...terminal(4, S3) }],
      setSlots(changes) {
        calls.push(new Map(changes));
        return 'ok';
      },
    },
    rows: () =>
      rows([running(S1, 4001), running(S2, 4003), running(S3, 4004)], {
        metas: [meta(S2, { group: 'G' }), meta(S3, { group: 'G' })],
      }),
    elsewhere: () => new Map(),
    nowNs: () => T0,
    openOrder: { ids: () => [], adopt: () => {} },
    persist: () => {},
    remember: () => {
      remembered += 1;
    },
  });
  assert.deepEqual(reorder.reorder(view(), S1, 'down'), {
    ok: false,
    error: 'a session here is shown by two terminals; close one of them first',
  });
  assert.equal(
    REORDER_REFUSALS.twins,
    'a session here is shown by two terminals; close one of them first',
  );
  // A session with one terminal that would pass it: the block moved up past S1 would get slots 1
  // and 3, S1 slot 4, and S1's row would go to its terminal in slot 2 (numbers 1 3 2): refused too.
  assert.deepEqual(reorder.reorder(view(), S2, 'up'), {
    ok: false,
    error: REORDER_REFUSALS.twins,
  });
  assert.deepEqual(calls, []);
  assert.equal(remembered, 0);
  // A move the twin does not spoil goes through: S3 up inside the block.
  assert.deepEqual(reorder.reorder(view(), S3, 'up'), { ok: true });
  assert.equal(calls.length, 1);
});

test("F42: the page's Show done reaches the rule: past a hidden copy the move is one visible step, a Show done page moves past the copy", () => {
  // S1 in slot 1, the empty copy S3 (another terminal's, hidden without Show done), S2 in slot 2;
  // kept in that order.
  const original = '4f9d7a5c-2b6e-4dae-9a7b-6c5d4e3f2a1b';
  const copy = ds({
    id: S3,
    state: 'running',
    holders: [
      {
        process: { bootId: BOOT_A, pid: 9003, procStart: 100 },
        sinceNs: T0,
        live: null,
        scripted: false,
      },
    ],
    marks: ['continued', 'empty-copy'],
    continuedFrom: original,
    copyOf: original,
    transcript: { aiTitle: 'made-up title', lastUserNs: null, lastTurnRole: null },
  });
  const orders = (showDone: boolean): string[][] => {
    const persisted: string[][] = [];
    const reorder = createReorder({
      registry: {
        list: () => [terminal(1, S1), terminal(2, S2)],
        setSlots(changes, write) {
          write?.(new Map(changes));
          return 'ok';
        },
      },
      rows: () =>
        rows([
          running(S1, 4001),
          running(S2, 4002),
          copy,
          ds({ id: original, transcript: { aiTitle: 'made-up title' } }),
        ]),
      elsewhere: () => new Map([[S3, { pid: 9003, tty: null }]]),
      nowNs: () => T0,
      openOrder: { ids: () => [S1, S3, S2], adopt: () => {} },
      persist: (_moved, order) => {
        persisted.push([...order]);
      },
    });
    assert.deepEqual(reorder.reorder(view({ showDone }), S2, 'up'), { ok: true });
    return persisted;
  };
  // Without Show done S2 passes S1 (the copy stays after S1, the row it followed).
  assert.deepEqual(orders(false), [[S2, S1, S3]]);
  // With Show done S2 passes the copy.
  assert.deepEqual(orders(true), [[S1, S2, S3]]);
});

test('F42: both or neither — a store whose second write throws keeps neither key, the kept order in memory stays, the move is thrown as busy', (t) => {
  const d = testDeck(t);
  const store = d.deck.store;
  store.setKv('window_slots', JSON.stringify({ '000000000009': 3 }));
  store.setKv('window_open_order', JSON.stringify([S1, S2]));
  const busy = (): Error =>
    Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  // The store as the move sees it: the second write, Open's order, meets a busy database.
  const failing = {
    transaction: <T>(fn: () => T): T => store.transaction(fn),
    setKv: (key: KvKey, value: string): void => {
      if (key === 'window_open_order') throw busy();
      store.setKv(key, value);
    },
    deleteKv: (key: KvKey): void => {
      store.deleteKv(key);
    },
  };
  let kept: readonly string[] = [S1, S2];
  let applied = 0;
  const reorder = createReorder({
    registry: {
      list: () => [terminal(1, S1), terminal(2, S2)],
      setSlots(changes, write) {
        write?.(new Map(changes)); // throws: nothing applied
        applied += 1;
        return 'ok';
      },
    },
    rows: () => rows([running(S1, 4001), running(S2, 4002)]),
    elsewhere: () => new Map(),
    nowNs: () => T0,
    openOrder: {
      ids: () => kept,
      adopt: (ids) => {
        kept = ids;
      },
    },
    persist: (moved, order) => {
      persistMove(failing, moved, order);
    },
  });
  assert.throws(
    () => reorder.reorder(view(), S2, 'up'),
    (error: unknown) => isBusy(error),
  );
  assert.equal(store.getKv('window_slots'), JSON.stringify({ '000000000009': 3 }));
  assert.equal(store.getKv('window_open_order'), JSON.stringify([S1, S2]));
  assert.deepEqual(kept, [S1, S2]);
  assert.equal(applied, 0);
});
