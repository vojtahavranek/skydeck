// Follow-up F44 (S2 7.6, 12.1): `createParkedSlots` over a real registry with real keepers and
// scripted rows, no tick, so that "before any refresh" is exact. Its `sync` withholds the slot of
// every terminal of a parked session and gives the others theirs back; a terminal opened for a
// parked session is born with the lowest free slot and gives it up in the same step; nothing
// depends on the withholding having been applied (the review's Critical); Open's kept order loses
// the parked ids at once. After every operation no two listed terminals hold one slot.
// Platform: realTestPlatform; real keepers running the stand-in (not started: no G).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { KvKey } from '../../src/store/types.ts';
import type { KeeperSpec } from '../../src/window/frames.ts';
import { createOpenOrder } from '../../src/window/open-order.ts';
import { createParkedSlots } from '../../src/window/parked-slots.ts';
import type { ParkedSlots } from '../../src/window/parked-slots.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';
import { listRow } from '../helpers/rows.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';

const S4 = '3e8c6f4b-1a5d-4c9e-8f6a-5b4c3d2e1f0a';

function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

interface Written {
  moved: Map<string, number | null>;
  withheld: Set<string>;
}

/** A `persistSlots` that records each write, or throws while `failing` is set. */
function store(): {
  writes: Written[];
  latest(): Written;
  failing: boolean;
  persist(moved: ReadonlyMap<string, number | null>, withheld: ReadonlySet<string>): void;
} {
  let latest: Written = { moved: new Map(), withheld: new Set() };
  const kept = {
    writes: [] as Written[],
    latest: () => latest,
    failing: false,
    persist(moved: ReadonlyMap<string, number | null>, withheld: ReadonlySet<string>): void {
      if (kept.failing) throw busyError();
      latest = { moved: new Map(moved), withheld: new Set(withheld) };
      kept.writes.push(latest);
    },
  };
  return kept;
}

/** The kv a kept order is written to: every write recorded. */
function kv(initial: Record<string, string> = {}): {
  values: Map<KvKey, string>;
  writes: number;
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
} {
  const values = new Map<KvKey, string>(Object.entries(initial) as [KvKey, string][]);
  const store = {
    values,
    writes: 0,
    getKv: (key: KvKey) => values.get(key) ?? null,
    setKv: (key: KvKey, value: string) => {
      store.writes += 1;
      values.set(key, value);
    },
    deleteKv: (key: KvKey) => {
      store.writes += 1;
      values.delete(key);
    },
  };
  return store;
}

/** The scripted rows: every session named, parked while in `parked`. */
interface Rows {
  sessions: string[];
  parked: Set<string>;
}

function fixture(
  r: TestRegistry,
  rows: Rows,
  options: { ready?: () => boolean; stopping?: () => boolean; order?: ReturnType<typeof kv> } = {},
): { slots: ParkedSlots; log: string[]; order: ReturnType<typeof createOpenOrder> } {
  const log: string[] = [];
  const order = createOpenOrder({
    store: options.order ?? kv(),
    log: (line) => {
      log.push(line);
    },
    stopping: () => false,
  });
  const slots = createParkedSlots({
    registry: r.registry,
    rows: () => rows.sessions.map((id) => listRow({ id, parked: rows.parked.has(id) })),
    ready: options.ready ?? (() => true),
    stopping: options.stopping ?? (() => false),
    openOrder: order,
    log: (line) => {
      log.push(line);
    },
  });
  return { slots, log, order };
}

let opened = 2_000n;

/**
 * Opens a terminal for `sessionId` as the window terminal does (S2 11.2): its meta's slot is
 * `nextSlot()`, the spawn is called, and `then` (the server's `listed`, its `sync`) runs in the same
 * synchronous step, before the spawn is awaited. The terminal's id.
 */
async function openFor(
  box: RegistryBox,
  r: TestRegistry,
  sessionId: string,
  then: () => void = () => {},
): Promise<string> {
  opened += 1n;
  const spec: KeeperSpec = box.spec({
    meta: {
      ...box.spec().meta,
      sessionId,
      slot: r.registry.nextSlot(),
      openedNs: String(opened),
    },
  });
  const spawning = r.registry.spawn(spec);
  then();
  noSlotTwice(r);
  await spawning;
  noSlotTwice(r);
  return spec.id;
}

