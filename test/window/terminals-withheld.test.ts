// Follow-up F44 (S2 7.6): the registry withholds the slot of a terminal the server names (its
// session is parked; the registry knows no session). `withholdSlots` names the whole set each time:
// a terminal that enters gives its slot up at once, one that leaves takes the lowest free slot or
// none; the set is written with the moved slots (`persistSlots`) before anything is applied, kept
// across a reconnect and a restart (`withheldSlots`, the store's `window_slots_withheld`), and
// dropped with the terminal. After every operation no two listed terminals hold one slot.
// Platform: realTestPlatform; real keepers running the stand-in (not started: no G).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { KeeperSpec } from '../../src/window/frames.ts';
import { KeeperStartError } from '../../src/window/terminals.ts';
import { sleep, until } from '../helpers/keeper.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';

/** What a store busy past its timeout throws (node:sqlite, SQLITE_BUSY). */
function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

interface Written {
  moved: Map<string, number | null>;
  withheld: Set<string>;
}

/** A `persistSlots` that records each write, or throws `failWith` while it is set; `during` is
 *  called inside each write before it is recorded (what the registry shows while it writes). */
function store(initial: Written = { moved: new Map(), withheld: new Set() }): {
  writes: Written[];
  latest(): Written;
  failWith: unknown;
  during: (() => void) | null;
  persist(moved: ReadonlyMap<string, number | null>, withheld: ReadonlySet<string>): void;
} {
  let latest: Written = { moved: new Map(initial.moved), withheld: new Set(initial.withheld) };
  const kept = {
    writes: [] as Written[],
    latest: () => latest,
    failWith: null as unknown,
    during: null as (() => void) | null,
    persist(moved: ReadonlyMap<string, number | null>, withheld: ReadonlySet<string>): void {
      kept.during?.();
      if (kept.failWith !== null) throw kept.failWith;
      latest = { moved: new Map(moved), withheld: new Set(withheld) };
      kept.writes.push(latest);
    },
  };
  return kept;
}

let opened = 1_000n;

/** Spawns a keeper (not started) with meta slot `slot`, each opened later than the one before;
 *  its id. */
async function open(box: RegistryBox, r: TestRegistry, slot: number | null): Promise<string> {
  opened += 1n;
  const spec: KeeperSpec = box.spec({
    meta: { ...box.spec().meta, slot, openedNs: String(opened) },
  });
  await r.registry.spawn(spec);
  noSlotTwice(r);
  return spec.id;
}

function slotOf(r: TestRegistry, id: string): number | null {
  return info(r.registry, id).slot;
}

/** No two listed terminals hold one slot (asserted after every operation). */
function noSlotTwice(r: TestRegistry): void {
  const slots = r.registry.list().flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, `slots: ${slots.join(' ')}`);
}

function withhold(
  r: TestRegistry,
  ids: Iterable<string>,
): ReturnType<TestRegistry['registry']['withholdSlots']> {
  const answer = r.registry.withholdSlots(new Set(ids));
  noSlotTwice(r);
  return answer;
}

async function ended(r: TestRegistry, id: string): Promise<void> {
  r.registry.refuse(id, 'closing it');
  await until(() => info(r.registry, id).state === 'not-started', `terminal ${id} ended`);
  noSlotTwice(r);
}

/** Every connection of `r` cut; resolves once each listed terminal has said hello again. */
async function reconnected(r: TestRegistry): Promise<void> {
  const hellos = r.events.hello.length;
  const count = r.registry.list().length;
  for (const socket of r.sockets) socket.destroy();
  await until(() => r.events.hello.length >= hellos + count, 'the reconnect hellos', 10_000);
  await until(() => r.registry.list().every((term) => term.state === 'starting'), 'claimed');
  noSlotTwice(r);
}

