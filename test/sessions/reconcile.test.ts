import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { ingestSpool } from '../../src/sessions/ingest.ts';
import { reconcile } from '../../src/sessions/reconcile.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, S2, SEC, T0, statLine } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

const START = 51234567;
const busy = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/claude/sessions/busy.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;

/** Sets the modification time of `path` to `ns` (whole seconds). */
function touch(path: string, ns: Ns): void {
  const seconds = Number(ns / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
}

/** Writes `C/sessions/<pid>.json`: busy.json with `over` applied (undefined removes a key). */
function live(
  d: TestDeck,
  over: Record<string, unknown> = {},
  mtimeNs: Ns = T0 - 10n * SEC,
): string {
  const content: Record<string, unknown> = { ...busy(), ...over };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete content[key];
  }
  const path = join(d.deck.places.claudeHome, 'sessions', `${String(content.pid)}.json`);
  writeFileSync(path, JSON.stringify(content));
  touch(path, mtimeNs);
  return path;
}

/** The deck of the plan: process 4242 runs `claude --model opus`, its live file is 10 s old. */
function setup(t: Parameters<typeof testDeck>[0]): TestDeck {
  const d = testDeck(t);
  d.proc.setProcess(4242, { stat: statLine(4242, START), cmdline: ['claude', '--model', 'opus'] });
  live(d);
  return d;
}

const observed = (d: TestDeck) => d.deck.store.events().filter((e) => e.kind === 'observed');
const problems = (d: TestDeck): string[] | null => {
  const value = d.deck.store.getKv('reconcile_problems');
  return value === null ? null : (JSON.parse(value) as string[]);
};

/** A hook start event for S1 by process 4242 (with argv), ingested. */
function hookStart(d: TestDeck, sessionId = S1): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid: 4242,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
    argv: ['claude', '--model', 'opus'],
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  assert.equal(ingestSpool(d.deck).ingested, 1);
}

test('a live process without events gets one observed event', (t) => {
  const d = setup(t);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.deepEqual(d.deck.store.events(), [
    {
      id: 1,
      spoolName: null,
      timeNs: T0,
      kind: 'observed',
      detail: '',
      rawDetail: null,
      sessionId: S1,
      bootId: BOOT_A,
      pid: 4242,
      procStart: START,
      cwd: '/home/dev/projects/demo',
      argv: ['claude', '--model', 'opus'],
      name: 'demo name',
      payload: null,
    },
  ]);
  assert.equal(problems(d), null);
});

test('reconciling again adds nothing', (t) => {
  const d = setup(t);
  reconcile(d.deck);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  assert.equal(d.deck.store.events().length, 1);
});

test('a process with a hook start event for its session gets no observed event', (t) => {
  const d = setup(t);
  hookStart(d);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
});

test('a process whose latest event names another session gets an observed event', (t) => {
  const d = setup(t);
  hookStart(d);
  live(d, { sessionId: S2 });
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.deepEqual(
    observed(d).map((e) => e.sessionId),
    [S2],
  );
});

