// Follow-up F37 (design 7.8): the window's memory of the slots each session held in this boot —
// written only when it changes, one holder per session and slot, a store that fails logged once
// and tried again at the next update, never a throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NS_PER_DAY } from '../../src/platform/time.ts';
import {
  parseRememberedSlots,
  rememberSlots,
  formatRememberedSlots,
} from '../../src/sessions/restore-order.ts';
import type { KvKey } from '../../src/store/types.ts';
import type { TerminalInfo, TerminalState } from '../../src/window/hub.ts';
import { createSlotMemory } from '../../src/window/slot-memory.ts';
import { BOOT_A, BOOT_B, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

function terminal(
  n: number,
  slot: number | null,
  sessionId: string | null,
  over: { expected?: string; state?: TerminalState } = {},
): TerminalInfo {
  return {
    id: n.toString(16).padStart(12, '0'),
    slot,
    state: over.state ?? 'running',
    sessionId,
    expectedSessionId: over.expected ?? sessionId ?? S1,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: null,
    openedNs: T0 - NS_PER_DAY + BigInt(n) * SEC,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
  };
}

function store(initial: string | null = null): {
  writes: string[];
  failWith: unknown;
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
} {
  let value = initial;
  const kept = {
    writes: [] as string[],
    failWith: null as unknown,
    getKv: (key: KvKey) => (key === 'window_restore_order' ? value : null),
    setKv(key: KvKey, text: string) {
      if (kept.failWith !== null) throw kept.failWith;
      assert.equal(key, 'window_restore_order');
      value = text;
      kept.writes.push(text);
    },
  };
  return kept;
}

function sessionsOf(text: string | undefined, bootId = BOOT_B): Record<string, number> {
  const part = parseRememberedSlots(text ?? null).find((one) => one.bootId === bootId);
  return Object.fromEntries(part?.sessions ?? []);
}

test("each session with the slot of its terminal, in this boot's part; written once per change", () => {
  const kept = store();
  const logs: string[] = [];
  const memory = createSlotMemory({ store: kept, bootId: BOOT_B, log: (line) => logs.push(line) });
  memory.update([
    terminal(1, 1, S1),
    terminal(2, 2, null, { expected: S2 }),
    terminal(3, null, S3),
  ]);
  assert.equal(kept.writes.length, 1);
  assert.deepEqual(sessionsOf(kept.writes[0]), { [S1]: 1, [S2]: 2 });
  memory.update([terminal(1, 1, S1), terminal(2, 2, null, { expected: S2 })]);
  assert.equal(kept.writes.length, 1, 'nothing changed: nothing written');
  memory.update([terminal(1, 2, S1), terminal(2, 1, S2)]);
  assert.equal(kept.writes.length, 2);
  assert.deepEqual(sessionsOf(kept.writes[1]), { [S2]: 1, [S1]: 2 });
  memory.update([]);
  assert.equal(kept.writes.length, 2, 'a terminal that goes is not forgotten');
  assert.deepEqual(logs, []);
});

test("one slot per session: the terminal whose program may still run first, then the lower slot; the earlier boot's part kept", () => {
  const earlier = formatRememberedSlots(rememberSlots([], BOOT_A, new Map([[S3, 1]])));
  const kept = store(earlier);
  const memory = createSlotMemory({ store: kept, bootId: BOOT_B, log: () => {} });
  memory.update([terminal(1, 1, S1, { state: 'ended' }), terminal(2, 3, S1), terminal(3, 2, S1)]);
  assert.deepEqual(sessionsOf(kept.writes[0]), { [S1]: 2 });
  assert.deepEqual(sessionsOf(kept.writes[0], BOOT_A), { [S3]: 1 });
});

test('a busy store: logged once, tried again at the next update; it never throws', () => {
  const kept = store();
  const logs: string[] = [];
  const memory = createSlotMemory({ store: kept, bootId: BOOT_B, log: (line) => logs.push(line) });
  kept.failWith = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
  memory.update([terminal(1, 1, S1)]);
  memory.update([terminal(1, 1, S1)]);
  assert.deepEqual(logs, ['restore order: the slots were not remembered (the database is busy)']);
  kept.failWith = null;
  memory.update([terminal(1, 1, S1)]);
  assert.equal(kept.writes.length, 1);
  assert.deepEqual(sessionsOf(kept.writes[0]), { [S1]: 1 });
});
