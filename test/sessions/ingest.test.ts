import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseSpoolFile } from '../../src/claude/hookinput.ts';
import { NS_PER_DAY, NS_PER_MINUTE, NS_PER_SECOND } from '../../src/platform/time.ts';
import type { Ns } from '../../src/platform/types.ts';
import { ingestSpool } from '../../src/sessions/ingest.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_B, S1, S2, S3, SEC, T0 } from '../helpers/platform.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import type { SpoolFields } from '../helpers/spool.ts';

const NONE = { ingested: 0, duplicates: 0, bad: 0, scripted: 0 };

/** Writes the spool file of `fields` as `spoolName(fields, seq)` into the spool; returns its name. */
function put(d: TestDeck, fields: SpoolFields, seq: number): string {
  const name = spoolName(fields, seq);
  writeFileSync(join(d.deck.places.spoolDir, name), spoolText(fields));
  return name;
}

const spool = (d: TestDeck): string[] => readdirSync(d.deck.places.spoolDir);
const bad = (d: TestDeck): string[] =>
  existsSync(d.deck.places.badDir) ? readdirSync(d.deck.places.badDir) : [];
const problems = (d: TestDeck): string[] | null => {
  const value = d.deck.store.getKv('ingest_problems');
  return value === null ? null : (JSON.parse(value) as string[]);
};

function start(
  sessionId: string,
  source: string,
  timeNs: Ns,
  over: Partial<SpoolFields> = {},
): SpoolFields {
  return {
    event: 'SessionStart',
    timeNs,
    pid: 4242,
    input: hookInput('SessionStart', sessionId, { source }),
    ...over,
  };
}

function end(
  sessionId: string,
  reason: string,
  timeNs: Ns,
  over: Partial<SpoolFields> = {},
): SpoolFields {
  return {
    event: 'SessionEnd',
    timeNs,
    pid: 4242,
    input: hookInput('SessionEnd', sessionId, { reason }),
    ...over,
  };
}

/** Sets the modification time of `path` to `ns` (whole seconds). */
function touch(path: string, ns: Ns): void {
  const seconds = Number(ns / NS_PER_SECOND);
  utimesSync(path, seconds, seconds);
}

test('an empty spool ingests nothing', (t) => {
  const d = testDeck(t);
  assert.deepEqual(ingestSpool(d.deck), NONE);
  assert.deepEqual(d.deck.store.events(), []);
  assert.equal(problems(d), null);
});

test('a SessionStart becomes one event row with the parsed values, and its file is deleted', (t) => {
  const d = testDeck(t);
  const fields = start(S1, 'startup', T0, { argv: ['claude', '--model', 'opus'] });
  const name = put(d, fields, 1);
  const parsed = parseSpoolFile(name, spoolText(fields), () => false);

  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1 });
  const { entrypointEnv, scripted, ...row } = parsed;
  void entrypointEnv;
  void scripted;
  assert.deepEqual(d.deck.store.events(), [{ id: 1, ...row }]);
  assert.deepEqual(d.deck.store.events()[0]?.argv, ['claude', '--model', 'opus']);
  assert.deepEqual(spool(d), []);
});

test('a SessionEnd becomes an end event without a launch command', (t) => {
  const d = testDeck(t);
  put(d, end(S1, 'prompt_input_exit', T0), 1);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1 });
  const [event] = d.deck.store.events();
  assert.equal(event?.kind, 'end');
  assert.equal(event?.detail, 'exit');
  assert.equal(event?.rawDetail, 'prompt_input_exit');
  assert.equal(event?.argv, null);
});

test('files are ingested in name order', (t) => {
  const d = testDeck(t);
  put(d, start(S2, 'startup', T0 + SEC), 2);
  put(d, start(S1, 'startup', T0), 1);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 2 });
  assert.deepEqual(
    d.deck.store.events().map((e) => [e.id, e.timeNs]),
    [
      [1, T0],
      [2, T0 + SEC],
    ],
  );
});

test('a file ingested twice is a duplicate: one row, and the file is deleted', (t) => {
  const d = testDeck(t);
  const fields = start(S1, 'startup', T0);
  put(d, fields, 1);
  ingestSpool(d.deck);
  put(d, fields, 1);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, duplicates: 1 });
  assert.equal(d.deck.store.events().length, 1);
  assert.deepEqual(spool(d), []);
});

