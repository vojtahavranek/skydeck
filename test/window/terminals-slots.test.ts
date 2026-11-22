// Follow-up F37 (S2 7.6): slots moved by hand. The registry applies them over the keepers' meta
// slots at every hello, keeps them across a reconnect and a restart (through `movedSlots` and
// `persistSlots`, the store's `window_slots`), never lets two terminals share a slot, and writes the
// map at a move, at the forget of a moved terminal and at a hello that changed it — never once
// stopped. Platform: realTestPlatform; real keepers running the stand-in (not started: no G).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { StoreNewerError } from '../../src/store/store.ts';
import type { KeeperSpec } from '../../src/window/frames.ts';
import { sleep, until } from '../helpers/keeper.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';

/** What a store busy past its timeout throws (node:sqlite, SQLITE_BUSY). */
function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

/** A `persistSlots` that records each write, or throws `failWith` while it is set. */
function store(initial: ReadonlyMap<string, number> = new Map()): {
  writes: Map<string, number>[];
  latest(): Map<string, number>;
  failWith: unknown;
  persist(moved: ReadonlyMap<string, number>): void;
} {
  let latest = new Map(initial);
  const kept = {
    writes: [] as Map<string, number>[],
    latest: () => latest,
    failWith: null as unknown,
    persist(moved: ReadonlyMap<string, number>): void {
      if (kept.failWith !== null) throw kept.failWith;
      latest = new Map(moved);
      kept.writes.push(latest);
    },
  };
  return kept;
}

/** Spawns a keeper (not started) with meta slot `slot`; its id. */
async function open(box: RegistryBox, r: TestRegistry, slot: number | null): Promise<string> {
  const spec: KeeperSpec = box.spec({ meta: { ...box.spec().meta, slot } });
  await r.registry.spawn(spec);
  return spec.id;
}

function slotOf(r: TestRegistry, id: string): number | null {
  return info(r.registry, id).slot;
}

async function ended(r: TestRegistry, id: string): Promise<void> {
  r.registry.refuse(id, 'closing it');
  await until(() => info(r.registry, id).state === 'not-started', `terminal ${id} ended`);
}

describe('registry: setSlots (F37)', () => {
  test('applies the slots, writes the moved ones before, announces the change', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    let changes = 0;
    r.registry.onChange(() => {
      changes += 1;
    });
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 2],
          [b, 1],
        ]),
      ),
      'ok',
    );
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, c)], [2, 1, 3]);
    assert.deepEqual(
      kept.latest(),
      new Map([
        [a, 2],
        [b, 1],
      ]),
    );
    assert.ok(changes >= 1);
    // Moved back to their meta slots: nothing is kept for them.
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 1],
          [b, 2],
        ]),
      ),
      'ok',
    );
    assert.deepEqual(kept.latest(), new Map());
    assert.equal(r.registry.nextSlot(), 4);
  });

  test('a write that throws refuses the move: it is thrown, no slot changes', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    kept.failWith = busyError();
    assert.throws(
      () =>
        r.registry.setSlots(
          new Map([
            [a, 2],
            [b, 1],
          ]),
        ),
      /locked/,
    );
    assert.deepEqual([slotOf(r, a), slotOf(r, b)], [1, 2]);
    assert.deepEqual(kept.writes, []);
  });

  test('refused: an id not listed, a terminal without a slot, slots that are not the same set, a duplicate; after stopAll', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const none = await open(box, r, null);
    assert.equal(r.registry.setSlots(new Map([['0123456789ab', 1]])), 'changed');
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 2],
          [none, 1],
        ]),
      ),
      'changed',
    );
    assert.equal(r.registry.setSlots(new Map([[a, 3]])), 'changed');
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 2],
          [b, 2],
        ]),
      ),
      'changed',
    );
    assert.deepEqual([slotOf(r, a), slotOf(r, b), slotOf(r, none)], [1, 2, null]);
    await r.registry.stopAll();
    assert.equal(
      r.registry.setSlots(
        new Map([
          [a, 2],
          [b, 1],
        ]),
      ),
      'stopping',
    );
    assert.deepEqual(kept.writes, []);
  });
});

