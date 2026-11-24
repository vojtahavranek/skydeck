// Issue #189 (S2 7.6): a free number goes to a terminal that waits for one. The registry's
// `giveSlots` (the free numbers by the one rule, only to a terminal whose program may run, never
// one whose number was freed, nothing while a keeper is still being found) and the fill wired to
// the registry's changes as the server wires it, at each moment a number becomes free: an exit
// applied, a hello that says the program exited, a lost terminal's number freed at the loss or
// after its 60 s, the close of a lost terminal that still held one. Platform: realTestPlatform;
// real keepers running the stand-in (not started: no G), and keepers played by this test.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import type { Platform } from '../../src/platform/types.ts';
import { createFill, HELD_LINE } from '../../src/window/freed-numbers.ts';
import { encodeFrame, frameReader } from '../../src/window/frames.ts';
import type { KeeperSpec } from '../../src/window/frames.ts';
import { SESSION, sleep, until } from '../helpers/keeper.ts';
import { info, registrySandbox } from '../helpers/registry.ts';
import type { RegistryBox, TestRegistry } from '../helpers/registry.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Session `n` of these tests. */
function nth(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A `persistSlots` that records each write, or throws `failWith` while it is set. */
function store(): {
  writes: Map<string, number | null>[];
  latest(): Map<string, number | null>;
  failWith: unknown;
  persist(moved: ReadonlyMap<string, number | null>): void;
} {
  let latest = new Map<string, number | null>();
  const kept = {
    writes: [] as Map<string, number | null>[],
    latest: () => latest,
    failWith: null as unknown,
    persist(moved: ReadonlyMap<string, number | null>): void {
      if (kept.failWith !== null) throw kept.failWith;
      latest = new Map(moved);
      kept.writes.push(latest);
    },
  };
  return kept;
}

let opened = 0;

/** Spawns a keeper (not started) of a new session of its own, with meta slot `slot`; opened after
 *  every earlier one (Open draws terminals without a number in that order). Its id. */
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

function slotOf(r: TestRegistry, id: string): number | null {
  return info(r.registry, id).slot;
}

async function ended(r: TestRegistry, id: string): Promise<void> {
  r.registry.refuse(id, 'closing it');
  await until(() => info(r.registry, id).state === 'not-started', `terminal ${id} ended`);
}

/** The fill as the server wires it: run at every change of the registry, and `run` a refresh that
 *  worked (the first one right away); Open over the registry's terminals (each a new session's
 *  row, no kept order). Its numbers are written to `kept`. */
function wire(
  box: RegistryBox,
  r: TestRegistry,
  kept: ReturnType<typeof store>,
): { run(): void; logs: string[] } {
  const logs: string[] = [];
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
    log: (line) => {
      logs.push(line);
    },
    stopping: () => false,
  });
  r.registry.onChange(() => {
    fill.run();
  });
  // Open's order is known from here on (each run of the tests below stands for a later refresh).
  fill.refreshed();
  return { run: () => fill.refreshed(), logs };
}

/** The numbers of `ids`, in order. */
const slotsOf = (r: TestRegistry, ids: readonly string[]): (number | null)[] =>
  ids.map((id) => slotOf(r, id));

/** Opens terminals with the numbers `numbers` (in that order), then `waiting` without one. */
async function openAll(
  box: RegistryBox,
  r: TestRegistry,
  numbers: readonly number[],
  waiting: number,
): Promise<{ held: Map<number, string>; waits: string[] }> {
  const held = new Map<number, string>();
  for (const slot of numbers) held.set(slot, await open(box, r, slot));
  const waits: string[] = [];
  for (let i = 0; i < waiting; i += 1) waits.push(await open(box, r, null));
  return { held, waits };
}

const ONE_TO_NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Waits until the wall clock, which a keeper's start deadline is read on, is a second past
 * `startBy`, and a second more: the keeper has then ended its program as not started. (A fixed
 * sleep is not enough where that clock runs slow or steps back.)
 */
async function pastOnTheWallClock(box: RegistryBox, startBy: bigint): Promise<void> {
  await until(
    () => box.tp.platform.clock.nowNs() > startBy + 1_000_000_000n,
    'past the deadline on the wall clock',
    20_000,
  );
  await sleep(1000);
}