test('a file that cannot be parsed is moved to spool/bad, and the reason is recorded', (t) => {
  const d = testDeck(t);
  const name = spoolName(start(S1, 'startup', T0), 1);
  writeFileSync(join(d.deck.places.spoolDir, name), 'garbage');
  writeFileSync(join(d.deck.places.spoolDir, 'x.ev'), spoolText(start(S1, 'startup', T0)));

  assert.deepEqual(ingestSpool(d.deck), { ...NONE, bad: 2 });
  assert.deepEqual(bad(d).sort(), [name, 'x.ev'].sort());
  assert.deepEqual(spool(d), ['bad']);
  const recorded = problems(d) ?? [];
  assert.equal(recorded.length, 2);
  assert.ok(recorded.some((line) => line.includes(name) && line.includes('spool/bad')));
  assert.deepEqual(d.deck.store.events(), []);
});

test('a file whose reading throws an unexpected error is moved to spool/bad; the others are ingested', (t) => {
  const d = testDeck(t);
  const broken = put(d, start(S1, 'startup', T0), 1);
  put(d, start(S2, 'startup', T0 + SEC), 2);
  const files = d.deck.platform.files;
  const deck = deckWith(d.deck, {
    files: {
      readText: (path) => {
        if (path.endsWith(broken)) throw new TypeError('something unexpected');
        return files.readText(path);
      },
    },
  });

  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1, bad: 1 });
  assert.deepEqual(bad(d), [broken]);
  assert.deepEqual(
    d.deck.store.events().map((e) => e.sessionId),
    [S2],
  );
  assert.deepEqual(problems(d), [
    `spool file ${broken} moved to spool/bad/: TypeError: something unexpected`,
  ]);
});

test('an entry that is not a regular file is moved to spool/bad', (t) => {
  const d = testDeck(t);
  const name = spoolName(start(S1, 'startup', T0), 1);
  mkdirSync(join(d.deck.places.spoolDir, name));
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, bad: 1 });
  assert.deepEqual(bad(d), [name]);
});

test('a file that is gone by the time it is read is skipped without a problem', (t) => {
  const d = testDeck(t);
  const name = put(d, start(S1, 'startup', T0), 1);
  const deck = deckWith(d.deck, { files: { readText: () => null } });
  assert.deepEqual(ingestSpool(deck), NONE);
  assert.deepEqual(spool(d), [name]);
  assert.equal(problems(d), null);
});

