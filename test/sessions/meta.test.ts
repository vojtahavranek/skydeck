import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { EXIT } from '../../src/cli/exit.ts';
import { SkydeckError, UsageError } from '../../src/platform/errors.ts';
import { ingestSpool } from '../../src/sessions/ingest.ts';
import { loadRows } from '../../src/sessions/load.ts';
import {
  attachManualPr,
  detachSessionPr,
  discardKeptNote,
  keptNotePath,
  markDone,
  markUndone,
  requirePrKey,
  setGroup,
  setLabel,
  setNote,
  setTicket,
} from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, SEC, T0 } from '../helpers/platform.ts';
import { startRunning, twoSessions, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';

const PR = 'https://github.com/o/r/pull/5';

/** A deck that has read the transcripts of S1 and S2. */
function known(t: TestContext): TestDeck {
  const d = twoSessions(t);
  refresh(d.deck);
  return d;
}

const meta = (d: TestDeck, sessionId: string) => d.deck.store.meta(sessionId);
const prsOf = (d: TestDeck, sessionId: string) =>
  d.deck.store.sessionPrs().filter((row) => row.sessionId === sessionId);

describe('setTicket (F18)', () => {
  test('sets the address at the clock time, replaces it, and null removes it; the other fields stay', (t) => {
    const d = known(t);
    setLabel(d.deck, S1, 'x');
    setNote(d.deck, S1, 'remember');
    d.clock.setNs(T0 + 5n * SEC);

    setTicket(d.deck, S1, 'https://example.com/browse/ABC-1');
    assert.equal(meta(d, S1)?.ticket, 'https://example.com/browse/ABC-1');
    assert.equal(meta(d, S1)?.updatedNs, T0 + 5n * SEC);
    setTicket(d.deck, S1, 'https://example.com/browse/ABC-2');
    assert.equal(meta(d, S1)?.ticket, 'https://example.com/browse/ABC-2');
    setTicket(d.deck, S1, null);

    assert.equal(meta(d, S1)?.ticket, null);
    assert.equal(meta(d, S1)?.label, 'x');
    assert.equal(meta(d, S1)?.note, 'remember');
    assert.equal(meta(d, S2), null, 'another session is not touched');
  });
});

describe('setLabel, setGroup, setNote', () => {
  test('setLabel sets the label and creates the row at the clock time', (t) => {
    const d = known(t);
    setLabel(d.deck, S1, 'x');
    assert.equal(meta(d, S1)?.label, 'x');
    assert.equal(meta(d, S1)?.createdNs, T0);
  });

  test('setLabel null clears the label and keeps the other fields', (t) => {
    const d = known(t);
    setLabel(d.deck, S1, 'x');
    setGroup(d.deck, S1, 'ABC-9');
    setNote(d.deck, S1, 'remember');
    d.clock.setNs(T0 + 5n * SEC);

    setLabel(d.deck, S1, null);

    assert.deepEqual(meta(d, S1), {
      sessionId: S1,
      label: null,
      group: 'ABC-9',
      note: 'remember',
      doneAtNs: null,
      ticket: null,
      createdNs: T0,
      updatedNs: T0 + 5n * SEC,
    });
  });

  test('setGroup sets and clears the group and leaves the label alone', (t) => {
    const d = known(t);
    setLabel(d.deck, S1, 'x');
    setGroup(d.deck, S1, 'ABC-9');
    assert.equal(meta(d, S1)?.group, 'ABC-9');
    assert.equal(meta(d, S1)?.label, 'x');
    setGroup(d.deck, S1, null);
    assert.equal(meta(d, S1)?.group, null);
    assert.equal(meta(d, S1)?.label, 'x');
  });

  test('a note that is empty or only whitespace is stored as null', (t) => {
    const d = known(t);
    for (const blank of ['  \n ', '', '\t\r\n']) {
      setNote(d.deck, S1, 'before');
      setNote(d.deck, S1, blank);
      assert.equal(meta(d, S1)?.note, null, JSON.stringify(blank));
    }
    setNote(d.deck, S1, 'before');
    setNote(d.deck, S1, null);
    assert.equal(meta(d, S1)?.note, null);
  });

  test('a note is stored as typed: several lines, not trimmed', (t) => {
    const d = known(t);
    setNote(d.deck, S1, 'a\nb');
    assert.equal(meta(d, S1)?.note, 'a\nb');
    setNote(d.deck, S1, '  indented\n\n');
    assert.equal(meta(d, S1)?.note, '  indented\n\n');
  });

  test('notes never move: a clear link from S1 to S2 leaves S2 without a row', (t) => {
    const d = known(t);
    setNote(d.deck, S1, 'n');
    const fields = (over: Partial<SpoolFields>): SpoolFields => ({
      event: 'SessionStart',
      timeNs: T0,
      pid: 4242,
      input: hookInput('SessionStart', S1, { source: 'startup' }),
      ...over,
    });
    const events: SpoolFields[] = [
      fields({}),
      fields({
        event: 'SessionEnd',
        timeNs: T0 + 60n * SEC,
        input: hookInput('SessionEnd', S1, { reason: 'clear' }),
      }),
      fields({
        timeNs: T0 + 61n * SEC,
        input: hookInput('SessionStart', S2, { source: 'clear' }),
      }),
    ];
    events.forEach((event, i) => {
      writeFileSync(join(d.deck.places.spoolDir, spoolName(event, i + 1)), spoolText(event));
    });

    ingestSpool(d.deck);

    assert.equal(d.deck.store.links().length, 1, 'the clear link was ingested');
    assert.equal(d.deck.store.links()[0]?.toSession, S2);
    assert.equal(meta(d, S2), null);
    assert.equal(meta(d, S1)?.note, 'n');
  });
});

describe('markDone, markUndone', () => {
  test('markDone sets the done time to the clock, markUndone clears it', (t) => {
    const d = known(t);
    markDone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, T0);
    markUndone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, null);
  });

  test('a running session can be marked done, and nothing is stopped', (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, 4242);
    refresh(d.deck);
    assert.equal(loadRows(d.deck)[0]?.state, 'working');

    markDone(d.deck, S1);

    const [row] = loadRows(d.deck);
    assert.equal(row?.done, true);
    assert.equal(row?.state, 'working', 'still running');
    assert.notEqual(d.proc.stat(4242), null, 'its process is still there');
    assert.deepEqual(d.runner.calls, []);
    assert.deepEqual(d.runner.interactiveCalls, []);
  });
});

