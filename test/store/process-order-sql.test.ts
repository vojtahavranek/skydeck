// The store's SQL of design 5.3 "Order" (#207: PROCESS_RULE in src/store/store.ts) gives the same
// answers as the TypeScript rule (src/sessions/process-order.ts), on processes made at random: with
// and without uptimes, inverted stamps, ties of time and of uptime, events of other processes
// beside them, and the place of an event that is not stored yet.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { byUptime, processOrder } from '../../src/sessions/process-order.ts';
import type { Ordered } from '../../src/sessions/process-order.ts';
import { openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import type { EventRow, NewEvent, ProcessPlace } from '../../src/store/types.ts';
import { sandbox } from '../helpers/sandbox.ts';

const BOOT = 'boot-a';
const START = 51234567;
const T0 = 1_795_000_000_000_000_000n;

/** A small fixed-seed generator (mulberry32), so that a failure can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function store(t: TestContext): Store {
  const opened = openStore(join(sandbox(t).root, 'skydeck.db'));
  t.after(() => {
    opened.close();
  });
  return opened;
}

function event(over: Partial<NewEvent>): NewEvent {
  return {
    spoolName: null,
    timeNs: T0,
    kind: 'start',
    detail: 'startup',
    rawDetail: null,
    sessionId: '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d',
    bootId: BOOT,
    pid: 4242,
    procStart: START,
    cwd: null,
    argv: null,
    name: null,
    payload: null,
    ...over,
  };
}

/** The ids of `events` in the TS rule's order. */
function order(events: readonly Ordered[]): number[] {
  return processOrder(events).map((one) => one.id);
}

/** A process: boot, pid and process start (null: none recorded). */
interface Key {
  bootId: string;
  pid: number;
  procStart: number | null;
}

/**
 * Four processes of ONE pid — two process starts, none, and the same start in another boot: a pid
 * used again, and the shapes that must never be taken for one another — each with its own share
 * of events without an uptime, made from `next`, stored mixed; the stored events of each.
 */
function filled(s: Store, pid: number, next: () => number, count: number): Map<Key, EventRow[]> {
  const keys: [Key, number][] = [
    [{ bootId: BOOT, pid, procStart: START }, [0, 0.1, 0.5, 1][Math.floor(next() * 4)] ?? 0],
    [{ bootId: BOOT, pid, procStart: START + 1 }, [0, 1][Math.floor(next() * 2)] ?? 0],
    [{ bootId: BOOT, pid, procStart: null }, [0, 1][Math.floor(next() * 2)] ?? 0],
    [{ bootId: 'boot-b', pid, procStart: START }, [0, 1][Math.floor(next() * 2)] ?? 0],
  ];
  s.transaction(() => {
    for (let i = 0; i < count; i++) {
      const [key, withoutUptime] = keys[Math.floor(next() * keys.length)]!;
      s.insertEvent(
        event({
          // Few distinct times and uptimes, so that ties are common, in no relation to each other.
          timeNs: T0 + BigInt(Math.floor(next() * 6)),
          ...(next() < withoutUptime ? {} : { uptimeCs: BigInt(Math.floor(next() * 6)) }),
          kind: next() < 0.5 ? 'start' : 'end',
          argv: next() < 0.4 ? ['claude'] : null,
          ...key,
        }),
      );
    }
  });
  const all = s.events();
  return new Map(
    keys.map(([key]) => [
      key,
      all.filter(
        (one) =>
          one.bootId === key.bootId && one.pid === key.pid && one.procStart === key.procStart,
      ),
    ]),
  );
}

const shown = (events: readonly EventRow[]): string =>
  JSON.stringify(events.map((e) => [e.id, String(e.timeNs), String(e.uptimeCs)]));

describe('the process order in SQL is the TypeScript rule (#207)', () => {
  test('first, latest, the rule and the latest stamp on 300 x 4 processes made at random', (t) => {
    const next = random(207);
    const s = store(t);
    for (let round = 0; round < 300; round++) {
      const PID = 1000 + round;
      for (const [key, own] of filled(s, PID, next, 4 + Math.floor(next() * 30))) {
        const { bootId, pid, procStart } = key;
        const ordered = order(own);
        const what = `round ${round}, ${JSON.stringify(key)}: ${shown(own)}`;
        assert.equal(s.processOrderedByUptime(bootId, pid, procStart), byUptime(own), what);
        assert.equal(
          s.latestEventOfProcess(bootId, pid, procStart, null)?.id,
          ordered.at(-1),
          what,
        );
        assert.equal(s.firstEventOfProcess(bootId, pid, procStart)?.id, ordered[0], what);
        const stamps = own.map((e) => e.timeNs);
        assert.equal(
          s.latestStampOfProcess(bootId, pid, procStart),
          stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b)),
          what,
        );
        // The rule is the whole process's: a subset is not ordered by its own.
        const launches = new Set(
          own.filter((e) => e.kind === 'start' && e.argv !== null).map((e) => e.id),
        );
        assert.equal(
          s.firstEventOfProcess(bootId, pid, procStart, { startWithLaunch: true })?.id,
          ordered.find((id) => launches.has(id)),
          what,
        );
      }
    }
  });

  test('the events before a place not stored yet, on 300 x 4 processes made at random', (t) => {
    const next = random(202);
    const s = store(t);
    for (let round = 0; round < 300; round++) {
      const PID = 1000 + round;
      for (const [key, own] of filled(s, PID, next, 4 + Math.floor(next() * 24))) {
        const { bootId, pid, procStart } = key;
        const place: ProcessPlace = {
          timeNs: T0 + BigInt(Math.floor(next() * 7)) - 1n,
          ...(next() < 0.8 ? { uptimeCs: BigInt(Math.floor(next() * 7)) - 1n } : {}),
        };
        // The place is an event stored after all of them: the highest id.
        const placed = { id: Number.MAX_SAFE_INTEGER, ...place };
        const ordered = order([...own, placed]);
        const before = ordered.slice(0, ordered.indexOf(placed.id));
        const what = `round ${round}, ${JSON.stringify(key)}: ${shown(own)} place ${String(place.timeNs)} ${String(place.uptimeCs)}`;
        assert.equal(
          s.latestEventOfProcess(bootId, pid, procStart, place)?.id,
          before.at(-1),
          what,
        );
        assert.equal(
          s.firstEventOfProcess(bootId, pid, procStart, { before: place })?.id,
          before[0],
          what,
        );
        const launches = new Set(
          own.filter((e) => e.kind === 'start' && e.argv !== null).map((e) => e.id),
        );
        assert.equal(
          s.firstEventOfProcess(bootId, pid, procStart, { before: place, startWithLaunch: true })
            ?.id,
          before.find((id) => launches.has(id)),
          what,
        );
      }
    }
  });

  test('a process with no event: no latest, no first, ordered by uptime', (t) => {
    const s = store(t);
    const PID = 4242;
    assert.equal(s.latestEventOfProcess(BOOT, PID, START, null), null);
    assert.equal(s.latestEventOfProcess(BOOT, PID, START, { timeNs: T0 }), null);
    assert.equal(s.firstEventOfProcess(BOOT, PID, START), null);
    assert.equal(s.processOrderedByUptime(BOOT, PID, START), true);
    assert.equal(s.latestStampOfProcess(BOOT, PID, START), null);
  });

  test('latestStampOfProcess is the highest stamp of the process, whatever the order', (t) => {
    const s = store(t);
    const PID = 4242;
    s.insertEvent(event({ timeNs: T0 + 9n, uptimeCs: 1n }));
    s.insertEvent(event({ timeNs: T0 + 3n, uptimeCs: 2n }));
    s.insertEvent(event({ timeNs: T0 + 50n, pid: PID + 1 }));
    assert.equal(s.latestStampOfProcess(BOOT, PID, START), T0 + 9n);
    assert.equal(s.latestEventOfProcess(BOOT, PID, START, null)?.timeNs, T0 + 3n, 'by uptime');
  });
});