describe('registry: withholdSlots, the call (F44)', () => {
  test('spawn has listed the terminal, with its meta slot, when it returns its promise', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const spec = box.spec({ meta: { ...box.spec().meta, slot: r.registry.nextSlot() } });
    const spawning = r.registry.spawn(spec);
    // No await yet: the registry lists it with its slot, so nextSlot gives the next one.
    assert.equal(slotOf(r, spec.id), 1);
    assert.equal(r.registry.nextSlot(), 2);
    await spawning;
    assert.equal(slotOf(r, spec.id), 1);
  });

  test('a withheld terminal has no slot at once, nextSlot gives its old one; the moved entry goes; written before the change, announced', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    assert.equal(
      r.registry.setSlots(
        new Map([
          [b, 3],
          [c, 2],
        ]),
      ),
      'ok',
    );
    let changes = 0;
    r.registry.onChange(() => {
      changes += 1;
    });
    const seen: (number | null)[] = [];
    kept.during = () => {
      seen.push(slotOf(r, b));
    };
    assert.equal(withhold(r, [b]), 'ok');
    assert.deepEqual(seen, [3], 'the write came while b still had its slot');
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, c)], [1, null, 2]);
    assert.equal(r.registry.nextSlot(), 3, "b's old slot is free");
    assert.deepEqual(kept.latest(), { moved: new Map([[c, 2]]), withheld: new Set([b]) });
    assert.ok(changes >= 1, 'announced');
    // Named again: nothing enters or leaves, nothing is written.
    const writes = kept.writes.length;
    assert.equal(withhold(r, [b]), 'unchanged');
    assert.equal(kept.writes.length, writes);
    // An id not listed is ignored.
    assert.equal(withhold(r, [b, '0123456789ab']), 'unchanged');
  });

  test('leaving takes the lowest free slot: its meta one (no entry) or another (an entry)', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    assert.equal(withhold(r, [a]), 'ok');
    assert.equal(withhold(r, []), 'ok');
    assert.equal(slotOf(r, a), 1, 'its meta slot, the lowest free one');
    assert.deepEqual(kept.latest(), { moved: new Map(), withheld: new Set() });
    assert.equal(withhold(r, [b]), 'ok');
    const c = await open(box, r, r.registry.nextSlot());
    assert.equal(slotOf(r, c), 2, "the next terminal takes b's slot");
    assert.equal(withhold(r, []), 'ok');
    assert.equal(slotOf(r, b), 3, 'b takes the lowest free one');
    assert.deepEqual(kept.latest(), { moved: new Map([[b, 3]]), withheld: new Set() });
  });

  test('one entering and one leaving in one call: the leaving one can take the entering one’s slot', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    assert.equal(withhold(r, [a]), 'ok');
    const c = await open(box, r, r.registry.nextSlot());
    assert.equal(slotOf(r, c), 1);
    assert.equal(withhold(r, [c]), 'ok');
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, c)], [1, 2, null]);
  });

  test('two that leave in one call take slots by opening time, not by the order named', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    assert.equal(withhold(r, [b, a]), 'ok');
    const d = await open(box, r, r.registry.nextSlot());
    assert.equal(slotOf(r, d), 1);
    assert.equal(withhold(r, []), 'ok');
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, c), slotOf(r, d)], [2, 4, 3, 1]);
  });

  test('all nine held: a leaving terminal takes none, kept as a null entry, and that none survives a reconnect', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    assert.equal(withhold(r, [a]), 'ok');
    for (let n = 0; n < 9; n += 1) await open(box, r, r.registry.nextSlot());
    assert.equal(r.registry.nextSlot(), null);
    assert.equal(withhold(r, []), 'ok');
    assert.equal(slotOf(r, a), null);
    assert.equal(kept.latest().moved.get(a), null, 'no slot although its meta has one');
    assert.equal(kept.latest().withheld.size, 0);
    await reconnected(r);
    assert.equal(slotOf(r, a), null, 'its hello keeps none');
  });

  test('a write that throws changes nothing, is logged once by kind, and the same call works later', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    kept.failWith = busyError();
    assert.equal(withhold(r, [a]), 'failed');
    assert.equal(withhold(r, [a]), 'failed');
    assert.deepEqual([slotOf(r, a), slotOf(r, b)], [1, 2]);
    assert.equal(r.registry.nextSlot(), 3, 'its slot is still held');
    assert.deepEqual(
      r.log.filter((line) => line.includes('withheld slots were not saved')),
      ['terminal registry: the withheld slots were not saved (the database is busy)'],
    );
    assert.deepEqual(kept.writes, []);
    kept.failWith = null;
    assert.equal(withhold(r, [a]), 'ok');
    assert.equal(slotOf(r, a), null);
    // Leaving, the write failing: it stays withheld, and leaves at the next call.
    kept.failWith = busyError();
    assert.equal(withhold(r, []), 'failed');
    assert.equal(slotOf(r, a), null);
    assert.equal(r.registry.nextSlot(), 1);
    kept.failWith = null;
    assert.equal(withhold(r, []), 'ok');
    assert.equal(slotOf(r, a), 1);
    assert.equal(
      r.log.filter((line) => line.includes('withheld slots were not saved')).length,
      2,
      'a failure after a success is logged again',
    );
  });

  test('after stopAll: stopping, nothing written', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    await r.registry.stopAll();
    assert.equal(r.registry.withholdSlots(new Set([a])), 'stopping');
    assert.deepEqual(kept.writes, []);
  });
});