describe('keptNotePath, discardKeptNote (plan D10)', () => {
  test("keptNotePath is <stateDir>/note-<id>.md, the file skydeck note's editor works on", (t) => {
    const d = testDeck(t);
    assert.equal(keptNotePath(d.deck, S1), join(d.deck.places.stateDir, `note-${S1}.md`));
  });

  test("discardKeptNote removes that session's kept file and no other", (t) => {
    const d = testDeck(t);
    mkdirSync(d.deck.places.stateDir, { recursive: true });
    const kept = keptNotePath(d.deck, S1);
    const other = keptNotePath(d.deck, S2);
    writeFileSync(kept, 'typed, never stored');
    writeFileSync(other, 'another session');
    discardKeptNote(d.deck, S1);
    assert.equal(existsSync(kept), false);
    assert.equal(readFileSync(other, 'utf8'), 'another session');
  });

  test('discardKeptNote without a kept file, or one that cannot be removed, does not throw', (t) => {
    const d = testDeck(t);
    discardKeptNote(d.deck, S1);
    const failing = deckWith(d.deck, {
      files: {
        remove: () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      },
    });
    discardKeptNote(failing, S1);
  });
});

describe('requirePrKey', () => {
  test('is the key of the url, the same one attachManualPr stores', () => {
    assert.deepEqual(requirePrKey('https://GitHub.com/O/R/pull/5/files?x=1'), {
      url: PR,
      owner: 'o',
      repo: 'r',
      number: 5,
    });
  });

  test('a url that is no pull request is a usage error with the sanitised text', () => {
    assert.throws(
      () => requirePrKey('https://example.com/\x1b[31mx'),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === 'not a GitHub pull-request URL: https://example.com/x',
    );
  });
});