test('a spool that cannot be listed ingests nothing and records why, without throwing', (t) => {
  const d = testDeck(t);
  put(d, start(S1, 'startup', T0), 1);
  const files = d.deck.platform.files;
  const deck = deckWith(d.deck, {
    files: {
      list: (dir) => {
        if (dir === d.deck.places.spoolDir) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return files.list(dir);
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), NONE);
  assert.deepEqual(problems(d), [`cannot list ${d.deck.places.spoolDir} (EACCES)`]);
});

test('a file that cannot be moved to spool/bad stays where it is, and that is recorded', (t) => {
  const d = testDeck(t);
  const name = spoolName(start(S1, 'startup', T0), 1);
  writeFileSync(join(d.deck.places.spoolDir, name), 'garbage');
  put(d, start(S2, 'startup', T0 + SEC), 2);
  const deck = deckWith(d.deck, {
    files: {
      rename: () => {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1, bad: 1 });
  assert.ok(spool(d).includes(name));
  assert.ok((problems(d) ?? []).some((line) => line.includes(name) && line.includes('EXDEV')));
});

test('a file that cannot be deleted after its row is committed is recorded, and is a duplicate next time', (t) => {
  const d = testDeck(t);
  const name = put(d, start(S1, 'startup', T0), 1);
  const deck = deckWith(d.deck, {
    files: {
      remove: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1 });
  assert.deepEqual(problems(d), [`cannot remove spool file ${name} (EPERM)`]);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, duplicates: 1 });
  assert.deepEqual(spool(d), []);
  assert.equal(problems(d), null, 'a clean run clears the recorded problems');
});

test('retention removes bad files older than 7 days and temporary files older than 1 hour, nothing else', (t) => {
  const d = testDeck(t);
  const { spoolDir, badDir } = d.deck.places;
  mkdirSync(badDir);
  const at = (path: string, ns: Ns, directory = false): string => {
    if (directory) mkdirSync(path);
    else writeFileSync(path, 'x');
    touch(path, ns);
    return path;
  };
  const oldBad = at(join(badDir, 'old.ev'), T0 - 8n * NS_PER_DAY);
  const newBad = at(join(badDir, 'new.ev'), T0 - 6n * NS_PER_DAY);
  const oldDirInBad = at(join(badDir, 'old-dir'), T0 - 8n * NS_PER_DAY, true);
  const oldTmp = at(
    join(spoolDir, '.1794474000000000000-4242-1.ev.tmp'),
    T0 - 120n * NS_PER_MINUTE,
  );
  const newTmp = at(join(spoolDir, '.1794474000000000000-4242-2.ev.tmp'), T0 - 10n * NS_PER_MINUTE);
  const oldTmpDir = at(join(spoolDir, '.dir.tmp'), T0 - 120n * NS_PER_MINUTE, true);
  const readme = at(join(spoolDir, 'README'), T0 - 30n * NS_PER_DAY);
  const tmpWithoutDot = at(join(spoolDir, 'x.tmp'), T0 - 30n * NS_PER_DAY);

  assert.deepEqual(ingestSpool(d.deck), NONE);
  assert.equal(existsSync(oldBad), false);
  assert.equal(existsSync(newBad), true);
  assert.equal(existsSync(oldDirInBad), true);
  assert.equal(existsSync(oldTmp), false);
  assert.equal(existsSync(newTmp), true);
  assert.equal(existsSync(oldTmpDir), true);
  assert.equal(existsSync(readme), true);
  assert.equal(existsSync(tmpWithoutDot), true);
  assert.equal(problems(d), null);
});

test('retention that cannot remove a file records it and goes on', (t) => {
  const d = testDeck(t);
  const { badDir } = d.deck.places;
  mkdirSync(badDir);
  writeFileSync(join(badDir, 'old.ev'), 'x');
  touch(join(badDir, 'old.ev'), T0 - 8n * NS_PER_DAY);
  put(d, start(S1, 'startup', T0), 1);
  const files = d.deck.platform.files;
  const deck = deckWith(d.deck, {
    files: {
      remove: (path) => {
        if (path.startsWith(badDir)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        files.remove(path);
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1 });
  assert.deepEqual(problems(d), [`cannot remove ${join(badDir, 'old.ev')} (EPERM)`]);
});

test('scripted runs are dropped and counted in kv', (t) => {
  const d = testDeck(t);
  const count = (): string | null => d.deck.store.getKv('dropped_scripted');

  put(d, start(S1, 'startup', T0, { argv: ['claude', '-p', 'hi'] }), 1);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, scripted: 1 });
  assert.deepEqual(spool(d), []);
  assert.equal(count(), '1');

  put(d, start(S1, 'startup', T0, { entrypointEnv: 'sdk-ts' }), 2);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, scripted: 1 });
  assert.equal(count(), '2');

  put(d, start(S1, 'startup', T0, { argv: ['claude', '-c', '-p', 'hi'] }), 3);
  put(d, start(S1, 'startup', T0, { argv: ['claude', '-cp'] }), 4);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, scripted: 2 });
  assert.equal(count(), '4');
  assert.deepEqual(d.deck.store.events(), []);
});

/** A transcript row for `sessionId` with `entrypoint`, as the scan saves it. */
function knownTranscript(d: TestDeck, sessionId: string, entrypoint: string | null): void {
  d.deck.store.saveTranscript({
    path: `/claude/projects/demo/${sessionId}.jsonl`,
    sessionId,
    sizeRead: 10,
    fileSize: 10,
    mtimeNs: T0,
    firstCwd: '/home/dev/projects/demo',
    entrypoint,
    aiTitle: null,
    customTitle: null,
    firstRecordNs: T0,
    lastRecordNs: T0,
    lastUserNs: T0,
    lastTurnRole: 'assistant',
    missingSinceNs: null,
  });
}

const RESUME_PRINT = ['claude', '-p', '--resume', S1, '--model', 'opus', 'summarise'];

