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
  carryFields,
  detachSessionPr,
  discardKeptNote,
  keptNotePath,
  markDone,
  markParked,
  markUndone,
  markUnparked,
  parkTime,
  requirePrKey,
  setGroup,
  setLabel,
  setNote,
  setTicket,
} from '../../src/sessions/meta.ts';
import { refresh } from '../../src/sessions/refresh.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import type { Ns } from '../../src/platform/types.ts';
import type { MetaPatch } from '../../src/store/types.ts';
import { S1, S2, SEC, T0 } from '../helpers/platform.ts';
import {
  startRunning,
  twoSessions,
  userRecord,
  writeTranscript,
} from '../helpers/session-files.ts';
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
      parkedAtNs: null,
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

describe('markDone after the wall clock stepped back (#207)', () => {
  /** A start of S1 by process 4242 with `source`, stamped `atNs` by its hook, ingested. */
  function startAt(d: TestDeck, source: string, atNs: bigint, seq: number): void {
    const fields = {
      event: 'SessionStart' as const,
      timeNs: atNs,
      pid: 4242,
      input: hookInput('SessionStart', S1, { source }),
    };
    writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, seq)), spoolText(fields));
    assert.equal(ingestSpool(d.deck).ingested, 1);
  }

  test("a resume stamped after the clock now: the done time is that start's, and the session is hidden", (t) => {
    const d = known(t);
    startAt(d, 'resume', T0 + 3n * SEC, 1);
    markDone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, T0 + 3n * SEC);
    assert.equal(loadRows(d.deck).find((row) => row.id === S1)?.session.hidden, true);
  });

  test("a transcript's input stamped after the clock now: the done time is that input's", (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1, [userRecord(S1, T0 + 4n * SEC)]);
    refresh(d.deck);
    markDone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, T0 + 4n * SEC);
  });

  test('only what makes a session active again counts: a /clear start or an end ahead of the clock does not', (t) => {
    const d = known(t);
    startAt(d, 'clear', T0 + 3n * SEC, 1);
    startAt(d, 'compact', T0 + 4n * SEC, 2);
    markDone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, T0, 'the clock');
  });

  test('a start before the clock leaves the done time at the clock', (t) => {
    const d = known(t);
    startAt(d, 'startup', T0 - 3n * SEC, 1);
    markDone(d.deck, S1);
    assert.equal(meta(d, S1)?.doneAtNs, T0);
  });
});

