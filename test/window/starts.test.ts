// A keeper found unstarted, and a terminal that ended (S2 7.3, 7.8; plan task 21):
// decideFoundKeeper runs the guard, the lock check and the deadline again before a G;
// settleEndedTerminal gives back what a launch took when its session never started. The rules run
// on testDeck (fake clock, /proc and spool files the test writes); the rediscovery with real
// keepers and the stand-in runs on realTestPlatform.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { refresh } from '../../src/sessions/refresh.ts';
import { lockKey, prepareNew, readLock, renewLock } from '../../src/sessions/resume.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { startDeadline } from '../../src/sessions/launch.ts';
import type { PreparedLaunch } from '../../src/sessions/resume.ts';
import type { KeeperHello, KeeperSpec } from '../../src/window/frames.ts';
import { decideFoundKeeper, settleEndedTerminal } from '../../src/window/starts.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, SEC, T0, statLine } from '../helpers/platform.ts';
import { userRecord, writeTranscript } from '../helpers/session-files.ts';
import { startProgram, until } from '../helpers/keeper.ts';
import { info } from '../helpers/registry.ts';
import type { TestRegistry } from '../helpers/registry.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import { readRecords, waitForRecord } from '../helpers/standin.ts';
import { windowDeck } from '../helpers/window-deck.ts';
import type { WindowDeck } from '../helpers/window-deck.ts';

/** S1: a transcript in the sandbox's home, which exists; nothing holds it. */
function resumable(d: TestDeck): void {
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: d.sandbox.home }]);
}

/** A start event of `sessionId` by process `pid` waiting in the spool; the process alive when asked. */
function spoolStart(
  d: TestDeck,
  sessionId: string,
  pid: number,
  timeNs: bigint,
  seq: number,
  alive = true,
): void {
  if (alive) {
    d.proc.setProcess(pid, { stat: statLine(pid, 51234567), cmdline: ['claude'] });
  }
  const fields = {
    event: 'SessionStart' as const,
    timeNs,
    pid,
    pwd: d.sandbox.home,
    input: hookInput('SessionStart', sessionId, { source: 'resume', cwd: d.sandbox.home }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, seq)), spoolText(fields));
}

/** The hello a keeper of this launch sends before it was started, as the registry passes it on. */
function helloOf(
  d: TestDeck,
  prepared: PreparedLaunch,
  lock: string | null,
  over: Partial<KeeperHello> = {},
): KeeperHello {
  return {
    protocol: 1,
    keeper: '2',
    id: 'aaaaaaaaaaaa',
    started: false,
    startBy: String(startDeadline(prepared, lock)),
    lock,
    pid: null,
    procStart: null,
    cols: 80,
    rows: 24,
    seq: 0,
    snapSeq: 0,
    tailFrom: 1,
    gap: false,
    meta: {
      sessionId: prepared.sessionId,
      kind: prepared.kind,
      slot: 1,
      openedNs: String(prepared.preparedAtNs),
      build: 'test-build',
      label: prepared.label,
      dir: prepared.cwd,
    },
    exited: null,
    ...over,
  };
}

/** A resume of S1 prepared now (the lock taken), and the hello its keeper sends. */
function resumeLaunch(d: TestDeck): { prepared: PreparedLaunch; lock: string; hello: KeeperHello } {
  resumable(d);
  const prepared = prepareResumeById(d.deck, S1);
  const lock = readLock(d.deck, S1);
  assert.ok(lock !== null);
  return { prepared, lock, hello: helloOf(d, prepared, lock) };
}

function newLaunch(d: TestDeck): { prepared: PreparedLaunch; hello: KeeperHello } {
  const prepared = prepareNew(d.deck, {
    dir: d.sandbox.home,
    label: 'fix the build',
    group: 'ops',
    extra: [],
  });
  return { prepared, hello: helloOf(d, prepared, null) };
}

