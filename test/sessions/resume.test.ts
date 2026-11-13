import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FLAGS, buildResumeCommand } from '../../src/claude/launch.ts';
import { ResumeRefusedError, UsageError } from '../../src/platform/errors.ts';
import { NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import {
  LOCK_TTL_NS,
  acquireLock,
  checkResumable,
  flagWarnings,
  isLockHeld,
  lockEventId,
  lockKey,
  openSafely,
  prepareNew,
  prepareResume,
  readLock,
  releaseLock,
  renewLock,
  settleFailedLaunch,
  sweepLocks,
} from '../../src/sessions/resume.ts';
import type { PreparedLaunch, SawEvents } from '../../src/sessions/resume.ts';
import type { Terminal } from '../../src/terminals/types.ts';
import type { DerivedSession, Holder } from '../../src/sessions/types.ts';
import type { Store } from '../../src/store/store.ts';
import type { NewEvent } from '../../src/store/types.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { ds, meta, rowOf } from '../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

const UUID1 = '00000000-0000-4000-8000-000000000001';

function holder(pid: number, sinceNs: Ns = T0): Holder {
  return {
    process: { bootId: BOOT_A, pid, procStart: 51234567 },
    sinceNs,
    live: null,
    scripted: false,
  };
}

/** A not-running session S1 in an existing directory, with a transcript. */
function dead(d: TestDeck, over: Partial<DerivedSession> = {}): DerivedSession {
  return ds({ id: S1, dir: d.sandbox.home, ...over });
}

function running(d: TestDeck, pids: number[]): DerivedSession {
  return dead(d, { state: 'working', holders: pids.map((pid) => holder(pid)) });
}

/** The message of the ResumeRefusedError `fn` throws; fails when it throws nothing or something else. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ResumeRefusedError, `not a ResumeRefusedError: ${String(error)}`);
    assert.equal(error.exitCode, 4);
    return error.message;
  }
  throw new assert.AssertionError({ message: 'nothing was refused' });
}

/** The value of the session's resume lock, null when there is none. */
function lockOf(d: TestDeck, sessionId: string): string | null {
  return d.deck.store.getKv(lockKey(sessionId));
}

function writeLock(d: TestDeck, sessionId: string, value: string): void {
  d.deck.store.setKv(lockKey(sessionId), value);
}

/** What a decision made right now would have seen of the session: the store's latest event id. */
function sawNow(d: TestDeck, sessionId: string = S1): SawEvents {
  return { latestEventId: d.deck.store.latestEventIdOfSession(sessionId) };
}

function startEvent(
  d: TestDeck,
  sessionId: string,
  timeNs: Ns,
  over: Partial<NewEvent> = {},
): number {
  const id = d.deck.store.insertEvent({
    spoolName: `${timeNs}-4242-${sessionId}.ev`,
    timeNs,
    kind: 'start',
    detail: 'resume',
    rawDetail: 'resume',
    sessionId,
    bootId: BOOT_A,
    pid: 4242,
    procStart: 51234567,
    cwd: d.sandbox.home,
    argv: ['claude'],
    name: null,
    payload: null,
    ...over,
  });
  assert.ok(id !== null);
  return id;
}

/** What node:sqlite throws when the database is locked (SQLITE_BUSY = 5). */
const locked = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

/**
 * The deck with its store watched: `depths` gets, for every kv read, write and delete, how many
 * store transactions were open at that moment.
 */
function watched(d: TestDeck): {
  deck: typeof d.deck;
  depths: number[];
  transactions: () => number;
} {
  const store = d.deck.store;
  const depths: number[] = [];
  let depth = 0;
  let count = 0;
  const deck = deckWith(d.deck, {
    store: {
      transaction<T>(fn: () => T): T {
        depth++;
        count++;
        try {
          return store.transaction(fn);
        } finally {
          depth--;
        }
      },
      getKv: (key) => (depths.push(depth), store.getKv(key)),
      setKv: (key, value) => (depths.push(depth), store.setKv(key, value)),
      deleteKv: (key) => (depths.push(depth), store.deleteKv(key)),
      kvEntries: (prefix) => (depths.push(depth), store.kvEntries(prefix)),
      latestEventIdOfSession: (id) => (depths.push(depth), store.latestEventIdOfSession(id)),
    } satisfies Partial<Store>,
  });
  return { deck, depths, transactions: () => count };
}

// --- checkResumable ----------------------------------------------------------------------------------

test('checkResumable refuses a running session, naming its process', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => checkResumable(rowOf(running(d, [4242])), d.platform.files)),
    '0b5f3c1e is running (pid 4242)',
  );
});

test('checkResumable names every holder, latest first', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => checkResumable(rowOf(running(d, [4343, 4242])), d.platform.files)),
    '0b5f3c1e is running (pid 4343, pid 4242)',
  );
});

test('checkResumable refuses a session without a transcript', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() =>
      checkResumable(
        rowOf(ds({ id: S1, dir: d.sandbox.home, transcript: null })),
        d.platform.files,
      ),
    ),
    '0b5f3c1e has no transcript',
  );
});

test('checkResumable refuses an expired session', (t) => {
  const d = testDeck(t);
  const session = ds({
    id: S1,
    dir: d.sandbox.home,
    transcript: { missingSinceNs: T0 },
    marks: ['expired'],
  });
  assert.equal(
    refusal(() => checkResumable(rowOf(session), d.platform.files)),
    '0b5f3c1e has expired: its transcript is gone',
  );
});

test('checkResumable refuses a session whose directory is gone', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => checkResumable(rowOf(dead(d, { dir: '/gone' })), d.platform.files)),
    '0b5f3c1e: directory /gone no longer exists',
  );
});

test('checkResumable refuses a session whose directory is a file now', (t) => {
  const d = testDeck(t);
  const file = join(d.sandbox.root, 'a-file');
  writeFileSync(file, '');
  assert.equal(
    refusal(() => checkResumable(rowOf(dead(d, { dir: file })), d.platform.files)),
    `0b5f3c1e: directory ${file} no longer exists`,
  );
});