describe('registry: giveSlots (#189)', () => {
  test("the lowest free numbers to the first candidates that may take one, in the caller's order; written before applied, announced once; the others keep theirs", async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const a = await open(box, r, 1);
    const b = await open(box, r, null);
    const c = await open(box, r, 3);
    const d = await open(box, r, null);
    const e = await open(box, r, null);
    let changes = 0;
    r.registry.onChange(() => {
      changes += 1;
    });
    const writes: { moved: Map<string, number | null>; given: Map<string, number> }[] = [];
    const outcome = r.registry.giveSlots([e, b, a, '0123456789ab', d], (moved, given) => {
      assert.deepEqual(slotsOf(r, [b, d, e]), [null, null, null], 'written before applied');
      writes.push({ moved: new Map(moved), given: new Map(given) });
    });
    assert.equal(outcome, 'ok');
    const given = new Map([
      [e, 2],
      [b, 4],
      [d, 5],
    ]);
    assert.deepEqual(writes, [{ moved: given, given }]);
    assert.deepEqual(slotsOf(r, [a, b, c, d, e]), [1, 4, 3, 5, 2]);
    assert.equal(changes, 1);
    assert.equal(r.registry.nextSlot(), 6);
    // Nothing to give: nothing written, nothing announced.
    assert.equal(
      r.registry.giveSlots([a, c], () => {
        assert.fail('nothing to write');
      }),
      'ok',
    );
    assert.equal(changes, 1);
  });

  test('never to a terminal whose program is over (F43), never more than the free numbers; a write that throws is thrown, nothing changed; after stopAll nothing', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { held, waits } = await openAll(box, r, [1, 2, 3, 4, 5, 6, 7, 8], 3);
    const [w1, w2, w3] = waits as [string, string, string];
    await ended(r, w1);
    const one = held.get(1) ?? '';
    await ended(r, one);
    assert.equal(r.registry.nextSlot(), 1);
    // Only 1 and 9 are free; the ended terminals take none.
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    assert.throws(
      () =>
        r.registry.giveSlots([one, w1, w2, w3], () => {
          throw busy;
        }),
      /locked/,
    );
    assert.deepEqual(slotsOf(r, [one, w1, w2, w3]), [null, null, null, null], 'nothing changed');
    let given: Map<string, number> | null = null;
    r.registry.giveSlots([one, w1, w2, w3], (_moved, g) => {
      given = new Map(g);
    });
    assert.deepEqual(
      given,
      new Map([
        [w2, 1],
        [w3, 9],
      ]),
    );
    assert.deepEqual(slotsOf(r, [one, w1, w2, w3]), [null, null, 1, 9]);
    assert.deepEqual(
      [2, 3, 4, 5, 6, 7, 8].map((slot) => slotOf(r, held.get(slot) ?? '')),
      [2, 3, 4, 5, 6, 7, 8],
      'the others keep theirs',
    );
    await r.registry.stopAll();
    assert.equal(
      r.registry.giveSlots([w1], () => {
        assert.fail('nothing once stopped');
      }),
      'stopping',
    );
  });

  test('nothing while a keeper is still being found, though its number looks free; once the finding is over the true gaps are filled and the slow keeper has its own', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const { held, waits } = await openAll(box, r1, [1, 2, 3, 4, 5, 6, 8, 9], 1);
    const [waiting] = waits as [string];
    // Number 7's keeper ends its program by itself (not started by its deadline) once r1 is gone:
    // 7 is a true gap at the next start.
    const startBy = box.tp.platform.clock.nowNs() + 2_000_000_000n;
    const seven = await open(box, r1, 7, { startBy: String(startBy) });
    r1.drop();
    await pastOnTheWallClock(box, startBy);
    // Number 4's keeper does not answer: the new registry goes on finding it.
    const slow = held.get(4) ?? '';
    const keeper = box.keeperOf(slow);
    box.signalKeeper(keeper, 'SIGSTOP');
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    const fill = wire(box, r2, kept);
    let found: Promise<unknown> = Promise.resolve();
    try {
      found = r2.registry.rediscover();
      await found;
      await until(() => info(r2.registry, seven).state === 'not-started', "7's exit applied");
      assert.equal(slotOf(r2, waiting), null);
      assert.equal(r2.registry.nextSlot(), 4, "the slow keeper's number looks free");
      fill.run(); // the first refresh after the start
      assert.equal(
        r2.registry.giveSlots([waiting], () => {
          assert.fail('nothing while a keeper is being found');
        }),
        'finding',
      );
      // Said in the log (also by the runs at the hellos, while some had not come yet), and not
      // again while it holds.
      const said = fill.logs.length;
      assert.ok(said >= 1 && fill.logs.every((line) => line === HELD_LINE), fill.logs.join('\n'));
      await sleep(1500);
      fill.run();
      assert.equal(slotOf(r2, waiting), null, 'the waiting terminal took nothing');
      assert.equal(fill.logs.length, said, 'said once while it holds');
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(
      () => {
        fill.run(); // each later refresh
        return slotOf(r2, waiting) !== null;
      },
      'the true gap filled once the finding is over',
      15_000,
    );
    assert.equal(slotOf(r2, slow), 4, 'the slow keeper has its own number');
    assert.equal(slotOf(r2, waiting), 7);
    assert.equal(slotOf(r2, seven), null);
  });
});

