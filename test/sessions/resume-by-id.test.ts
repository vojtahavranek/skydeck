import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { RefError, ResumeRefusedError } from '../../src/platform/errors.ts';
import { statLine } from '../helpers/platform.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { isLockHeld, lockKey, prepareResume } from '../../src/sessions/resume.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, SEC, T0 } from '../helpers/platform.ts';
import { userRecord, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

/** S1: a transcript in an existing directory, and one `startup` by process 4242, which is gone. */
function resumableSession(d: TestDeck): void {
  const dir = d.sandbox.home;
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 30n * SEC), cwd: dir }]);
  spoolStart(d, 4242, T0 - 120n * SEC, 1);
}

/** The start event of process `pid` for S1, waiting in the spool (not ingested). */
function spoolStart(d: TestDeck, pid: number, timeNs: bigint, seq: number): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs,
    pid,
    pwd: d.sandbox.home,
    argv: ['claude', '--model', 'opus'],
    input: hookInput('SessionStart', S1, { source: 'resume', cwd: d.sandbox.home }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, seq)), spoolText(fields));
}

/** What another skydeck does: process 4343 resumes S1, and its start event reaches the spool. */
function anotherSkydeckResumes(d: TestDeck): void {
  d.proc.setProcess(4343, { stat: statLine(4343, 51234567), cmdline: ['claude'] });
  spoolStart(d, 4343, T0 - 1n * SEC, 2);
}

const lockOf = (d: TestDeck, sessionId: string): string | null =>
  d.deck.store.getKv(lockKey(sessionId));

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

test('prepareResumeById resumes a session that is not running, and takes the lock', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  const prepared = prepareResumeById(d.deck, S1);
  assert.equal(prepared.kind, 'resume');
  assert.equal(prepared.sessionId, S1);
  assert.deepEqual(prepared.argv, ['claude', '--resume', S1, '--model', 'opus']);
  // The time it was taken, and the latest event of S1 the decision was made on.
  assert.equal(lockOf(d, S1), `${T0}:${d.deck.store.latestEventIdOfSession(S1)}`);
});

test('prepareResumeById refreshes first: a start event still in the spool is seen, and the session refused', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  refresh(d.deck);
  const looked = loadRows(d.deck); // the look: S1 is not running
  assert.equal(looked.find((row) => row.id === S1)?.session.holders.length, 0);
  anotherSkydeckResumes(d); // after the look, before the resume is prepared
  assert.equal(
    refusal(() => prepareResumeById(d.deck, S1)),
    '0b5f3c1e is running (pid 4343)',
  );
  assert.equal(lockOf(d, S1), null);
});

/** A scripted run (process `pid`, alive) starts on S1; its start event waits in the spool. */
function scriptedRunHolds(
  d: TestDeck,
  pid: number,
  how: { entrypointEnv: string; argv: string[] },
  timeNs: bigint = T0 - 1n * SEC,
): void {
  d.proc.setProcess(pid, { stat: statLine(pid, 51234567), cmdline: how.argv });
  const fields = {
    event: 'SessionStart' as const,
    timeNs,
    pid,
    pwd: d.sandbox.home,
    entrypointEnv: how.entrypointEnv,
    argv: how.argv,
    input: hookInput('SessionStart', S1, { source: 'resume', cwd: d.sandbox.home }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 9)), spoolText(fields));
}

test('prepareResumeById refuses a session a live scripted run holds, like an interactive holder', async (t) => {
  const runs = {
    'claude -p --resume (entry point sdk-cli)': {
      entrypointEnv: 'sdk-cli',
      argv: ['claude', '-p', '--resume', S1, 'summarise'],
    },
    'claude -cp (entry point unknown)': { entrypointEnv: '', argv: ['claude', '-cp'] },
  };
  for (const [name, how] of Object.entries(runs)) {
    await t.test(name, (t) => {
      const d = testDeck(t);
      resumableSession(d);
      scriptedRunHolds(d, 5555, how);
      assert.equal(
        refusal(() => prepareResumeById(d.deck, S1)),
        '0b5f3c1e is running (pid 5555)',
      );
      assert.equal(lockOf(d, S1), null);
    });
  }
});