test('checkResumable refuses a session whose directory is not known', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => checkResumable(rowOf(dead(d, { dir: null })), d.platform.files)),
    '0b5f3c1e: its project directory is not known',
  );
});

test('checkResumable refuses a directory that is not an absolute path', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => checkResumable(rowOf(dead(d, { dir: 'relative/dir' })), d.platform.files)),
    '0b5f3c1e: directory relative/dir is not an absolute path',
  );
});

test('checkResumable refuses a directory it cannot look at, with the reason', (t) => {
  const d = testDeck(t);
  const files = {
    ...d.platform.files,
    stat: (): never => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  };
  assert.equal(
    refusal(() => checkResumable(rowOf(dead(d)), files)),
    `0b5f3c1e: directory ${d.sandbox.home} cannot be checked (EACCES)`,
  );
});

test('checkResumable checks the directory of the session, not the display text of the row', (t) => {
  const d = testDeck(t);
  const dir = join(d.sandbox.root, 'with\ttab');
  mkdirSync(dir);
  const row = rowOf(dead(d, { dir }));
  assert.notEqual(row.dir, dir); // sanitised for display
  checkResumable(row, d.platform.files);
});

test('checkResumable refuses a running session before anything else', (t) => {
  const d = testDeck(t);
  const session = ds({
    id: S1,
    dir: '/gone',
    transcript: null,
    state: 'running',
    holders: [holder(4242)],
  });
  assert.equal(
    refusal(() => checkResumable(rowOf(session), d.platform.files)),
    '0b5f3c1e is running (pid 4242)',
  );
});

test('checkResumable refuses a row derived without a boot id, before anything else', (t) => {
  // Without the boot id no process looked alive: the row cannot show that the session runs.
  const d = testDeck(t);
  for (const session of [dead(d, { bootId: null }), running(d, [4242])]) {
    session.bootId = null;
    assert.equal(
      refusal(() => checkResumable(rowWith(d, session), d.platform.files)),
      'cannot tell which sessions are running: the boot id could not be read',
    );
  }
});

test('checkResumable lets a dead session with an existing directory through', (t) => {
  const d = testDeck(t);
  checkResumable(rowOf(dead(d)), d.platform.files);
});

// --- lockKey, acquireLock --------------------------------------------------------------------------

test('LOCK_TTL_NS is 60 seconds', () => {
  assert.equal(LOCK_TTL_NS, 60n * NS_PER_SECOND);
});

test('lockKey is the kv key resume_lock:<id>', () => {
  assert.equal(lockKey(S1), `resume_lock:${S1}`);
});

test('lockKey refuses anything but a session id', () => {
  for (const bad of ['../x', S1.toUpperCase(), `${S1}/x`, '']) {
    assert.throws(() => lockKey(bad), RangeError);
  }
});

test('acquireLock stores the lock with the time as its value', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('acquireLock refuses within 60 s, says how long to wait and leaves the lock as it is', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  d.clock.setNs(T0 + 10n * SEC);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, sawNow(d))),
    '0b5f3c1e is being resumed (10 s ago); try again in 50 s',
  );
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('acquireLock rounds the age down and the wait up', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  d.clock.setNs(T0 + 59n * SEC + 500_000_000n);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, sawNow(d))),
    '0b5f3c1e is being resumed (59 s ago); try again in 1 s',
  );
});

test('acquireLock replaces a lock older than 60 s', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  d.clock.setNs(T0 + 61n * SEC);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(lockOf(d, S1), `${T0 + 61n * SEC}`);
});

test('acquireLock replaces a lock exactly 60 s old', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  d.clock.setNs(T0 + 60n * SEC);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(lockOf(d, S1), `${T0 + 60n * SEC}`);
});

test('acquireLock replaces a lock when the session started at or after the lock', (t) => {
  for (const startNs of [T0, T0 + 2n * SEC]) {
    const d = testDeck(t);
    acquireLock(d.deck, S1, sawNow(d));
    const started = startEvent(d, S1, startNs);
    d.clock.setNs(T0 + 5n * SEC);
    acquireLock(d.deck, S1, sawNow(d));
    assert.equal(lockOf(d, S1), `${T0 + 5n * SEC}:${started}`);
  }
});

test('acquireLock keeps a lock when the session started before it, or another one started', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  startEvent(d, S1, T0 - 1n);
  startEvent(d, S2, T0 + SEC);
  d.clock.setNs(T0 + 5n * SEC);
  assert.match(
    refusal(() => acquireLock(d.deck, S1, sawNow(d))),
    /being resumed \(5 s ago\)/,
  );
});

/** A start event the hook wrote without a process to name: no `CLAUDE_PID`, or no readable `stat`. */
const WITHOUT_A_PROCESS: Partial<NewEvent>[] = [
  { pid: 0, procStart: null },
  { pid: 0 },
  { procStart: null },
];

test('a start event without a real process does not release a lock: acquireLock still refuses', (t) => {
  for (const over of WITHOUT_A_PROCESS) {
    const d = testDeck(t);
    acquireLock(d.deck, S1, sawNow(d));
    d.clock.setNs(T0 + 10n * SEC);
    startEvent(d, S1, T0 + 5n * SEC, over);
    assert.equal(
      refusal(() => acquireLock(d.deck, S1, sawNow(d))),
      '0b5f3c1e is being resumed (10 s ago); try again in 50 s',
      JSON.stringify(over),
    );
    assert.equal(lockOf(d, S1), `${T0}`);
  }
});

test('a start event without a real process does not make sweepLocks remove a lock', (t) => {
  for (const over of WITHOUT_A_PROCESS) {
    const d = testDeck(t);
    writeLock(d, S1, `${T0 - 5n * SEC}`);
    startEvent(d, S1, T0 - 2n * SEC, over);
    assert.equal(sweepLocks(d.deck), 0, JSON.stringify(over));
    assert.equal(lockOf(d, S1), `${T0 - 5n * SEC}`);
  }
});