test('a live file modified in the last 2 seconds is left for later', (t) => {
  const d = setup(t);
  live(d, {}, T0 - 1n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
});

test('only trusted cli live files count', async (t) => {
  await t.test('pid reused (procStart differs)', (t) => {
    const d = setup(t);
    live(d, { procStart: '999' });
    assert.deepEqual(reconcile(d.deck), { observed: 0 });
  });
  await t.test('pid absent from /proc', (t) => {
    const d = setup(t);
    d.proc.setProcess(4242, null);
    assert.deepEqual(reconcile(d.deck), { observed: 0 });
  });
  await t.test("entrypoint 'sdk-ts'", (t) => {
    const d = setup(t);
    live(d, { entrypoint: 'sdk-ts' });
    assert.deepEqual(reconcile(d.deck), { observed: 0 });
  });
  await t.test('no entrypoint key', (t) => {
    const d = setup(t);
    live(d, { entrypoint: undefined });
    assert.deepEqual(reconcile(d.deck), { observed: 1 });
  });
});

test('an unreadable or empty cmdline gives argv null, and a readable one later adds its launch', (t) => {
  const d = setup(t);
  d.proc.setProcess(4242, { stat: statLine(4242, START), cmdline: [] });
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.equal(observed(d)[0]?.argv, null);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  d.proc.setProcess(4242, { stat: statLine(4242, START), cmdline: ['claude'] });
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.deepEqual(observed(d)[1]?.argv, ['claude']);

  // /proc/<pid>/cmdline that cannot be read at all (null) is the same as an empty one
  const e = setup(t);
  assert.deepEqual(reconcile(deckWith(e.deck, { proc: { cmdline: () => null } })), {
    observed: 1,
  });
  assert.equal(observed(e)[0]?.argv, null);
});

test('a relative path-flag value is stored absolute against the live file cwd', (t) => {
  const d = setup(t);
  const project = join(d.sandbox.root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 's.json'), '{}');
  live(d, { cwd: project });
  d.proc.setProcess(4242, {
    stat: statLine(4242, START),
    cmdline: ['claude', '--settings', 's.json'],
  });
  reconcile(d.deck);
  assert.deepEqual(observed(d)[0]?.argv, ['claude', '--settings', join(project, 's.json')]);
});

test('no boot id: nothing is reconciled, and that is recorded', (t) => {
  const d = setup(t);
  d.proc.setBootId(null);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  assert.deepEqual(problems(d), ['cannot read the boot id: reconcile skipped']);
  d.proc.setBootId(BOOT_A);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.equal(problems(d), null);
});

/** What the real platform throws when /proc cannot be read for another reason than absence. */
const procError = (code: string): Error =>
  Object.assign(new Error(`cannot read /proc (${code})`), { code });

for (const code of ['EACCES', 'EMFILE']) {
  test(`a boot id that cannot be read (${code}) is no missing boot id: the reconcile stops with the error, recording nothing`, (t) => {
    const d = setup(t);
    const deck = deckWith(d.deck, {
      proc: {
        bootId: () => {
          throw procError(code);
        },
      },
    });

    assert.throws(() => reconcile(deck), { code });
    assert.deepEqual(observed(d), []);
    assert.equal(problems(d), null);
  });

  test(`a process whose /proc/<pid>/stat cannot be read (${code}) is recorded and skipped, not taken as gone`, (t) => {
    const d = setup(t);
    d.proc.setProcess(4343, { stat: statLine(4343, START), cmdline: ['claude'] });
    live(d, { pid: 4343, sessionId: S2 });
    const deck = deckWith(d.deck, {
      proc: {
        stat: (pid) => {
          if (pid === 4242) throw procError(code);
          return d.proc.stat(pid);
        },
      },
    });

    assert.deepEqual(reconcile(deck), { observed: 1 });
    assert.deepEqual(
      observed(d).map((e) => [e.pid, e.sessionId]),
      [[4343, S2]],
    );
    assert.deepEqual(problems(d), [`process 4242: ${code}`]);
  });
}