const PRINT_RESUME = { entrypointEnv: 'sdk-cli', argv: ['claude', '-p', '--resume', S1] };

test('a scripted run that starts between a resume’s decision and its lock makes the lock refuse', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  refresh(d.deck);
  const row = loadRows(d.deck).find((candidate) => candidate.id === S1);
  assert.ok(row);
  assert.equal(row.session.holders.length, 0); // the decision: S1 is not running
  scriptedRunHolds(d, 5555, PRINT_RESUME);
  refresh(d.deck); // another skydeck's refresh ingests the scripted start
  assert.equal(
    refusal(() => prepareResume(d.deck, row)),
    "the session's state changed while preparing; run the command again",
  );
  assert.equal(lockOf(d, S1), null);
});

test('a scripted start never releases a resume lock: it is not the claude the resume started', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  prepareResumeById(d.deck, S1); // the lock, taken at T0
  const seen = d.deck.store.latestEventIdOfSession(S1);
  scriptedRunHolds(d, 5555, PRINT_RESUME, T0 + 5n * SEC);
  d.clock.setNs(T0 + 10n * SEC);
  refresh(d.deck); // ingests the scripted start, then sweeps the locks
  assert.equal(d.deck.store.events().at(-1)?.kind, 'scripted');
  assert.equal(lockOf(d, S1), `${T0}:${seen}`); // the lock as it was taken
  assert.equal(isLockHeld(d.deck, S1), true);
});

test('prepareResumeById refuses a session a stale live file hides: the hook said the process holds it', (t) => {
  // Process 4242 started on S2, then /resume'd S1 inside the session; its live file, written before
  // the switch, still names S2.
  const d = testDeck(t);
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 300n * SEC), cwd: d.sandbox.home }]);
  d.proc.setProcess(4242, { stat: statLine(4242, 51234567), cmdline: ['claude'] });
  const started = {
    event: 'SessionStart' as const,
    timeNs: T0 - 120n * SEC,
    pid: 4242,
    input: hookInput('SessionStart', S2, { source: 'startup', cwd: d.sandbox.home }),
  };
  const end = {
    event: 'SessionEnd' as const,
    timeNs: T0 - 20n * SEC,
    pid: 4242,
    input: hookInput('SessionEnd', S2, { reason: 'resume' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(started, 1)), spoolText(started));
  writeFileSync(join(d.deck.places.spoolDir, spoolName(end, 2)), spoolText(end));
  spoolStart(d, 4242, T0 - 10n * SEC, 3); // start(S1, resume)
  const file = join(d.deck.places.claudeHome, 'sessions', '4242.json');
  writeFileSync(
    file,
    JSON.stringify({
      pid: 4242,
      sessionId: S2,
      cwd: d.sandbox.home,
      procStart: '51234567',
      entrypoint: 'cli',
      status: 'idle',
    }),
  );
  const minuteAgo = Number((T0 - 60n * SEC) / SEC);
  utimesSync(file, minuteAgo, minuteAgo);
  assert.equal(
    refusal(() => prepareResumeById(d.deck, S1)),
    '0b5f3c1e is running (pid 4242)',
  );
});