test("acquireLock records the session's latest event id after the time: `<time>:<id>`", (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 10n * SEC);
  acquireLock(d.deck, S1, { latestEventId: seen });
  assert.equal(lockOf(d, S1), `${T0}:${seen}`);
  acquireLock(d.deck, S2, { latestEventId: null }); // a session without events: the time alone
  assert.equal(lockOf(d, S2), `${T0}`);
});

/** A start of a real process (pid 5151, dead now) dated ten minutes ahead: the clock stepped back since. */
function startAhead(d: TestDeck): number {
  return startEvent(d, S1, T0 + 600n * SEC, { pid: 5151, spoolName: `ahead-${S1}.ev` });
}

test('a start stored before the lock was taken does not release it, whatever its time', (t) => {
  const d = testDeck(t);
  const ahead = startAhead(d);
  acquireLock(d.deck, S1, { latestEventId: ahead });
  d.clock.setNs(T0 + 10n * SEC);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, sawNow(d))),
    '0b5f3c1e is being resumed (10 s ago); try again in 50 s',
  );
  assert.equal(isLockHeld(d.deck, S1), true);
  assert.equal(sweepLocks(d.deck), 0);
  assert.equal(lockOf(d, S1), `${T0}:${ahead}`);
});

test('a start stored after the lock was taken releases it when it is dated at or after the lock', (t) => {
  const d = testDeck(t);
  const ahead = startAhead(d);
  acquireLock(d.deck, S1, { latestEventId: ahead });
  startEvent(d, S1, T0 - 1n); // stored later, but dated before the lock: not this resume's
  d.clock.setNs(T0 + 5n * SEC);
  assert.equal(isLockHeld(d.deck, S1), true);
  const started = startEvent(d, S1, T0 + 2n * SEC); // the claude the resume started
  assert.equal(isLockHeld(d.deck, S1), false);
  acquireLock(d.deck, S1, { latestEventId: started });
  assert.equal(lockOf(d, S1), `${T0 + 5n * SEC}:${started}`);
});

test('a scripted run or its end, stored after the lock, neither releases it nor slips past the saw check', (t) => {
  for (const kind of ['scripted', 'scripted-end'] as const) {
    const d = testDeck(t);
    const seen = startEvent(d, S1, T0 - 10n * SEC);
    acquireLock(d.deck, S1, { latestEventId: seen });
    d.clock.setNs(T0 + 5n * SEC);
    const scripted = startEvent(d, S1, T0 + 2n * SEC, {
      kind,
      detail: '',
      pid: 5555,
      spoolName: `${kind}-${S1}.ev`,
    });
    assert.equal(isLockHeld(d.deck, S1), true, kind); // only a real `start` is the resume's own
    assert.equal(sweepLocks(d.deck), 0, kind);
    assert.equal(
      refusal(() => acquireLock(d.deck, S1, { latestEventId: seen })),
      '0b5f3c1e is being resumed (5 s ago); try again in 55 s',
      kind,
    );
    d.clock.setNs(T0 + 61n * SEC); // the lock has expired: now the saw check speaks
    assert.equal(
      refusal(() => acquireLock(d.deck, S1, { latestEventId: seen })),
      CHANGED,
      kind,
    );
    acquireLock(d.deck, S1, { latestEventId: scripted }); // it counts as the latest event
    assert.equal(lockOf(d, S1), `${T0 + 61n * SEC}:${scripted}`, kind);
  }
});