test('a live file modified exactly 2 seconds ago is still left for later', (t) => {
  const d = setup(t);
  live(d, {}, T0 - 2n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  live(d, {}, T0 - 3n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
});

test('no positional argument and no removed flag is ever stored', (t) => {
  const d = setup(t);
  d.proc.setProcess(4242, {
    stat: statLine(4242, START),
    cmdline: ['claude', '--model', 'opus', 'fix the bug'],
  });
  reconcile(d.deck);
  assert.deepEqual(observed(d)[0]?.argv, ['claude', '--model', 'opus']);

  const e = setup(t);
  e.proc.setProcess(4242, {
    stat: statLine(4242, START),
    cmdline: ['claude', '--prefill-b64=Zml4', '--model', 'opus'],
  });
  reconcile(e.deck);
  assert.deepEqual(observed(e)[0]?.argv, ['claude', '--model', 'opus']);
});

test('a process whose handling throws an unexpected error is recorded and skipped; the others are reconciled', (t) => {
  const d = setup(t);
  d.proc.setProcess(4343, { stat: statLine(4343, START), cmdline: ['claude'] });
  live(d, { pid: 4343, sessionId: S2 });
  const deck = deckWith(d.deck, {
    proc: {
      cmdline: (pid) => {
        if (pid === 4242) throw new TypeError('something unexpected');
        return d.proc.cmdline(pid);
      },
    },
  });
  assert.deepEqual(reconcile(deck), { observed: 1 });
  assert.deepEqual(
    observed(d).map((e) => [e.pid, e.sessionId]),
    [[4343, S2]],
  );
  assert.deepEqual(problems(d), ['process 4242: TypeError: something unexpected']);

  // the next clean run clears the record
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.equal(problems(d), null);
});

test('a process whose observed event cannot be saved is recorded and skipped; the others are reconciled', (t) => {
  const d = setup(t);
  d.proc.setProcess(4343, { stat: statLine(4343, START), cmdline: ['claude'] });
  live(d, { pid: 4343, sessionId: S2 });
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: (event) => {
        if (event.pid === 4242) throw new RangeError('cannot bind');
        return d.deck.store.insertEvent(event);
      },
    },
  });
  assert.deepEqual(reconcile(deck), { observed: 1 });
  assert.deepEqual(
    observed(d).map((e) => [e.pid, e.sessionId]),
    [[4343, S2]],
  );
  assert.deepEqual(problems(d), ['process 4242: RangeError: cannot bind']);
});

test('a process another refresh recorded in the meantime is not recorded twice', (t) => {
  const d = setup(t);
  const concurrent = {
    spoolName: null,
    timeNs: T0 + 1_000_000n,
    kind: 'observed' as const,
    detail: '' as const,
    rawDetail: null,
    sessionId: S1,
    bootId: BOOT_A,
    pid: 4242,
    procStart: START,
    cwd: '/home/dev/projects/demo',
    argv: ['claude', '--model', 'opus'],
    name: 'demo name',
    payload: null,
  };
  let raced = false;
  const deck = deckWith(d.deck, {
    store: {
      // Another skydeck commits the same observed event (1 ms later by the clock) just before
      // this one takes the write lock.
      transaction: <T>(fn: () => T): T => {
        if (!raced) {
          raced = true;
          d.clock.setNs(T0 + 1_000_000n);
          d.deck.store.insertEvent(concurrent);
        }
        return d.deck.store.transaction(fn);
      },
    },
  });
  assert.deepEqual(reconcile(deck), { observed: 0 });
  assert.equal(observed(d).length, 1);
});

/**
 * The hook's end(S1) and start(S2) of process 4242 at `atNs` (an in-session `/resume` or `/clear`:
 * reason `resume` / `clear`, source the same), ingested.
 */
function switchByHook(d: TestDeck, how: 'resume' | 'clear', atNs: Ns): void {
  const end = {
    event: 'SessionEnd' as const,
    timeNs: atNs,
    pid: 4242,
    input: hookInput('SessionEnd', S1, { reason: how }),
  };
  const start = {
    event: 'SessionStart' as const,
    timeNs: atNs + 200_000_000n,
    pid: 4242,
    input: hookInput('SessionStart', S2, { source: how }),
    argv: ['claude', '--model', 'opus'],
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(end, 2)), spoolText(end));
  writeFileSync(join(d.deck.places.spoolDir, spoolName(start, 3)), spoolText(start));
  assert.equal(ingestSpool(d.deck).ingested, 2);
}

/** The session the process 4242 holds by its latest event (null after an end). */
function heldBy4242(d: TestDeck): string | null {
  const latest = d.deck.store.latestEventOfProcess(BOOT_A, 4242, START, T0 + 3600n * SEC);
  return latest === null || latest.kind === 'end' ? null : latest.sessionId;
}