describe('decideFoundKeeper: a busy store (ruled, task 23 review 2)', () => {
  /** The deck with its write transactions failing as SQLite does, with `errcode`. */
  const failing = (d: TestDeck, errcode: number) =>
    deckWith(d.deck, {
      store: {
        transaction: () => {
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_ERROR',
            errcode,
          });
        },
      },
    });

  test('a busy or locked database → later: the keeper is not refused', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    spoolStart(d, '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e', 4343, T0 + SEC, 1); // the refresh writes
    assert.deepEqual(decideFoundKeeper(failing(d, 5), hello), { start: 'later' }, 'SQLITE_BUSY');
    assert.deepEqual(decideFoundKeeper(failing(d, 6), hello), { start: 'later' }, 'SQLITE_LOCKED');
    assert.deepEqual(
      decideFoundKeeper(failing(d, 517), hello),
      { start: 'later' },
      'BUSY_SNAPSHOT',
    );
  });

  test('any other failure of the database is still a refusal', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    spoolStart(d, '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e', 4343, T0 + SEC, 1);
    const decision = decideFoundKeeper(failing(d, 10), hello); // SQLITE_IOERR
    assert.equal(decision.start, false);
  });
});

describe('decideFoundKeeper: a resume', () => {
  test('guard, lock and deadline all hold → start', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    d.clock.advanceMs(10_000);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: true });
  });

  test('it refreshes first: a holder whose start is still in the spool → the guard’s message', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    spoolStart(d, S1, 4343, T0 + SEC, 1);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: '0b5f3c1e is running (pid 4343)',
    });
  });

  test('the lock replaced by another value, or gone → not started', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    d.deck.store.setKv(lockKey(S1), `${T0 + SEC}:999`);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: '0b5f3c1e: its resume lock was renewed or taken over',
    });
    d.deck.store.deleteKv(lockKey(S1));
    assert.equal(decideFoundKeeper(d.deck, hello).start, false);
  });

  test('a renewed lock is not the hello’s either (ruled: the exact value; S2 7.3’s limit for restore)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    d.clock.advanceMs(1000);
    const renewed = renewLock(d.deck, S1, lock);
    assert.ok(renewed !== null && renewed !== lock);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: '0b5f3c1e: its resume lock was renewed or taken over',
    });
    settleEndedTerminal(d.deck, hello);
    assert.equal(
      readLock(d.deck, S1),
      renewed,
      'settling leaves a lock that is not exactly the hello’s',
    );
  });

  test('a hello without a lock skydeck wrote → not started', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    for (const lock of [null, 'garbage']) {
      const got = decideFoundKeeper(d.deck, { ...hello, lock });
      assert.equal(got.start, false, String(lock));
    }
  });

  test('the deadline passed → “the start deadline passed”, also while the lock still holds', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    d.clock.advanceMs(56_000); // past the deadline (55 s), within the lock's 60 s
    assert.equal(d.deck.store.getKv(lockKey(S1)) !== null, true);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: 'the start deadline passed',
    });
  });

  test('an unknown session, or the boot id unreadable → not started, with the reason', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const other = {
      ...hello,
      meta: { ...hello.meta, sessionId: '2d7b5e3a-0f4c-4b8d-9e5f-4a3b2c1d0e9f' },
    };
    const unknown = decideFoundKeeper(d.deck, other);
    assert.equal(unknown.start, false);
    assert.match(unknown.start ? '' : unknown.reason, /no session matches/);
    d.proc.setBootId(null);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: 'cannot tell which sessions are running: the boot id could not be read',
    });
  });

  test('a keeper that started or ended already is never started again', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    assert.equal(
      decideFoundKeeper(d.deck, { ...hello, started: true, pid: 77, procStart: 7 }).start,
      false,
    );
    const exited = {
      code: null,
      signal: null,
      atNs: String(T0),
      notStarted: 'the start deadline passed',
    };
    assert.equal(decideFoundKeeper(d.deck, { ...hello, exited }).start, false);
  });

  test('a failure while checking (the store) → not started, the failure named; never a throw', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const broken = deckWith(d.deck, {
      store: {
        events: () => {
          throw Object.assign(new Error('the database is locked'), { code: 'SQLITE_BUSY' });
        },
      },
    });
    const got = decideFoundKeeper(broken, hello);
    assert.equal(got.start, false);
    assert.match(got.start ? '' : got.reason, /cannot check/);
  });
});