test('a lock that records no event id (an earlier skydeck wrote it) is released as before', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0}`);
  startAhead(d); // any start at or after the lock's time releases it
  d.clock.setNs(T0 + 5n * SEC);
  assert.equal(isLockHeld(d.deck, S1), false);
  assert.equal(sweepLocks(d.deck), 1);
});

test('a lock whose event id is not a number is stale like any value skydeck did not write', (t) => {
  for (const value of [`${T0}:`, `${T0}:x`, `${T0}:-1`, `${T0}:1:2`, `:1`, `${T0}:1 `]) {
    const d = testDeck(t);
    writeLock(d, S1, value);
    assert.equal(isLockHeld(d.deck, S1), false, JSON.stringify(value));
    acquireLock(d.deck, S1, sawNow(d));
    assert.equal(lockOf(d, S1), `${T0}`, JSON.stringify(value));
  }
});

test('lockEventId is the event id a lock records; null when it records none or is no lock', () => {
  assert.equal(lockEventId(`${T0}:42`), 42);
  assert.equal(lockEventId(`${T0}`), null);
  assert.equal(lockEventId('soon'), null);
  assert.equal(lockEventId(`${T0}:x`), null);
});

test('acquireLock locks each session on its own', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  acquireLock(d.deck, S2, sawNow(d, S2));
  assert.equal(lockOf(d, S2), `${T0}`);
});

test('acquireLock replaces a lock whose value is not a time', (t) => {
  for (const value of ['', 'soon', '12x', '-5', ' 1']) {
    const d = testDeck(t);
    writeLock(d, S1, value);
    acquireLock(d.deck, S1, sawNow(d));
    assert.equal(lockOf(d, S1), `${T0}`, JSON.stringify(value));
  }
});

test('acquireLock treats a lock dated a little in the future as fresh, one far ahead as stale', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 + 10n * SEC}`);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, sawNow(d))),
    '0b5f3c1e is being resumed (0 s ago); try again in 70 s',
  );
  writeLock(d, S1, `${T0 + 60n * SEC}`);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('acquireLock reads and writes the lock inside one transaction', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 120n * SEC}`);
  const w = watched(d);
  acquireLock(w.deck, S1, sawNow(d));
  assert.equal(w.transactions(), 1);
  assert.ok(w.depths.length >= 2, String(w.depths));
  assert.ok(
    w.depths.every((depth) => depth === 1),
    String(w.depths),
  );
  d.clock.setNs(T0 + SEC);
  refusal(() => acquireLock(w.deck, S1, sawNow(d)));
  assert.equal(w.transactions(), 2);
  assert.ok(
    w.depths.every((depth) => depth === 1),
    String(w.depths),
  );
});

const CHANGED = "the session's state changed while preparing; run the command again";

test('acquireLock takes the lock when the session still has the latest event it was decided on', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 10n * SEC);
  acquireLock(d.deck, S1, { latestEventId: seen });
  assert.equal(lockOf(d, S1), `${T0}:${seen}`);
  d.clock.setNs(T0 + 61n * SEC);
  acquireLock(d.deck, S2, { latestEventId: null }); // none seen, none there
  assert.equal(lockOf(d, S2), `${T0 + 61n * SEC}`);
});

test('acquireLock refuses, and writes no lock, when the session has a newer event than the decision saw', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 10n * SEC);
  startEvent(d, S1, T0 - 1n * SEC); // another skydeck resumed the session since
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, { latestEventId: seen })),
    CHANGED,
  );
  assert.equal(lockOf(d, S1), null);
});

test('acquireLock refuses when the decision saw no event and one has appeared', (t) => {
  const d = testDeck(t);
  startEvent(d, S1, T0 - 1n * SEC);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, { latestEventId: null })),
    CHANGED,
  );
  assert.equal(lockOf(d, S1), null);
});

test('acquireLock ignores the events of other sessions', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 10n * SEC);
  startEvent(d, S2, T0 - 1n * SEC);
  acquireLock(d.deck, S1, { latestEventId: seen });
  assert.equal(lockOf(d, S1), `${T0}:${seen}`);
});

test('acquireLock cannot be called without the decision it checks (a compile error, not a skipped check)', (t) => {
  const d = testDeck(t);
  const withoutIt = (): void => {
    // @ts-expect-error `saw` is required: a caller that skips the re-check must be a compile error
    acquireLock(d.deck, S1);
  };
  assert.equal(typeof withoutIt, 'function'); // never called: `npm run typecheck` is the test
});

test('acquireLock leaves a stale lock as it is when the state changed', (t) => {
  const d = testDeck(t);
  const stale = `${T0 - 120n * SEC}`;
  writeLock(d, S1, stale);
  const seen = startEvent(d, S1, T0 - 130n * SEC);
  startEvent(d, S1, T0 - 1n * SEC);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1, { latestEventId: seen })),
    CHANGED,
  );
  assert.equal(lockOf(d, S1), stale);
});

test('acquireLock reads the latest event inside its transaction, before it writes the lock', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 10n * SEC);
  const w = watched(d);
  acquireLock(w.deck, S1, { latestEventId: seen });
  assert.equal(w.transactions(), 1);
  assert.ok(w.depths.length >= 3, String(w.depths)); // the lock, the latest event, the write
  assert.ok(
    w.depths.every((depth) => depth === 1),
    String(w.depths),
  );
});

test('acquireLock lets a failure of the database through', (t) => {
  const d = testDeck(t);
  const failure = locked();
  const deck = deckWith(d.deck, {
    store: {
      getKv(): string | null {
        throw failure;
      },
    },
  });
  assert.throws(() => acquireLock(deck, S1, sawNow(d)), failure);
});

// --- sweepLocks ------------------------------------------------------------------------------------

test('sweepLocks removes stale locks, keeps fresh ones and counts what it removed', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}`); // too old
  writeLock(d, S2, `${T0 - 5n * SEC}`); // followed by a start
  startEvent(d, S2, T0 - 2n * SEC);
  writeLock(d, S3, `${T0 - 5n * SEC}`); // fresh
  assert.equal(sweepLocks(d.deck), 2);
  assert.equal(lockOf(d, S1), null);
  assert.equal(lockOf(d, S2), null);
  assert.equal(lockOf(d, S3), `${T0 - 5n * SEC}`);
});

test('sweepLocks removes a lock whose value is not a time, and one far in the future', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, 'soon');
  writeLock(d, S2, `${T0 + 60n * SEC}`);
  writeLock(d, S3, `${T0 + 59n * SEC}`);
  assert.equal(sweepLocks(d.deck), 2);
  assert.deepEqual(
    d.deck.store.kvEntries('resume_lock:').map((entry) => entry.key),
    [lockKey(S3)],
  );
});

test('sweepLocks leaves every other kv entry alone', (t) => {
  const d = testDeck(t);
  d.deck.store.setKv('settings_hash', 'abc');
  d.deck.store.setKv('first_scan_done', '1');
  assert.equal(sweepLocks(d.deck), 0);
  assert.equal(d.deck.store.getKv('settings_hash'), 'abc');
  assert.equal(d.deck.store.getKv('first_scan_done'), '1');
});

test('sweepLocks reads again and removes inside one transaction', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}`);
  writeLock(d, S2, `${T0 - 61n * SEC}`);
  const w = watched(d);
  assert.equal(sweepLocks(w.deck), 2);
  assert.equal(w.transactions(), 1);
  // A look first (outside), then, inside the transaction, the list again and every removal.
  assert.deepEqual(w.depths, [0, 1, 1, 1]);
});

test('sweepLocks without a stale lock takes no write transaction', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 5n * SEC}`);
  const w = watched(d);
  assert.equal(sweepLocks(w.deck), 0);
  assert.equal(w.transactions(), 0);
  assert.equal(lockOf(d, S1), `${T0 - 5n * SEC}`);
});

test('sweepLocks keeps a lock that became fresh between its look and its transaction', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}`);
  const store = d.deck.store;
  let looks = 0;
  const deck = deckWith(d.deck, {
    store: {
      kvEntries(prefix: string) {
        if (++looks === 2) {
          store.setKv(lockKey(S1), `${T0}`); // another resume took it over meanwhile
        }
        return store.kvEntries(prefix);
      },
    },
  });
  assert.equal(sweepLocks(deck), 0);
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('sweepLocks lets a failure of the database through', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 5n * SEC}`);
  const failure = locked();
  const deck = deckWith(d.deck, {
    store: {
      hasProcessStartSince(): boolean {
        throw failure;
      },
    },
  });
  assert.throws(() => sweepLocks(deck), failure);
  assert.equal(lockOf(d, S1), `${T0 - 5n * SEC}`);
});