test('a scripted start of a session skydeck knows is kept as a `scripted` event, and only that', async (t) => {
  const scriptedRun = (seq: number): SpoolFields =>
    start(S1, 'resume', T60 + BigInt(seq) * SEC, {
      pid: 5555,
      entrypointEnv: 'sdk-cli',
      argv: RESUME_PRINT,
      input: hookInput('SessionStart', S1, { source: 'resume', session_title: 'its name' }),
    });

  await t.test('known from an event of an interactive run', (t) => {
    const d = testDeck(t);
    put(d, start(S1, 'startup', T0), 1);
    put(d, end(S1, 'prompt_input_exit', T0 + SEC), 2);
    put(d, scriptedRun(3), 3);
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 3 });
    const kept = d.deck.store.events()[2];
    assert.deepEqual(
      kept && {
        kind: kept.kind,
        detail: kept.detail,
        rawDetail: kept.rawDetail,
        sessionId: kept.sessionId,
        pid: kept.pid,
        procStart: kept.procStart,
        argv: kept.argv,
        name: kept.name,
      },
      {
        kind: 'scripted',
        detail: '',
        rawDetail: 'resume',
        sessionId: S1,
        pid: 5555,
        procStart: 51234567,
        argv: null, // a scripted run never supplies the launch command
        name: null,
      },
    );
    assert.equal(d.deck.store.getKv('dropped_scripted'), null);
    assert.deepEqual(d.deck.store.links(), []);
  });

  await t.test('`claude -p -c`: the hook names the continued session, the same path', (t) => {
    const d = testDeck(t);
    put(d, start(S1, 'startup', T0), 1);
    put(
      d,
      start(S1, 'startup', T60, {
        pid: 5555,
        entrypointEnv: 'sdk-cli',
        argv: ['claude', '-p', '-c'],
      }),
      2,
    );
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 2 });
    assert.deepEqual(
      d.deck.store.events().map((e) => [e.kind, e.pid, e.argv]),
      [
        ['start', 4242, ['claude']],
        ['scripted', 5555, null],
      ],
    );
  });

  await t.test('without a pid it names no process that could hold the session: dropped', (t) => {
    const d = testDeck(t);
    put(d, start(S1, 'startup', T0), 1);
    put(d, { ...scriptedRun(2), pid: null }, 2);
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1, scripted: 1 });
    assert.equal(d.deck.store.getKv('dropped_scripted'), '1');
  });

  await t.test('without a process start it could never be found alive: dropped', (t) => {
    const d = testDeck(t);
    put(d, start(S1, 'startup', T0), 1);
    put(d, { ...scriptedRun(2), procStart: null }, 2);
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1, scripted: 1 });
    assert.equal(d.deck.store.getKv('dropped_scripted'), '1');
  });

  for (const entrypoint of ['cli', null]) {
    await t.test(`known only from its transcript (entry point ${String(entrypoint)})`, (t) => {
      const d = testDeck(t);
      knownTranscript(d, S1, entrypoint);
      put(d, scriptedRun(1), 1);
      assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1 });
      assert.equal(d.deck.store.events()[0]?.kind, 'scripted');
    });
  }
});

test('scripted runs of sessions skydeck does not know stay dropped and counted', async (t) => {
  await t.test('a new session, or one only a scripted run made', (t) => {
    const d = testDeck(t);
    knownTranscript(d, S2, 'sdk-cli'); // a session a scripted run made earlier
    put(d, start(S1, 'startup', T0, { entrypointEnv: 'sdk-cli', argv: ['claude', '-p'] }), 1);
    put(d, end(S1, 'other', T0 + SEC, { entrypointEnv: 'sdk-cli' }), 2);
    put(
      d,
      start(S2, 'resume', T0 + 2n * SEC, {
        entrypointEnv: 'sdk-cli',
        argv: ['claude', '-p', '--resume', S2],
      }),
      3,
    );
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, scripted: 3 });
    assert.deepEqual(d.deck.store.events(), []);
    assert.equal(d.deck.store.getKv('dropped_scripted'), '3');
  });

  await t.test(
    'the end of a scripted run whose start was not kept is dropped, also for a known session',
    (t) => {
      const d = testDeck(t);
      put(d, start(S1, 'startup', T0), 1);
      put(d, end(S1, 'other', T0 + SEC, { pid: 5555, entrypointEnv: 'sdk-cli' }), 2);
      assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1, scripted: 1 });
      assert.deepEqual(
        d.deck.store.events().map((e) => e.kind),
        ['start'],
      );
    },
  );
});

