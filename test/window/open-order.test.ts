// Follow-up F42 (S2 12.1, 10.2): the kv entry `window_open_order`, Open's kept order. Read
// tolerantly, written whole, removed when empty; the freeze writes it once per change, never while
// nothing is kept or once the stop began, and a failed write is logged once and tried again.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { StoreNewerError } from '../../src/store/store.ts';
import type { KvKey } from '../../src/store/types.ts';
import {
  createOpenOrder,
  OPEN_ORDER_KEY,
  parseOpenOrder,
  readOpenOrder,
  writeOpenOrder,
} from '../../src/window/open-order.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';

/** What a store busy past its timeout throws (node:sqlite, SQLITE_BUSY). */
function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

function kv(initial: Partial<Record<KvKey, string>> = {}): {
  values: Map<KvKey, string>;
  writes: number;
  failWith: unknown;
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
} {
  const values = new Map<KvKey, string>(Object.entries(initial) as [KvKey, string][]);
  const store = {
    values,
    writes: 0,
    failWith: null as unknown,
    getKv: (key: KvKey) => values.get(key) ?? null,
    setKv(key: KvKey, value: string) {
      if (store.failWith !== null) throw store.failWith;
      store.writes += 1;
      values.set(key, value);
    },
    deleteKv(key: KvKey) {
      if (store.failWith !== null) throw store.failWith;
      store.writes += 1;
      values.delete(key);
    },
  };
  return store;
}

describe('the entry', () => {
  test('written and read back; empty removes it', () => {
    const store = kv();
    writeOpenOrder(store, [S3, S1, S2]);
    assert.equal(store.values.get(OPEN_ORDER_KEY), JSON.stringify([S3, S1, S2]));
    assert.deepEqual(readOpenOrder(store), [S3, S1, S2]);
    writeOpenOrder(store, []);
    assert.equal(store.values.has(OPEN_ORDER_KEY), false);
    assert.deepEqual(readOpenOrder(store), []);
  });

  test('read tolerantly: not JSON, not an array are none; non-ids and repeats left out; at most 500', () => {
    for (const text of ['[', 'not json', '3', '"x"', 'null', '{}', 'true']) {
      assert.deepEqual(parseOpenOrder(text), [], text);
    }
    assert.deepEqual(parseOpenOrder(null), []);
    assert.deepEqual(
      parseOpenOrder(JSON.stringify([S1, 'nope', 3, null, S2, S1, S3.toUpperCase()])),
      [S1, S2],
    );
    const many = Array.from(
      { length: 600 },
      (_, n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    );
    const read = parseOpenOrder(JSON.stringify(many));
    assert.equal(read.length, 500);
    assert.deepEqual(read, many.slice(0, 500));
  });
});

describe('createOpenOrder', () => {
  test('reads the entry when made; adopt holds a move’s order without writing', () => {
    const store = kv({ window_open_order: JSON.stringify([S2, S1]) });
    const order = createOpenOrder({ store, log: () => {}, stopping: () => false });
    assert.deepEqual(order.ids(), [S2, S1]);
    assert.equal(order.keeps(), true);
    order.adopt([S1, S2, S3]);
    assert.deepEqual(order.ids(), [S1, S2, S3]);
    assert.equal(store.writes, 0);
  });

  test('freeze writes once per change, nothing when unchanged; an empty one removes the entry', () => {
    const store = kv({ window_open_order: JSON.stringify([S2, S1]) });
    const order = createOpenOrder({ store, log: () => {}, stopping: () => false });
    order.freeze([S2, S1]);
    assert.equal(store.writes, 0);
    order.freeze([S2, S1, S3]);
    assert.equal(store.writes, 1);
    assert.deepEqual(readOpenOrder(store), [S2, S1, S3]);
    order.freeze([S2, S1, S3]);
    assert.equal(store.writes, 1);
    order.freeze([]);
    assert.equal(store.values.has(OPEN_ORDER_KEY), false);
    assert.equal(order.keeps(), false);
    // The kept order ended: nothing is written until a move adopts one again.
    order.freeze([S1]);
    assert.equal(store.writes, 2);
    assert.deepEqual(order.ids(), []);
  });

  test('nothing is kept: freeze writes nothing', () => {
    const store = kv();
    const order = createOpenOrder({ store, log: () => {}, stopping: () => false });
    assert.equal(order.keeps(), false);
    order.freeze([S1, S2]);
    assert.equal(store.writes, 0);
    assert.equal(store.values.has(OPEN_ORDER_KEY), false);
  });

  test('a busy store and a newer one: logged once by kind, memory takes it, written at the next freeze; never thrown', () => {
    const store = kv({ window_open_order: JSON.stringify([S1]) });
    const logs: string[] = [];
    const order = createOpenOrder({ store, log: (line) => logs.push(line), stopping: () => false });
    store.failWith = busyError();
    order.freeze([S1, S2]);
    order.freeze([S1, S2]);
    assert.deepEqual(order.ids(), [S1, S2]);
    store.failWith = new StoreNewerError('newer');
    order.freeze([S1, S2]);
    assert.deepEqual(logs, [
      'open order: the order of Open was not saved (the database is busy)',
      'open order: the order of Open was not saved (StoreNewerError)',
    ]);
    store.failWith = null;
    order.freeze([S1, S2]); // unchanged, but still to be written
    assert.deepEqual(readOpenOrder(store), [S1, S2]);
    assert.equal(store.writes, 1);
    order.freeze([S1, S2]);
    assert.equal(store.writes, 1);
  });

  test('an empty order whose removal failed: only the removal is written at the next freeze, also when a session opened meanwhile', () => {
    const store = kv({ window_open_order: JSON.stringify([S1]) });
    const order = createOpenOrder({ store, log: () => {}, stopping: () => false });
    store.failWith = busyError();
    order.freeze([]);
    assert.equal(order.keeps(), true);
    store.failWith = null;
    order.freeze([S2]);
    assert.equal(store.values.has(OPEN_ORDER_KEY), false);
    assert.equal(order.keeps(), false);
    assert.deepEqual(order.ids(), []);
  });

  test('nothing once the stop began', () => {
    const store = kv({ window_open_order: JSON.stringify([S1]) });
    let stopping = false;
    const order = createOpenOrder({ store, log: () => {}, stopping: () => stopping });
    stopping = true;
    order.freeze([S1, S2]);
    assert.equal(store.writes, 0);
    assert.deepEqual(order.ids(), [S1]);
  });
});