test('refresh sweeps the locks at its end', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}`);
  refresh(d.deck);
  assert.equal(lockOf(d, S1), null);
});

test('no lock is a file: the locks directory stays empty', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  mkdirSync(d.deck.places.locksDir, { recursive: true });
  writeFileSync(join(d.deck.places.locksDir, `${S2}.lock`), `${T0 - 600n * SEC}\n`);
  assert.equal(sweepLocks(d.deck), 0); // a file there is not a lock any more
  assert.equal(lockOf(d, S1), `${T0}`);
});

// --- readLock, renewLock, releaseLock, isLockHeld --------------------------------------------------

test("readLock is the value of the session's lock, null without one", (t) => {
  const d = testDeck(t);
  assert.equal(readLock(d.deck, S1), null);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(readLock(d.deck, S1), `${T0}`);
});

test('renewLock moves a lock that is still ours to now and returns its new value', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  d.clock.setNs(T0 + 50n * SEC);
  assert.equal(renewLock(d.deck, S1, `${T0}`), `${T0 + 50n * SEC}`);
  assert.equal(lockOf(d, S1), `${T0 + 50n * SEC}`);
  d.clock.setNs(T0 + 100n * SEC); // 50 s after the renewal: it still holds
  assert.throws(() => acquireLock(d.deck, S1, sawNow(d)), /is being resumed \(50 s ago\)/);
});

test('renewLock keeps the event id the lock records: only a later start releases it still', (t) => {
  const d = testDeck(t);
  const ahead = startAhead(d);
  acquireLock(d.deck, S1, { latestEventId: ahead });
  d.clock.setNs(T0 + 50n * SEC);
  assert.equal(renewLock(d.deck, S1, `${T0}:${ahead}`), `${T0 + 50n * SEC}:${ahead}`);
  assert.equal(lockOf(d, S1), `${T0 + 50n * SEC}:${ahead}`);
  assert.equal(isLockHeld(d.deck, S1), true);
});

test('renewLock leaves a lock that is no longer ours, or gone, as it is, and says so', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 + 1n}`); // another skydeck took it over
  assert.equal(renewLock(d.deck, S1, `${T0}`), null);
  assert.equal(lockOf(d, S1), `${T0 + 1n}`);
  assert.equal(renewLock(d.deck, S2, `${T0}`), null);
  assert.equal(lockOf(d, S2), null);
});

test('renewLock reads and writes inside one transaction', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  const w = watched(d);
  renewLock(w.deck, S1, `${T0}`);
  assert.equal(w.transactions(), 1);
  assert.deepEqual(w.depths, [1, 1]);
});

test('releaseLock removes a lock that is still ours, and only that', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  writeLock(d, S2, `${T0 + 1n}`);
  assert.equal(releaseLock(d.deck, S1, `${T0}`), true);
  assert.equal(lockOf(d, S1), null);
  assert.equal(releaseLock(d.deck, S2, `${T0}`), false);
  assert.equal(lockOf(d, S2), `${T0 + 1n}`);
  const w = watched(d);
  releaseLock(w.deck, S2, `${T0}`);
  assert.equal(w.transactions(), 1);
});

test('isLockHeld is true for a lock that holds, by the rules of acquireLock, and takes none', (t) => {
  const d = testDeck(t);
  assert.equal(isLockHeld(d.deck, S1), false);
  writeLock(d, S1, `${T0 - 59n * SEC}`);
  assert.equal(isLockHeld(d.deck, S1), true);
  writeLock(d, S1, `${T0 - 60n * SEC}`);
  assert.equal(isLockHeld(d.deck, S1), false);
  writeLock(d, S1, 'soon');
  assert.equal(isLockHeld(d.deck, S1), false);
  writeLock(d, S1, `${T0 - 5n * SEC}`);
  startEvent(d, S1, T0 - 2n * SEC);
  assert.equal(isLockHeld(d.deck, S1), false); // it started: the guard's running check takes over
  const w = watched(d);
  isLockHeld(w.deck, S2);
  assert.equal(w.transactions(), 0);
  assert.equal(lockOf(d, S2), null);
});

// --- what the command line and restore share about a launch ---------------------------------------

test('flagWarnings: what a resume says about the flags it could not take over, unprefixed', () => {
  assert.deepEqual(flagWarnings({ flagsKnown: true, unknownFlags: [] }), []);
  assert.deepEqual(flagWarnings({ flagsKnown: false, unknownFlags: ['--a\x1b[1mb', '--c'] }), [
    'original flags unknown; resuming with defaults',
    'started with flags skydeck does not know, not passed on resume: --ab --c',
  ]);
});

test('openSafely turns a terminal that rejects into a failed open, not a timeout', async () => {
  const spec = { cwd: '/w', argv: ['claude'] };
  const rejecting: Terminal = {
    name: 'wezterm',
    opensTabs: true,
    open: () => Promise.reject(new Error('the terminal fell over')),
  };
  assert.deepEqual(await openSafely(rejecting, spec), {
    ok: false,
    error: 'cannot open the terminal (Error: the terminal fell over)',
    timedOut: false,
  });
  const fine: Terminal = { ...rejecting, open: async () => ({ ok: true }) };
  assert.deepEqual(await openSafely(fine, spec), { ok: true });
});

function launch(d: TestDeck, over: Partial<PreparedLaunch> = {}): PreparedLaunch {
  return {
    sessionId: S1,
    cwd: '/w',
    argv: ['claude', '--resume', S1],
    flagsKnown: true,
    unknownFlags: [],
    kind: 'resume',
    ...over,
  };
}

const UNPRINTABLE_ARGV = ['claude', '--resume', S1, '--model', 'op\x1b[31mus'];

