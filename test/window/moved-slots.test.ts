// Follow-up F37 (S2 7.6, 10.2): the kv entry `window_slots`, terminal id → slot moved by hand.
// Read tolerantly (what is not well formed is left out), written whole, removed when empty. F44:
// the kv entry `window_slots_withheld`, the terminals whose slot the server withholds, the same way.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KvKey } from '../../src/store/types.ts';
import {
  MOVED_SLOTS_KEY,
  readMovedSlots,
  readWithheldSlots,
  WITHHELD_SLOTS_KEY,
  writeMovedSlots,
  writeWithheldSlots,
} from '../../src/window/moved-slots.ts';

function kv(initial: Record<string, string> = {}): {
  values: Map<KvKey, string>;
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
} {
  const values = new Map<KvKey, string>(Object.entries(initial) as [KvKey, string][]);
  return {
    values,
    getKv: (key) => values.get(key) ?? null,
    setKv: (key, value) => {
      values.set(key, value);
    },
    deleteKv: (key) => {
      values.delete(key);
    },
  };
}

const A = '0123456789ab';
const B = 'ba9876543210';

test('the key is window_slots', () => {
  assert.equal(MOVED_SLOTS_KEY, 'window_slots');
});

test('written whole as a JSON object, read back; none removes the entry', () => {
  const store = kv();
  writeMovedSlots(
    store,
    new Map([
      [A, 2],
      [B, 9],
    ]),
  );
  assert.deepEqual(JSON.parse(store.values.get('window_slots') ?? ''), { [A]: 2, [B]: 9 });
  assert.deepEqual(
    readMovedSlots(store),
    new Map([
      [A, 2],
      [B, 9],
    ]),
  );
  writeMovedSlots(store, new Map());
  assert.equal(store.values.has('window_slots'), false);
  assert.deepEqual(readMovedSlots(store), new Map());
});

test('read tolerantly: not JSON, not an object, an array, null are none', () => {
  for (const text of ['{', 'not json', '3', '"x"', 'null', '[1, 2]', 'true']) {
    assert.deepEqual(readMovedSlots(kv({ window_slots: text })), new Map(), text);
  }
});

test('read tolerantly: entries with a bad id or a slot that is not a whole number 1–9 or null are left out', () => {
  const stored = JSON.stringify({
    [A]: 3,
    [B]: 0,
    '0123456789AB': 4, // upper case: no terminal id
    '0123456789a': 5, // 11 characters
    '0123456789abc': 6, // 13 characters
    '0123456789az': 7,
    aaaaaaaaaaaa: 10,
    bbbbbbbbbbbb: 2.5,
    cccccccccccc: '4',
    dddddddddddd: null,
    eeeeeeeeeeee: 9,
    ffffffffffff: 1,
  });
  assert.deepEqual(
    readMovedSlots(kv({ window_slots: stored })),
    new Map<string, number | null>([
      [A, 3],
      // F42: null is a slot a move took away.
      ['dddddddddddd', null],
      ['eeeeeeeeeeee', 9],
      ['ffffffffffff', 1],
    ]),
  );
});

test('F42: a slot taken away (null) is written and read back', () => {
  const store = kv({});
  writeMovedSlots(
    store,
    new Map([
      [A, 9],
      [B, null],
    ]),
  );
  assert.deepEqual(JSON.parse(store.values.get('window_slots') ?? ''), { [A]: 9, [B]: null });
  assert.deepEqual(
    readMovedSlots(store),
    new Map([
      [A, 9],
      [B, null],
    ]),
  );
});

test('F44: the key is window_slots_withheld; written as a JSON array in id order, read back; none removes the entry', () => {
  assert.equal(WITHHELD_SLOTS_KEY, 'window_slots_withheld');
  const store = kv();
  writeWithheldSlots(store, new Set([B, A]));
  assert.deepEqual(JSON.parse(store.values.get('window_slots_withheld') ?? ''), [A, B]);
  assert.deepEqual(readWithheldSlots(store), new Set([A, B]));
  writeWithheldSlots(store, new Set());
  assert.equal(store.values.has('window_slots_withheld'), false);
  assert.deepEqual(readWithheldSlots(store), new Set());
});

test('F44: the withheld terminals read tolerantly: not JSON or not an array is none; of an array, only terminal ids', () => {
  for (const text of ['[', 'not json', '3', '"x"', 'null', '{"a": 1}', 'true']) {
    assert.deepEqual(readWithheldSlots(kv({ window_slots_withheld: text })), new Set(), text);
  }
  const stored = JSON.stringify([A, '0123456789AB', '0123456789a', 5, null, [B], B, A]);
  assert.deepEqual(readWithheldSlots(kv({ window_slots_withheld: stored })), new Set([A, B]));
});