function slotOf(r: TestRegistry, id: string): number | null {
  return info(r.registry, id).slot;
}

/** The slot of the keeper's meta, as its hello reported it. */
function metaSlotOf(r: TestRegistry, id: string): number | null {
  const hello = r.events.hello.filter((event) => event.hello.id === id).at(-1);
  assert.ok(hello !== undefined, `a hello of ${id}`);
  return hello.hello.meta.slot;
}

function noSlotTwice(r: TestRegistry): void {
  const slots = r.registry.list().flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, `slots: ${slots.join(' ')}`);
}

function sync(r: TestRegistry, slots: ParkedSlots): void {
  slots.sync();
  noSlotTwice(r);
}

describe('parkedSlots: before the server is ready, and once it stops (F44)', () => {
  test('before ready() nothing is changed or written, whatever the rows say; the stored set is still whole afterwards', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const rows: Rows = { sessions: [S1, S2], parked: new Set([S1]) };
    const first = fixture(r1, rows);
    const a = await openFor(box, r1, S1);
    const b = await openFor(box, r1, S2);
    sync(r1, first.slots);
    assert.deepEqual([slotOf(r1, a), slotOf(r1, b)], [null, 2]);
    r1.drop();
    // The restart: the stored set, a registry that has not looked for its keepers yet.
    let ready = false;
    const r2 = box.registry({ withheldSlots: kept.latest().withheld, persistSlots: kept.persist });
    rows.parked = new Set([S2]);
    const second = fixture(r2, rows, { ready: () => ready });
    const writes = kept.writes.length;
    sync(r2, second.slots); // nothing listed yet: a pruning now would lose a's entry
    await r2.registry.rediscover();
    sync(r2, second.slots);
    assert.equal(kept.writes.length, writes, 'nothing written');
    assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [null, 2], 'a still withheld at its hello');
    ready = true;
    sync(r2, second.slots);
    assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [1, null]);
    assert.deepEqual(kept.latest().withheld, new Set([b]));
  });

  test('once stopping() says true, sync changes and writes nothing', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    let stopping = false;
    const rows: Rows = { sessions: [S1], parked: new Set() };
    const f = fixture(r, rows, { stopping: () => stopping });
    const a = await openFor(box, r, S1);
    stopping = true;
    rows.parked.add(S1);
    sync(r, f.slots);
    assert.equal(slotOf(r, a), 1);
    assert.deepEqual(kept.writes, []);
  });
});

describe('parkedSlots: a terminal opened for a parked session (F44, the review’s Critical)', () => {
  test('sync in the step of the spawn: its keeper’s meta holds the lowest free slot, the registry lists it without one, nextSlot gives that slot', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const rows: Rows = { sessions: [S1, S2, S3], parked: new Set([S2]) };
    const f = fixture(r, rows);
    const a = await openFor(box, r, S1, () => {
      sync(r, f.slots);
    });
    const b = await openFor(box, r, S2, () => {
      sync(r, f.slots);
    });
    assert.equal(metaSlotOf(r, b), 2, 'born with the lowest free slot');
    assert.deepEqual([slotOf(r, a), slotOf(r, b)], [1, null]);
    assert.equal(r.registry.nextSlot(), 2);
    const c = await openFor(box, r, S3, () => {
      sync(r, f.slots);
    });
    assert.equal(slotOf(r, c), 2, 'the next terminal takes it');
  });

  test('un-parked with no refresh between (sync again at once): it takes the lowest free slot', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const rows: Rows = { sessions: [S1, S2, S3], parked: new Set([S1]) };
    const f = fixture(r, rows);
    const a = await openFor(box, r, S1, () => {
      sync(r, f.slots);
    });
    assert.equal(slotOf(r, a), null);
    const b = await openFor(box, r, S2);
    assert.equal(slotOf(r, b), 1, 'its born slot was free');
    rows.parked.delete(S1);
    sync(r, f.slots);
    assert.equal(slotOf(r, a), 2, 'the lowest free one');
  });

  test('the first withhold write failing: it keeps its born number; un-parked it still has it; parked, the write working, it gives it up', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const rows: Rows = { sessions: [S1, S2, S3, S4], parked: new Set([S1, S3]) };
    const f = fixture(r, rows);
    kept.failing = true;
    const a = await openFor(box, r, S1, () => {
      sync(r, f.slots);
    });
    assert.equal(slotOf(r, a), 1, 'its born number, in the registry');
    const b = await openFor(box, r, S2, () => {
      sync(r, f.slots);
    });
    assert.equal(slotOf(r, b), 2, 'no terminal shares it');
    // Un-parked while the write still fails: it never depended on the withholding.
    rows.parked.delete(S1);
    sync(r, f.slots);
    assert.equal(slotOf(r, a), 1);
    // Another, parked, while the write fails; then the write works again.
    const c = await openFor(box, r, S3, () => {
      sync(r, f.slots);
    });
    assert.equal(slotOf(r, c), 3);
    sync(r, f.slots);
    assert.equal(slotOf(r, c), 3, 'still its number while the write fails');
    kept.failing = false;
    sync(r, f.slots);
    assert.equal(slotOf(r, c), null, 'withheld once written');
    assert.equal(r.registry.nextSlot(), 3, 'its number is free');
    assert.deepEqual(kept.latest().withheld, new Set([c]));
    assert.deepEqual(
      r.log.filter((line) => line.includes('withheld slots were not saved')),
      ['terminal registry: the withheld slots were not saved (the database is busy)'],
      'logged once while it repeated',
    );
    assert.deepEqual(f.log, [], 'sync itself never failed');
  });
});

