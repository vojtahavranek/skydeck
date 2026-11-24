// A restart's held number (issue #166) together with the hand-out of freed numbers (#189), with
// nine numbers taken and a tenth terminal waiting for one, the fill wired to the registry's changes
// as the server wires it: the number of the terminal a restart holds is taken in `takenSlots`' eyes
// from before its program ends until the next terminal has it — so the tenth gets none — and when
// the restart ended its program without opening another terminal the number is freed and the tenth
// takes it at once; a restart given up changes nothing; the tenth restarted waits as any other
// until its program ends, and a number given to it meanwhile passes to its next terminal; while a
// keeper is still being found the hand-out gives nothing, and the restart's number still passes to
// its next terminal. Platform:
// realTestPlatform; real keepers running the stand-in (not started: no G; a program "ends" when its
// keeper is refused the start, N, which applies an exit as any end does).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createFill } from '../../src/window/freed-numbers.ts';
import type { KeeperSpec } from '../../src/window/frames.ts';
import { until } from '../helpers/keeper.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';

/** Session `n` of these tests. */
function nth(n: number): string {
  return `00000000-0000-4000-8000-${(0x1660 + n).toString(16).padStart(12, '0')}`;
}

/** A `persistSlots` that keeps the latest write. */
function store(): {
  latest(): Map<string, number | null>;
  persist(moved: ReadonlyMap<string, number | null>): void;
} {
  let latest = new Map<string, number | null>();
  return {
    latest: () => latest,
    persist(moved) {
      latest = new Map(moved);
    },
  };
}

let opened = 0;

/** Spawns a keeper (not started) of a new session of its own with meta slot `slot`; its id. */
async function open(
  box: RegistryBox,
  r: TestRegistry,
  slot: number | null,
  over: Partial<KeeperSpec> = {},
): Promise<string> {
  opened += 1;
  const spec = box.spec({
    ...over,
    meta: {
      ...box.spec().meta,
      kind: 'new',
      sessionId: nth(opened),
      slot,
      openedNs: String(1_000_000_000n * BigInt(opened)),
    },
  });
  await r.registry.spawn(spec);
  return spec.id;
}

/** The fill as the server wires it: at every change of the registry, and a first refresh. */
function wire(box: RegistryBox, r: TestRegistry, kept: ReturnType<typeof store>): () => void {
  const fill = createFill({
    registry: r.registry,
    input: () => ({
      rows: [],
      terminals: r.registry.list(),
      elsewhere: new Map(),
      nowNs: box.tp.platform.clock.nowNs(),
      openOrder: [],
    }),
    openOrder: { ids: () => [], adopt: () => {} },
    persist: (moved) => {
      kept.persist(moved);
    },
    log: () => {},
    stopping: () => false,
  });
  r.registry.onChange(() => {
    fill.run();
  });
  fill.refreshed();
  return () => fill.refreshed();
}

/** Numbers 1–9 and a tenth terminal without one, the fill wired. */
async function nineAndATenth(
  box: RegistryBox,
  r: TestRegistry,
  kept: ReturnType<typeof store>,
): Promise<{ byNumber: Map<number, string>; tenth: string }> {
  const byNumber = new Map<number, string>();
  for (let slot = 1; slot <= 9; slot += 1) byNumber.set(slot, await open(box, r, slot));
  const tenth = await open(box, r, null);
  wire(box, r, kept);
  assert.equal(info(r.registry, tenth).slot, null);
  return { byNumber, tenth };
}

/** Its program ends (the keeper refused the start): the exit applied. */
async function ends(r: TestRegistry, id: string): Promise<void> {
  r.registry.refuse(id, 'ended for the test');
  await until(() => info(r.registry, id).state === 'not-started', `terminal ${id} ended`);
}

/** No two listed terminals with one number. */
function noNumberTwice(r: TestRegistry): void {
  const slots = r.registry.list().flatMap((term) => (term.slot === null ? [] : [term.slot]));
  assert.equal(new Set(slots).size, slots.length, slots.join(' '));
}

