import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { RefError, ResumeRefusedError } from '../../src/platform/errors.ts';
import { statLine } from '../helpers/platform.ts';
import { loadRows } from '../../src/sessions/load.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { lockKey } from '../../src/sessions/resume.ts';
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
  assert.equal(lockOf(d, S1), `${T0}`);
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
