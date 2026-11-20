// Follow-up F33 (design 5.3 "Copies", 5.4): a process started with `--fork-session --resume <id>`
// holds, as its first session, a copy of <id>. skydeck records that as a link of kind `copy` from
// <id> to that session — at ingest from the hook's recorded command, at reconcile from the
// process's command line —, once, keeping only the id.
import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { ingestSpool } from '../../src/sessions/ingest.ts';
import { reconcile } from '../../src/sessions/reconcile.ts';
import type { LinkRow } from '../../src/store/types.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, S2, S3, SEC, T0, statLine } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';

/** S2 is the original throughout; S1 the copy, S3 what the copy's process moves on to. */
const ORIGINAL = S2;
const PATH = `/home/dev/.claude/projects/-home-dev-projects-demo/${ORIGINAL}.jsonl`;
const COPY_COMMAND = ['claude', '--fork-session', '--resume', PATH, '--permission-mode', 'auto'];
const PID = 4242;
const START = 51234567;

function start(sessionId: string, timeNs: Ns, over: Partial<SpoolFields> = {}): SpoolFields {
  return {
    event: 'SessionStart',
    timeNs,
    pid: PID,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
    argv: COPY_COMMAND,
    ...over,
  };
}

function ingest(d: TestDeck, ...runs: SpoolFields[][]): void {
  let seq = 0;
  for (const run of runs) {
    for (const fields of run) {
      writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, ++seq)), spoolText(fields));
    }
    ingestSpool(d.deck);
  }
}

function copyLink(eventId: number, to: string, timeNs: Ns, from = ORIGINAL): LinkRow {
  return { eventId, fromSession: from, toSession: to, kind: 'copy', timeNs };
}