test('a scripted process that cleared away from the session no longer blocks its resume', (t) => {
  // An SDK host (one process, several sessions) resumed S1, then /clear'ed to a new session.
  const d = testDeck(t);
  resumableSession(d);
  const sdk = { entrypointEnv: 'sdk-ts', argv: ['claude', '--model', 'opus'] };
  scriptedRunHolds(d, 5555, sdk, T0 - 30n * SEC);
  const end = {
    event: 'SessionEnd' as const,
    timeNs: T0 - 20n * SEC,
    pid: 5555,
    entrypointEnv: 'sdk-ts',
    input: hookInput('SessionEnd', S1, { reason: 'clear' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(end, 10)), spoolText(end));
  assert.equal(prepareResumeById(d.deck, S1).sessionId, S1);
  // The scripted start and its end count for the latest event the lock records.
  assert.equal(lockOf(d, S1), `${T0}:${d.deck.store.latestEventIdOfSession(S1)}`);
  assert.equal(d.deck.store.events().at(-1)?.kind, 'scripted-end');
});

test('prepareResumeById refuses a session whose holder an earlier reconcile recorded on the session it left', (t) => {
  // A reconcile read 4242's file naming S2; before its insert the process /resume'd S1 and the
  // file was rewritten. observed(S2) is stamped after both; the idle file is not written again.
  const d = testDeck(t);
  writeTranscript(d, S1, [{ ...userRecord(S1, T0 - 300n * SEC), cwd: d.sandbox.home }]);
  d.proc.setProcess(4242, { stat: statLine(4242, 51234567), cmdline: ['claude'] });
  d.deck.store.insertEvent({
    spoolName: null,
    timeNs: T0,
    kind: 'observed',
    detail: '',
    rawDetail: null,
    sessionId: S2,
    bootId: d.proc.bootId() ?? '',
    pid: 4242,
    procStart: 51234567,
    cwd: d.sandbox.home,
    argv: ['claude'],
    name: null,
    payload: null,
  });
  spoolStart(d, 4242, T0 - 1n * SEC, 1); // start(S1, resume)
  const file = join(d.deck.places.claudeHome, 'sessions', '4242.json');
  writeFileSync(
    file,
    JSON.stringify({
      pid: 4242,
      sessionId: S1,
      cwd: d.sandbox.home,
      procStart: '51234567',
      entrypoint: 'cli',
      status: 'idle',
    }),
  );
  const secondAgo = Number((T0 - 1n * SEC) / SEC);
  utimesSync(file, secondAgo, secondAgo);
  d.clock.setNs(T0 + 600n * SEC);
  assert.equal(
    refusal(() => prepareResumeById(d.deck, S1)),
    '0b5f3c1e is running (pid 4242)',
  );
});

test('prepareResumeById refuses a session for the other reasons of the guard, with no lock', (t) => {
  const d = testDeck(t);
  writeTranscript(d, S1, [
    { ...userRecord(S1, T0 - 30n * SEC), cwd: join(d.sandbox.root, 'gone') },
  ]);
  assert.match(
    refusal(() => prepareResumeById(d.deck, S1)),
    /^0b5f3c1e: directory .*gone no longer exists$/,
  );
  assert.equal(lockOf(d, S1), null);
});

test('prepareResumeById refuses a boot id that cannot be read, with no lock', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  d.proc.setBootId(null);
  assert.equal(
    refusal(() => prepareResumeById(d.deck, S1)),
    'cannot tell which sessions are running: the boot id could not be read',
  );
  assert.equal(lockOf(d, S1), null);
});

test('prepareResumeById refuses a second resume within 60 s', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  prepareResumeById(d.deck, S1);
  d.clock.setNs(T0 + 30n * SEC);
  assert.equal(
    refusal(() => prepareResumeById(d.deck, S1)),
    '0b5f3c1e is being resumed (30 s ago); try again in 30 s',
  );
});

test('prepareResumeById names a session the deck does not know, and takes no lock', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  assert.throws(() => prepareResumeById(d.deck, S2), RefError);
  assert.equal(lockOf(d, S2), null);
});

test('prepareResumeById takes only the id of one session: a prefix or a label names nothing', (t) => {
  const d = testDeck(t);
  resumableSession(d);
  d.deck.store.updateMeta(S1, { label: 'fix' }, T0);
  for (const ref of [S1.slice(0, 8), 'fix', S1.toUpperCase()]) {
    assert.throws(() => prepareResumeById(d.deck, ref), RefError, ref);
  }
  assert.equal(lockOf(d, S1), null);
});