test('settleFailedLaunch gives the command to print, and keeps the lock: the user may run it now', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(
    settleFailedLaunch(d.deck, launch(d), `${T0}`, false),
    `cd -- /w && claude --resume ${S1}`,
  );
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('settleFailedLaunch after a timeout gives no command and keeps the lock: it may have started', (t) => {
  for (const argv of [['claude', '--resume', S1], UNPRINTABLE_ARGV]) {
    const d = testDeck(t);
    acquireLock(d.deck, S1, sawNow(d));
    assert.equal(settleFailedLaunch(d.deck, launch(d, { argv }), `${T0}`, true), null);
    assert.equal(lockOf(d, S1), `${T0}`, JSON.stringify(argv));
  }
});

test('settleFailedLaunch with nothing started and nothing printable releases the lock, if still ours', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1, sawNow(d));
  assert.equal(
    settleFailedLaunch(d.deck, launch(d, { argv: UNPRINTABLE_ARGV }), `${T0}`, false),
    null,
  );
  assert.equal(lockOf(d, S1), null);
  writeLock(d, S1, 'someone else');
  settleFailedLaunch(d.deck, launch(d, { argv: UNPRINTABLE_ARGV }), `${T0}`, false);
  assert.equal(lockOf(d, S1), 'someone else');
});

test('settleFailedLaunch of a new session that started nothing and printed nothing removes its label and group', (t) => {
  const d = testDeck(t);
  d.deck.store.updateMeta(S1, { label: 'fix it', group: 'G' }, T0);
  const p = launch(d, { kind: 'new', argv: UNPRINTABLE_ARGV });
  assert.equal(settleFailedLaunch(d.deck, p, null, true), null); // timed out: kept
  assert.equal(d.deck.store.meta(S1)?.label, 'fix it');
  assert.equal(settleFailedLaunch(d.deck, p, null, false), null);
  assert.equal(d.deck.store.meta(S1), null);
});

// --- prepareResume ---------------------------------------------------------------------------------

function rowWith(d: TestDeck, session: DerivedSession, label: string | null = null): ListRow {
  return rowOf(session, label === null ? {} : { metas: [meta(S1, { label })] });
}

test('prepareResume builds the command and takes the lock', (t) => {
  const d = testDeck(t);
  const launch = ['claude', '--model', 'opus'];
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { launch }), 'fix'));
  assert.deepEqual(prepared, {
    sessionId: S1,
    cwd: d.sandbox.home,
    argv: buildResumeCommand({ claudeCommand: 'claude', launch, sessionId: S1, label: 'fix' }).argv,
    flagsKnown: true,
    unknownFlags: [],
    kind: 'resume',
  });
  assert.deepEqual(prepared.argv, ['claude', '--resume', S1, '-n', 'fix', '--model', 'opus']);
  assert.equal(lockOf(d, S1), `${T0}`);
});

test('prepareResume runs the configured program', (t) => {
  const d = testDeck(t, { config: { claudeCommand: '/opt/claude/bin/claude' } });
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { launch: ['claude'] })));
  assert.deepEqual(prepared.argv, ['/opt/claude/bin/claude', '--resume', S1]);
});

test('prepareResume names the flags it cannot pass on', (t) => {
  const d = testDeck(t);
  const launch = ['claude', '--frob', 'x', '--model', 'opus'];
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { launch })));
  assert.deepEqual(prepared.argv, ['claude', '--resume', S1, '--model', 'opus']);
  assert.deepEqual(prepared.unknownFlags, ['--frob']);
  assert.equal(prepared.flagsKnown, true);
});

test('prepareResume of a session without a launch command: flags unknown, none named', (t) => {
  const d = testDeck(t);
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { launch: null })));
  assert.deepEqual(prepared.argv, ['claude', '--resume', S1]);
  assert.equal(prepared.flagsKnown, false);
  assert.deepEqual(prepared.unknownFlags, []);
});

test('prepareResume keeps a permission flag the session had, and never adds one', (t) => {
  const d = testDeck(t);
  const kept = prepareResume(
    d.deck,
    rowWith(d, dead(d, { launch: ['claude', '--permission-mode', 'plan'] })),
  );
  assert.deepEqual(kept.argv, ['claude', '--resume', S1, '--permission-mode', 'plan']);
  d.clock.setNs(T0 + 61n * SEC);
  const none = prepareResume(d.deck, rowWith(d, dead(d, { launch: ['claude'] })));
  assert.deepEqual(none.argv, ['claude', '--resume', S1]);
});

test('prepareResume refuses a running session and takes no lock', (t) => {
  const d = testDeck(t);
  assert.match(
    refusal(() => prepareResume(d.deck, rowWith(d, running(d, [4242])))),
    /running/,
  );
  assert.equal(lockOf(d, S1), null);
});

test('prepareResume refuses a session whose directory is gone and takes no lock', (t) => {
  const d = testDeck(t);
  refusal(() => prepareResume(d.deck, rowWith(d, dead(d, { dir: '/gone' }))));
  assert.equal(lockOf(d, S1), null);
});

test('prepareResume guards before it locks: a stale lock of a running session stays as it is', (t) => {
  const d = testDeck(t);
  const stale = `${T0 - 120n * SEC}`;
  writeLock(d, S1, stale);
  assert.equal(
    refusal(() => prepareResume(d.deck, rowWith(d, running(d, [4242])))),
    '0b5f3c1e is running (pid 4242)',
  );
  assert.equal(lockOf(d, S1), stale);
});

test('prepareResume refuses a second resume within 60 s', (t) => {
  const d = testDeck(t);
  prepareResume(d.deck, rowWith(d, dead(d)));
  d.clock.setNs(T0 + 30n * SEC);
  assert.equal(
    refusal(() => prepareResume(d.deck, rowWith(d, dead(d)))),
    '0b5f3c1e is being resumed (30 s ago); try again in 30 s',
  );
});