describe('ingest: the copy link from the hook’s recorded command', () => {
  test('--fork-session --resume <path of the original’s transcript>: a copy link original → the new session, on its start', (t) => {
    const d = testDeck(t);
    ingest(d, [start(S1, T0)]);
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)]);
    // Nothing of the command but the id is stored: neither flag, not the path.
    assert.deepEqual(d.deck.store.events()[0]?.argv, ['claude', '--permission-mode', 'auto']);
    assert.equal(JSON.stringify(d.deck.store.events()[0]?.argv).includes(PATH), false);
  });

  test('--fork-session --resume <id> and -r <id> link the same way', (t) => {
    for (const argv of [
      ['claude', '--fork-session', '--resume', ORIGINAL],
      ['claude', '-r', ORIGINAL, '--fork-session'],
    ]) {
      const d = testDeck(t);
      ingest(d, [start(S1, T0, { argv })]);
      assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)], argv.join(' '));
    }
  });

  test('no copy: --resume alone, --fork-session alone, a value that is neither, a plain command', (t) => {
    for (const argv of [
      ['claude', '--resume', ORIGINAL],
      ['claude', '--fork-session'],
      ['claude', '--fork-session', '--resume', 'my work'],
      ['claude'],
    ]) {
      const d = testDeck(t);
      ingest(d, [start(S1, T0, { argv })]);
      assert.deepEqual(d.deck.store.links(), [], argv.join(' '));
      assert.equal(d.deck.store.events().length, 1);
    }
  });

  test('a copy of a session skydeck knows nothing of is a copy all the same', (t) => {
    const d = testDeck(t);
    ingest(d, [start(S1, T0)]);
    assert.equal(
      d.deck.store.events().some((event) => event.sessionId === ORIGINAL),
      false,
    );
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)]);
  });

  test('whatever source the start reports: the link does not depend on it', (t) => {
    for (const source of ['startup', 'resume', 'fork', 'something new']) {
      const d = testDeck(t);
      ingest(d, [start(S1, T0, { input: hookInput('SessionStart', S1, { source }) })]);
      assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)], source);
    }
  });

  test('the copy’s process clears to another session: no second copy link, and the clear link as before', (t) => {
    const d = testDeck(t);
    ingest(d, [
      start(S1, T0),
      {
        event: 'SessionEnd',
        timeNs: T0 + 60n * SEC,
        pid: PID,
        input: hookInput('SessionEnd', S1, { reason: 'clear' }),
      },
      start(S3, T0 + 61n * SEC, { input: hookInput('SessionStart', S3, { source: 'clear' }) }),
    ]);
    assert.deepEqual(d.deck.store.links(), [
      copyLink(1, S1, T0),
      { eventId: 3, fromSession: S1, toSession: S3, kind: 'clear', timeNs: T0 + 61n * SEC },
    ]);
  });

  test('the first start without a recorded command: the link goes to the process’s FIRST session at its next start', (t) => {
    const d = testDeck(t);
    ingest(d, [
      start(S1, T0, { argv: null }),
      start(S3, T0 + 60n * SEC, { input: hookInput('SessionStart', S3, { source: 'clear' }) }),
    ]);
    assert.deepEqual(d.deck.store.links(), [
      copyLink(1, S1, T0),
      { eventId: 2, fromSession: S1, toSession: S3, kind: 'clear', timeNs: T0 + 60n * SEC },
    ]);
  });

  test('a duplicate spool file and a later run add no second link', (t) => {
    const d = testDeck(t);
    ingest(d, [start(S1, T0)]);
    ingest(d, [start(S1, T0)]); // the same file name: a duplicate
    assert.equal(d.deck.store.events().length, 1);
    ingest(d, [
      start(S1, T0 + 5n * SEC, { input: hookInput('SessionStart', S1, { source: 'compact' }) }),
    ]);
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)]);
  });

  test('a start without a pid names no process: no link', (t) => {
    const d = testDeck(t);
    ingest(d, [start(S1, T0, { pid: null })]);
    assert.deepEqual(d.deck.store.links(), []);
  });

  test('a start whose command names its own session is no copy', (t) => {
    const d = testDeck(t);
    ingest(d, [start(ORIGINAL, T0)]);
    assert.deepEqual(d.deck.store.links(), []);
  });

  test('a scripted copy (-p) is dropped or kept as scripted, as every scripted run: no link', (t) => {
    const argv = ['claude', '-p', '--fork-session', '--resume', ORIGINAL];
    const d = testDeck(t);
    ingest(d, [start(S1, T0, { argv })]);
    assert.deepEqual(d.deck.store.events(), [], 'a scripted run of an unknown session: dropped');
    ingest(d, [start(S1, T0, { argv: ['claude'] })], [start(S1, T0 + SEC, { argv, pid: 5555 })]);
    assert.deepEqual(
      d.deck.store.events().map((event) => event.kind),
      ['start', 'scripted'],
    );
    assert.deepEqual(d.deck.store.links(), []);
  });

  test('a pid used again in the same boot is another process: the copy link is on the new one’s start', (t) => {
    const d = testDeck(t);
    const earlier = { procStart: 1111 };
    ingest(d, [
      start(S3, T0 - 100n * SEC, { argv: ['claude'], ...earlier }),
      {
        event: 'SessionEnd',
        timeNs: T0 - 90n * SEC,
        pid: PID,
        input: hookInput('SessionEnd', S3, { reason: 'prompt_input_exit' }),
        ...earlier,
      },
      start(S1, T0),
    ]);
    assert.deepEqual(d.deck.store.links(), [copyLink(3, S1, T0)]);
  });

  test('two copies by two processes: two links, one each', (t) => {
    const d = testDeck(t);
    ingest(d, [start(S1, T0), start(S3, T0 + SEC, { pid: 5555 })]);
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0), copyLink(2, S3, T0 + SEC)]);
  });

  test('the first start’s file lost: the end the process recorded first names the copy, and carries the link', (t) => {
    const d = testDeck(t);
    ingest(d, [
      {
        event: 'SessionEnd',
        timeNs: T0 + 60n * SEC,
        pid: PID,
        input: hookInput('SessionEnd', S1, { reason: 'clear' }),
      },
      start(S3, T0 + 61n * SEC, { input: hookInput('SessionStart', S3, { source: 'clear' }) }),
    ]);
    assert.deepEqual(d.deck.store.links(), [
      copyLink(1, S1, T0 + 60n * SEC),
      { eventId: 2, fromSession: S1, toSession: S3, kind: 'clear', timeNs: T0 + 61n * SEC },
    ]);
  });
});

// --- reconcile ------------------------------------------------------------------------------------

/** Sets the modification time of `path` to `ns` (whole seconds). */
function touch(path: string, ns: Ns): void {
  const seconds = Number(ns / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
}

const busy = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;

/** `C/sessions/4242.json` (session S1), 10 s old; `over` applied. */
function live(d: TestDeck, over: Record<string, unknown> = {}): void {
  const content: Record<string, unknown> = { ...busy(), ...over };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete content[key];
  }
  const path = join(d.deck.places.claudeHome, 'sessions', `${PID}.json`);
  writeFileSync(path, JSON.stringify(content));
  touch(path, T0 - 10n * SEC);
}

/** Process 4242 runs `cmdline`; its live file names S1. */
function running(t: Parameters<typeof testDeck>[0], cmdline: string[] = COPY_COMMAND): TestDeck {
  const d = testDeck(t);
  d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline });
  live(d);
  return d;
}