describe('a restart’s held number and the hand-out of freed numbers (#166 with #189)', () => {
  test('nine numbers and a tenth waiting: the restart keeps its number through the end and into its next terminal; the tenth gets none', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { byNumber, tenth } = await nineAndATenth(box, r, kept);
    const four = byNumber.get(4) ?? '';
    const hold = r.registry.holdSlot(four);
    assert.ok(hold !== null);
    await ends(r, four);
    assert.deepEqual([info(r.registry, four).slot, info(r.registry, tenth).slot], [4, null]);
    const next = box.spec({ meta: { ...box.spec().meta, sessionId: nth(99), kind: 'resume' } });
    const slot = hold.take(next.id);
    assert.equal(slot, 4);
    await r.registry.spawn({ ...next, meta: { ...next.meta, slot } });
    hold.release();
    assert.equal(info(r.registry, next.id).slot, 4, 'the next terminal holds it');
    assert.equal(info(r.registry, tenth).slot, null, 'the tenth still waits');
    noNumberTwice(r);
  });

  test('ended, and no next terminal: the hold let go frees the number, and the tenth takes it at once', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { byNumber, tenth } = await nineAndATenth(box, r, kept);
    const four = byNumber.get(4) ?? '';
    const hold = r.registry.holdSlot(four);
    assert.ok(hold !== null);
    await ends(r, four);
    assert.equal(info(r.registry, tenth).slot, null, 'not while held');
    hold.release();
    assert.deepEqual([info(r.registry, four).slot, info(r.registry, tenth).slot], [null, 4]);
    noNumberTwice(r);
  });

  test('given up while the program runs: nothing changes; its later end frees the number as any end does', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { byNumber, tenth } = await nineAndATenth(box, r, kept);
    const four = byNumber.get(4) ?? '';
    const hold = r.registry.holdSlot(four);
    assert.ok(hold !== null);
    hold.release();
    assert.deepEqual([info(r.registry, four).slot, info(r.registry, tenth).slot], [4, null]);
    await ends(r, four);
    assert.deepEqual([info(r.registry, four).slot, info(r.registry, tenth).slot], [null, 4]);
    noNumberTwice(r);
  });

  test('the tenth restarted: held without a number, it still waits; a number freed before its program ends goes to it and passes to its next terminal; a tenth that ends without one opens its next terminal with none, which waits and takes the next freed', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { byNumber, tenth } = await nineAndATenth(box, r, kept);
    const hold = r.registry.holdSlot(tenth);
    assert.ok(hold !== null);
    await ends(r, byNumber.get(4) ?? '');
    assert.equal(info(r.registry, tenth).slot, 4, 'held, it took the freed number');
    await ends(r, tenth);
    assert.equal(info(r.registry, tenth).slot, 4, 'kept through its end');
    const next = box.spec({ meta: { ...box.spec().meta, sessionId: nth(97), kind: 'resume' } });
    const slot = hold.take(next.id);
    assert.equal(slot, 4);
    await r.registry.spawn({ ...next, meta: { ...next.meta, slot } });
    hold.release();
    assert.deepEqual([info(r.registry, tenth).slot, info(r.registry, next.id).slot], [null, 4]);
    noNumberTwice(r);
    // A new tenth, restarted while every number is taken: it ends without one, so its next
    // terminal is opened with none and waits as any other (a terminal of a new session here, so
    // that it has a row of Open without one of the store's), and takes the next number freed.
    const eleventh = await open(box, r, null);
    assert.equal(info(r.registry, eleventh).slot, null);
    const held = r.registry.holdSlot(eleventh);
    assert.ok(held !== null);
    await ends(r, eleventh);
    opened += 1;
    const after = box.spec({
      meta: {
        ...box.spec().meta,
        kind: 'new',
        sessionId: nth(opened),
        slot: null,
        openedNs: String(1_000_000_000n * BigInt(opened)),
      },
    });
    assert.equal(held.take(after.id), null);
    await r.registry.spawn(after);
    held.release();
    assert.equal(info(r.registry, after.id).slot, null, 'opened with none: every number is taken');
    await ends(r, byNumber.get(6) ?? '');
    assert.equal(info(r.registry, after.id).slot, 6, 'it waits as any other, and takes 6');
    noNumberTwice(r);
  });

  test('while a keeper is still being found: the hand-out gives nothing, and the restart’s number passes to its next terminal; a number a restart freed meanwhile waits for the end of the finding', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const byNumber = new Map<number, string>();
    for (let slot = 1; slot <= 9; slot += 1) byNumber.set(slot, await open(box, r1, slot));
    const tenth = await open(box, r1, null);
    r1.drop();
    // Number 2's keeper does not answer: the next registry goes on finding it.
    const slow = box.keeperOf(byNumber.get(2) ?? '');
    box.signalKeeper(slow, 'SIGSTOP');
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    let refresh = (): void => {};
    try {
      await r2.registry.rediscover();
      refresh = wire(box, r2, kept);
      const four = byNumber.get(4) ?? '';
      const six = byNumber.get(6) ?? '';
      await until(() => info(r2.registry, four).slot === 4, 'number 4 found');
      await until(() => info(r2.registry, six).slot === 6, 'number 6 found');
      // A restart of 4 that opens its next terminal: the number passes to it.
      const hold = r2.registry.holdSlot(four);
      assert.ok(hold !== null);
      await ends(r2, four);
      const next = box.spec({ meta: { ...box.spec().meta, sessionId: nth(98), kind: 'resume' } });
      const slot = hold.take(next.id);
      assert.equal(slot, 4);
      await r2.registry.spawn({ ...next, meta: { ...next.meta, slot } });
      hold.release();
      assert.equal(info(r2.registry, next.id).slot, 4);
      // A restart of 6 that ends without a next terminal: freed, but given to nobody yet.
      const held6 = r2.registry.holdSlot(six);
      assert.ok(held6 !== null);
      await ends(r2, six);
      held6.release();
      refresh();
      assert.equal(info(r2.registry, six).slot, null);
      assert.equal(info(r2.registry, tenth).slot, null, 'nothing while a keeper is being found');
    } finally {
      box.signalKeeper(slow, 'SIGCONT');
    }
    await until(
      () => {
        refresh();
        return info(r2.registry, tenth).slot !== null;
      },
      'the freed number given once the finding is over',
      15_000,
    );
    assert.equal(info(r2.registry, tenth).slot, 6);
    assert.equal(info(r2.registry, byNumber.get(2) ?? '').slot, 2, 'the slow keeper has its own');
    noNumberTwice(r2);
  });
});