describe('registry: a withheld slot over hellos (F44)', () => {
  test('a reconnect’s hello keeps a withheld terminal without a slot, though its meta slot is free, and writes nothing', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    assert.equal(withhold(r, [a]), 'ok');
    const writes = kept.writes.length;
    await reconnected(r);
    assert.deepEqual([slotOf(r, a), slotOf(r, b)], [null, 2]);
    assert.equal(kept.writes.length, writes, 'its hello writes nothing');
  });

  test('a new registry given the stored set keeps none at the hello, and gives a slot when the next call no longer names it', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r1, 1);
    const b = await open(box, r1, 2);
    assert.equal(withhold(r1, [a]), 'ok');
    r1.drop();
    const r2 = box.registry({
      movedSlots: kept.latest().moved,
      withheldSlots: kept.latest().withheld,
      persistSlots: kept.persist,
    });
    await r2.registry.rediscover();
    noSlotTwice(r2);
    assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [null, 2]);
    assert.equal(r2.registry.nextSlot(), 1);
    assert.equal(withhold(r2, [a]), 'unchanged', 'still withheld');
    assert.equal(withhold(r2, []), 'ok');
    assert.equal(slotOf(r2, a), 1);
  });

  test('the stored set lost: the terminal takes a slot at its hello and gives it up at the next call', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r1, 1);
    const b = await open(box, r1, 2);
    assert.equal(withhold(r1, [a]), 'ok');
    r1.drop();
    const r2 = box.registry({ persistSlots: kept.persist });
    await r2.registry.rediscover();
    noSlotTwice(r2);
    assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [1, 2], 'its meta slot, free');
    assert.equal(withhold(r2, [a]), 'ok');
    assert.equal(slotOf(r2, a), null);
    assert.equal(r2.registry.nextSlot(), 1);
  });

  test('a keeper still being found keeps its entry through a call and a write; found, it holds no slot', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r1, 1);
    const b = await open(box, r1, 2);
    assert.equal(withhold(r1, [a]), 'ok');
    r1.drop();
    const keeper = box.keeperOf(a);
    box.signalKeeper(keeper, 'SIGSTOP');
    const r2 = box.registry({
      withheldSlots: kept.latest().withheld,
      persistSlots: kept.persist,
    });
    let found: Promise<unknown> = Promise.resolve();
    try {
      found = r2.registry.rediscover();
      await until(() => r2.registry.list().length === 1, 'b found', 10_000);
      // b enters, a (not listed) is in no call's reach: its entry stays in what is written.
      assert.equal(withhold(r2, [b]), 'ok');
      assert.deepEqual(kept.latest().withheld, new Set([a, b]));
      assert.equal(withhold(r2, []), 'ok');
      assert.deepEqual(kept.latest().withheld, new Set([a]));
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await found;
    await until(() => r2.registry.list().length === 2, 'a found', 15_000);
    noSlotTwice(r2);
    assert.equal(slotOf(r2, a), null, 'withheld at its hello');
  });

  test('an id kept for a keeper that is gone is pruned at the next write', async (t) => {
    const box = await registrySandbox(t);
    const kept = store({ moved: new Map(), withheld: new Set(['0123456789ab']) });
    const r = box.registry({ withheldSlots: kept.latest().withheld, persistSlots: kept.persist });
    const a = await open(box, r, 1);
    assert.equal(withhold(r, [a]), 'ok');
    assert.deepEqual(kept.latest().withheld, new Set([a]));
  });
});