describe('registry: a moved slot over hellos (F37)', () => {
  test('a reconnect keeps the moved slot', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    r.registry.setSlots(
      new Map([
        [a, 2],
        [b, 1],
      ]),
    );
    const hellos = r.events.hello.length;
    r.sockets.find((socket) => !socket.destroyed)?.destroy();
    await until(() => r.events.hello.length > hellos, 'the reconnect hello', 10_000);
    await until(() => r.registry.list().every((term) => term.state === 'starting'), 'claimed');
    assert.deepEqual([slotOf(r, a), slotOf(r, b)], [2, 1]);
  });

  test('a new registry given the moved slots keeps every one, also a keeper still being found while another opens', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r1, 1);
    const b = await open(box, r1, 2);
    const c = await open(box, r1, 3);
    r1.registry.setSlots(
      new Map([
        [a, 3],
        [c, 1],
      ]),
    );
    r1.drop();
    // a's keeper does not answer: the new registry keeps trying to find it.
    const keeper = box.keeperOf(a);
    box.signalKeeper(keeper, 'SIGSTOP');
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    let found: Promise<unknown> = Promise.resolve();
    try {
      found = r2.registry.rediscover();
      await until(() => r2.registry.list().length === 2, 'b and c found', 10_000);
      assert.deepEqual([slotOf(r2, b), slotOf(r2, c)], [2, 1]);
      assert.equal(r2.registry.nextSlot(), 4, 'slot 3 is kept for a, which is still being found');
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await found;
    await until(() => r2.registry.list().length === 3, 'a found', 15_000);
    assert.equal(slotOf(r2, a), 3, 'its own moved slot is no conflict for it');
    assert.equal(
      r2.log.some((line) => line.includes('is another terminal')),
      false,
    );
  });

  test('a moved slot another terminal holds at the hello: the lowest free slot, logged, the map written', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await open(box, r1, 1);
    r1.drop();
    const kept = store(new Map([[a, 2]]));
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    const d = await open(box, r2, 1);
    const e = await open(box, r2, 2);
    await r2.registry.rediscover();
    assert.deepEqual([slotOf(r2, d), slotOf(r2, e), slotOf(r2, a)], [1, 2, 3]);
    assert.ok(r2.log.includes(`terminal ${a}: slot 2 is another terminal's; it takes slot 3`));
    assert.deepEqual(kept.latest(), new Map([[a, 3]]));
  });

  test('no moved slots and two keepers with one meta slot: the second to say hello takes the lowest free one', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await open(box, r1, 1);
    const b = await open(box, r1, 1);
    assert.equal(slotOf(r1, b), 2, 'at its own hello b took the lowest free slot');
    r1.drop();
    // b's meta slot 1 too, as after a move and a close; the store's entry is lost.
    const r2 = box.registry({ persistSlots: store().persist });
    const c = await open(box, r2, 1);
    await r2.registry.rediscover();
    const slots = [slotOf(r2, a), slotOf(r2, b), slotOf(r2, c)];
    assert.equal(slots[2], 1);
    assert.deepEqual([...slots].sort(), [1, 2, 3], 'every terminal has a slot, none shared');
  });

  test('all nine held: a keeper whose slot is taken gets none', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const late = await open(box, r1, 1);
    r1.drop();
    const r2 = box.registry({ persistSlots: store().persist });
    for (let slot = 1; slot <= 9; slot += 1) {
      await open(box, r2, slot);
    }
    await r2.registry.rediscover();
    assert.equal(slotOf(r2, late), null);
    assert.ok(r2.log.includes(`terminal ${late}: slot 1 is another terminal's; it takes no slot`));
    const slots = r2.registry.list().flatMap((term) => (term.slot === null ? [] : [term.slot]));
    assert.equal(new Set(slots).size, 9);
  });
});

