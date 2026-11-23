// Follow-up F37, F42 (design 7.8): the order a restore opens its sessions in — the order they last
// had under Open in the window, per boot; the record the window keeps of it
// (`window_restore_order`), merged, read tolerantly (F37's record by slot too), and applied to a
// restore's entries.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatRememberedOrder,
  inRememberedOrder,
  parseRememberedOrder,
  readRememberedOrder,
  RESTORE_ORDER_KEY,
  rememberOrder,
} from '../../src/sessions/restore-order.ts';
import type { RememberedOrder } from '../../src/sessions/restore-order.ts';
import { BOOT_A, BOOT_B } from '../helpers/platform.ts';
import { BOOT_C, sid } from '../helpers/restore.ts';

/** A record as plain objects, for comparing. */
function plain(record: RememberedOrder): { bootId: string; order: string[] }[] {
  return record.map((part) => ({ bootId: part.bootId, order: [...part.order] }));
}

const ids = (ns: readonly number[]): string[] => ns.map(sid);
const none = (): boolean => false;

describe('rememberOrder', () => {
  test("the first write of a new boot goes first and keeps the earlier boot's part second", () => {
    const earlier = rememberOrder([], BOOT_A, ids([1, 2]), none);
    const now = rememberOrder(earlier, BOOT_B, ids([3]), none);
    assert.deepEqual(plain(now), [
      { bootId: BOOT_B, order: ids([3]) },
      { bootId: BOOT_A, order: ids([1, 2]) },
    ]);
  });

  test('a third boot drops the oldest', () => {
    let record = rememberOrder([], BOOT_A, ids([1]), none);
    record = rememberOrder(record, BOOT_B, ids([2]), none);
    record = rememberOrder(record, BOOT_C, ids([3]), none);
    assert.deepEqual(
      record.map((part) => part.bootId),
      [BOOT_C, BOOT_B],
    );
  });

  test("a move's new order is taken whole", () => {
    let record = rememberOrder([], BOOT_A, ids([1, 2, 3]), none);
    record = rememberOrder(record, BOOT_A, ids([1, 3, 2]), none);
    assert.deepEqual(plain(record), [{ bootId: BOOT_A, order: ids([1, 3, 2]) }]);
  });

  test('a session that left and is still restorable stays after the nearest earlier session still there; one that is not goes', () => {
    // Old part W X Y Z: X ended normally, Y crashed.
    const record = rememberOrder([], BOOT_A, ids([1, 2, 3, 4]), none);
    const restorable = new Set([sid(3)]);
    const next = rememberOrder(record, BOOT_A, ids([1, 4]), (id) => restorable.has(id));
    assert.deepEqual(plain(next), [{ bootId: BOOT_A, order: ids([1, 3, 4]) }]);
    // None earlier left: first.
    const first = rememberOrder(record, BOOT_A, ids([4]), (id) => restorable.has(id));
    assert.deepEqual(plain(first), [{ bootId: BOOT_A, order: ids([3, 4]) }]);
  });

  test("Open empty changes nothing: a session that goes is not forgotten, the earlier boot's part is kept", () => {
    const record = rememberOrder([], BOOT_A, ids([1]), none);
    assert.equal(rememberOrder(record, BOOT_A, [], none), record);
    assert.equal(rememberOrder(record, BOOT_B, [], none), record);
    assert.deepEqual(rememberOrder([], BOOT_B, [], none), []);
  });
});

describe('the record in the store', () => {
  test('written and read back the same; the key', () => {
    const record = rememberOrder(
      rememberOrder([], BOOT_A, ids([2, 1]), none),
      BOOT_B,
      ids([3]),
      none,
    );
    const text = formatRememberedOrder(record);
    assert.deepEqual(JSON.parse(text), [
      { bootId: BOOT_B, order: ids([3]) },
      { bootId: BOOT_A, order: ids([2, 1]) },
    ]);
    assert.deepEqual(plain(parseRememberedOrder(text)), plain(record));
    assert.deepEqual(
      plain(readRememberedOrder({ getKv: (key) => (key === RESTORE_ORDER_KEY ? text : null) })),
      plain(record),
    );
    assert.equal(RESTORE_ORDER_KEY, 'window_restore_order');
  });

  test('read tolerantly: what is not well formed is left out', () => {
    for (const text of [null, '', '{', '{}', '"x"', '3', 'null']) {
      assert.deepEqual(parseRememberedOrder(text), [], String(text));
    }
    const text = JSON.stringify([
      null,
      'x',
      { bootId: 'not-a-boot', order: ids([1]) },
      { bootId: BOOT_A.toUpperCase(), order: [] },
      { bootId: BOOT_A, order: 'x' }, // neither an order nor F37's sessions: left out
      { bootId: BOOT_A, order: [sid(1), sid(1), 'not-a-session', 3, null, sid(7)] },
      { bootId: BOOT_A, order: ids([8]) }, // the boot again
      { bootId: BOOT_B, order: [] },
      { bootId: BOOT_C, order: ids([9]) }, // a third part
    ]);
    assert.deepEqual(plain(parseRememberedOrder(text)), [
      { bootId: BOOT_A, order: ids([1, 7]) },
      { bootId: BOOT_B, order: [] },
    ]);
    const many = JSON.stringify([
      { bootId: BOOT_A, order: ids(Array.from({ length: 600 }, (_, n) => n + 1)) },
    ]);
    assert.equal(parseRememberedOrder(many)[0]?.order.length, 500);
  });

  test("F37's record: a part's sessions read in the order of their slots, its bad entries left out", () => {
    const text = JSON.stringify([
      {
        bootId: BOOT_A,
        sessions: {
          [sid(7)]: 9,
          [sid(1)]: 2,
          [sid(2)]: 2, // the slot again: left out
          [sid(3)]: 0,
          [sid(4)]: 10,
          [sid(5)]: 2.5,
          [sid(6)]: '3',
          'not-a-session': 4,
          [sid(8)]: 1,
        },
      },
      { bootId: BOOT_B, sessions: [] }, // not an object: left out
    ]);
    assert.deepEqual(plain(parseRememberedOrder(text)), [
      { bootId: BOOT_A, order: ids([8, 1, 7]) },
    ]);
  });
});

describe('inRememberedOrder', () => {
  const entry = (n: number, bootId = BOOT_A) => ({ row: { id: sid(n) }, bootId });

  test('remembered ones first by place, the rest after in their order', () => {
    const record = rememberOrder([], BOOT_A, ids([4, 5, 2]), none);
    const ordered = inRememberedOrder(
      [1, 2, 3, 4, 5].map((n) => entry(n)),
      record,
    );
    assert.deepEqual(
      ordered.map((one) => one.row.id),
      ids([4, 5, 2, 1, 3]),
    );
  });

  test("each entry looks in its own boot's part; equal places of two boots keep their order", () => {
    const record = rememberOrder(
      rememberOrder([], BOOT_A, ids([3, 1]), none),
      BOOT_B,
      ids([2, 5]),
      none,
    );
    const ordered = inRememberedOrder(
      [entry(1), entry(2, BOOT_B), entry(3), entry(4, BOOT_C)],
      record,
    );
    // 2 (place 0 of B) and 3 (place 0 of A) tie: their order; then 1 (place 1); 4 has none.
    assert.deepEqual(
      ordered.map((one) => one.row.id),
      ids([2, 3, 1, 4]),
    );
  });

  test('no record: the order as given', () => {
    const entries = [3, 1, 2].map((n) => entry(n));
    assert.deepEqual(inRememberedOrder(entries, []), entries);
  });
});
