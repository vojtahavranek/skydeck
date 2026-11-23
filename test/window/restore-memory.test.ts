// Follow-up F37, F42 (design 7.8): the window's memory of the order of Open in this boot — written
// only when it changes, a session that left Open kept at its place while it is still a restore's
// candidate, a store that fails logged once and tried again at the next update, never a throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ListRow } from '../../src/sessions/list.ts';
import { parseRememberedOrder } from '../../src/sessions/restore-order.ts';
import type { KvKey } from '../../src/store/types.ts';
import { createRestoreMemory } from '../../src/window/restore-memory.ts';
import { ds, rows } from '../helpers/derived.ts';
import { BOOT_A, BOOT_B, S1, S2, S3, T0 } from '../helpers/platform.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

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

function orderOf(text: string | undefined, bootId = BOOT_B): string[] {
  return [
    ...(parseRememberedOrder(text ?? null).find((one) => one.bootId === bootId)?.order ?? []),
  ];
}

/** A session that ended unexpectedly (a restore's candidate), and one that ended normally. */
function crashed(id: string): ListRow['session'] {
  return ds({
    id,
    marks: ['ended-unexpectedly'],
    lastHolding: {
      process: { bootId: BOOT_B, pid: 4000, procStart: 1 },
      alive: false,
      endedAtNs: null,
      endDetail: null,
    },
  });
}

function endedNormally(id: string): ListRow['session'] {
  return ds({
    id,
    lastHolding: {
      process: { bootId: BOOT_B, pid: 4001, procStart: 1 },
      alive: false,
      endedAtNs: T0,
      endDetail: 'exit',
    },
  });
}

test("Open's order in this boot's part; written once per change; empty Open changes nothing", () => {
  const kept = store();
  const logs: string[] = [];
  const memory = createRestoreMemory({
    store: kept,
    bootId: BOOT_B,
    log: (line) => logs.push(line),
  });
  memory.update([S3, S1, S2], []);
  assert.equal(kept.writes.length, 1);
  assert.deepEqual(orderOf(kept.writes[0]), [S3, S1, S2]);
  memory.update([S3, S1, S2], []);
  assert.equal(kept.writes.length, 1, 'nothing changed: nothing written');
  memory.update([S1, S3, S2], []);
  assert.deepEqual(orderOf(kept.writes[1]), [S1, S3, S2]);
  memory.update([], []);
  assert.equal(kept.writes.length, 2, 'Open empty: nothing is forgotten');
  assert.deepEqual(logs, []);
});

test("a session that left Open stays at its place while it is still a restore's candidate; the earlier boot's part is kept", () => {
  const earlier = JSON.stringify([{ bootId: BOOT_A, order: [S4] }]);
  const kept = store(earlier);
  const memory = createRestoreMemory({ store: kept, bootId: BOOT_B, log: () => {} });
  memory.update([S1, S2, S3, S4], []);
  // S2 crashed, S3 ended normally, S4 is unknown to the rows.
  memory.update([S1], rows([crashed(S2), endedNormally(S3)]));
  assert.deepEqual(orderOf(kept.writes.at(-1)), [S1, S2]);
  assert.deepEqual(orderOf(kept.writes.at(-1), BOOT_A), [S4]);
});

test('a busy store: logged once, tried again at the next update; it never throws', () => {
  const kept = store();
  const logs: string[] = [];
  const memory = createRestoreMemory({
    store: kept,
    bootId: BOOT_B,
    log: (line) => logs.push(line),
  });
  kept.failWith = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
  memory.update([S1], []);
  memory.update([S1], []);
  assert.deepEqual(logs, [
    'restore order: the order of Open was not remembered (the database is busy)',
  ]);
  kept.failWith = null;
  memory.update([S1], []);
  assert.equal(kept.writes.length, 1);
  assert.deepEqual(orderOf(kept.writes[0]), [S1]);
});