describe('decideFoundKeeper: a new session', () => {
  test('no live process holds the id → start', (t) => {
    const d = testDeck(t);
    const { hello } = newLaunch(d);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: true });
  });

  test('a live process holds the id (its start still in the spool) → not started, the guard’s words', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    spoolStart(d, prepared.sessionId, 4343, T0 + SEC, 1);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: `${prepared.sessionId.slice(0, 8)} is running (pid 4343)`,
    });
  });

  test('a process that held the id and ended is no reason not to start', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    spoolStart(d, prepared.sessionId, 4343, T0 + SEC, 1, false);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: true });
  });

  test('the deadline passed, or the boot id unreadable → not started', (t) => {
    const d = testDeck(t);
    const { hello } = newLaunch(d);
    d.proc.setBootId(null);
    assert.equal(decideFoundKeeper(d.deck, hello).start, false);
    d.proc.setBootId(BOOT_A);
    d.clock.advanceMs(55_000);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: 'the start deadline passed',
    });
  });
});

describe('settleEndedTerminal', () => {
  test('a resume whose session never started: the lock is released when it is still the hello’s', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    d.clock.advanceMs(2000);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), null);
    // At once a second resume is accepted (not "being resumed").
    prepareResumeById(d.deck, S1);
  });

  test('a start of the session after the lock (still in the spool: it ingests first) → the lock stays', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    spoolStart(d, S1, 4343, T0 + SEC, 1, false);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), lock);
  });

  test('a start dated a little before the lock but recorded after it counts (the clock steps back)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    spoolStart(d, S1, 4343, T0 - 2n * SEC, 1, false);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), lock);
  });

  test('a start recorded before the lock is not this launch’s: the lock is released', (t) => {
    const d = testDeck(t);
    resumable(d);
    spoolStart(d, S1, 4343, T0 - 100n * SEC, 1, false);
    refresh(d.deck); // the earlier start is in the store before the lock is taken
    const prepared = prepareResumeById(d.deck, S1);
    const lock = readLock(d.deck, S1);
    settleEndedTerminal(d.deck, helloOf(d, prepared, lock));
    assert.equal(readLock(d.deck, S1), null);
  });

  test('a lock that is no longer the hello’s is left alone; a hello without a lock changes nothing', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const theirs = `${T0 + SEC}:999`;
    d.deck.store.setKv(lockKey(S1), theirs);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), theirs);
    settleEndedTerminal(d.deck, { ...hello, lock: null });
    assert.equal(readLock(d.deck, S1), theirs);
  });

  test('a new session with no event: its label and group are removed', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    assert.ok(d.deck.store.meta(prepared.sessionId));
    settleEndedTerminal(d.deck, hello);
    assert.equal(d.deck.store.meta(prepared.sessionId), null);
  });

  test('a new session’s row changed since prepareNew wrote it (a note, a new label) is kept (principle 6)', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    d.clock.advanceMs(1000);
    d.deck.store.updateMeta(prepared.sessionId, { note: 'keep me' }, d.clock.nowNs());
    settleEndedTerminal(d.deck, hello);
    assert.equal(d.deck.store.meta(prepared.sessionId)?.note, 'keep me');
  });

  test('a new session that reported a start (in the spool) keeps its label and group', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    spoolStart(d, prepared.sessionId, 4343, T0 + SEC, 1, false);
    settleEndedTerminal(d.deck, hello);
    assert.equal(d.deck.store.meta(prepared.sessionId)?.label, 'fix the build');
  });
});