test('the end of a scripted process that holds a session by a kept start is kept as `scripted-end`', (t) => {
  // An SDK host or an editor extension can /clear or switch inside one process: the end of what it
  // held must release that holding.
  const d = testDeck(t);
  const sdk = { pid: 5555, entrypointEnv: 'sdk-ts', argv: ['claude', '--model', 'opus'] };
  put(d, start(S1, 'startup', T0), 1);
  put(d, end(S1, 'prompt_input_exit', T0 + SEC), 2);
  put(d, start(S1, 'resume', T60, sdk), 3);
  put(d, end(S1, 'clear', T60_2, { pid: 5555, entrypointEnv: 'sdk-ts' }), 4);
  put(d, start(S2, 'clear', T60_2 + SEC, sdk), 5); // a new session: dropped
  put(d, end(S2, 'other', T60_2 + 2n * SEC, { pid: 5555, entrypointEnv: 'sdk-ts' }), 6); // holds nothing kept
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 4, scripted: 2 });
  const kept = d.deck.store.events().at(-1);
  assert.deepEqual(
    kept && [kept.kind, kept.detail, kept.rawDetail, kept.sessionId, kept.pid, kept.argv],
    ['scripted-end', '', 'clear', S1, 5555, null],
  );
  assert.equal(d.deck.store.getKv('dropped_scripted'), '2');
  assert.deepEqual(d.deck.store.links(), []);
});

/** Ingests each group of files in its own run. */
function ingestRuns(d: TestDeck, ...runs: SpoolFields[][]): void {
  let seq = 0;
  for (const run of runs) {
    for (const fields of run) put(d, fields, ++seq);
    ingestSpool(d.deck);
  }
}

const T60 = T0 + 60n * SEC;
const T60_2 = T60 + 200_000_000n;

test('links: clear, switch and fork', async (t) => {
  await t.test('start startup, end clear, start clear of another session → a clear link', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [start(S1, 'startup', T0), end(S1, 'clear', T60), start(S2, 'clear', T60_2)]);
    assert.deepEqual(d.deck.store.links(), [
      { eventId: 3, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T60_2 },
    ]);
  });

  await t.test(
    'start startup, end resume, start resume of another session → a switch link',
    (t) => {
      const d = testDeck(t);
      ingestRuns(d, [start(S1, 'startup', T0), end(S1, 'resume', T60), start(S2, 'resume', T60_2)]);
      assert.deepEqual(d.deck.store.links(), [
        { eventId: 3, fromSession: S1, toSession: S2, kind: 'switch', timeNs: T60_2 },
      ]);
    },
  );

  await t.test('start startup, start fork → a fork link', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [start(S1, 'startup', T0), start(S3, 'fork', T60)]);
    assert.deepEqual(d.deck.store.links(), [
      { eventId: 2, fromSession: S1, toSession: S3, kind: 'fork', timeNs: T60 },
    ]);
  });

  await t.test('the first event of a new process gets no link', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [start(S2, 'startup', T0), start(S1, 'resume', T60, { pid: 5555 })]);
    assert.deepEqual(d.deck.store.links(), []);
  });

  await t.test('the same session again gets no link (clear and compact)', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [
      start(S1, 'startup', T0),
      start(S1, 'clear', T0 + SEC),
      start(S1, 'compact', T0 + 2n * SEC),
    ]);
    assert.deepEqual(d.deck.store.links(), []);
  });

  await t.test('one file per run gives the same single link', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [start(S1, 'startup', T0)], [end(S1, 'clear', T60)], [start(S2, 'clear', T60_2)]);
    assert.deepEqual(d.deck.store.links(), [
      { eventId: 3, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T60_2 },
    ]);
  });

  await t.test('events without a pid never get links', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [
      start(S1, 'startup', T0, { pid: null }),
      start(S2, 'clear', T60, { pid: null }),
    ]);
    assert.equal(d.deck.store.events().length, 2);
    assert.deepEqual(d.deck.store.links(), []);
  });

  await t.test(
    'the same pid in another boot or with another process start is another process',
    (t) => {
      const d = testDeck(t);
      ingestRuns(d, [
        start(S1, 'startup', T0),
        start(S2, 'clear', T60, { bootId: BOOT_B }),
        start(S3, 'clear', T60_2, { procStart: 999 }),
      ]);
      assert.deepEqual(d.deck.store.links(), []);
    },
  );

  await t.test('a duplicate file adds no second link', (t) => {
    const d = testDeck(t);
    ingestRuns(d, [start(S1, 'startup', T0), start(S2, 'clear', T60)]);
    put(d, start(S2, 'clear', T60), 2);
    assert.deepEqual(ingestSpool(d.deck), { ...NONE, duplicates: 1 });
    assert.equal(d.deck.store.links().length, 1);
  });
});

