// Follow-up F37 (design 7.8): the order a restore opens its sessions in — the slots they last had
// in the window, per boot; the record the window keeps of them (`window_restore_order`), merged,
// read tolerantly, and applied to a restore's entries.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatRememberedSlots,
  inRememberedOrder,
  parseRememberedSlots,
  readRememberedSlots,
  RESTORE_ORDER_KEY,
  rememberSlots,
} from '../../src/sessions/restore-order.ts';
import type { RememberedSlots } from '../../src/sessions/restore-order.ts';
import { BOOT_A, BOOT_B } from '../helpers/platform.ts';
import { BOOT_C, sid } from '../helpers/restore.ts';

/** A record as plain objects, for comparing. */
function plain(record: RememberedSlots): { bootId: string; sessions: Record<string, number> }[] {
  return record.map((part) => ({
    bootId: part.bootId,
    sessions: Object.fromEntries(part.sessions),
  }));
}

const holders = (pairs: [number, number][]): Map<string, number> =>
  new Map(pairs.map(([n, slot]) => [sid(n), slot]));

describe('rememberSlots', () => {
  test("the first write of a new boot goes first and keeps the earlier boot's part second", () => {
    const earlier = rememberSlots(
      [],
      BOOT_A,
      holders([
        [1, 1],
        [2, 2],
      ]),
    );
    const now = rememberSlots(earlier, BOOT_B, holders([[3, 1]]));
    assert.deepEqual(plain(now), [
      { bootId: BOOT_B, sessions: { [sid(3)]: 1 } },
      { bootId: BOOT_A, sessions: { [sid(1)]: 1, [sid(2)]: 2 } },
    ]);
  });

  test('a third boot drops the oldest', () => {
    let record = rememberSlots([], BOOT_A, holders([[1, 1]]));
    record = rememberSlots(record, BOOT_B, holders([[2, 1]]));
    record = rememberSlots(record, BOOT_C, holders([[3, 1]]));
    assert.deepEqual(
      record.map((part) => part.bootId),
      [BOOT_C, BOOT_B],
    );
  });

  test('a slot names its latest session, and a session one slot', () => {
    let record = rememberSlots(
      [],
      BOOT_A,
      holders([
        [1, 1],
        [2, 2],
      ]),
    );
    // sid(1) closed, sid(3) opened in its slot; sid(2) still in 2.
    record = rememberSlots(
      record,
      BOOT_A,
      holders([
        [3, 1],
        [2, 2],
      ]),
    );
    assert.deepEqual(plain(record), [{ bootId: BOOT_A, sessions: { [sid(3)]: 1, [sid(2)]: 2 } }]);
    // A session moved to another slot keeps only the new one.
    record = rememberSlots(record, BOOT_A, holders([[2, 4]]));
    assert.deepEqual(plain(record), [{ bootId: BOOT_A, sessions: { [sid(3)]: 1, [sid(2)]: 4 } }]);
  });

  test("a move's permutation is taken whole", () => {
    let record = rememberSlots(
      [],
      BOOT_A,
      holders([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
    record = rememberSlots(
      record,
      BOOT_A,
      holders([
        [1, 1],
        [3, 2],
        [2, 3],
      ]),
    );
    assert.deepEqual(plain(record), [
      { bootId: BOOT_A, sessions: { [sid(1)]: 1, [sid(3)]: 2, [sid(2)]: 3 } },
    ]);
  });

  test('no holders changes nothing: a terminal that goes is not forgotten, the earlier boot is kept', () => {
    const record = rememberSlots([], BOOT_A, holders([[1, 1]]));
    assert.equal(rememberSlots(record, BOOT_A, new Map()), record);
    assert.equal(rememberSlots(record, BOOT_B, new Map()), record);
    assert.deepEqual(rememberSlots([], BOOT_B, new Map()), []);
  });
});

describe('the record in the store', () => {
  test('written and read back the same; the key', () => {
    const record = rememberSlots(
      rememberSlots(
        [],
        BOOT_A,
        holders([
          [2, 2],
          [1, 5],
        ]),
      ),
      BOOT_B,
      holders([[3, 1]]),
    );
    const text = formatRememberedSlots(record);
    assert.deepEqual(plain(parseRememberedSlots(text)), plain(record));
    assert.deepEqual(
      plain(readRememberedSlots({ getKv: (key) => (key === RESTORE_ORDER_KEY ? text : null) })),
      plain(record),
    );
    assert.equal(RESTORE_ORDER_KEY, 'window_restore_order');
  });

  test('read tolerantly: what is not well formed is left out', () => {
    for (const text of [null, '', '{', '{}', '"x"', '3', 'null']) {
      assert.deepEqual(parseRememberedSlots(text), [], String(text));
    }
    const text = JSON.stringify([
      null,
      'x',
      { bootId: 'not-a-boot', sessions: { [sid(1)]: 1 } },
      { bootId: BOOT_A.toUpperCase(), sessions: {} },
      { bootId: BOOT_A, sessions: [] },
      {
        bootId: BOOT_A,
        sessions: {
          [sid(1)]: 1,
          [sid(2)]: 1, // the slot again: left out
          [sid(3)]: 0,
          [sid(4)]: 10,
          [sid(5)]: 2.5,
          [sid(6)]: '3',
          'not-a-session': 4,
          [sid(7)]: 9,
        },
      },
      { bootId: BOOT_A, sessions: { [sid(8)]: 2 } }, // the boot again
      { bootId: BOOT_B, sessions: {} },
      { bootId: BOOT_C, sessions: { [sid(9)]: 1 } }, // a third part
    ]);
    assert.deepEqual(plain(parseRememberedSlots(text)), [
      { bootId: BOOT_A, sessions: { [sid(1)]: 1, [sid(7)]: 9 } },
      { bootId: BOOT_B, sessions: {} },
    ]);
  });
});

describe('inRememberedOrder', () => {
  const entry = (n: number, bootId = BOOT_A) => ({ row: { id: sid(n) }, bootId });

  test('remembered ones first by slot, the rest after in their order', () => {
    const record = rememberSlots(
      [],
      BOOT_A,
      holders([
        [4, 1],
        [2, 3],
        [5, 2],
      ]),
    );
    const ordered = inRememberedOrder(
      [1, 2, 3, 4, 5].map((n) => entry(n)),
      record,
    );
    assert.deepEqual(
      ordered.map((one) => one.row.id),
      [4, 5, 2, 1, 3].map(sid),
    );
  });

  test("each entry looks in its own boot's part; equal slots of two boots keep their order", () => {
    const record = rememberSlots(
      rememberSlots(
        [],
        BOOT_A,
        holders([
          [1, 2],
          [3, 1],
        ]),
      ),
      BOOT_B,
      holders([
        [2, 1],
        [1, 9],
      ]),
    );
    const ordered = inRememberedOrder(
      [entry(1), entry(2, BOOT_B), entry(3), entry(4, BOOT_C)],
      record,
    );
    assert.deepEqual(
      ordered.map((one) => one.row.id),
      [2, 3, 1, 4].map(sid),
    );
  });

  test('no record: the order as given', () => {
    const entries = [3, 1, 2].map((n) => entry(n));
    assert.deepEqual(inRememberedOrder(entries, []), entries);
  });
});