test('a hook event newer than the live file wins: the file still names the session the process left', async (t) => {
  for (const how of ['resume', 'clear'] as const) {
    await t.test(how, (t) => {
      const d = setup(t);
      hookStart(d); // S1 at T0 - 20 s
      live(d, {}, T0 - 60n * SEC); // names S1, written a minute ago
      switchByHook(d, how, T0 - 5n * SEC);
      assert.deepEqual(reconcile(d.deck), { observed: 0 });
      assert.equal(heldBy4242(d), S2);
    });
  }
});

test('a start event newer than a live file naming another session adds no observed event', (t) => {
  const d = setup(t);
  live(d, {}, T0 - 60n * SEC); // names S1
  hookStart(d, S2); // T0 - 20 s, with a launch command
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  assert.equal(heldBy4242(d), S2);
});

test('a start event without a launch command, newer than a live file naming another session, adds nothing either', (t) => {
  const d = setup(t);
  live(d, {}, T0 - 60n * SEC); // names S1
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid: 4242,
    input: hookInput('SessionStart', S2, { source: 'resume' }),
    argv: null,
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  assert.equal(ingestSpool(d.deck).ingested, 1);
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  assert.equal(heldBy4242(d), S2);

  // Once the file names S2, the launch command it can read is added.
  live(d, { sessionId: S2 }, T0 - 10n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.deepEqual(observed(d)[0]?.argv, ['claude', '--model', 'opus']);
  assert.equal(heldBy4242(d), S2);
});

test('when the live file is rewritten after the hook and names what the hook said, nothing is added', (t) => {
  const d = setup(t);
  hookStart(d); // S1 at T0 - 20 s
  live(d, {}, T0 - 60n * SEC);
  switchByHook(d, 'clear', T0 - 15n * SEC);
  live(d, { sessionId: S2 }, T0 - 10n * SEC); // rewritten after the switch
  assert.deepEqual(reconcile(d.deck), { observed: 0 });
  assert.equal(heldBy4242(d), S2);
});

test('reconcile’s own observed event is no hook speaking: a file that names another session wins over it', (t) => {
  // Reconcile read the file naming S1; before its insert the process switched to S2 and the file
  // was rewritten, so observed(S1) is stamped after the file and after the hook's start(S2).
  const d = setup(t);
  d.deck.store.insertEvent({
    spoolName: null,
    timeNs: T0,
    kind: 'observed',
    detail: '',
    rawDetail: null,
    sessionId: S1,
    bootId: BOOT_A,
    pid: 4242,
    procStart: START,
    cwd: '/home/dev/projects/demo',
    argv: ['claude', '--model', 'opus'],
    name: null,
    payload: null,
  });
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 1n * SEC,
    pid: 4242,
    input: hookInput('SessionStart', S2, { source: 'resume' }),
    argv: ['claude', '--model', 'opus'],
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, 1)), spoolText(fields));
  assert.equal(ingestSpool(d.deck).ingested, 1);
  live(d, { sessionId: S2 }, T0 - 1n * SEC); // idle from now on: never rewritten
  d.clock.setNs(T0 + 600n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.equal(heldBy4242(d), S2);
});

test('a hook event older than the live file still loses to it (the hook of the change was lost)', (t) => {
  const d = setup(t);
  hookStart(d); // S1 at T0 - 20 s
  live(d, { sessionId: S2 }, T0 - 10n * SEC);
  assert.deepEqual(reconcile(d.deck), { observed: 1 });
  assert.equal(heldBy4242(d), S2);
});

/** What node:sqlite throws while another connection holds the write lock. */
const locked = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('a failure of the database itself ends the reconcile at once', (t) => {
  const d = setup(t);
  d.proc.setProcess(4343, { stat: statLine(4343, START), cmdline: ['claude'] });
  live(d, { pid: 4343, sessionId: S2 });
  let attempts = 0;
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: () => {
        attempts++;
        throw locked();
      },
    },
  });
  assert.throws(() => reconcile(deck), /database is locked/);
  assert.equal(attempts, 1);
});