describe('registry: each moment a number becomes free, with the fill wired as the server wires it (#189)', () => {
  test('an exit applied: the first waiting terminal takes the number in the same change that frees it; with three waiting only the first; then the next one freed goes to the next', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { held, waits } = await openAll(box, r, ONE_TO_NINE, 3);
    wire(box, r, kept);
    const five = held.get(5) ?? '';
    const seen: (number | null)[][] = [];
    r.registry.onChange(() => {
      if (info(r.registry, five).state === 'not-started') seen.push(slotsOf(r, waits));
    });
    await ended(r, five);
    assert.deepEqual(seen[0], [5, null, null], 'no change shows 5 free while a terminal waits');
    assert.deepEqual(slotsOf(r, waits), [5, null, null]);
    assert.equal(kept.latest().get(waits[0] ?? ''), 5, 'written');
    await ended(r, held.get(2) ?? '');
    assert.deepEqual(slotsOf(r, waits), [5, 2, null]);
    assert.deepEqual(
      [1, 3, 4, 6, 7, 8, 9].map((slot) => slotOf(r, held.get(slot) ?? '')),
      [1, 3, 4, 6, 7, 8, 9],
      'the others keep theirs',
    );
    assert.equal(r.registry.nextSlot(), null);
  });

  test('a hello that says the program exited, two at once at a start: once every keeper answered, the first two waiting take the two numbers, lowest first', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r1 = box.registry({ persistSlots: kept.persist });
    const { held, waits } = await openAll(box, r1, [1, 2, 4, 5, 6, 8, 9], 3);
    // Numbers 7 and 3: keepers that end their programs by themselves (not started by their
    // deadlines) once r1 is gone; the next start finds both with their exits.
    let last = 0n;
    const deadline = (): string => {
      last = box.tp.platform.clock.nowNs() + 2_000_000_000n;
      return String(last);
    };
    const seven = await open(box, r1, 7, { startBy: deadline() });
    const three = await open(box, r1, 3, { startBy: deadline() });
    r1.drop();
    await pastOnTheWallClock(box, last);
    const r2 = box.registry({ movedSlots: kept.latest(), persistSlots: kept.persist });
    const fill = wire(box, r2, kept);
    await r2.registry.rediscover();
    for (const id of [three, seven]) {
      assert.equal(
        r2.events.hello.find((e) => e.hello.id === id)?.hello.exited !== null,
        true,
        'its hello said its program exited',
      );
    }
    fill.run(); // the first refresh after the start
    await until(() => slotOf(r2, waits[1] ?? '') !== null, 'both numbers given', 10_000);
    assert.deepEqual(slotsOf(r2, waits), [3, 7, null]);
    assert.deepEqual(slotsOf(r2, [three, seven]), [null, null]);
    assert.deepEqual(
      [1, 2, 4, 5, 6, 8, 9].map((slot) => slotOf(r2, held.get(slot) ?? '')),
      [1, 2, 4, 5, 6, 8, 9],
    );
  });

  test('a keeper that only stops answering keeps its number meanwhile; a number freed then goes to the waiting terminal, not to it', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    const { held, waits } = await openAll(box, r, [1, 3, 4, 5, 6, 7, 8, 9], 1);
    const two = await open(box, r, 2); // last: its connection is the last one opened
    wire(box, r, kept);
    const keeper = box.keeperOf(two);
    box.signalKeeper(keeper, 'SIGSTOP');
    try {
      r.sockets.at(-1)?.destroy();
      await until(() => info(r.registry, two).state === 'reconnecting', 'reconnecting');
      await ended(r, held.get(6) ?? '');
      assert.equal(info(r.registry, two).state, 'reconnecting');
      assert.deepEqual(slotsOf(r, [two, waits[0] ?? '']), [2, 6]);
    } finally {
      box.signalKeeper(keeper, 'SIGCONT');
    }
    await until(() => info(r.registry, two).state === 'starting', 'answering again', 10_000);
    assert.deepEqual(slotsOf(r, [two, waits[0] ?? '']), [2, 6], 'back with its number');
  });
});

