import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildResumeCommand } from '../../src/claude/launch.ts';
import { ResumeRefusedError, UsageError } from '../../src/platform/errors.ts';
import { NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import {
  LOCK_TTL_NS,
  acquireLock,
  checkResumable,
  lockPath,
  prepareNew,
  prepareResume,
  sweepLocks,
} from '../../src/sessions/resume.ts';
import type { DerivedSession, Holder } from '../../src/sessions/types.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { ds, meta, rowOf } from '../helpers/derived.ts';
import { BOOT_A, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';

const UUID1 = '00000000-0000-4000-8000-000000000001';

function holder(pid: number, sinceNs: Ns = T0): Holder {
  return { process: { bootId: BOOT_A, pid, procStart: 51234567 }, sinceNs, live: null };
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

function lockOf(d: TestDeck, sessionId: string): string | null {
  const path = lockPath(d.deck.places, sessionId);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function writeLock(d: TestDeck, sessionId: string, content: string): void {
  writeFileSync(lockPath(d.deck.places, sessionId), content);
}

function startEvent(d: TestDeck, sessionId: string, timeNs: Ns): void {
  d.deck.store.insertEvent({
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
  });
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

test('checkResumable lets a dead session with an existing directory through', (t) => {
  const d = testDeck(t);
  checkResumable(rowOf(dead(d)), d.platform.files);
});

// --- lockPath, acquireLock -------------------------------------------------------------------------

test('LOCK_TTL_NS is 60 seconds', () => {
  assert.equal(LOCK_TTL_NS, 60n * NS_PER_SECOND);
});

test('lockPath is <locksDir>/<id>.lock', (t) => {
  const d = testDeck(t);
  assert.equal(lockPath(d.deck.places, S1), join(d.deck.places.locksDir, `${S1}.lock`));
});

test('lockPath refuses anything but a session id', (t) => {
  const d = testDeck(t);
  for (const bad of ['../x', S1.toUpperCase(), `${S1}/x`, '']) {
    assert.throws(() => lockPath(d.deck.places, bad), RangeError);
  }
});

test('acquireLock creates the lock with the time as content', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('acquireLock refuses within 60 s and says how long to wait', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  d.clock.setNs(T0 + 10n * SEC);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1)),
    '0b5f3c1e is being resumed (10 s ago); try again in 50 s',
  );
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('acquireLock rounds the age down and the wait up', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  d.clock.setNs(T0 + 59n * SEC + 500_000_000n);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1)),
    '0b5f3c1e is being resumed (59 s ago); try again in 1 s',
  );
});

test('acquireLock replaces a lock older than 60 s', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  d.clock.setNs(T0 + 61n * SEC);
  acquireLock(d.deck, S1);
  assert.equal(lockOf(d, S1), `${T0 + 61n * SEC}\n`);
});

test('acquireLock replaces a lock exactly 60 s old', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  d.clock.setNs(T0 + 60n * SEC);
  acquireLock(d.deck, S1);
  assert.equal(lockOf(d, S1), `${T0 + 60n * SEC}\n`);
});

test('acquireLock replaces a lock when the session started at or after the lock', (t) => {
  for (const startNs of [T0, T0 + 2n * SEC]) {
    const d = testDeck(t);
    acquireLock(d.deck, S1);
    startEvent(d, S1, startNs);
    d.clock.setNs(T0 + 5n * SEC);
    acquireLock(d.deck, S1);
    assert.equal(lockOf(d, S1), `${T0 + 5n * SEC}\n`);
  }
});

test('acquireLock keeps a lock when the session started before it, or another one started', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  startEvent(d, S1, T0 - 1n);
  startEvent(d, S2, T0 + SEC);
  d.clock.setNs(T0 + 5n * SEC);
  assert.match(
    refusal(() => acquireLock(d.deck, S1)),
    /being resumed \(5 s ago\)/,
  );
});

test('acquireLock locks each session on its own', (t) => {
  const d = testDeck(t);
  acquireLock(d.deck, S1);
  acquireLock(d.deck, S2);
  assert.equal(lockOf(d, S2), `${T0}\n`);
});

test('acquireLock dates a lock it cannot read the time of by its modification time', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, 'not a time\n');
  const seconds = Number((T0 - 5n * SEC) / NS_PER_SECOND);
  utimesSync(lockPath(d.deck.places, S1), seconds, seconds);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1)),
    '0b5f3c1e is being resumed (5 s ago); try again in 55 s',
  );
  const old = Number((T0 - 61n * SEC) / NS_PER_SECOND);
  utimesSync(lockPath(d.deck.places, S1), old, old);
  acquireLock(d.deck, S1);
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('acquireLock treats a lock dated a little in the future as fresh, one far ahead as stale', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 + 10n * SEC}\n`);
  assert.equal(
    refusal(() => acquireLock(d.deck, S1)),
    '0b5f3c1e is being resumed (0 s ago); try again in 70 s',
  );
  writeLock(d, S1, `${T0 + 61n * SEC}\n`);
  acquireLock(d.deck, S1);
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('acquireLock refuses when another resume took the lock while it replaced a stale one', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 120n * SEC}\n`);
  // Between this resume reading the stale lock and moving it aside, another one replaces it.
  const path = lockPath(d.deck.places, S1);
  let swapped = false;
  const deck = deckWith(d.deck, {
    files: {
      rename(from: string, to: string): void {
        if (from === path && !swapped) {
          swapped = true;
          writeFileSync(path, `${T0 - SEC}\n`);
        }
        d.platform.files.rename(from, to);
      },
    },
  });
  assert.match(
    refusal(() => acquireLock(deck, S1)),
    /being resumed \(1 s ago\)/,
  );
  assert.equal(lockOf(d, S1), `${T0 - SEC}\n`);
  assert.deepEqual(
    readdirSync(d.deck.places.locksDir).filter((name) => name !== `${S1}.lock`),
    [],
  );
});