describe('registry: a withheld slot and the other slot rules (F44)', () => {
  test('setSlots refuses a slot for a withheld terminal and still moves the others', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    assert.equal(withhold(r, [b]), 'ok');
    const writes = kept.writes.length;
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 2],
          [b, 1],
        ]),
      ),
      'changed',
    );
    assert.equal(kept.writes.length, writes, 'nothing written');
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 3],
          [c, 1],
        ]),
      ),
      'ok',
    );
    noSlotTwice(r);
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, c)], [3, null, 1]);
    assert.deepEqual(kept.latest().withheld, new Set([b]), 'the set is written as it is');
    // A null for it is no slot gained: allowed.
    assert.equal(r.registry.setSlots(new Map([[b, null]])), 'ok');
  });

  test("the program's end and a close drop the entry, and write it", async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    assert.equal(withhold(r, [a, b, c]), 'ok');
    await ended(r, a);
    assert.deepEqual(kept.latest().withheld, new Set([b, c]), 'its end dropped it');
    assert.equal(withhold(r, [a, b, c]), 'unchanged', 'an ended terminal is ignored');
    assert.equal(slotOf(r, a), null);
    assert.equal(withhold(r, [b, c]), 'unchanged');
    await ended(r, b);
    assert.equal(r.registry.close(b), 'ok');
    assert.equal(r.registry.close(a), 'ok');
    assert.deepEqual(kept.latest().withheld, new Set([c]));
    noSlotTwice(r);
    assert.equal(withhold(r, []), 'ok');
    assert.equal(slotOf(r, c), 1, 'the freed slots are free');
  });

  test('terminals opening between calls never share a slot with one leaving', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) ids.push(await open(box, r, r.registry.nextSlot()));
    const [a, b] = ids as [string, string];
    assert.equal(withhold(r, [a, b]), 'ok');
    ids.push(await open(box, r, r.registry.nextSlot()));
    assert.equal(withhold(r, [b]), 'ok');
    ids.push(await open(box, r, r.registry.nextSlot()));
    assert.equal(withhold(r, [a]), 'ok');
    assert.equal(withhold(r, []), 'ok');
    await sleep(50);
    const slots = ids.map((id) => slotOf(r, id));
    assert.deepEqual([...slots].sort(), [1, 2, 3, 4, 5, 6]);
  });
});

describe('registry: a terminal withheld before its keeper started, whose spawn fails (F44)', () => {
  /** Spawns `spec`, names it to withholdSlots in the same step (as the server does for a parked
   *  session's terminal), and answers the spawn's error. */
  async function failing(
    r: TestRegistry,
    spec: KeeperSpec,
    between?: () => Promise<void>,
  ): Promise<unknown> {
    const spawning = r.registry.spawn(spec).then(
      () => null,
      (error: unknown) => error,
    );
    assert.equal(withhold(r, [spec.id]), 'ok', 'listed at once: it enters');
    await between?.();
    return spawning;
  }

  test('python3 missing: its id is out of the set and out of what was written last', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const bare = join(box.s.root, 'bare-bin');
    const platform = { ...box.tp.platform, env: { ...box.tp.platform.env, PATH: bare } };
    const r = box.registry({ platform, persistSlots: kept.persist });
    const spec = box.spec({ meta: { ...box.spec().meta, slot: 1 } });
    const error = await failing(r, spec);
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'python-missing');
    assert.deepEqual(r.registry.list(), []);
    assert.deepEqual(kept.latest().withheld, new Set(), 'written without it');
    assert.ok(kept.writes.length >= 2, 'the withholding, then the drop');
  });

  test('a keeper that ends at its start: its id is out of the set and out of what was written last', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const spec = { ...box.spec({ meta: { ...box.spec().meta, slot: 1 } }), argv: [] };
    const error = await failing(r, spec);
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'spawn-failed');
    assert.deepEqual(r.registry.list(), []);
    assert.deepEqual(kept.latest().withheld, new Set());
  });

  test('the registry stopped before the hello: forgotten, and nothing is written once stopped (the keeper may live: a later server finds it withheld)', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const slow = join(box.s.root, 'slow-bin');
    mkdirSync(slow);
    const script = join(slow, 'python3');
    writeFileSync(script, `#!/bin/sh\nsleep 2\nexec ${join(box.s.bin, 'python3')} "$@"\n`);
    chmodSync(script, 0o755);
    const platform = {
      ...box.tp.platform,
      env: { ...box.tp.platform.env, PATH: `${slow}:${box.s.bin}` },
    };
    const r = box.registry({ platform, persistSlots: kept.persist });
    const spec = box.spec({ meta: { ...box.spec().meta, slot: 1 } });
    let writes = 0;
    const error = await failing(r, spec, async () => {
      writes = kept.writes.length;
      await sleep(300);
      await r.registry.stopAll();
    });
    assert.ok(error instanceof KeeperStartError, String(error));
    assert.equal(error.kind, 'stopping');
    assert.deepEqual(r.registry.list(), []);
    assert.equal(kept.writes.length, writes, 'nothing written once stopped');
    // The keeper lives on: its pid line, by which the cleanup's killKeepersIn finds it.
    await until(
      () => existsSync(box.files.termPid(spec.id)),
      'the keeper came up after all (its pid line)',
      10_000,
    );
  });
});