/**
 * A keeper played by this test: a socket in terms/ that answers C with a protocol-1 hello (its
 * fields replaced by `over`'s), and a pid line naming this test process (alive; killKeepersIn
 * never signals it).
 */
async function fakeKeeper(
  t: TestContext,
  box: RegistryBox,
  id: string,
  over: Record<string, unknown> = {},
): Promise<{ stop(): Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    const reader = frameReader();
    socket.on('data', (chunk) => {
      const frames = reader.push(chunk);
      if ('error' in frames || !frames.some((f) => f.type === 'C')) return;
      const hello = {
        protocol: 1,
        keeper: '2',
        id,
        started: true,
        startBy: '1',
        lock: null,
        pid: process.pid,
        procStart: 1,
        cols: 80,
        rows: 24,
        seq: 0,
        snapSeq: 0,
        tailFrom: 1,
        gap: false,
        meta: {
          sessionId: SESSION,
          kind: 'resume',
          slot: 1,
          openedNs: '1',
          build: 'test',
          label: null,
          dir: box.s.home,
        },
        exited: null,
        ...over,
      };
      socket.write(encodeFrame('H', utf8(JSON.stringify(hello))));
    });
  });
  await new Promise<void>((resolve) => server.listen(box.files.termSock(id), resolve));
  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(stop);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  box.tp.platform.files.writeText(
    box.files.termPid(id),
    `${process.pid} ${procStartFromStat(stat)} ${bootId} 2 1\n`,
  );
  return { stop };
}

/**
 * The box's platform with a wall clock `shift()` moves forward (the 60 s without waiting) and
 * whose /proc cannot read this test process's stat line: the program the fake keeper names (this
 * process) may still run for design 5.5's rule.
 */
function shifted(box: RegistryBox): { platform: Platform; shift(ns: bigint): void } {
  const base = box.tp.platform;
  let by = 0n;
  return {
    platform: {
      ...base,
      clock: { ...base.clock, nowNs: () => base.clock.nowNs() + by },
      proc: {
        ...base.proc,
        stat: (pid) => {
          if (pid === process.pid) {
            throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
          }
          return base.proc.stat(pid);
        },
      },
    },
    shift(ns) {
      by += ns;
    },
  };
}

/** The fake keeper (number 1) found by `r`, terminals 2–9 opened and `waiting` without one; then
 *  the fake keeper lost: its socket refuses. */
async function lostOne(
  t: TestContext,
  box: RegistryBox,
  r: TestRegistry,
  id: string,
  waiting: number,
  over: Record<string, unknown> = {},
): Promise<string[]> {
  const keeper = await fakeKeeper(t, box, id, over);
  await r.registry.rediscover();
  assert.equal(slotOf(r, id), 1, 'found with its number');
  const { waits } = await openAll(box, r, [2, 3, 4, 5, 6, 7, 8, 9], waiting);
  await keeper.stop();
  const sock = box.files.termSock(id);
  if (!existsSync(sock)) writeFileSync(sock, ''); // connecting to a file is refused
  await until(() => info(r.registry, id).state === 'lost', 'lost', 10_000);
  return waits;
}