describe('markParked, markUnparked, parkTime (follow-up F44)', () => {
  /** The session's row as the list reads it now, which `markParked` is given. */
  function target(d: TestDeck, sessionId: string, parked: boolean) {
    const row = loadRows(d.deck).find((candidate) => candidate.id === sessionId);
    assert.ok(row, `a row of ${sessionId}`);
    assert.equal(row.parked, parked);
    return row;
  }

  /** Every patch `updateMeta` is called with from now on. */
  function patches(d: TestDeck): MetaPatch[] {
    const seen: MetaPatch[] = [];
    const store = d.deck.store;
    const update = store.updateMeta.bind(store);
    store.updateMeta = (sessionId, patch, nowNs) => {
      seen.push(patch);
      return update(sessionId, patch, nowNs);
    };
    return seen;
  }

  test('parkTime is the later of now and one nanosecond after the last input', () => {
    const cases: [what: string, lastUserNs: Ns | null, expected: Ns][] = [
      ['no input', null, T0],
      ['input before now', T0 - 30n * SEC, T0],
      ['input one nanosecond before now', T0 - 1n, T0],
      ['input at now', T0, T0 + 1n],
      ['input after now (the clock stepped back)', T0 + 2n * SEC, T0 + 2n * SEC + 1n],
    ];
    for (const [what, lastUserNs, expected] of cases) {
      assert.equal(parkTime(T0, lastUserNs), expected, what);
    }
  });

  test('markParked stores the clock time and returns true; markUnparked clears it; the other fields stay', (t) => {
    const d = known(t);
    setLabel(d.deck, S1, 'x');
    d.clock.setNs(T0 + 5n * SEC);

    assert.equal(markParked(d.deck, target(d, S1, false)), true);
    assert.equal(meta(d, S1)?.parkedAtNs, T0 + 5n * SEC);
    assert.equal(meta(d, S1)?.label, 'x');
    d.clock.setNs(T0 + 9n * SEC);
    markUnparked(d.deck, S1);

    assert.equal(meta(d, S1)?.parkedAtNs, null);
    assert.equal(meta(d, S1)?.updatedNs, T0 + 9n * SEC);
    assert.equal(meta(d, S1)?.label, 'x');
    assert.equal(meta(d, S2), null, 'another session is not touched');
  });

  test("markParked dates a parking after the input it knows of, when the clock is behind the transcript's", (t) => {
    const d = known(t); // S1's last input is at T0 - 30 s
    d.clock.setNs(T0 - 31n * SEC);

    markParked(d.deck, target(d, S1, false));

    assert.equal(meta(d, S1)?.parkedAtNs, T0 - 30n * SEC + 1n);
  });

  test('parking a done session clears its done mark in the same statement', (t) => {
    const d = known(t);
    markDone(d.deck, S1);
    d.clock.setNs(T0 + 5n * SEC);
    const seen = patches(d);

    markParked(d.deck, target(d, S1, false));

    assert.deepEqual(seen, [{ parkedAtNs: T0 + 5n * SEC, doneAtNs: null }], 'one updateMeta');
    assert.equal(meta(d, S1)?.doneAtNs, null);
    assert.equal(meta(d, S1)?.parkedAtNs, T0 + 5n * SEC);
  });

  test('marking a parked session done ends its parking in the same statement', (t) => {
    const d = known(t);
    markParked(d.deck, target(d, S1, false));
    d.clock.setNs(T0 + 5n * SEC);
    const seen = patches(d);

    markDone(d.deck, S1);

    assert.deepEqual(seen, [{ doneAtNs: T0 + 5n * SEC, parkedAtNs: null }], 'one updateMeta');
    assert.equal(meta(d, S1)?.parkedAtNs, null);
    assert.equal(meta(d, S1)?.doneAtNs, T0 + 5n * SEC);
  });

  test('markUndone leaves a parking as it is', (t) => {
    const d = known(t);
    markParked(d.deck, target(d, S1, false));

    markUndone(d.deck, S1);

    assert.equal(meta(d, S1)?.parkedAtNs, T0);
    assert.equal(meta(d, S1)?.doneAtNs, null);
  });

  test('a second markParked on a parked row writes nothing and keeps the first time', (t) => {
    const d = known(t);
    markParked(d.deck, target(d, S1, false));
    const first = meta(d, S1);
    d.clock.setNs(T0 + 60n * SEC);
    const seen = patches(d);
    const row = loadRows(d.deck).find((candidate) => candidate.id === S1);
    assert.equal(row?.parked, true, 'derived as parked');

    assert.equal(row !== undefined && markParked(d.deck, row), false);

    assert.deepEqual(seen, []);
    assert.deepEqual(meta(d, S1), first);
  });

  test('a running session can be parked, and nothing is stopped', (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, 4242);
    refresh(d.deck);

    markParked(d.deck, target(d, S1, false));

    assert.equal(loadRows(d.deck)[0]?.state, 'working', 'still running');
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

describe('carryFields (follow-up F40)', () => {
  const PR2 = 'https://github.com/o/r/pull/6';

  test('writes exactly the given fields in one update, and attaches each pull request as manual', (t) => {
    const d = known(t);
    d.deck.store.ensurePr({ url: PR, owner: 'o', repo: 'r', number: 5 });
    d.deck.store.ensurePr({ url: PR2, owner: 'o', repo: 'r', number: 6 });
    d.deck.store.updateMeta(S2, { label: 'old', note: 'old note' }, T0);
    d.deck.store.attachPr(S2, PR, 'auto', T0);
    const before = d.deck.store.meta(S2);
    const otherPrs = prsOf(d, S2);
    d.clock.setNs(T0 + 5n * SEC);

    carryFields(d.deck, S1, {
      label: 'work',
      ticket: 'https://example.com/browse/TRY-1',
      prs: [PR, PR2],
    });

    const row = d.deck.store.meta(S1);
    assert.equal(row?.label, 'work');
    assert.equal(row?.ticket, 'https://example.com/browse/TRY-1');
    assert.equal(row?.group, null);
    assert.equal(row?.note, null);
    assert.equal(row?.updatedNs, T0 + 5n * SEC);
    assert.deepEqual(
      prsOf(d, S1).map((pr) => [pr.url, pr.origin, pr.detachedAtNs]),
      [
        [PR, 'manual', null],
        [PR2, 'manual', null],
      ],
    );
    assert.deepEqual(d.deck.store.meta(S2), before);
    assert.deepEqual(prsOf(d, S2), otherPrs);
  });

  test('a pull request detached from the session is attached again', (t) => {
    const d = known(t);
    attachManualPr(d.deck, S1, PR);
    detachSessionPr(d.deck, S1, PR);

    carryFields(d.deck, S1, { prs: [PR] });

    assert.equal(prsOf(d, S1)[0]?.detachedAtNs, null);
    assert.equal(d.deck.store.meta(S1), null);
  });

  test('no field given: nothing is written', (t) => {
    const d = known(t);

    carryFields(d.deck, S1, {});

    assert.equal(d.deck.store.meta(S1), null);
    assert.deepEqual(d.deck.store.sessionPrs(), []);
  });
});