/** An event as a skydeck before F33 stored it for the copy: its start, the flags dropped, no link. */
function storedStart(d: TestDeck, sessionId: string, timeNs: Ns): number {
  const id = d.deck.store.insertEvent({
    spoolName: `${timeNs}-${PID}-1.ev`,
    timeNs,
    kind: 'start',
    detail: 'startup',
    rawDetail: 'startup',
    sessionId,
    bootId: BOOT_A,
    pid: PID,
    procStart: START,
    cwd: '/home/dev/projects/demo',
    argv: ['claude', '--permission-mode', 'auto'],
    name: null,
    payload: '{}',
  });
  assert.ok(id !== null);
  return id;
}

describe('reconcile: the copy link from the process’s command line', () => {
  test('a live copy no hook reported: its observed event, and the copy link on it', (t) => {
    const d = running(t);
    assert.deepEqual(reconcile(d.deck), { observed: 1 });
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0)]);
    assert.deepEqual(d.deck.store.events()[0]?.argv, ['claude', '--permission-mode', 'auto']);
  });

  test('a copy already in the database whose process still runs gets the link on its first event, and no other event', (t) => {
    const d = running(t);
    const id = storedStart(d, S1, T0 - 30n * SEC);
    assert.deepEqual(reconcile(d.deck), { observed: 0 });
    assert.deepEqual(d.deck.store.links(), [copyLink(id, S1, T0 - 30n * SEC)]);
    assert.equal(d.deck.store.events().length, 1);
  });

  test('reconciling again adds nothing', (t) => {
    const d = running(t);
    reconcile(d.deck);
    reconcile(d.deck);
    assert.equal(d.deck.store.links().length, 1);
    assert.equal(d.deck.store.events().length, 1);
  });

  test('a link the hook made first is not made again; nor the other way round', (t) => {
    const d = running(t);
    ingest(d, [start(S1, T0 - 20n * SEC)]);
    reconcile(d.deck);
    assert.deepEqual(d.deck.store.links(), [copyLink(1, S1, T0 - 20n * SEC)]);

    const e = running(t);
    reconcile(e.deck); // the observed event and its link, stamped now
    ingest(e, [start(S1, T0 - 20n * SEC)]); // the hook's start comes late, dated before it
    assert.deepEqual(
      e.deck.store.links().map((link) => [link.kind, link.toSession]),
      [['copy', S1]],
    );
  });

  test('no copy: --resume alone, --fork-session alone, a value that is neither', (t) => {
    for (const cmdline of [
      ['claude', '--resume', ORIGINAL],
      ['claude', '--fork-session'],
      ['claude', '--fork-session', '--resume', 'my work'],
    ]) {
      const d = running(t, cmdline);
      assert.deepEqual(reconcile(d.deck), { observed: 1 });
      assert.deepEqual(d.deck.store.links(), [], cmdline.join(' '));
    }
  });

  test('a process reconcile does not take (another entry point, a live file not trusted, one just written) gets no link', (t) => {
    const a = running(t);
    live(a, { entrypoint: 'sdk-ts' });
    storedStart(a, S1, T0 - 30n * SEC);
    reconcile(a.deck);
    assert.deepEqual(a.deck.store.links(), []);

    const b = running(t);
    live(b, { procStart: '999' });
    storedStart(b, S1, T0 - 30n * SEC);
    reconcile(b.deck);
    assert.deepEqual(b.deck.store.links(), []);
  });

  test('a copy whose process has ended is not rewritten', (t) => {
    const d = running(t);
    storedStart(d, S1, T0 - 30n * SEC);
    d.proc.setProcess(PID, null);
    reconcile(d.deck);
    assert.deepEqual(d.deck.store.links(), []);
  });

  test('the process moved on to another session: the link is the first session’s', (t) => {
    const d = running(t);
    const first = storedStart(d, S1, T0 - 30n * SEC);
    storedStart(d, S3, T0 - 20n * SEC);
    live(d, { sessionId: S3 });
    reconcile(d.deck);
    assert.deepEqual(d.deck.store.links(), [copyLink(first, S1, T0 - 30n * SEC)]);
  });

  test('a process whose first event is a scripted run’s gets no link', (t) => {
    const d = running(t);
    const id = d.deck.store.insertEvent({
      spoolName: `${T0 - 30n * SEC}-${PID}-1.ev`,
      timeNs: T0 - 30n * SEC,
      kind: 'scripted',
      detail: '',
      rawDetail: 'resume',
      sessionId: S1,
      bootId: BOOT_A,
      pid: PID,
      procStart: START,
      cwd: '/home/dev/projects/demo',
      argv: null,
      name: null,
      payload: '{}',
    });
    assert.ok(id !== null);
    reconcile(d.deck);
    assert.deepEqual(d.deck.store.links(), []);
  });

  test('the original is the process’s own first session: no link', (t) => {
    const d = running(t, ['claude', '--fork-session', '--resume', S1]);
    reconcile(d.deck);
    assert.deepEqual(d.deck.store.links(), []);
  });
});