describe('registry: a lost terminal and Close, with the fill wired (#189)', () => {
  test('a lost terminal whose program is gone: its number goes to the waiting terminal at the loss', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const r = box.registry({ persistSlots: kept.persist });
    wire(box, r, kept);
    // The hello's process start (1) is not this process's (design 5.5: another process).
    const waits = await lostOne(t, box, r, 'a1a1a1a1a1a1', 1);
    await until(() => slotOf(r, waits[0] ?? '') === 1, 'the waiting terminal took 1', 5000);
    assert.equal(slotOf(r, 'a1a1a1a1a1a1'), null, 'never to the lost terminal');
  });

  test('a lost terminal whose program may still run keeps its number for the 60 s; then the first waiting terminal takes it', async (t) => {
    const box = await registrySandbox(t);
    const kept = store();
    const clock = shifted(box);
    const r = box.registry({ platform: clock.platform, persistSlots: kept.persist });
    wire(box, r, kept);
    const id = 'b2b2b2b2b2b2';
    const waits = await lostOne(t, box, r, id, 3);
    await sleep(1500);
    assert.deepEqual(slotsOf(r, [id, ...waits]), [1, null, null, null], 'held meanwhile');
    clock.shift(65n * 1_000_000_000n);
    await until(() => slotOf(r, waits[0] ?? '') === 1, 'the first waiting took 1', 5000);
    assert.deepEqual(slotsOf(r, [id, ...waits]), [null, 1, null, null]);
  });

  for (const waiting of [1, 3]) {
    test(`Close of a lost terminal that still held its number, ${waiting} waiting: the first waiting terminal takes it at once, the others wait`, async (t) => {
      const box = await registrySandbox(t);
      const kept = store();
      const clock = shifted(box);
      const r = box.registry({ platform: clock.platform, persistSlots: kept.persist });
      wire(box, r, kept);
      const id = waiting === 1 ? 'c3c3c3c3c3c3' : 'd4d4d4d4d4d4';
      const waits = await lostOne(t, box, r, id, waiting);
      assert.equal(slotOf(r, id), 1, 'held: its program may still run');
      assert.equal(r.registry.close(id), 'ok');
      assert.deepEqual(slotsOf(r, waits), [1, ...waits.slice(1).map(() => null)]);
      assert.equal(kept.latest().get(waits[0] ?? ''), 1, 'written');
    });
  }
});

/** A `giveSlots` write that must not happen. */
const noWrite = (): void => {
  assert.fail('nothing to give: nothing is written');
};

const META_NONE = {
  sessionId: SESSION,
  kind: 'resume',
  slot: null,
  openedNs: '1',
  build: 'test',
  label: null,
};

describe('registry: the terminals giveSlots passes over, each by its own guard (#189)', () => {
  test('a terminal whose hello said its program exited, its exit not applied yet: still drawn as one that may run, it takes none', async (t) => {
    const box = await registrySandbox(t);
    const id = 'e5e5e5e5e5e5';
    // A hello that says the program exited, and no exit frame after it.
    const exited = { code: 0, signal: null, atNs: '1', notStarted: null };
    await fakeKeeper(t, box, id, { meta: { ...META_NONE, dir: box.s.home }, exited });
    const r = box.registry();
    await r.registry.rediscover();
    assert.equal(info(r.registry, id).state, 'running', 'drawn as one whose program may run');
    assert.equal(info(r.registry, id).exit, null, 'its exit is not applied');
    assert.equal(r.registry.nextSlot(), 1);
    assert.equal(r.registry.giveSlots([id], noWrite), 'ok');
    assert.equal(slotOf(r, id), null);
  });

  test('a lost terminal that never had a number, while its program may still run: it takes none', async (t) => {
    const box = await registrySandbox(t);
    const id = 'f6f6f6f6f6f6';
    const keeper = await fakeKeeper(t, box, id, { meta: { ...META_NONE, dir: box.s.home } });
    const clock = shifted(box);
    const r = box.registry({ platform: clock.platform });
    await r.registry.rediscover();
    assert.equal(slotOf(r, id), null);
    await keeper.stop();
    const sock = box.files.termSock(id);
    if (!existsSync(sock)) writeFileSync(sock, ''); // connecting to a file is refused
    await until(() => info(r.registry, id).state === 'lost', 'lost', 10_000);
    assert.equal(r.registry.giveSlots([id], noWrite), 'ok');
    assert.equal(slotOf(r, id), null);
  });
});