test('prepareResume decides on the latest event its row saw: a session resumed since is refused, with no lock', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 120n * SEC);
  const row = rowWith(d, dead(d, { lastEventId: seen })); // the look
  startEvent(d, S1, T0 - 1n * SEC); // another skydeck resumed it, and its start was ingested
  assert.equal(
    refusal(() => prepareResume(d.deck, row)),
    CHANGED,
  );
  assert.equal(lockOf(d, S1), null);
});

test('prepareResume refuses a session that another skydeck resumed and whose lock a sweep has removed', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 120n * SEC);
  const lookedAt = rowWith(d, dead(d, { lastEventId: seen })); // B looks: not running
  acquireLock(d.deck, S1, { latestEventId: seen }); // A takes the lock …
  d.clock.setNs(T0 + 3n * SEC);
  startEvent(d, S1, T0 + 2n * SEC); // … its claude starts, the start event is ingested …
  assert.equal(sweepLocks(d.deck), 1); // … and a sweep removes the lock: a start event was seen
  assert.equal(lockOf(d, S1), null);
  assert.equal(
    refusal(() => prepareResume(d.deck, lookedAt)), // B takes its lock now
    CHANGED,
  );
  assert.equal(lockOf(d, S1), null);
});

test('prepareResume refuses a session whose event arrives between its checks and its lock', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 120n * SEC);
  const real = d.platform.files;
  let inserted = false;
  const deck = deckWith(d.deck, {
    files: {
      stat(path) {
        // checkResumable looks at the directory after the guard has read the row, before the lock
        if (!inserted) {
          inserted = true;
          startEvent(d, S1, T0 - 1n * SEC);
        }
        return real.stat(path);
      },
    },
  });
  assert.equal(
    refusal(() => prepareResume(deck, rowWith(d, dead(d, { lastEventId: seen })))),
    CHANGED,
  );
  assert.ok(inserted);
  assert.equal(lockOf(d, S1), null);
});

test('prepareResume resumes a session that has not changed since its row was read', (t) => {
  const d = testDeck(t);
  const seen = startEvent(d, S1, T0 - 120n * SEC);
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { lastEventId: seen })));
  assert.equal(prepared.sessionId, S1);
  assert.equal(lockOf(d, S1), `${T0}:${seen}`);
});

const BOOT_UNKNOWN = 'cannot tell which sessions are running: the boot id could not be read';

test('prepareResume refuses a row derived without a boot id, and takes no lock', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusal(() => prepareResume(d.deck, rowWith(d, dead(d, { bootId: null })))),
    BOOT_UNKNOWN,
  );
  assert.equal(lockOf(d, S1), null);
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

test('an unknown boot id is refused before anything else: no process looks alive without it', (t) => {
  const d = testDeck(t);
  const noTranscript = rowOf(ds({ id: S1, dir: d.sandbox.home, transcript: null, bootId: null }));
  assert.equal(
    refusal(() => prepareResume(d.deck, noTranscript)),
    BOOT_UNKNOWN,
  );
  // the refusal is the guard's own: exit 4, like the other refusals of 7.6
  assert.throws(
    () => prepareResume(d.deck, rowWith(d, dead(d, { bootId: null }))),
    ResumeRefusedError,
  );
});

test("the boot id of the decision is the row's: a read that failed then is not replaced by one that works now", (t) => {
  const d = testDeck(t);
  d.proc.setBootId(BOOT_A); // readable now; the row was judged without it
  assert.equal(
    refusal(() => prepareResume(d.deck, rowWith(d, dead(d, { bootId: null })))),
    BOOT_UNKNOWN,
  );
  assert.equal(lockOf(d, S1), null);
  assert.equal(prepareResume(d.deck, rowWith(d, dead(d, { bootId: BOOT_A }))).sessionId, S1);
});

// --- prepareNew ------------------------------------------------------------------------------------

test('prepareNew stores the cleaned label and group and builds the command', (t) => {
  const d = testDeck(t);
  const prepared = prepareNew(d.deck, { label: ' x ', group: 'G', extra: ['--model', 'opus'] });
  assert.deepEqual(prepared, {
    sessionId: UUID1,
    cwd: d.platform.cwd,
    argv: ['claude', '--session-id', UUID1, '-n', 'x', '--model', 'opus'],
    flagsKnown: true,
    unknownFlags: [],
    kind: 'new',
  });
  const stored = d.deck.store.meta(UUID1);
  assert.equal(stored?.label, 'x');
  assert.equal(stored?.group, 'G');
});