describe('parkedSlots: a restart (F44)', () => {
  for (const lost of [false, true]) {
    test(`a new registry over the same keepers, the stored set ${lost ? 'lost' : 'kept'}: after the hello and one sync no number while parked, a number once it is not`, async (t) => {
      const box = await registrySandbox(t);
      const kept = store();
      const r1 = box.registry({ persistSlots: kept.persist });
      const rows: Rows = { sessions: [S1, S2], parked: new Set([S1]) };
      const first = fixture(r1, rows);
      // Each keeper's meta has a slot of its own (1, 2), so that no hello order decides anything.
      const a = await openFor(box, r1, S1);
      const b = await openFor(box, r1, S2);
      sync(r1, first.slots);
      assert.deepEqual([slotOf(r1, a), slotOf(r1, b)], [null, 2]);
      r1.drop();
      const r2 = box.registry({
        ...(lost ? {} : { withheldSlots: kept.latest().withheld }),
        movedSlots: kept.latest().moved,
        persistSlots: kept.persist,
      });
      await r2.registry.rediscover();
      noSlotTwice(r2);
      const second = fixture(r2, rows);
      sync(r2, second.slots);
      assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [null, 2], 'no number while parked');
      rows.parked.delete(S1);
      sync(r2, second.slots);
      assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [1, 2], 'a number once it is not');
      rows.parked.add(S2);
      sync(r2, second.slots);
      assert.deepEqual([slotOf(r2, a), slotOf(r2, b)], [1, null]);
    });
  }
});

describe("parkedSlots: Open's kept order (F44, S2 12.1)", () => {
  test('a parked id is dropped at once, the others keep their order; nothing is written when no parked id is kept', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const order = kv({ window_open_order: JSON.stringify([S1, S2, S3]) });
    const rows: Rows = { sessions: [S1, S2, S3, S4], parked: new Set() };
    const f = fixture(r, rows, { order });
    sync(r, f.slots);
    assert.equal(order.writes, 0, 'no parked id kept: nothing written');
    rows.parked.add(S2);
    rows.parked.add(S4);
    sync(r, f.slots);
    assert.deepEqual(f.order.ids(), [S1, S3]);
    assert.equal(order.values.get('window_open_order'), JSON.stringify([S1, S3]));
    assert.equal(order.writes, 1);
    sync(r, f.slots);
    assert.equal(order.writes, 1, 'nothing more to drop');
  });

  test('no kept order: nothing is written', async (t) => {
    const box = await registrySandbox(t);
    const r = box.registry({ persistSlots: store().persist });
    const order = kv();
    const rows: Rows = { sessions: [S1], parked: new Set([S1]) };
    const f = fixture(r, rows, { order });
    sync(r, f.slots);
    assert.equal(order.writes, 0);
    assert.deepEqual(f.order.ids(), []);
  });
});