describe('attachManualPr, detachSessionPr', () => {
  test('attaches by the key of the url, with origin manual', (t) => {
    const d = known(t);

    const key = attachManualPr(d.deck, S1, `${PR.replace('/o/r/', '/O/R/')}/files`);

    assert.deepEqual(key, { url: PR, owner: 'o', repo: 'r', number: 5 });
    assert.deepEqual(
      d.deck.store.prs().map((row) => row.url),
      [PR],
    );
    const [row] = prsOf(d, S1);
    assert.equal(row?.url, PR);
    assert.equal(row?.origin, 'manual');
    assert.equal(row?.detachedAtNs, null);
  });

  test('after a detach it is detached; attaching again clears the detach', (t) => {
    const d = known(t);
    attachManualPr(d.deck, S1, PR);

    assert.deepEqual(detachSessionPr(d.deck, S1, PR), {
      url: PR,
      owner: 'o',
      repo: 'r',
      number: 5,
    });
    assert.equal(prsOf(d, S1)[0]?.detachedAtNs, T0);

    attachManualPr(d.deck, S1, PR);
    assert.equal(prsOf(d, S1).length, 1);
    assert.equal(prsOf(d, S1)[0]?.detachedAtNs, null);
  });

  test('an auto-attached pull request becomes manual when attached by hand', (t) => {
    const d = known(t);
    d.deck.store.ensurePr({ url: PR, owner: 'o', repo: 'r', number: 5 });
    d.deck.store.attachPr(S1, PR, 'auto', T0);

    attachManualPr(d.deck, S1, PR);

    assert.equal(prsOf(d, S1)[0]?.origin, 'manual');
  });

  test('a url that is not a pull request is a usage error that says so and attaches nothing', (t) => {
    const d = known(t);
    assert.throws(
      () => attachManualPr(d.deck, S1, 'https://example.com'),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === 'not a GitHub pull-request URL: https://example.com',
    );
    assert.deepEqual(d.deck.store.prs(), []);
    assert.deepEqual(d.deck.store.sessionPrs(), []);
  });

  test('the text of a bad url is sanitised where the message repeats it', (t) => {
    const d = known(t);
    assert.throws(
      () => attachManualPr(d.deck, S1, 'not\x1b[31m a url\x07'),
      (error: unknown) =>
        error instanceof UsageError && error.message === 'not a GitHub pull-request URL: not a url',
    );
  });

  test('detaching a url that is not a pull request is a usage error', (t) => {
    const d = known(t);
    assert.throws(
      () => detachSessionPr(d.deck, S1, 'nope'),
      (error: unknown) =>
        error instanceof UsageError && error.message === 'not a GitHub pull-request URL: nope',
    );
  });

  test('detaching a pull request that was never attached is a failure (exit 1) that names both', (t) => {
    const d = known(t);
    assert.throws(
      () => detachSessionPr(d.deck, S1, PR),
      (error: unknown) =>
        error instanceof SkydeckError &&
        !(error instanceof UsageError) &&
        error.exitCode === EXIT.failure &&
        error.message === `${PR} is not attached to ${S1.slice(0, 8)}`,
    );
  });

  test('detaching twice fails the second time; another session keeps its attachment', (t) => {
    const d = known(t);
    attachManualPr(d.deck, S1, PR);
    attachManualPr(d.deck, S2, PR);

    detachSessionPr(d.deck, S1, PR);
    assert.throws(() => detachSessionPr(d.deck, S1, PR), SkydeckError);

    assert.equal(prsOf(d, S2)[0]?.detachedAtNs, null);
  });
});
