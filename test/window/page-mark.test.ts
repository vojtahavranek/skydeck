// The pages mark (plan C20, task 81): `kv` `window_pages_open` kept while pages are connected,
// and the window a server expects back when it found the mark at its start. On testDeck
// (testPlatform's fake clock, a real store in the sandbox); a store that fails is the deck's store
// with one method replaced (deckWith).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { NS_PER_MS } from '../../src/platform/time.ts';
import type { Store } from '../../src/store/store.ts';
import { createPageMark } from '../../src/window/page-mark.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import { SEC, T0 } from '../helpers/platform.ts';

const KEY = 'window_pages_open';

/** SQLite's "database is locked" as node:sqlite throws it. */
function busyError(): Error {
  return Object.assign(new Error('database is locked MARKER-7f3e'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
}

interface Marked {
  store: Store;
  logs: string[];
  /** The writes of the key the mark made, in order: 'set <value>' or 'delete'. */
  writes: string[];
  /** Makes the next `n` writes of the key (set or delete) fail as a busy store does. */
  failNext(n: number): void;
}

/** A deck's store whose writes of the key are recorded (and can be made to fail). */
function marked(t: TestContext, holds: string | null): Marked {
  const d = testDeck(t);
  if (holds !== null) d.deck.store.setKv(KEY, holds);
  const logs: string[] = [];
  const writes: string[] = [];
  let failing = 0;
  const write = (what: string, act: () => void): void => {
    if (failing > 0) {
      failing--;
      throw busyError();
    }
    writes.push(what);
    act();
  };
  const store = deckWith(d.deck, {
    store: {
      setKv: (key, value) => {
        write(`set ${value}`, () => {
          d.deck.store.setKv(key, value);
        });
      },
      deleteKv: (key) => {
        write('delete', () => {
          d.deck.store.deleteKv(key);
        });
      },
    },
  }).store;
  return {
    store,
    logs,
    writes,
    failNext(n) {
      failing = n;
    },
  };
}

function markOf(m: Marked) {
  return createPageMark({ store: m.store, log: (line) => m.logs.push(line) });
}

describe('createPageMark: foundAtStart', () => {
  test('true when the store holds the key at the start, false when it does not', (t) => {
    assert.equal(markOf(marked(t, '1')).foundAtStart, true);
    assert.equal(markOf(marked(t, null)).foundAtStart, false);
  });

  test('a value other than "1" is there too (the key, whatever a damaged store holds)', (t) => {
    assert.equal(markOf(marked(t, 'garbage')).foundAtStart, true);
  });

  test('a read that fails at the start: false — nothing is expected that cannot be known — and one line by kind', (t) => {
    const d = testDeck(t);
    d.deck.store.setKv(KEY, '1');
    const logs: string[] = [];
    const store = deckWith(d.deck, {
      store: {
        getKv: () => {
          throw busyError();
        },
      },
    }).store;

    const mark = createPageMark({ store, log: (line) => logs.push(line) });

    assert.equal(mark.foundAtStart, false);
    assert.deepEqual(logs, [
      'page mark: window_pages_open could not be read (Error (ERR_SQLITE_ERROR))',
    ]);
  });

  test('creating the mark writes nothing', (t) => {
    const m = marked(t, '1');
    markOf(m);
    assert.deepEqual(m.writes, []);
    assert.equal(m.store.getKv(KEY), '1');
  });
});

describe('createPageMark: update', () => {
  test('a mark left by a dead server is removed by the next server’s first refresh without a page', (t) => {
    const m = marked(t, '1');
    const mark = markOf(m);

    mark.update(0);

    assert.equal(m.store.getKv(KEY), null);
    assert.deepEqual(m.writes, ['delete']);
    assert.equal(mark.foundAtStart, true, 'what the start found stays');
  });

  test('then a page writes the key, a second page writes nothing, no page removes it', (t) => {
    const m = marked(t, '1');
    const mark = markOf(m);
    mark.update(0);

    mark.update(1);
    assert.equal(m.store.getKv(KEY), '1');
    mark.update(2);
    mark.update(1);
    assert.deepEqual(m.writes, ['delete', 'set 1'], 'no write while pages stay above 0');
    mark.update(0);
    assert.equal(m.store.getKv(KEY), null);
    mark.update(0);
    assert.deepEqual(m.writes, ['delete', 'set 1', 'delete'], 'none while they stay 0');
    assert.deepEqual(m.logs, []);
  });

  test('the first call writes whatever the store holds: the key it already has, a removal of a key it lacks', (t) => {
    const held = marked(t, 'garbage');
    markOf(held).update(1);
    assert.deepEqual(held.writes, ['set 1']);
    assert.equal(held.store.getKv(KEY), '1', 'a damaged value is made the mark');

    const none = marked(t, null);
    markOf(none).update(0);
    assert.deepEqual(none.writes, ['delete']);
    assert.equal(none.store.getKv(KEY), null);
  });

  test('a store that is busy at a write: one line by kind, and the write is made at the next call', (t) => {
    const m = marked(t, null);
    const mark = markOf(m);
    mark.update(0);

    m.failNext(1);
    mark.update(1);
    assert.equal(m.store.getKv(KEY), null, 'not written');
    assert.deepEqual(m.logs, [
      'page mark: window_pages_open could not be written (Error (ERR_SQLITE_ERROR))',
    ]);
    assert.ok(!m.logs.join('\n').includes('MARKER'), 'kinds only, never a message');

    mark.update(1);
    assert.equal(m.store.getKv(KEY), '1', 'written at the next call');
    assert.equal(m.logs.length, 1);
  });

  test('a removal that fails is made at the next call too — also when the pages came and went meanwhile', (t) => {
    const m = marked(t, '1');
    const mark = markOf(m);

    m.failNext(1);
    mark.update(0);
    assert.equal(m.store.getKv(KEY), '1');
    assert.deepEqual(m.logs, [
      'page mark: window_pages_open could not be removed (Error (ERR_SQLITE_ERROR))',
    ]);
    mark.update(0);
    assert.equal(m.store.getKv(KEY), null);

    mark.update(1);
    m.failNext(1);
    mark.update(0); // fails: the store still holds the key
    mark.update(1); // agrees with the store, but what the store holds is not known: written
    mark.update(0);
    assert.equal(m.store.getKv(KEY), null);
    assert.deepEqual(m.writes, ['delete', 'set 1', 'set 1', 'delete']);
  });

  test('an error that is not the store’s is logged by kind too, and the mark goes on', (t) => {
    const m = marked(t, null);
    const store = new Proxy(m.store, {
      get(target, key) {
        if (key === 'setKv') {
          return () => {
            throw new TypeError('MARKER-1b2c');
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const logs: string[] = [];
    const mark = createPageMark({ store, log: (line) => logs.push(line) });

    mark.update(1);

    assert.deepEqual(logs, ['page mark: window_pages_open could not be written (TypeError)']);
  });
});

describe('createPageMark: expectedMs (C20: the wait is the server’s fact)', () => {
  const ms = (n: number): bigint => BigInt(n) * NS_PER_MS;

  test('7,000 while the start is not done, whatever the time', (t) => {
    const mark = markOf(marked(t, '1'));
    assert.equal(mark.expectedMs(T0, null, 0), 7000);
    assert.equal(mark.expectedMs(T0 + 60n * SEC, null, 0), 7000);
  });

  test('counting down from the end of the start; null once 7 s have passed', (t) => {
    const mark = markOf(marked(t, '1'));
    const done = T0 + 3n * SEC;
    assert.equal(mark.expectedMs(done, done, 0), 7000);
    assert.equal(mark.expectedMs(done + ms(2500), done, 0), 4500);
    assert.equal(mark.expectedMs(done + ms(6999) + 1n, done, 0), 1, 'a part of a ms left is 1');
    assert.equal(mark.expectedMs(done + ms(7000), done, 0), null);
    assert.equal(mark.expectedMs(done + 60n * SEC, done, 0), null);
  });

  test('a whole number of ms, never 0', (t) => {
    const mark = markOf(marked(t, '1'));
    const done = T0;
    for (let ns = 0n; ns <= ms(7000); ns += 333_333_333n) {
      const left = mark.expectedMs(done + ns, done, 0);
      assert.ok(left === null || (Number.isSafeInteger(left) && left >= 1), String(left));
    }
  });

  test('a clock that stepped back after the start: never more than 7,000', (t) => {
    const mark = markOf(marked(t, '1'));
    const done = T0 + 10n * SEC;
    assert.equal(mark.expectedMs(done - ms(1800), done, 0), 7000);
    assert.equal(mark.expectedMs(done - 3600n * SEC, done, 0), 7000);
  });

  test('null once a page was seen: by this call, during the start too, and for good', (t) => {
    const mark = markOf(marked(t, '1'));
    const done = T0;
    assert.equal(mark.expectedMs(done, done, 0), 7000);
    assert.equal(mark.expectedMs(done + SEC, done, 1), null);
    assert.equal(mark.expectedMs(done + 2n * SEC, done, 0), null, 'the page went: still none');

    const starting = markOf(marked(t, '1'));
    assert.equal(starting.expectedMs(T0, null, 2), null);
    assert.equal(starting.expectedMs(T0, null, 0), null);
  });

  test('null once a page was seen by update — also when its write failed', (t) => {
    const seen = markOf(marked(t, '1'));
    seen.update(1);
    seen.update(0);
    assert.equal(seen.expectedMs(T0, T0, 0), null);

    const m = marked(t, '1');
    const failed = markOf(m);
    m.failNext(1);
    failed.update(3);
    assert.equal(m.logs.length, 1);
    assert.equal(failed.expectedMs(T0, null, 0), null);
  });

  test('null when nothing was found at the start', (t) => {
    const mark = markOf(marked(t, null));
    assert.equal(mark.expectedMs(T0, null, 0), null);
    assert.equal(mark.expectedMs(T0, T0, 0), null);
  });

  test('the first refresh’s removal does not end the expectation: it is a fact of the start', (t) => {
    const m = marked(t, '1');
    const mark = markOf(m);
    mark.update(0);
    assert.equal(m.store.getKv(KEY), null);
    assert.equal(mark.expectedMs(T0 + SEC, T0, 0), 6000);
  });
});