test('a relative path-flag value is stored absolute against the input cwd', (t) => {
  const d = testDeck(t);
  const project = join(d.sandbox.root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'mcp.json'), '{}');
  put(
    d,
    {
      ...start(S1, 'startup', T0, { argv: ['claude', '--mcp-config', 'mcp.json'] }),
      input: hookInput('SessionStart', S1, { source: 'startup', cwd: project }),
    },
    1,
  );
  ingestSpool(d.deck);
  assert.deepEqual(d.deck.store.events()[0]?.argv, [
    'claude',
    '--mcp-config',
    join(project, 'mcp.json'),
  ]);
});

/** Directories `first` and `second`, each holding an `s.json`. */
function twoProjects(d: TestDeck): { first: string; second: string } {
  const first = join(d.sandbox.root, 'first');
  const second = join(d.sandbox.root, 'second');
  for (const dir of [first, second]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 's.json'), '{}');
  }
  return { first, second };
}

/** A start of process `over.pid ?? 4242` whose launch command has `--settings s.json`, in `cwd`. */
function startIn(
  cwd: string,
  sessionId: string,
  source: string,
  timeNs: Ns,
  over: Partial<SpoolFields> = {},
): SpoolFields {
  return {
    ...start(sessionId, source, timeNs, { argv: ['claude', '--settings', 's.json'], ...over }),
    input: hookInput('SessionStart', sessionId, { source, cwd }),
  };
}

test('a later start of the same process keeps the launch command its first start stored', (t) => {
  // After /clear (or an in-session /resume) the hook input's cwd need not be where the process
  // was launched; its command line never changes, so its relative path flags are not resolved again.
  const d = testDeck(t);
  const { first, second } = twoProjects(d);
  ingestRuns(d, [
    startIn(first, S1, 'startup', T0),
    end(S1, 'clear', T60),
    startIn(second, S2, 'clear', T60_2),
    // a start whose hook could not read the command line gets it too
    startIn(second, S3, 'clear', T60_2 + SEC, { argv: null }),
  ]);
  const settings = join(first, 's.json');
  assert.deepEqual(
    d.deck.store.events().map((e) => e.argv),
    [
      ['claude', '--settings', settings],
      null,
      ['claude', '--settings', settings],
      ['claude', '--settings', settings],
    ],
  );
});

test('the launch command reused is the one of the process’s FIRST start that stored one', (t) => {
  // A later start stored with another resolution (e.g. ingested before this rule existed) is not
  // the one reused: the first start ran where the process was launched.
  const d = testDeck(t);
  const { first, second } = twoProjects(d);
  ingestRuns(d, [startIn(first, S1, 'startup', T0)]);
  d.deck.store.insertEvent({
    ...d.deck.store.events()[0]!,
    spoolName: 'older-rule.ev',
    timeNs: T60,
    sessionId: S2,
    detail: 'clear',
    argv: ['claude', '--settings', join(second, 's.json')],
  });
  ingestRuns(d, [startIn(second, S3, 'clear', T60_2)]);
  assert.deepEqual(d.deck.store.events().at(-1)?.argv, [
    'claude',
    '--settings',
    join(first, 's.json'),
  ]);
});

test('another process (another process start) resolves its own launch command', (t) => {
  const d = testDeck(t);
  const { first, second } = twoProjects(d);
  ingestRuns(d, [
    startIn(first, S1, 'startup', T0),
    startIn(second, S2, 'startup', T60, { procStart: 999 }), // the pid, reused
    startIn(second, S3, 'startup', T60_2, { pid: null }), // no process at all
  ]);
  assert.deepEqual(
    d.deck.store.events().map((e) => e.argv),
    [
      ['claude', '--settings', join(first, 's.json')],
      ['claude', '--settings', join(second, 's.json')],
      ['claude', '--settings', join(second, 's.json')],
    ],
  );
});