describe('registry: when the moved slots are written (F37)', () => {
  test('the forget of a moved terminal writes the map without it; one without an entry writes nothing', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    const c = await open(box, r, 3);
    r.registry.setSlots(
      new Map([
        [a, 2],
        [b, 1],
      ]),
    );
    const writes = kept.writes.length;
    await ended(r, c);
    assert.equal(r.registry.close(c), 'ok');
    assert.equal(kept.writes.length, writes, 'c had no entry');
    await ended(r, a);
    assert.equal(r.registry.close(a), 'ok');
    assert.deepEqual(kept.latest(), new Map([[b, 1]]));
    assert.equal(kept.writes.length, writes + 1);
  });

  test('close answers ok whatever the write does (busy, a newer store), logged once by kind; flushSlots writes it then', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const ids: string[] = [];
    for (let slot = 1; slot <= 4; slot += 1) {
      ids.push(await open(box, r, slot));
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    r.registry.setSlots(
      new Map([
        [a, 2],
        [b, 1],
        [c, 4],
        [d, 3],
      ]),
    );
    const writes = kept.writes.length;
    r.registry.flushSlots();
    assert.equal(kept.writes.length, writes, 'nothing to flush while clean');
    kept.failWith = busyError();
    await ended(r, a);
    assert.equal(r.registry.close(a), 'ok');
    await ended(r, b);
    assert.equal(r.registry.close(b), 'ok');
    kept.failWith = new StoreNewerError('newer');
    await ended(r, c);
    assert.equal(r.registry.close(c), 'ok');
    r.registry.flushSlots();
    assert.deepEqual(
      r.log.filter((line) => line.includes('moved slots were not saved')),
      [
        'terminal registry: the moved slots were not saved (the database is busy)',
        'terminal registry: the moved slots were not saved (StoreNewerError)',
      ],
    );
    assert.equal(kept.writes.length, writes);
    kept.failWith = null;
    r.registry.flushSlots();
    assert.deepEqual(kept.latest(), new Map([[d, 3]]));
    r.registry.flushSlots();
    assert.equal(kept.writes.length, writes + 1, 'written once, then clean');
  });

  test('a write that fails at a hello: the terminal still takes its slot, the map stays dirty', async (t) => {
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await open(box, r1, 1);
    r1.drop();
    const kept = store(new Map([[a, 2]]));
    kept.failWith = busyError();
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    await open(box, r2, 2);
    await r2.registry.rediscover();
    assert.equal(slotOf(r2, a), 1, 'its meta slot, the lowest free one');
    assert.deepEqual(kept.writes, []);
    kept.failWith = null;
    r2.registry.flushSlots();
    assert.deepEqual(kept.latest(), new Map(), 'its slot is its meta slot again: no entry');
    assert.equal(kept.writes.length, 1);
  });

  test('once stopped nothing is written and no hello changes a slot', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, 2);
    r.registry.setSlots(
      new Map([
        [a, 2],
        [b, 1],
      ]),
    );
    await ended(r, a);
    const writes = kept.writes.length;
    // A failed write leaves the map dirty; after the stop not even flushSlots writes it.
    kept.failWith = busyError();
    await ended(r, b);
    assert.equal(r.registry.close(b), 'ok');
    kept.failWith = null;
    await r.registry.stopAll();
    assert.equal(r.registry.close(a), 'ok');
    r.registry.flushSlots();
    await sleep(200);
    assert.equal(kept.writes.length, writes);
  });

  test('a hello that comes after the stop changes no slot and writes nothing', async (t) => {
    const box = await registrySandbox(t);
    const r0 = box.registry();
    const late = await open(box, r0, 5);
    r0.drop();
    // Its moved slot 3 is another terminal's: before the stop its hello would take another one.
    const kept = store();
    const r = box.registry({ movedSlots: new Map([[late, 3]]), persistSlots: kept.persist });
    await open(box, r, 3);
    const keeper = box.keeperOf(late);
    box.signalKeeper(keeper, 'SIGSTOP');
    let found: Promise<unknown> = Promise.resolve();
    try {
      found = r.registry.rediscover();
      await sleep(300);
      await r.registry.stopAll();
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await found;
    await until(
      () => r.events.hello.some((event) => event.hello.id === late),
      'the late hello came after the stop',
      10_000,
    );
    await sleep(200);
    assert.deepEqual(
      r.log.filter((line) => line.includes("is another terminal's")),
      [],
      'no slot was taken for it',
    );
    assert.deepEqual(kept.writes, []);
  });
});

describe('the moved slots in the store (F37)', () => {
  test('nextSlot does not give a slot moved to a keeper still being found', async (t) => {
    // Covered with the restart above; here the rule alone, without a move in this registry.
    const box = await registrySandbox(t);
    const r1 = box.registry();
    const a = await open(box, r1, 1);
    r1.drop();
    const keeper = box.keeperOf(a);
    box.signalKeeper(keeper, 'SIGSTOP');
    const r2 = box.registry({ movedSlots: new Map([[a, 1]]) });
    let found: Promise<unknown> = Promise.resolve();
    try {
      found = r2.registry.rediscover();
      await sleep(300);
      assert.equal(r2.registry.list().length, 0);
      assert.equal(r2.registry.nextSlot(), 2);
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await found;
    await until(() => r2.registry.list().length === 1, 'a found', 15_000);
    assert.equal(slotOf(r2, a), 1);
  });
});
