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
import {
  acquireLock,
  lockKey,
  lockMark,
  prepareNew,
  readLock,
  renewLock,
} from '../../src/sessions/resume.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { startDeadline } from '../../src/sessions/launch.ts';
import type { PreparedLaunch } from '../../src/sessions/resume.ts';
import type { KeeperHello, KeeperSpec } from '../../src/window/frames.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
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

type LostTerminal = Pick<TerminalInfo, 'state' | 'program' | 'exit'>;

/** decideFoundKeeper's refusal when the store's lock is not of the hello's take (C19). */
const TAKEN_OVER = '0b5f3c1e: its resume lock was taken over';

/**
 * S1's lock gone stale and taken over at `atNs` by another resume (acquireLock), with no new event
 * since the hello's lock was taken. The new value.
 */
function takeOver(d: TestDeck, atNs: bigint): string {
  d.clock.setNs(atNs);
  acquireLock(d.deck, S1, { latestEventId: d.deck.store.latestEventIdOfSession(S1) });
  const value = readLock(d.deck, S1);
  assert.equal(value, `${atNs}:0`);
  return value ?? '';
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
      reason: TAKEN_OVER,
    });
    d.deck.store.deleteKv(lockKey(S1));
    assert.equal(decideFoundKeeper(d.deck, hello).start, false);
  });

  // Turned around by task 80 (C19). Until then, as "a renewed lock is not the hello's either
  // (ruled: the exact value; S2 7.3's limit for restore)", a renewal was refused like a take-over.
  test('a renewed lock is of the hello’s take → start, after one renewal and after a chain of them (C19)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    d.clock.advanceMs(1000);
    const renewed = renewLock(d.deck, S1, lock);
    assert.ok(renewed !== null && renewed !== lock);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: true });
    d.clock.advanceMs(20_000);
    const again = renewLock(d.deck, S1, renewed);
    assert.ok(again !== null && again !== renewed);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: true });
    assert.equal(readLock(d.deck, S1), again, 'deciding takes nothing');
  });

  test('a lock taken over with no new event → “its resume lock was taken over”; also after renewals', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    takeOver(d, T0 + 61n * SEC); // stage A's "acquireLock replaces a lock older than 60 s"
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: false, reason: TAKEN_OVER });
    const renewedFirst = testDeck(t);
    const launch = resumeLaunch(renewedFirst);
    renewedFirst.clock.setNs(T0 + 50n * SEC);
    assert.ok(renewLock(renewedFirst.deck, S1, launch.lock) !== null);
    takeOver(renewedFirst, T0 + 111n * SEC);
    assert.deepEqual(decideFoundKeeper(renewedFirst.deck, launch.hello), {
      start: false,
      reason: TAKEN_OVER,
    });
  });

  test('a take-over that its taker renews (another skydeck’s restore) → taken over: the mark tells them apart', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 61n * SEC);
    d.clock.setNs(T0 + 62n * SEC);
    const theirs = renewLock(d.deck, S1, over);
    assert.ok(theirs !== null && lockMark(theirs) !== lockMark(hello.lock ?? ''));
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: false, reason: TAKEN_OVER });
  });

  test('a renewal an older skydeck wrote (now, no mark) → refused as taken over, as stage A does', (t) => {
    // Conservative across an update: nothing starts on a lock this build cannot tie to the hello.
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    assert.equal(lock, `${T0}:0`);
    d.deck.store.setKv(lockKey(S1), `${T0 + SEC}:0`); // stage A's renewLock: the time set to now
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: false, reason: TAKEN_OVER });
  });

  test('a take-over at a millisecond ≡ the take’s (mod 999,999) → taken over (ruled: two takes’ values)', (t) => {
    // C19's one in a million: the same mark and event id, but both written by acquireLock.
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 999_999n * 1_000_000n);
    assert.equal(lockMark(over), lockMark(lock));
    assert.deepEqual(decideFoundKeeper(d.deck, hello), { start: false, reason: TAKEN_OVER });
  });

  test('a renewal of such a take-over (the named limit) still starts nothing: the deadline passed long before', (t) => {
    // It is a restore's: it took the lock over 999,999 ms (16 min 40 s) after the hello's take and
    // renewed it. It reads as of the hello's take, but the keeper's deadline (55 s) is long past.
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const overAtNs = T0 + 999_999n * 1_000_000n;
    const over = takeOver(d, overAtNs);
    d.clock.setNs(overAtNs + SEC);
    assert.ok(renewLock(d.deck, S1, over) !== null);
    assert.deepEqual(decideFoundKeeper(d.deck, hello), {
      start: false,
      reason: 'the start deadline passed',
    });
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

  test('an exit before the start gives back a renewed lock of its take, after two renewals (C19)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    d.clock.setNs(T0 + 50n * SEC);
    const renewed = renewLock(d.deck, S1, lock);
    assert.ok(renewed !== null);
    d.clock.setNs(T0 + 100n * SEC);
    assert.ok(renewLock(d.deck, S1, renewed) !== null);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), null);
    prepareResumeById(d.deck, S1); // at once a second resume is accepted, not "being resumed"
  });

  test('an exit before the start leaves a lock taken over, also one taken over after renewals', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 61n * SEC);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), over);
    const renewedFirst = testDeck(t);
    const launch = resumeLaunch(renewedFirst);
    renewedFirst.clock.setNs(T0 + 50n * SEC);
    assert.ok(renewLock(renewedFirst.deck, S1, launch.lock) !== null);
    const overAfter = takeOver(renewedFirst, T0 + 111n * SEC);
    settleEndedTerminal(renewedFirst.deck, launch.hello);
    assert.equal(readLock(renewedFirst.deck, S1), overAfter);
  });

  test('an exit before the start leaves a take-over that its taker renewed; the taker renews it still', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 61n * SEC);
    d.clock.setNs(T0 + 62n * SEC);
    const theirs = renewLock(d.deck, S1, over);
    assert.ok(theirs !== null);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), theirs);
    d.clock.setNs(T0 + 63n * SEC);
    assert.notEqual(renewLock(d.deck, S1, theirs), null);
  });

  test('a renewed lock of a session that started (its start still in the spool) stays', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    // Renewed more than the 5 s tolerance after the start: the start counts from the hello's take,
    // not from the stored renewal (S2 7.8: "for this launch").
    d.clock.setNs(T0 + 10n * SEC);
    const renewed = renewLock(d.deck, S1, lock);
    spoolStart(d, S1, 4343, T0 + SEC, 1, false);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), renewed);
  });

  test('a take-over at a millisecond ≡ the take’s (mod 999,999) stays while its claude has not started (ruled)', (t) => {
    // C19's one in a million. Given back, it would let a third resume start the session while the
    // taker's claude is still on its way: twice.
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 999_999n * 1_000_000n);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), over);
    assert.throws(() => prepareResumeById(d.deck, S1), /is being resumed/);
  });

  test('… and once its claude started (its start still in the spool) it stays, and the guard refuses', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const over = takeOver(d, T0 + 999_999n * 1_000_000n);
    spoolStart(d, S1, 4343, T0 + 999_999n * 1_000_000n + SEC, 1); // the taker's claude, alive
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), over);
    assert.throws(() => prepareResumeById(d.deck, S1), /is running \(pid 4343\)/);
  });

  test('a restore’s renewal of such a take-over, its claude not started, is given back (the named limit)', (t) => {
    // What stays of C19's one in a million (ruled): the waiting restore's next renewLock returns
    // null, and its terminal's start is no longer guarded by a lock.
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    const overAtNs = T0 + 999_999n * 1_000_000n;
    const over = takeOver(d, overAtNs);
    d.clock.setNs(overAtNs + SEC);
    const renewed = renewLock(d.deck, S1, over);
    assert.ok(renewed !== null);
    settleEndedTerminal(d.deck, hello);
    assert.equal(readLock(d.deck, S1), null);
    assert.equal(renewLock(d.deck, S1, renewed), null);
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

describe('settleEndedTerminal: a lost keeper’s exit while its program may still run (task 82; S2 7.8)', () => {
  // A keeper that died sent no X: the server made the exit up at once (SIGHUP). Nobody reaped the
  // program; before its SessionStart it holds nothing the guard can see, so the lock is all the
  // command line has.
  const PROGRAM = { pid: 6161, procStart: 7777 };
  /** What the registry listed for the terminal when its exit came: lost, its program, its exit. */
  const lostAt = (atNs: bigint, over: Partial<LostTerminal> = {}): LostTerminal => ({
    state: 'lost',
    program: PROGRAM,
    exit: { code: null, signal: 1, atNs: String(atNs), notStarted: null },
    ...over,
  });
  const alive = (d: TestDeck, start = 7777): void => {
    d.proc.setProcess(6161, { stat: statLine(6161, start), cmdline: ['claude'] });
  };

  test('not started and its program lives: the lock is kept and the exit is left for later (false); once the program is gone it is released (true)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    alive(d);
    const lost = lostAt(T0);
    d.clock.advanceMs(2000);
    assert.equal(settleEndedTerminal(d.deck, hello, lost), false);
    assert.equal(readLock(d.deck, S1), lock);
    assert.throws(() => prepareResumeById(d.deck, S1), /is being resumed/);
    d.proc.setProcess(6161, null); // it ran its end and is gone
    assert.equal(settleEndedTerminal(d.deck, hello, lost), true);
    assert.equal(readLock(d.deck, S1), null);
    prepareResumeById(d.deck, S1); // at once a second resume is accepted
  });

  test('what cannot be told may still run: a stat read that throws, a stat line without a start — kept', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    d.proc.setProcess(6161, { stat: '6161 (claude) S', cmdline: ['claude'] });
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false, 'no start');
    const failing = deckWith(d.deck, {
      proc: {
        stat: () => {
          throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
        },
      },
    });
    assert.equal(settleEndedTerminal(failing, hello, lostAt(T0)), false, 'unreadable');
    assert.equal(readLock(d.deck, S1), lock);
  });

  test('its pid with another start is another process: released at once', (t) => {
    const d = testDeck(t);
    const { hello } = resumeLaunch(d);
    alive(d, 8888);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), true);
    assert.equal(readLock(d.deck, S1), null);
  });

  test('only for less than 60 s after the loss by the server’s clock: kept at 59 s and with the clock stepped back, released at 60 s (the named limit)', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    alive(d);
    d.clock.setNs(T0 + 59n * SEC);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false, '59 s');
    d.clock.setNs(T0 - 3600n * SEC);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false, 'stepped back');
    assert.equal(readLock(d.deck, S1), lock);
    d.clock.setNs(T0 + 60n * SEC);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), true, '60 s');
    assert.equal(readLock(d.deck, S1), null);
  });

  test('its program reported its start meanwhile: the settling still waits (ruled: the whole of it); once the program is gone it is settled and releases nothing', (t) => {
    const d = testDeck(t);
    const { lock, hello } = resumeLaunch(d);
    alive(d);
    spoolStart(d, S1, 4343, T0 + SEC, 1); // its child, below a wrapper, holds the session
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false);
    assert.equal(readLock(d.deck, S1), lock);
    d.proc.setProcess(6161, null);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), true);
    assert.equal(readLock(d.deck, S1), lock, 'started: the settlement keeps it (design 7.6)');
    assert.throws(() => prepareResumeById(d.deck, S1), /is running \(pid 4343\)/);
  });

  test('a new session (ruled: it waits as a resume does): its label and group stay while the program may still run; kept for good once it reported its start', (t) => {
    const d = testDeck(t);
    const { prepared, hello } = newLaunch(d);
    alive(d);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false);
    assert.equal(d.deck.store.meta(prepared.sessionId)?.label, 'fix the build');
    // Its SessionStart within the 60 s: the session is the program's now.
    spoolStart(d, prepared.sessionId, 4343, T0 + SEC, 1);
    d.clock.setNs(T0 + 30n * SEC);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), false);
    d.proc.setProcess(6161, null);
    assert.equal(settleEndedTerminal(d.deck, hello, lostAt(T0)), true);
    assert.equal(d.deck.store.meta(prepared.sessionId)?.label, 'fix the build');
    assert.equal(d.deck.store.meta(prepared.sessionId)?.group, 'ops');
  });

  test('a new session with no start: settled as before once its program is gone, or 60 s after the loss — its label and group removed', (t) => {
    const gone = testDeck(t);
    const first = newLaunch(gone);
    alive(gone);
    assert.equal(settleEndedTerminal(gone.deck, first.hello, lostAt(T0)), false);
    gone.proc.setProcess(6161, null);
    assert.equal(settleEndedTerminal(gone.deck, first.hello, lostAt(T0)), true);
    assert.equal(gone.deck.store.meta(first.prepared.sessionId), null, 'program gone');
    const late = testDeck(t);
    const second = newLaunch(late);
    alive(late);
    late.clock.setNs(T0 + 59n * SEC);
    assert.equal(settleEndedTerminal(late.deck, second.hello, lostAt(T0)), false, '59 s');
    late.clock.setNs(T0 + 60n * SEC);
    assert.equal(settleEndedTerminal(late.deck, second.hello, lostAt(T0)), true, '60 s');
    assert.equal(late.deck.store.meta(second.prepared.sessionId), null, '60 s past');
  });

  test('an exit the keeper sent (it reaped the program), a keeper lost before T, or no terminal: released as before', (t) => {
    for (const terminal of [
      lostAt(T0, {
        state: 'ended',
        exit: { code: 0, signal: null, atNs: String(T0), notStarted: null },
      }),
      lostAt(T0, {
        state: 'not-started',
        exit: { code: null, signal: null, atNs: String(T0), notStarted: 'x' },
      }),
      lostAt(T0, { program: null }),
      null,
    ]) {
      const d = testDeck(t);
      const { hello } = resumeLaunch(d);
      alive(d); // the pid and start live: only the exit the keeper sent tells it is over
      assert.equal(settleEndedTerminal(d.deck, hello, terminal), true, terminal?.state ?? 'none');
      assert.equal(readLock(d.deck, S1), null, terminal?.state ?? 'none');
    }
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