test('no positional argument and no removed flag is ever stored', (t) => {
  const d = testDeck(t);
  put(d, start(S1, 'startup', T0, { argv: ['claude', '--model', 'opus', 'fix the bug'] }), 1);
  put(
    d,
    start(S2, 'startup', T0 + SEC, { argv: ['claude', '--prefill-b64=Zml4', '--model', 'opus'] }),
    2,
  );
  ingestSpool(d.deck);
  assert.deepEqual(
    d.deck.store.events().map((e) => e.argv),
    [
      ['claude', '--model', 'opus'],
      ['claude', '--model', 'opus'],
    ],
  );
});

test('a spool file whose row cannot be saved stays in the spool, and the others are ingested', (t) => {
  const d = testDeck(t);
  const failing = put(d, start(S1, 'startup', T0), 1);
  put(d, start(S2, 'startup', T0 + SEC), 2);
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: (event) => {
        if (event.spoolName === failing) throw new RangeError('cannot bind');
        return d.deck.store.insertEvent(event);
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1 });
  // The file is deleted only after its row is committed: this one stays for the next refresh.
  assert.deepEqual(spool(d), [failing]);
  assert.deepEqual(bad(d), []);
  assert.deepEqual(
    d.deck.store.events().map((e) => e.sessionId),
    [S2],
  );
  assert.deepEqual(problems(d), [
    `spool file ${failing} could not be recorded (RangeError: cannot bind)`,
  ]);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1 });
  assert.deepEqual(spool(d), []);
});

test('a link that cannot be saved leaves no event row behind', (t) => {
  const d = testDeck(t);
  put(d, start(S1, 'startup', T0), 1);
  const clear = put(d, start(S2, 'clear', T60), 2);
  const deck = deckWith(d.deck, {
    store: {
      insertLink: () => {
        throw new Error('no link');
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), { ...NONE, ingested: 1 });
  assert.deepEqual(spool(d), [clear]);
  assert.equal(d.deck.store.events().length, 1);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, ingested: 1 });
  assert.equal(d.deck.store.links().length, 1);
});

test('a scripted run whose file cannot be removed is counted once, when it is removed', (t) => {
  const d = testDeck(t);
  put(d, start(S1, 'startup', T0, { argv: ['claude', '-p', 'hi'] }), 1);
  const deck = deckWith(d.deck, {
    files: {
      remove: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    },
  });
  assert.deepEqual(ingestSpool(deck), NONE);
  assert.deepEqual(ingestSpool(deck), NONE);
  assert.equal(d.deck.store.getKv('dropped_scripted'), null);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, scripted: 1 });
  assert.equal(d.deck.store.getKv('dropped_scripted'), '1');
});

test('a bad file moved in this run stays in spool/bad until the next run, however old it is', (t) => {
  const d = testDeck(t);
  const name = spoolName(start(S1, 'startup', T0), 1);
  const path = join(d.deck.places.spoolDir, name);
  writeFileSync(path, 'garbage');
  touch(path, T0 - 8n * NS_PER_DAY);
  assert.deepEqual(ingestSpool(d.deck), { ...NONE, bad: 1 });
  assert.deepEqual(bad(d), [name]);
  assert.equal(problems(d)?.length, 1);
  ingestSpool(d.deck);
  assert.deepEqual(bad(d), []);
});

/** What node:sqlite throws while another connection holds the write lock. */
const locked = (): Error =>
  Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('a failure of the database itself ends the ingest at once, and the file stays', (t) => {
  const d = testDeck(t);
  const first = put(d, start(S1, 'startup', T0), 1);
  const second = put(d, start(S2, 'startup', T0 + SEC), 2);
  let attempts = 0;
  const deck = deckWith(d.deck, {
    store: {
      insertEvent: () => {
        attempts++;
        throw locked();
      },
    },
  });
  assert.throws(() => ingestSpool(deck), /database is locked/);
  assert.equal(attempts, 1);
  assert.deepEqual(spool(d).sort(), [first, second].sort());
});