test('acquireLock creates the lock when the stale one vanished meanwhile', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 120n * SEC}\n`);
  const path = lockPath(d.deck.places, S1);
  const deck = deckWith(d.deck, {
    files: {
      rename(from: string, to: string): void {
        if (from === path) {
          d.platform.files.remove(path); // swept by another skydeck
        }
        d.platform.files.rename(from, to);
      },
    },
  });
  acquireLock(deck, S1);
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('acquireLock gives up when the lock keeps changing under it', (t) => {
  const d = testDeck(t);
  const deck = deckWith(d.deck, {
    files: { createExclusive: () => false, readText: () => null },
  });
  assert.equal(
    refusal(() => acquireLock(deck, S1)),
    '0b5f3c1e: its resume lock keeps changing; try again',
  );
});

// --- sweepLocks ------------------------------------------------------------------------------------

test('sweepLocks removes stale locks, keeps fresh ones and counts what it removed', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}\n`); // too old
  writeLock(d, S2, `${T0 - 5n * SEC}\n`); // followed by a start
  startEvent(d, S2, T0 - 2n * SEC);
  writeLock(d, S3, `${T0 - 5n * SEC}\n`); // fresh
  assert.equal(sweepLocks(d.deck), 2);
  assert.equal(lockOf(d, S1), null);
  assert.equal(lockOf(d, S2), null);
  assert.equal(lockOf(d, S3), `${T0 - 5n * SEC}\n`);
});

test('sweepLocks leaves every other name in the directory alone', (t) => {
  const d = testDeck(t);
  const { locksDir } = d.deck.places;
  const others = [
    `.${S1}.lock.0a1b2c3d4e5f.tmp`,
    `${S1}.lock.bak`,
    'notes.txt',
    `${S1.toUpperCase()}.lock`,
    'x.lock',
  ];
  for (const name of others) {
    writeFileSync(join(locksDir, name), `${T0 - 600n * SEC}\n`);
  }
  assert.equal(sweepLocks(d.deck), 0);
  assert.deepEqual(readdirSync(locksDir).sort(), [...others].sort());
});

test('sweepLocks skips a lock it cannot read and goes on', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}\n`);
  writeLock(d, S2, `${T0 - 61n * SEC}\n`);
  const bad = lockPath(d.deck.places, S1);
  const deck = deckWith(d.deck, {
    files: {
      readText(path: string): string | null {
        if (path === bad) {
          throw new Error('EACCES: permission denied');
        }
        return d.platform.files.readText(path);
      },
    },
  });
  assert.equal(sweepLocks(deck), 1);
  assert.notEqual(lockOf(d, S1), null);
  assert.equal(lockOf(d, S2), null);
});

test('sweepLocks returns 0 when the directory cannot be listed', (t) => {
  const d = testDeck(t);
  const deck = deckWith(d.deck, {
    files: {
      list(): string[] {
        throw new Error('EACCES: permission denied');
      },
    },
  });
  assert.equal(sweepLocks(deck), 0);
});

test('sweepLocks lets a failure of the database through', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 5n * SEC}\n`);
  const failure = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
  const deck = deckWith(d.deck, {
    store: {
      hasStartSince(): boolean {
        throw failure;
      },
    },
  });
  assert.throws(() => sweepLocks(deck), failure);
});

test('sweepLocks keeps a lock that a resume replaced while it looked at the old one', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 120n * SEC}\n`);
  const path = lockPath(d.deck.places, S1);
  let swapped = false;
  const deck = deckWith(d.deck, {
    files: {
      rename(from: string, to: string): void {
        if (from === path && !swapped) {
          swapped = true;
          writeFileSync(path, `${T0 - SEC}\n`); // a resume replaced the stale lock
        }
        d.platform.files.rename(from, to);
      },
    },
  });
  assert.equal(sweepLocks(deck), 0);
  assert.equal(lockOf(d, S1), `${T0 - SEC}\n`);
  assert.deepEqual(readdirSync(d.deck.places.locksDir), [`${S1}.lock`]);
});

test('refresh sweeps the locks at its end', (t) => {
  const d = testDeck(t);
  writeLock(d, S1, `${T0 - 61n * SEC}\n`);
  refresh(d.deck);
  assert.equal(lockOf(d, S1), null);
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
  });
  assert.deepEqual(prepared.argv, ['claude', '--resume', S1, '-n', 'fix', '--model', 'opus']);
  assert.equal(lockOf(d, S1), `${T0}\n`);
});

test('prepareResume runs the configured program', (t) => {
  const d = testDeck(t, { config: { claudeCommand: '/opt/claude/bin/claude' } });
  const prepared = prepareResume(d.deck, rowWith(d, dead(d, { launch: ['claude'] })));
  assert.deepEqual(prepared.argv, ['/opt/claude/bin/claude', '--resume', S1]);
});

test('prepareResume names the flags it does not pass on', (t) => {
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
  const stale = `${T0 - 120n * SEC}\n`;
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

test('prepareNew takes no lock', (t) => {
  const d = testDeck(t);
  prepareNew(d.deck, { label: null, group: null, extra: [] });
  assert.deepEqual(readdirSync(d.deck.places.locksDir), []);
});