test('prepareNew without a label or group stores nothing and passes no name', (t) => {
  const d = testDeck(t, { config: { claudeCommand: 'cc' } });
  const prepared = prepareNew(d.deck, { label: null, group: null, extra: [] });
  assert.deepEqual(prepared.argv, ['cc', '--session-id', UUID1]);
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('prepareNew refuses a bad label or group before it stores anything', (t) => {
  const d = testDeck(t);
  assert.throws(() => prepareNew(d.deck, { label: '-x', group: 'G', extra: [] }), UsageError);
  assert.throws(() => prepareNew(d.deck, { label: 'x', group: 'a\nb', extra: [] }), UsageError);
  assert.deepEqual(d.deck.store.allMeta(), []);
});

test('prepareNew does not need the boot id: it resumes nothing', (t) => {
  const d = testDeck(t);
  d.proc.setBootId(null);
  const prepared = prepareNew(d.deck, { label: null, group: null, extra: [] });
  assert.deepEqual(prepared.argv, ['claude', '--session-id', UUID1]);
});

test('prepareNew takes no lock', (t) => {
  const d = testDeck(t);
  prepareNew(d.deck, { label: null, group: null, extra: [] });
  assert.deepEqual(d.deck.store.kvEntries('resume_lock:'), []);
});

/** The UsageError prepareNew throws for these extra flags; nothing may be stored. */
function refusedExtra(d: TestDeck, extra: string[]): string {
  try {
    prepareNew(d.deck, { label: 'x', group: 'G', extra });
  } catch (error) {
    assert.ok(error instanceof UsageError, `not a UsageError: ${String(error)}`);
    assert.deepEqual(d.deck.store.allMeta(), []);
    return error.message;
  }
  throw new assert.AssertionError({ message: `${JSON.stringify(extra)} was not refused` });
}

test('prepareNew refuses a flag that resumes or continues a session: -r <id>, -c', (t) => {
  const d = testDeck(t);
  assert.match(refusedExtra(d, ['-r', S1]), /^cannot pass -r to claude:/);
  assert.match(refusedExtra(d, ['--model', 'opus', '-c']), /cannot pass -c to claude/);
  assert.match(refusedExtra(d, ['--resume']), /cannot pass --resume to claude/);
  assert.match(refusedExtra(d, [`-r${S1}`]), /cannot pass -r to claude/);
});

test('prepareNew refuses such a flag inside a cluster of short flags, naming the cluster', (t) => {
  const d = testDeck(t);
  assert.match(refusedExtra(d, ['-cp']), /cannot pass -cp \(--continue\) to claude/);
  assert.match(refusedExtra(d, ['-pc']), /cannot pass -pc \(--continue\) to claude/);
});

test('prepareNew refuses every flag that picks an existing session: alone, as --flag=value, in a cluster', (t) => {
  const d = testDeck(t);
  assert.match(refusedExtra(d, [`--session-id=${S1}`]), /cannot pass --session-id to claude/);
  const picking = FLAGS.filter((spec) => spec.picksSession);
  assert.ok(picking.length > 0);
  for (const spec of picking) {
    for (const name of spec.names) {
      const args = spec.shape === 'none' ? [name] : [name, 'v'];
      assert.match(refusedExtra(d, args), new RegExp(`^cannot pass ${name} to claude: `), name);
      if (name.startsWith('--') && spec.shape !== 'none') {
        const glued = refusedExtra(d, [`${name}=v`]);
        assert.match(glued, new RegExp(`^cannot pass ${name} to claude: `), `${name}=v`);
      }
      if (!name.startsWith('--') && spec.shape === 'none') {
        assert.match(refusedExtra(d, [`-p${name.slice(1)}`]), /^cannot pass -p. \(--/, name);
      }
    }
  }
});

test('prepareNew refuses a cluster that picks a session before an unknown letter or an unknown long flag', (t) => {
  const d = testDeck(t);
  assert.match(refusedExtra(d, ['-cZ']), /^cannot pass -cZ \(--continue\) to claude: it picks/);
  assert.match(refusedExtra(d, ['-pcZfix']), /^cannot pass -pcZfix \(--continue\) to claude: /);
  assert.match(
    refusedExtra(d, ['-c-frob', 'x']),
    /^cannot pass -c-frob \(--continue\) to claude: /,
  );
  assert.match(refusedExtra(d, ['-c-frob=x']), /^cannot pass -c-frob=x \(--continue\) to claude: /);
  assert.match(refusedExtra(d, ['-pc-frob']), /^cannot pass -pc-frob \(--continue\) to claude: /);
  // nothing that picks a session was read before the unknown part: the flags are passed on
  for (const extra of [['-pZ'], ['-Zc'], ['-p-frob'], ['--frob', 'x']]) {
    const prepared = prepareNew(d.deck, { label: null, group: null, extra });
    assert.deepEqual(prepared.argv.slice(3), extra, extra.join(' '));
  }
});

test('prepareNew says that a refused flag picks an existing session, and what to use instead', (t) => {
  const d = testDeck(t);
  assert.equal(
    refusedExtra(d, ['--fork-session']),
    'cannot pass --fork-session to claude: it picks an existing session; use skydeck resume',
  );
});

test('prepareNew refuses --name and -n and points to --label, which skydeck passes as the name', (t) => {
  const d = testDeck(t);
  for (const extra of [['-n', 'x'], ['--name', 'x'], ['--name=x'], ['-nx'], ['-pn', 'x']]) {
    assert.match(
      refusedExtra(d, extra),
      /^cannot pass -?-?\w+ (\(--name\) )?to claude: .*--label/,
      extra.join(' '),
    );
  }
  assert.equal(
    refusedExtra(d, ['-n', 'x']),
    'cannot pass -n to claude: the label is given with --label, and skydeck passes it as the name',
  );
});

test('prepareNew passes --worktree and the other flags that say where a new session starts', (t) => {
  const d = testDeck(t);
  const passed = (extra: string[]): string[] =>
    prepareNew(d.deck, { label: null, group: null, extra }).argv.slice(3);
  assert.deepEqual(passed(['--worktree']), ['--worktree']);
  assert.deepEqual(passed(['-w', 'feat', '--model', 'x', 'fix the bug']), [
    '-w',
    'feat',
    '--model',
    'x',
    'fix the bug',
  ]);
  assert.deepEqual(passed(['-pw', '--tmux']), ['-pw', '--tmux']);
});

test('prepareNew passes every removed flag that does not pick a session, except --name', (t) => {
  const d = testDeck(t);
  const rest = FLAGS.filter(
    (spec) => spec.remove && !spec.picksSession && !spec.names.includes('--name'),
  );
  assert.ok(rest.length > 0);
  for (const spec of rest) {
    for (const name of spec.names) {
      const extra = spec.shape === 'none' ? [name] : [name, 'v'];
      const prepared = prepareNew(d.deck, { label: 'x', group: null, extra });
      assert.deepEqual(prepared.argv.slice(-extra.length), extra, name);
    }
  }
});

test('prepareNew passes other flags and a prompt on as they are', (t) => {
  const d = testDeck(t);
  const prepared = prepareNew(d.deck, {
    label: null,
    group: null,
    extra: ['--model', 'x', 'fix the bug', '--frob', '--', '-r'],
  });
  assert.deepEqual(prepared.argv, [
    'claude',
    '--session-id',
    UUID1,
    '--model',
    'x',
    'fix the bug',
    '--frob',
    '--',
    '-r',
  ]);
});
