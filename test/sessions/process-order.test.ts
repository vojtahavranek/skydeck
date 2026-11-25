// Design 5.3 "Order" (#207): one process's events by (uptime, time, id) when every one has an
// uptime, else by (time, id). The store's SQL of the same rule is held to this one in
// test/store/process-order-sql.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { byUptime, compareInProcess, processOrder } from '../../src/sessions/process-order.ts';
import type { Ordered } from '../../src/sessions/process-order.ts';

const SEC = 1_000_000_000n;
const T0 = 1_795_000_000n * SEC;

const ids = (events: readonly Ordered[]): number[] => events.map((event) => event.id);

describe('the order of one process (design 5.3 "Order", #207)', () => {
  test('stamps a step back inverted, uptimes in order: by uptime', () => {
    // A resume's start, then a /clear's end and start stamped 2.7 s back.
    const events: Ordered[] = [
      { id: 1, timeNs: T0, uptimeCs: 10_000n },
      { id: 2, timeNs: T0 - 2_700_000_000n + 900_000_000n, uptimeCs: 10_090n },
      { id: 3, timeNs: T0 - 2_700_000_000n + 950_000_000n, uptimeCs: 10_095n },
    ];
    assert.deepEqual(ids(processOrder([...events].reverse())), [1, 2, 3]);
    assert.equal(byUptime(events), true);
  });

  test('the same uptime (two events within 10 ms): by time, then by id', () => {
    const events: Ordered[] = [
      { id: 4, timeNs: T0 + 5n, uptimeCs: 7n },
      { id: 2, timeNs: T0 + 9n, uptimeCs: 7n },
      { id: 3, timeNs: T0 + 5n, uptimeCs: 7n },
      { id: 1, timeNs: T0, uptimeCs: 8n },
    ];
    assert.deepEqual(ids(processOrder(events)), [3, 4, 2, 1]);
  });

  test('one event without an uptime: the whole process by (time, id), every uptime left aside', () => {
    const events: Ordered[] = [
      { id: 1, timeNs: T0 + 3n * SEC, uptimeCs: 100n },
      { id: 2, timeNs: T0 + SEC },
      { id: 3, timeNs: T0 + 2n * SEC, uptimeCs: 300n },
      { id: 4, timeNs: T0 + 2n * SEC, uptimeCs: 50n },
    ];
    assert.equal(byUptime(events), false);
    assert.deepEqual(ids(processOrder(events)), [2, 3, 4, 1]);
  });

  test('a process begun under an older hook stays on (time, id) for its life', () => {
    // Its first events have no uptime; after an update of skydeck its later ones have one.
    const older: Ordered[] = [
      { id: 1, timeNs: T0 },
      { id: 2, timeNs: T0 + SEC },
    ];
    const later: Ordered[] = [
      { id: 3, timeNs: T0 + 5n * SEC, uptimeCs: 900n },
      { id: 4, timeNs: T0 + 4n * SEC, uptimeCs: 901n }, // stamped a step back
    ];
    assert.deepEqual(ids(processOrder([...later, ...older])), [1, 2, 4, 3]);
    for (let more = 5; more < 50; more++) {
      later.push({ id: more, timeNs: T0 + BigInt(more) * SEC, uptimeCs: BigInt(900 + more) });
    }
    assert.equal(byUptime([...older, ...later]), false, 'never by uptime while one has none');
  });

  test('a process none of whose events has an uptime: exactly as before #207, (time, id)', () => {
    const events: Ordered[] = [
      { id: 3, timeNs: T0 },
      { id: 1, timeNs: T0 + 1n },
      { id: 2, timeNs: T0 },
    ];
    assert.deepEqual(ids(processOrder(events)), [2, 3, 1]);
  });

  test('compareInProcess is a total order: antisymmetric, and 0 only for the same id', () => {
    const events: Ordered[] = [];
    for (let id = 1; id <= 30; id++) {
      events.push({
        id,
        timeNs: T0 + BigInt(id % 4),
        ...(id % 7 === 0 ? {} : { uptimeCs: BigInt(id % 3) }),
      });
    }
    // By uptime only where every event has one, as processOrder uses it.
    for (const [uptime, set] of [
      [true, events.filter((one) => one.uptimeCs !== undefined)],
      [false, events],
    ] as const) {
      for (const a of set) {
        for (const b of set) {
          const ab = compareInProcess(a, b, uptime);
          assert.equal(Math.sign(ab) + Math.sign(compareInProcess(b, a, uptime)), 0);
          assert.equal(ab === 0, a.id === b.id);
        }
      }
    }
  });

  test('processOrder leaves its argument as it was', () => {
    const events: Ordered[] = [
      { id: 2, timeNs: T0, uptimeCs: 2n },
      { id: 1, timeNs: T0, uptimeCs: 1n },
    ];
    processOrder(events);
    assert.deepEqual(ids(events), [2, 1]);
  });
});