describe(
  'decideFoundKeeper: a keeper spawned without G, found by a new registry',
  { concurrency: true },
  () => {
    /**
     * A resume of S1 prepared (its lock taken) and its keeper spawned by a registry that sends no G
     * and is then dropped (a server that crashed); a new registry rediscovers it. Its found hello.
     */
    async function found(
      t: TestContext,
      startByNs?: (spec: KeeperSpec) => bigint,
    ): Promise<{ w: WindowDeck; r: TestRegistry; spec: KeeperSpec; hello: KeeperHello }> {
      const w = await windowDeck(t);
      const dir = w.resumable(S1);
      const prepared = prepareResumeById(w.deck, S1);
      const lock = readLock(w.deck, S1);
      const base = w.spec();
      const spec = w.spec({
        argv: [...prepared.argv],
        cwd: dir,
        env: { ...base.env, PWD: dir },
        lock,
        startBy: String(startDeadline(prepared, lock)),
        meta: { ...base.meta, sessionId: S1, kind: 'resume', slot: 1, label: null, dir },
      });
      if (startByNs !== undefined) {
        spec.startBy = String(startByNs(spec));
      }
      const first = w.registry();
      await first.registry.spawn(spec);
      first.drop();
      if (startByNs !== undefined) {
        const due = BigInt(spec.startBy);
        await until(() => w.tp.platform.clock.nowNs() > due + 500_000_000n, 'past the deadline');
      }
      const r = w.registry();
      await r.registry.rediscover();
      const event = r.events.hello.find((e) => e.hello.id === spec.id);
      assert.ok(event, 'the keeper was found');
      assert.equal(event.origin, 'found');
      return { w, r, spec, hello: event.hello };
    }

    const record = (spec: KeeperSpec): string => spec.env['STANDIN_RECORD'] ?? '';

    test('all well → start: the stand-in runs', async (t) => {
      const { w, r, spec, hello } = await found(t);
      assert.equal(hello.started, false);
      assert.deepEqual(decideFoundKeeper(w.deck, hello), { start: true });
      r.registry.start(spec.id);
      const start = await waitForRecord(record(spec), (x) => x.ev === 'start', 15_000);
      assert.deepEqual(start.ev === 'start' ? start.argv : null, ['--resume', S1]);
    });

    test('the session meanwhile running elsewhere → N with the guard’s message; nothing started', async (t) => {
      const { w, r, spec, hello } = await found(t);
      const other = await w.start({ spec: { argv: [w.standin, '--resume', S1] } });
      const { started } = await startProgram(other);
      const decision = decideFoundKeeper(w.deck, hello);
      assert.deepEqual(decision, {
        start: false,
        reason: `${S1.slice(0, 8)} is running (pid ${started.pid})`,
      });
      r.registry.refuse(spec.id, decision.start ? '' : decision.reason);
      await until(() => info(r.registry, spec.id).state === 'not-started', 'not started', 10_000);
      assert.deepEqual(readRecords(record(spec)), []);
    });

    test('the lock replaced by another value → N; nothing started', async (t) => {
      const { w, r, spec, hello } = await found(t);
      w.deck.store.setKv(lockKey(S1), `${w.tp.platform.clock.nowNs()}:12345`);
      const decision = decideFoundKeeper(w.deck, hello);
      assert.equal(decision.start, false);
      r.registry.refuse(spec.id, decision.start ? '' : decision.reason);
      await until(() => info(r.registry, spec.id).state === 'not-started', 'not started', 10_000);
      assert.deepEqual(readRecords(record(spec)), []);
    });

    test('startBy passed → the keeper itself ends the terminal not started; the decision agrees', async (t) => {
      const { w, r, spec, hello } = await found(
        t,
        (spec) => BigInt(spec.meta.openedNs) + 2_000_000_000n,
      );
      assert.equal(decideFoundKeeper(w.deck, hello).start, false);
      await until(() => info(r.registry, spec.id).state === 'not-started', 'not started', 10_000);
      assert.equal(info(r.registry, spec.id).exit?.notStarted, 'the start deadline passed');
      assert.deepEqual(readRecords(record(spec)), []);
    });
  },
);
