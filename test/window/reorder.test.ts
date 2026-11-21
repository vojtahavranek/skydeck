// Follow-up F37 (S2 12.9): `act reorder`'s glue on the server, with fakes — the page's view refuses
// a move while a filter or a chip is set; else the rule's plan goes to the registry's setSlots, and
// what the registry refuses is answered with its line; a store that cannot be written throws.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NS_PER_DAY } from '../../src/platform/time.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import type { ViewMessage } from '../../src/window/protocol.ts';
import { createReorder, SERVER_STOPPING } from '../../src/window/reorder.ts';
import type { ReorderDeps } from '../../src/window/reorder.ts';
import { REORDER_REFUSALS } from '../../src/window/view/slot-moves.ts';
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

/** S1 in slot 1, S2 in slot 2; setSlots records its calls and answers `answer`; `remembered`
 *  counts the calls of `remember`. */
function glue(answer: () => 'ok' | 'changed' | 'stopping' = () => 'ok'): {
  reorder: ReturnType<typeof createReorder>;
  calls: Map<string, number>[];
  remembered: () => number;
} {
  const calls: Map<string, number>[] = [];
  let remembered = 0;
  const deps: ReorderDeps = {
    registry: {
      list: () => [terminal(1, S1), terminal(2, S2)],
      setSlots(changes) {
        calls.push(new Map(changes));
        return answer();
      },
    },
    rows: () => rows([running(S1, 4001), running(S2, 4002)]),
    elsewhere: () => new Map(),
    nowNs: () => T0,
    remember: () => {
      remembered += 1;
    },
  };
  return { reorder: createReorder(deps), calls, remembered: () => remembered };
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

test('a session two terminals of the window show: a move that would not read as intended is refused with its own line, nothing changed', () => {
  // S1 in slot 1 and, after a `/resume` inside a terminal, in slot 2 too; S2 and S3 a block in 3, 4.
  // Moved past the block S1 would get 4: its row would go to the terminal in slot 2, and the numbers
  // would read 1 3 2.
  const calls: Map<string, number>[] = [];
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
    remember: () => {
      remembered += 1;
    },
  });
  assert.deepEqual(reorder.reorder(view(), S1, 'down'), {
    ok: false,
    error: 'this session is shown by two terminals; close one to move it',
  });
  assert.equal(
    REORDER_REFUSALS.twins,
    'this session is shown by two terminals; close one to move it',
  );
  assert.deepEqual(calls, []);
  assert.equal(remembered, 0);
  // A move the twin does not spoil goes through: S3 up inside the block.
  assert.deepEqual(reorder.reorder(view(), S3, 'up'), { ok: true });
  assert.equal(calls.length, 1);
});
