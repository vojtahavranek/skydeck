// The server's tick (S2 10.1; plan task 23, A7, A24): what runs every second, every second tick,
// every 30 seconds and once a minute, step 1's reload rule of the interactive list, the failed
// tick shown once, the migrated store, the settling of ended terminals, the mapping of terminals to
// sessions and the automatic pull-request refresh. On testPlatform's fake clock and /proc, with
// fakes for the registry, the pages, the keep-alive and the interop link; one case of task 57 runs
// end to end, on a real registry with a real keeper the test starts and kills itself.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { main } from '../../src/cli/main.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { launchPrepared } from '../../src/sessions/launch.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { attachManualPr, setLabel } from '../../src/sessions/meta.ts';
import { prepareResumeById } from '../../src/sessions/resume-by-id.ts';
import { lockKey, prepareNew, readLock } from '../../src/sessions/resume.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { openStore } from '../../src/store/store.ts';
import { createActions } from '../../src/window/actions.ts';
import type { KeeperHello } from '../../src/window/frames.ts';
import type { PageInfo, TerminalInfo } from '../../src/window/hub.ts';
import { createLaunches } from '../../src/window/launches.ts';
import type { ActMessage, NoticeMessage } from '../../src/window/protocol.ts';
import { createTick } from '../../src/window/tick.ts';
import type { Tick, TickDeps } from '../../src/window/tick.ts';
import { windowTerminal } from '../../src/window/window-terminal.ts';
import { testContextOn } from '../helpers/context.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { procStartOf, stillRuns, until } from '../helpers/keeper.ts';
import { S1, S2, SEC, T0, statLine } from '../helpers/platform.ts';
import { info } from '../helpers/registry.ts';
import { startRunning, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';
import { readRecords, standinCommand, waitForRecord } from '../helpers/standin.ts';
import { windowDeck } from '../helpers/window-deck.ts';

const PID = 4242;
const START = 51234567;
const MiB = 1024 * 1024;

function terminal(over: Partial<TerminalInfo> & { id: string }): TerminalInfo {
  return {
    slot: 1,
    state: 'running',
    expectedSessionId: S1,
    sessionId: null,
    kind: 'resume',
    label: null,
    dir: '/home/dev/projects/demo',
    program: null,
    openedNs: T0,
    cols: 80,
    rows: 24,
    exit: null,
    notReported: false,
    ...over,
  };
}

function helloOf(over: Partial<KeeperHello> = {}): KeeperHello {
  return {
    protocol: 1,
    keeper: '2',
    id: 'aaaaaaaaaaaa',
    started: true,
    startBy: String(T0 + 60n * SEC),
    lock: null,
    pid: 9000,
    procStart: 1,
    cols: 80,
    rows: 24,
    seq: 0,
    snapSeq: 0,
    tailFrom: 1,
    gap: false,
    meta: {
      sessionId: S1,
      kind: 'resume',
      slot: 1,
      openedNs: String(T0),
      build: 'test-build',
      label: null,
      dir: '/home/dev/projects/demo',
    },
    exited: null,
    ...over,
  };
}

/** A SQLite error the store counts as a failure of the database itself (SQLITE_BUSY). */
function busyError(text: string): Error {
  return Object.assign(new Error(text), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

interface Fixture {
  d: TestDeck;
  tick: Tick;
  /** What the tick was made with: a test makes a second tick on the same fakes with `{ ...deps }`. */
  deps: TickDeps;
  terminals: TerminalInfo[];
  closed: string[];
  sessions: { id: string; sessionId: string | null; notReported: boolean }[];
  notices: { kind: NoticeMessage['kind']; text: string }[];
  pushes: () => number;
  keepAliveTicks: () => number;
  interopRefreshes: () => number;
  logs: string[];
  storeNewer: string[];
  keepersLog: string;
}

function fixture(
  t: TestContext,
  options: { d?: TestDeck; deck?: (deck: Deck) => Deck; terminals?: TerminalInfo[] } = {},
): Fixture {
  const d = options.d ?? testDeck(t);
  const deck = options.deck === undefined ? d.deck : options.deck(d.deck);
  const terminals = options.terminals ?? [];
  const closed: string[] = [];
  const sessions: Fixture['sessions'] = [];
  const notices: Fixture['notices'] = [];
  const logs: string[] = [];
  const storeNewer: string[] = [];
  let pushes = 0;
  let keepAliveTicks = 0;
  let interopRefreshes = 0;
  const keepersLog = join(d.deck.places.stateDir, 'keepers.log');
  const deps: TickDeps = {
    deck,
    hub: {
      list: () => terminals.map((term) => ({ ...term })),
      setSession(id, sessionId, notReported) {
        sessions.push({ id, sessionId, notReported });
        const term = terminals.find((candidate) => candidate.id === id);
        if (term !== undefined) {
          term.sessionId = sessionId;
          term.notReported = notReported;
        }
      },
      close(id) {
        closed.push(id);
        const index = terminals.findIndex((candidate) => candidate.id === id);
        if (index === -1) return 'unknown';
        terminals.splice(index, 1);
        return 'ok';
      },
    },
    pages: {
      pushList() {
        pushes++;
      },
      notice(kind, text) {
        notices.push({ kind, text });
      },
    },
    keepAlive: {
      tick() {
        keepAliveTicks++;
        return Promise.resolve();
      },
    },
    interop: {
      refresh() {
        interopRefreshes++;
        return Promise.resolve(null);
      },
    },
    keepersLog,
    log: (line) => {
      logs.push(line);
    },
    storeNewer: (reason) => {
      storeNewer.push(reason);
    },
  };
  const tick = createTick(deps);
  t.after(() => tick.stop());
  return {
    d,
    tick,
    deps,
    terminals,
    closed,
    sessions,
    notices,
    pushes: () => pushes,
    keepAliveTicks: () => keepAliveTicks,
    interopRefreshes: () => interopRefreshes,
    logs,
    storeNewer,
    keepersLog,
  };
}

/** Runs `n` ticks, one after the other. */
async function ticks(f: Fixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await f.tick.run();
  }
}

/** A SessionStart of `sessionId` waiting in the spool, so that the next refresh has to write. */
function spoolStart(d: TestDeck, sessionId: string, pid: number, seq: number): void {
  const fields = {
    event: 'SessionStart' as const,
    timeNs: T0 - 20n * SEC,
    pid,
    input: hookInput('SessionStart', sessionId, { source: 'startup' }),
  };
  writeFileSync(join(d.deck.places.spoolDir, spoolName(fields, seq)), spoolText(fields));
}

describe('the schedule (S2 10.1)', () => {
  test('every second the keep-alive; every second tick the refresh and the lists', async (t) => {
    const f = fixture(t);
    await ticks(f, 1);
    assert.deepEqual([f.keepAliveTicks(), f.pushes()], [1, 1], 'the first tick refreshes');
    await ticks(f, 1);
    assert.deepEqual([f.keepAliveTicks(), f.pushes()], [2, 1]);
    await ticks(f, 2);
    assert.deepEqual([f.keepAliveTicks(), f.pushes()], [4, 2]);
  });

  test('the interop link every 30 seconds, not at the first tick (the server has just pointed it)', async (t) => {
    const f = fixture(t);
    await ticks(f, 30);
    assert.equal(f.interopRefreshes(), 0);
    await ticks(f, 1);
    assert.equal(f.interopRefreshes(), 1, 'at second 30');
    await ticks(f, 30);
    assert.equal(f.interopRefreshes(), 2, 'at second 60');
  });

  test('start() runs a tick at once and one every second on the clock; stop() ends them', async (t) => {
    const f = fixture(t);
    await f.tick.start();
    assert.equal(f.keepAliveTicks(), 1, 'the first tick ran before start() resolved');
    f.d.clock.advanceMs(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.keepAliveTicks(), 2);
    await f.tick.stop();
    f.d.clock.advanceMs(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.keepAliveTicks(), 2, 'no tick after stop()');
    assert.equal(f.d.clock.timers(), 0, 'no timer is left');
  });

  test('a keep-alive or an interop link that fails is logged by kind and the tick goes on', async (t) => {
    const f = fixture(t);
    const failing = createTick({
      ...f.deps,
      keepAlive: { tick: () => Promise.reject(new TypeError('marker-keepalive')) },
      interop: { refresh: () => Promise.reject(new RangeError('marker-interop')) },
    });
    t.after(() => failing.stop());
    for (let i = 0; i <= 30; i++) await failing.run();
    assert.ok(f.logs.some((line) => line.includes('keep-alive') && line.includes('TypeError')));
    assert.ok(f.logs.some((line) => line.includes('interop') && line.includes('RangeError')));
    assert.ok(
      f.logs.every((line) => !line.includes('marker')),
      'no message is logged',
    );
    assert.ok(f.pushes() >= 16, 'the lists still went out');
  });
});

describe('keepers.log (S2 4.2)', () => {
  test('is rotated once a minute on the tick', async (t) => {
    const f = fixture(t);
    writeFileSync(f.keepersLog, 'x'.repeat(MiB + 1));
    await ticks(f, 60);
    assert.equal(existsSync(`${f.keepersLog}.1`), false, 'not before second 60');
    await ticks(f, 1);
    assert.equal(existsSync(`${f.keepersLog}.1`), true, 'rotated at second 60');
  });

  test('a rotation that fails is logged by kind, and the tick goes on', async (t) => {
    const f = fixture(t);
    const dir = join(f.d.sandbox.root, 'readonly-logs');
    mkdirSync(dir);
    const log = join(dir, 'keepers.log');
    writeFileSync(log, 'x'.repeat(MiB + 1));
    const rotating = createTick({ ...f.deps, keepersLog: log });
    chmodSync(dir, 0o500); // the copy to `.keepers.log.1.tmp` beside it fails
    try {
      for (let i = 0; i <= 60; i++) await rotating.run();
    } finally {
      chmodSync(dir, 0o700); // before the sandbox goes
      await rotating.stop();
    }
    assert.ok(
      f.logs.some((line) => line.includes('keepers.log') && line.includes('EACCES')),
      f.logs.join('\n'),
    );
    assert.equal(existsSync(`${log}.1`), false);
  });
});

describe('the rows (A24: the interactive list rule)', () => {
  test('are loaded at the first tick', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    assert.deepEqual(f.tick.rows(), [], 'nothing before the first tick');
    await ticks(f, 1);
    assert.deepEqual(
      f.tick.rows().map((row) => row.id),
      [S1],
    );
  });

  test('are kept as they are when nothing changed', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 1);
    const before = f.tick.rows();
    await ticks(f, 6);
    assert.equal(f.tick.rows(), before, 'the same rows, not loaded again');
  });

  test('are loaded again when the refresh saved something', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 1);
    writeTranscript(d, S2);
    await ticks(f, 1);
    assert.equal(f.tick.rows().length, 1, 'only every second tick refreshes');
    await ticks(f, 1);
    assert.deepEqual(
      f.tick
        .rows()
        .map((row) => row.id)
        .sort(),
      [S1, S2].sort(),
    );
  });

  test('are loaded again when a live file changes', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    const live = join(d.deck.places.claudeHome, 'sessions', `${PID}.json`);
    const file = JSON.parse(readFileSync(live, 'utf8')) as Record<string, unknown>;
    writeFileSync(live, JSON.stringify({ ...file, status: 'idle' }));
    await ticks(f, 2);
    assert.notEqual(f.tick.rows(), before);
  });

  test('are loaded again when another connection committed to the store', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    const other = openStore(d.deck.places.dbPath);
    other.setKv('window_alarm', String(T0));
    other.close();
    await ticks(f, 2);
    assert.notEqual(f.tick.rows(), before);
  });

  test('are loaded again a minute after they were last loaded', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    d.clock.advanceMs(59_000);
    await ticks(f, 2);
    assert.equal(f.tick.rows(), before, 'not before the minute');
    d.clock.advanceMs(1_000);
    await ticks(f, 2);
    assert.notEqual(f.tick.rows(), before);
  });

  test('are loaded again when reload() asks for it', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    f.tick.reload();
    await ticks(f, 2);
    assert.notEqual(f.tick.rows(), before);
  });
});

describe('reloadNow (plan D7)', () => {
  test("loads the rows and pushes the lists at once, without waiting for a tick (a write on the server's own connection moves no change mark)", async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    setLabel(d.deck, S1, 'renamed');
    const pushes = f.pushes();
    f.tick.reloadNow();
    assert.equal(f.tick.rows().find((row) => row.id === S1)?.title, 'renamed');
    assert.equal(f.pushes(), pushes + 1);
    assert.deepEqual(f.logs, []);
  });

  test('counts as a load: the next refresh does not load again for what it loaded, nor a minute after the load before it', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    d.clock.advanceMs(30_000);
    f.tick.reload(); // owed, as after an action
    f.tick.reloadNow();
    const loaded = f.tick.rows();
    await ticks(f, 2);
    assert.equal(f.tick.rows(), loaded, 'the reload owed was made');
    d.clock.advanceMs(30_000); // a minute after the first load, 30 s after this one
    await ticks(f, 2);
    assert.equal(f.tick.rows(), loaded, 'the minute counts from this load');
  });

  test('a store that is busy: one log line by kind, nothing pushed, and the rows are loaded at the next refresh', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    let failing = false;
    const f = fixture(t, {
      d,
      deck: (deck) =>
        deckWith(deck, {
          store: {
            allMeta: () => {
              if (failing) throw busyError('database is locked (marker-secret)');
              return deck.store.allMeta();
            },
          },
        }),
    });
    await ticks(f, 2);
    const before = f.tick.rows();
    setLabel(d.deck, S1, 'renamed');
    const pushes = f.pushes();
    failing = true;
    f.tick.reloadNow();
    assert.deepEqual(f.logs, ['tick: the rows were not loaded again (Error (ERR_SQLITE_ERROR))']);
    assert.equal(f.pushes(), pushes, 'nothing new to push');
    assert.equal(f.tick.rows(), before, 'the rows kept');
    failing = false;
    await ticks(f, 2);
    assert.equal(f.tick.rows().find((row) => row.id === S1)?.title, 'renamed', 'the next refresh');
  });

  test('after stop() it loads nothing and pushes nothing', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    await f.tick.stop();
    setLabel(d.deck, S1, 'renamed');
    const pushes = f.pushes();
    f.tick.reloadNow();
    assert.equal(f.tick.rows(), before);
    assert.equal(f.pushes(), pushes);
  });
});

describe('a tick that fails (S2 10.1, 14; A7)', () => {
  test('is shown once to the pages, logged by kind, and the next refresh tries again', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    let failing = true;
    const f = fixture(t, {
      d,
      deck: (deck) =>
        deckWith(deck, {
          store: {
            transaction: <T>(fn: () => T): T => {
              if (failing) throw busyError('database is locked (marker-secret)');
              return deck.store.transaction(fn);
            },
          },
        }),
    });
    spoolStart(d, S2, PID, 1);
    await ticks(f, 6);
    assert.deepEqual(
      f.notices.map((notice) => notice.kind),
      ['tick-failed'],
      'one notice for three failed refreshes',
    );
    assert.match(
      f.notices[0]?.text ?? '',
      /^skydeck could not refresh the list: .+; it tries again$/,
    );
    assert.ok(f.logs.length >= 1);
    assert.ok(
      f.logs.every((line) => !line.includes('marker')),
      f.logs.join('\n'),
    );
    assert.equal(f.pushes(), 3, 'the lists still went out');

    failing = false;
    await ticks(f, 2);
    assert.ok(
      f.tick.rows().some((row) => row.id === S2),
      'the refresh that worked loaded the rows',
    );
    assert.equal(f.notices.length, 1, 'no notice for a tick that worked');

    failing = true;
    spoolStart(d, S1, PID + 1, 2);
    await ticks(f, 2);
    assert.deepEqual(
      f.notices.map((notice) => notice.kind),
      ['tick-failed', 'tick-failed'],
      'a failure after a success is shown again',
    );
  });

  test('a store migrated under the server: storeNewer once with the update text, no notice, nothing more', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    // The server's own connection checks the schema before every write (S2 10.1).
    const guarded = openDeck(d.platform, { guardSchema: true });
    t.after(() => {
      guarded.store.close();
    });
    const f = fixture(t, { d, deck: () => guarded });
    await ticks(f, 2);
    const db = new DatabaseSync(d.deck.places.dbPath);
    db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();
    writeTranscript(d, S2); // the refresh must write: the guard refuses it
    await ticks(f, 6);
    assert.deepEqual(f.storeNewer, ['skydeck was updated; run skydeck window']);
    assert.deepEqual(f.notices, []);
    assert.equal(
      d.deck.store.transcripts().some((row) => row.sessionId === S2),
      false,
      'nothing written',
    );
  });
});

describe('ended terminals (S2 7.8; plan task 21)', () => {
  test('ended(hello): the next refresh settles it — a resume lock nothing started is released', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    const f = fixture(t, { d });
    f.tick.ended(helloOf({ lock, started: false }));
    await ticks(f, 1);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  });

  test("a settled exit loads the rows again (the settle ingests and writes on the server's own connection)", async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const f = fixture(t, { d });
    await ticks(f, 2);
    const before = f.tick.rows();
    f.tick.ended(helloOf({ lock: `${T0}:0`, started: false }));
    await ticks(f, 1);
    await ticks(f, 2);
    assert.notEqual(f.tick.rows(), before);
  });

  test('a settle that meets a failure of the database is tried again at the next refresh', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    let failing = true;
    const f = fixture(t, {
      d,
      deck: (deck) =>
        deckWith(deck, {
          store: {
            transaction: <T>(fn: () => T): T => {
              if (failing) throw busyError('database is locked');
              return deck.store.transaction(fn);
            },
          },
        }),
    });
    f.tick.ended(helloOf({ lock, started: false }));
    await ticks(f, 2);
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock, 'kept while the store fails');
    failing = false;
    await ticks(f, 2);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  });

  test('a lost exit whose program may still run is not settled yet (task 82): its lock stays at every refresh until the program is gone, then it is released', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    const lost = terminal({
      id: 'aaaaaaaaaaaa',
      state: 'lost',
      program: { pid: PID, procStart: START },
      exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
    });
    const f = fixture(t, { d, terminals: [lost] });
    f.tick.ended(helloOf({ lock, started: false }));
    await ticks(f, 1);
    d.clock.advanceMs(2000);
    await ticks(f, 2);
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock, 'kept while the program may run');
    d.proc.setProcess(PID, null); // it ran its end and is gone
    await ticks(f, 2);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
    assert.deepEqual(f.logs, []);
  });

  test('a lost `new` exit waits as a resume’s does (task 82, ruled): its label and group stay while its program may still run; removed at the next refresh once it is gone', async (t) => {
    const d = testDeck(t);
    const prepared = prepareNew(d.deck, {
      dir: d.sandbox.home,
      label: 'fix the build',
      group: 'ops',
      extra: [],
    });
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    const lost = terminal({
      id: 'aaaaaaaaaaaa',
      state: 'lost',
      kind: 'new',
      expectedSessionId: prepared.sessionId,
      program: { pid: PID, procStart: START },
      exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
    });
    const f = fixture(t, { d, terminals: [lost] });
    const hello = helloOf({ started: false });
    f.tick.ended({ ...hello, meta: { ...hello.meta, kind: 'new', sessionId: prepared.sessionId } });
    await ticks(f, 1);
    assert.equal(d.deck.store.meta(prepared.sessionId)?.label, 'fix the build');
    d.proc.setProcess(PID, null);
    await ticks(f, 2);
    assert.equal(d.deck.store.meta(prepared.sessionId), null);
  });

  test('ended() keeps the terminal of that hello, not another one the hub lists before it (task 82)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    const terminals = [
      terminal({ id: 'aaaaaaaaaaaa', expectedSessionId: S2, program: { pid: 9999, procStart: 1 } }),
      terminal({
        id: 'bbbbbbbbbbbb',
        state: 'lost',
        program: { pid: PID, procStart: START },
        exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
      }),
    ];
    const f = fixture(t, { d, terminals });
    f.tick.ended(helloOf({ id: 'bbbbbbbbbbbb', lock, started: false }));
    await ticks(f, 1);
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock, 'the lost one, listed second, is held');
  });

  test('a held exit holds back no other: an exit the keeper sent, listed and ended after it, is settled at the same refresh (task 82)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    const lockS1 = `${T0}:0`;
    const lockS2 = `${T0 + 1_000_000n}:0`;
    d.deck.store.setKv(lockKey(S1), lockS1);
    d.deck.store.setKv(lockKey(S2), lockS2);
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    // The ended terminal's program pid is alive too: only the exit its keeper sent tells it is over.
    d.proc.setProcess(PID + 1, { stat: statLine(PID + 1, START), cmdline: ['claude'] });
    const terminals = [
      terminal({
        id: 'aaaaaaaaaaaa',
        state: 'lost',
        program: { pid: PID, procStart: START },
        exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
      }),
      terminal({
        id: 'bbbbbbbbbbbb',
        state: 'ended',
        expectedSessionId: S2,
        sessionId: S2,
        program: { pid: PID + 1, procStart: START },
        exit: { code: 1, signal: null, atNs: String(T0), notStarted: null },
      }),
    ];
    const f = fixture(t, { d, terminals });
    const s2 = helloOf({ id: 'bbbbbbbbbbbb', lock: lockS2, started: false });
    f.tick.ended(helloOf({ id: 'aaaaaaaaaaaa', lock: lockS1, started: false }));
    f.tick.ended({ ...s2, meta: { ...s2.meta, sessionId: S2 } });
    await ticks(f, 1);
    assert.equal(d.deck.store.getKv(lockKey(S2)), null, 'the sent exit is settled at once');
    assert.equal(d.deck.store.getKv(lockKey(S1)), lockS1, 'the lost one is held');
  });

  test('… the terminal as the registry listed it at ended(): closed since, its program still keeps the lock (task 82)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    const terminals = [
      terminal({
        id: 'aaaaaaaaaaaa',
        state: 'lost',
        program: { pid: PID, procStart: START },
        exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
      }),
    ];
    const f = fixture(t, { d, terminals });
    f.tick.ended(helloOf({ lock, started: false }));
    terminals.splice(0); // the user closed it (close-terminal) before the next refresh
    await ticks(f, 1);
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock);
    d.proc.setProcess(PID, null);
    await ticks(f, 2);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  });

  test('settleAll (the server’s stop) leaves a lost exit whose program may still run: its lock stays and expires by itself (task 82)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    d.proc.setProcess(PID, { stat: statLine(PID, START), cmdline: ['claude'] });
    const f = fixture(t, {
      d,
      terminals: [
        terminal({
          id: 'aaaaaaaaaaaa',
          state: 'lost',
          program: { pid: PID, procStart: START },
          exit: { code: null, signal: 1, atNs: String(T0), notStarted: null },
        }),
      ],
    });
    f.tick.ended(helloOf({ lock, started: false }));
    f.tick.settleAll();
    assert.equal(d.deck.store.getKv(lockKey(S1)), lock);
    assert.deepEqual(f.logs, []);
  });

  test('a hub whose list() throws at ended(): the exit is settled as before (no terminal known), nothing thrown (task 82)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    const lock = `${T0}:0`;
    d.deck.store.setKv(lockKey(S1), lock);
    const f = fixture(t, { d });
    const list = f.deps.hub.list;
    f.deps.hub.list = () => {
      throw new TypeError('not now');
    };
    f.tick.ended(helloOf({ lock, started: false }));
    f.deps.hub.list = list;
    await ticks(f, 1);
    assert.equal(d.deck.store.getKv(lockKey(S1)), null);
  });

  test('an ended terminal whose session runs again elsewhere is closed; a running one never', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    startRunning(d, S1, PID);
    startRunning(d, S2, PID + 1);
    const ended = terminal({
      id: 'eeeeeeeeeeee',
      state: 'ended',
      sessionId: S1,
      exit: { code: 0, signal: null, atNs: String(T0), notStarted: null },
    });
    const live = terminal({
      id: 'ffffffffffff',
      state: 'running',
      expectedSessionId: S2,
      sessionId: S2,
      program: { pid: 9999, procStart: 1 },
    });
    const f = fixture(t, { d, terminals: [ended, live] });
    await ticks(f, 1);
    assert.deepEqual(f.closed, ['eeeeeeeeeeee']);
  });
});

describe('a lost keeper’s program while it lives (task 57; S2 7.8)', () => {
  /** A keeper that died: its exit is made up at once (SIGHUP), its program may still run. */
  const lostExit = { code: null, signal: 1, atNs: String(T0), notStarted: null };
  /** `text` as one word of a `sh` script. */
  const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

  test('the lost terminal is not closed and its session is not elsewhere while its own program lives', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const lost = terminal({
      id: 'eeeeeeeeeeee',
      state: 'lost',
      sessionId: S1,
      program: { pid: PID, procStart: START },
      exit: lostExit,
    });
    const f = fixture(t, { d, terminals: [lost] });
    await ticks(f, 1);
    assert.deepEqual(f.closed, []);
    assert.deepEqual([...f.tick.elsewhere().keys()], []);
    assert.deepEqual(f.sessions.at(-1), { id: 'eeeeeeeeeeee', sessionId: S1, notReported: false });
  });

  test('once the program is gone it is an ended terminal as any other: kept with its exit, closed when the session runs elsewhere', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const lost = terminal({
      id: 'eeeeeeeeeeee',
      state: 'lost',
      sessionId: S1,
      program: { pid: PID, procStart: START },
      exit: lostExit,
    });
    const f = fixture(t, { d, terminals: [lost] });
    await ticks(f, 1);
    d.proc.setProcess(PID, null); // the program has run its end and is gone
    await ticks(f, 2);
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.terminals[0]?.exit, lostExit, 'its exit stays the lost one');
    assert.equal(
      f.tick.rows().find((row) => row.id === S1)?.state,
      'not-running',
      'the row no longer runs',
    );
    // Now the session runs again in a program outside the window.
    startRunning(d, S1, PID + 7);
    await ticks(f, 2);
    assert.deepEqual(f.closed, ['eeeeeeeeeeee']);
  });

  test('for 60 s after the loss only (ruled): kept at 59 s, closed as on main at 61 s, with the holder’s pid elsewhere', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const lost = terminal({
      id: 'eeeeeeeeeeee',
      state: 'lost',
      sessionId: S1,
      program: { pid: PID, procStart: START },
      exit: { ...lostExit, atNs: String(d.clock.nowNs()) },
    });
    const f = fixture(t, { d, terminals: [lost] });
    await ticks(f, 1);
    d.clock.setNs(T0 + 59n * SEC);
    await ticks(f, 2);
    assert.deepEqual(f.closed, [], 'kept at 59 s');
    d.clock.setNs(T0 + 61n * SEC);
    await ticks(f, 2);
    assert.deepEqual(f.closed, ['eeeeeeeeeeee'], 'closed at 61 s');
    assert.equal(f.tick.elsewhere().get(S1)?.pid, PID);
  });

  test('a clock that steps back after the loss keeps the lost terminal (it never closes early)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const lost = terminal({
      id: 'eeeeeeeeeeee',
      state: 'lost',
      sessionId: S1,
      program: { pid: PID, procStart: START },
      exit: { ...lostExit, atNs: String(d.clock.nowNs()) },
    });
    const f = fixture(t, { d, terminals: [lost] });
    await ticks(f, 1);
    d.clock.setNs(T0 - 3600n * SEC);
    await ticks(f, 2);
    assert.deepEqual(f.closed, []);
    assert.equal(f.tick.elsewhere().has(S1), false);
  });

  test('a lost terminal whose program lives is still closed when its session runs in another program or another terminal (as today)', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    startRunning(d, S1, PID); // outside every terminal
    startRunning(d, S2, PID + 1); // the program of the running terminal below
    // The lost terminals' programs live on and hold nothing.
    d.proc.setProcess(9000, { stat: statLine(9000, 1), cmdline: ['claude'] });
    d.proc.setProcess(9001, { stat: statLine(9001, 2), cmdline: ['claude'] });
    const lostS1 = terminal({
      id: 'eeeeeeeeeeee',
      state: 'lost',
      sessionId: S1,
      program: { pid: 9000, procStart: 1 },
      exit: lostExit,
    });
    const lostS2 = terminal({
      id: 'dddddddddddd',
      state: 'lost',
      expectedSessionId: S2,
      sessionId: S2,
      program: { pid: 9001, procStart: 2 },
      exit: lostExit,
    });
    const live = terminal({
      id: 'ffffffffffff',
      expectedSessionId: S2,
      program: { pid: PID + 1, procStart: START },
    });
    const f = fixture(t, { d, terminals: [lostS1, lostS2, live] });
    await ticks(f, 1);
    assert.deepEqual([...f.closed].sort(), ['dddddddddddd', 'eeeeeeeeeeee']);
  });

  test('end to end: the test’s own keeper killed while the program and its holder live on — the terminal stays lost, then its row ended unexpectedly', async (t) => {
    // The program is a `sh` that outlives the hangup of its pty until the test releases it, and so
    // does its child, the stand-in that holds the session: at a hangup only the session leader
    // gets SIGHUP; the kernel sends it to the child's process group when the leader ends.
    let release = '';
    let record = '';
    /** Kills this test's keeper while it runs; null once the case has killed it. */
    let killOwnKeeper: (() => void) | null = null;
    // Registered before windowDeck's cleanup, so it runs first (t.after: first in, first out):
    // also when the case failed half way, the keeper is gone, the `sh` released and the holder's
    // last hook written before the keepers' box waits for the program and the sandbox goes.
    t.after(async () => {
      if (release === '') return;
      writeFileSync(release, '');
      try {
        killOwnKeeper?.();
      } catch {
        // It no longer runs.
      }
      if (record !== '') {
        await waitForRecord(record, (entry) => entry.ev === 'exit', 10_000).catch(() => {});
      }
    });
    const w = await windowDeck(t, {
      claudeCommand: (s) => {
        const standin = standinCommand(s);
        s.link('sleep');
        release = join(s.root, 'release-57');
        const script = join(s.bin, 'claude-outlives-hangup');
        writeFileSync(
          script,
          [
            '#!/bin/sh',
            `release=${shellWord(release)}`,
            `root=${shellWord(s.root)}`,
            // 200 rounds (20 s and more), and not past the sandbox; the hook above releases it.
            'trap \'n=0; while [ ! -e "$release" ] && [ -d "$root" ] && [ "$n" -lt 200 ]; do sleep 0.1; n=$((n + 1)); done; exit 129\' HUP',
            'exec 3<&0',
            `${shellWord(standin)} "$@" <&3 3<&- &`,
            'wait "$!"',
            '',
          ].join('\n'),
        );
        chmodSync(script, 0o755);
        return script;
      },
    });
    w.resumable(S1);
    const r = w.registry();
    const made = w.deps(r);
    record = made.record;
    const outcome = await launchPrepared(
      w.deck,
      prepareResumeById(w.deck, S1),
      windowTerminal(made.deps, { cols: 80, rows: 24 }),
    );
    assert.equal(outcome.code, 0);
    const id = r.registry.list()[0]?.id ?? '';
    killOwnKeeper = () => {
      w.signalKeeper(w.keeperOf(id), 'SIGKILL');
    };
    await w.prompt(r, id, S1);
    const holder = readRecords(record).find((entry) => entry.ev === 'start')?.pid;
    const program = info(r.registry, id).program?.pid;
    assert.ok(holder !== undefined && program !== undefined && holder !== program);
    const holderStart = procStartOf(holder);
    assert.ok(holderStart !== null);

    const closed: string[] = [];
    const tick = createTick({
      deck: w.deck,
      hub: {
        list: () => r.registry.list(),
        setSession: (termId, sessionId, notReported) => {
          r.registry.setSession(termId, sessionId, notReported);
        },
        close: (termId) => {
          closed.push(termId);
          return r.registry.close(termId);
        },
      },
      pages: { pushList() {}, notice() {} },
      keepAlive: { tick: () => Promise.resolve() },
      interop: { refresh: () => Promise.resolve(null) },
      keepersLog: join(w.deck.places.stateDir, 'keepers.log'),
      log: () => {},
      storeNewer: () => {},
    });
    t.after(() => tick.stop());
    /** The next refresh (every second tick runs one). */
    const refreshNow = async (): Promise<void> => {
      await tick.run();
      await tick.run();
    };
    const rowOf = (): ListRow | undefined => tick.rows().find((row) => row.id === S1);
    // 'working', 'waiting' or 'running': a live holder holds the session.
    await tick.run();
    assert.equal(info(r.registry, id).sessionId, S1);
    assert.notEqual(rowOf()?.state ?? 'not-running', 'not-running');

    // Only the keeper this test started, by the pid of its own record.
    w.signalKeeper(w.keeperOf(id), 'SIGKILL');
    killOwnKeeper = null;
    await until(() => info(r.registry, id).state === 'lost', 'the terminal is lost', 15_000);
    await refreshNow();
    assert.deepEqual(
      readRecords(record).filter((entry) => entry.ev === 'hup' || entry.ev === 'exit'),
      [],
      'the holder still lives at this refresh',
    );
    assert.notEqual(rowOf()?.state ?? 'not-running', 'not-running', 'the holder still holds it');
    assert.deepEqual(closed, [], 'its own program is not "elsewhere"');
    assert.equal(tick.elsewhere().has(S1), false);
    assert.equal(info(r.registry, id).sessionId, S1);

    writeFileSync(release, '');
    await waitForRecord(record, (entry) => entry.ev === 'exit', 15_000);
    // The exit record comes a moment before the exit, and `ended-unexpectedly` needs the last
    // holder's process gone (derive: `!lastHolding.alive`), not only its end ingested.
    await until(() => !stillRuns(holder, holderStart), 'the holder is gone', 15_000);
    const deadline = performance.now() + 15_000;
    while ((rowOf()?.state ?? 'not-running') !== 'not-running') {
      assert.ok(performance.now() < deadline, 'the row no longer runs within 15 s');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await refreshNow();
    }
    assert.deepEqual(closed, []);
    const term = info(r.registry, id);
    assert.equal(term.state, 'lost');
    assert.deepEqual(
      [term.exit?.code, term.exit?.signal],
      [null, 1],
      'its exit stays the lost one',
    );
    assert.ok(rowOf()?.marks.includes('ended-unexpectedly'), 'the row ended unexpectedly');
  });
});

describe('a start is refused while a lost terminal’s program may still live (task 82, end to end)', () => {
  const SIZE = { cols: 100, rows: 30 };
  const PAGE: PageInfo = {
    windowId: '0123456789abcdef',
    focused: true,
    area: { cols: 120, rows: 40 },
  };
  /** `text` as one word of a `sh` script. */
  const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

  interface Lost {
    w: Awaited<ReturnType<typeof windowDeck>>;
    r: ReturnType<Awaited<ReturnType<typeof windowDeck>>['registry']>;
    tick: Tick;
    launches: ReturnType<typeof createLaunches>;
    terminalFor: (size: { cols: number; rows: number }) => ReturnType<typeof windowTerminal>;
    id: string;
    program: { pid: number; procStart: number };
    /** The lock the first launch took. */
    lock: string;
    /** The next refresh (every second tick runs one). */
    refreshNow(): Promise<void>;
    /** Lets the program end; then waits until it is gone. */
    release(): Promise<void>;
    /** What each way to start S1 answers now: the window's two (launches, act) and the command line's. */
    ways(): Promise<{ launches: string; act: string; command: string; handoff: boolean }>;
  }

  /**
   * Program B of task 72's C5: a claude that ignores the hangup and has reported no session start.
   * Started through the window, its keeper — this test's own, by the pid of its own record — killed;
   * returned once the registry lists the terminal `lost` and the tick was told of the exit, as the
   * server tells it inside the registry's exit event.
   */
  async function lostWithProgram(t: TestContext): Promise<Lost> {
    let releaseFile = '';
    let killOwnKeeper: (() => void) | null = null;
    let program: { pid: number; procStart: number } | null = null;
    // Registered before windowDeck's cleanup, so it runs first (t.after: first in, first out):
    // also when the case failed half way, the keeper is gone and the program released before the
    // keepers' box waits for the programs and the sandbox goes.
    t.after(async () => {
      if (releaseFile === '') return;
      writeFileSync(releaseFile, '');
      try {
        killOwnKeeper?.();
      } catch {
        // It no longer runs.
      }
      const seen = program;
      if (seen !== null) {
        await until(() => !stillRuns(seen.pid, seen.procStart), 'program B ended', 15_000).catch(
          () => {},
        );
      }
    });
    let ready = '';
    const w = await windowDeck(t, {
      claudeCommand: (s) => {
        s.link('sleep');
        releaseFile = join(s.root, 'release-82');
        ready = join(s.root, 'ready-82');
        const script = join(s.bin, 'claude-before-its-start');
        writeFileSync(
          script,
          [
            '#!/bin/sh',
            `release=${shellWord(releaseFile)}`,
            `root=${shellWord(s.root)}`,
            `ready=${shellWord(ready)}`,
            // It ignores the hangup and reports nothing; 900 rounds (90 s and more), not past the
            // sandbox; the hook above releases it. `ready` once the hangup is ignored.
            "trap '' HUP",
            ': > "$ready"',
            'n=0; while [ ! -e "$release" ] && [ -d "$root" ] && [ "$n" -lt 900 ]; do sleep 0.1; n=$((n + 1)); done',
            '',
          ].join('\n'),
        );
        chmodSync(script, 0o755);
        return script;
      },
    });
    w.resumable(S1);
    const r = w.registry();
    const made = w.deps(r);
    const terminalFor = (size: { cols: number; rows: number }): ReturnType<typeof windowTerminal> =>
      windowTerminal(made.deps, size);
    const first = await launchPrepared(w.deck, prepareResumeById(w.deck, S1), terminalFor(SIZE));
    assert.equal(first.code, 0, JSON.stringify(first));
    const id = r.registry.list()[0]?.id ?? '';
    const reported = info(r.registry, id).program;
    assert.ok(reported !== null);
    program = reported;
    killOwnKeeper = () => {
      w.signalKeeper(w.keeperOf(id), 'SIGKILL');
    };
    await until(() => existsSync(ready), 'program B ignores the hangup', 15_000);
    const lock = readLock(w.deck, S1);
    assert.ok(lock !== null, 'the launch took the lock');

    const tick = createTick({
      deck: w.deck,
      hub: {
        list: () => r.registry.list(),
        setSession: (termId, sessionId, notReported) => {
          r.registry.setSession(termId, sessionId, notReported);
        },
        close: (termId) => r.registry.close(termId),
      },
      pages: { pushList() {}, notice() {} },
      keepAlive: { tick: () => Promise.resolve() },
      interop: { refresh: () => Promise.resolve(null) },
      keepersLog: join(w.deck.places.stateDir, 'keepers.log'),
      log: () => {},
      storeNewer: () => {},
    });
    t.after(() => tick.stop());
    const refreshNow = async (): Promise<void> => {
      await tick.run();
      await tick.run();
    };
    await refreshNow();
    assert.equal(tick.rows().find((row) => row.id === S1)?.state, 'not-running', 'no start');

    // Only the keeper this test started, by the pid of its own record.
    w.signalKeeper(w.keeperOf(id), 'SIGKILL');
    killOwnKeeper = null;
    await until(
      () => r.events.exited.some((event) => event.term.id === id && event.lost),
      'the terminal is lost',
      15_000,
    );
    assert.equal(info(r.registry, id).state, 'lost');
    const hello = r.events.hello.filter((event) => event.hello.id === id).at(-1)?.hello;
    assert.ok(hello !== undefined);
    tick.ended(hello);

    const launches = createLaunches({ deck: w.deck, hub: r.registry, terminalFor, log: () => {} });
    const actions = createActions({
      deck: w.deck,
      hub: r.registry,
      terminalFor,
      openLink: async () => true,
      log: () => {},
      changed() {},
      prs: { fetch: () => undefined, refresh: () => undefined },
    });
    let acts = 0;
    const ways: Lost['ways'] = async () => {
      const launched = await launches.resume(S1, SIZE);
      const action: ActMessage = { t: 'act', id: ++acts, kind: 'resume', sessionId: S1, ...SIZE };
      const result = await actions.act(PAGE, action);
      const handoff = join(w.s.root, `handoff-82-${acts}`);
      const platform = {
        ...w.tp.platform,
        env: { ...w.tp.platform.env, SKYDECK_HANDOFF: handoff },
      };
      const c = testContextOn({ platform });
      const code = await main(['resume', S1, '--here'], c.ctx);
      return {
        launches: `${launched.code}: ${launched.lines.join(' | ')}`,
        act: `${result.ok}: ${result.lines.join(' | ')}`,
        command: `${code}: ${c.stderr().trim()}`,
        handoff: existsSync(handoff),
      };
    };
    const release = async (): Promise<void> => {
      writeFileSync(releaseFile, '');
      await until(() => !stillRuns(reported.pid, reported.procStart), 'program B is gone', 15_000);
    };
    return {
      w,
      r,
      tick,
      launches,
      terminalFor,
      id,
      program: reported,
      lock,
      refreshNow,
      release,
      ways,
    };
  }

  test('refused by every way before the first refresh after the loss and after it; once the program is gone the lock is given back and the next start works', async (t) => {
    const l = await lostWithProgram(t);
    const running = `${S1.slice(0, 8)} is running (pid ${l.program.pid})`;
    const spawned = l.r.spawned.length;
    for (const moment of ['before the first refresh', 'after it']) {
      assert.ok(stillRuns(l.program.pid, l.program.procStart), `${moment}: program B lives`);
      const said = await l.ways();
      assert.equal(said.launches, `4: ${running}`, moment);
      assert.equal(said.act, `false: ${running}`, moment);
      assert.match(
        said.command,
        /^4: skydeck: 0b5f3c1e is being resumed \(\d+ s ago\); try again in \d+ s$/,
        moment,
      );
      assert.equal(said.handoff, false, `${moment}: the command line hands nothing off`);
      assert.equal(l.launches.refusal(S1), running, `${moment}: restore's refuse`);
      assert.equal(readLock(l.w.deck, S1), l.lock, `${moment}: the lock is kept`);
      assert.equal(l.r.spawned.length, spawned, `${moment}: no second keeper`);
      await l.refreshNow();
    }
    await l.release();
    await l.refreshNow();
    assert.equal(readLock(l.w.deck, S1), null, 'the settlement gave the lock back');
    assert.equal(l.launches.refusal(S1), null);
    const again = await l.launches.resume(S1, SIZE);
    assert.equal(again.code, 0, JSON.stringify(again));
    assert.equal(l.r.spawned.length, spawned + 1, 'one new keeper');
    assert.ok(
      !l.r.registry.list().some((term) => term.id === l.id),
      'the lost terminal was closed',
    );
  });

  test('after the lock’s expiry, while the loss is less than 60 s old: the window still refuses; the command line is open (the named limit)', async (t) => {
    const l = await lostWithProgram(t);
    const running = `${S1.slice(0, 8)} is running (pid ${l.program.pid})`;
    await l.refreshNow();
    // The lock as the store holds it once the launch is older than the lock's 60 s (as when the
    // keeper is lost a minute after the launch): stale, its event id kept.
    const nowMs = l.w.deck.platform.clock.nowNs() / 1_000_000n;
    const stale = `${(nowMs - 61_000n) * 1_000_000n}${l.lock.slice(l.lock.indexOf(':'))}`;
    l.w.deck.store.setKv(lockKey(S1), stale);
    await l.refreshNow();
    assert.ok(stillRuns(l.program.pid, l.program.procStart), 'program B lives');
    const said = await l.ways();
    assert.equal(said.launches, `4: ${running}`);
    assert.equal(said.act, `false: ${running}`);
    assert.equal(l.launches.refusal(S1), running, "restore's refuse");
    // The guard sees no holder and the lock no longer holds: the command line would start a second
    // program (S2 7.8's named limit; the handoff is only written, nothing runs it here).
    assert.match(said.command, /^0: /);
    assert.equal(said.handoff, true);
  });

  test('the named limit (ruled): closing the lost terminal ends the window’s refusal — with the lock stale, the next Resume starts a second program', async (t) => {
    // S2 7.8: the window refuses only while it lists the lost terminal; after a Close (or a
    // restart of the server) the lock alone refuses, until 60 s after the launch.
    const l = await lostWithProgram(t);
    const running = `${S1.slice(0, 8)} is running (pid ${l.program.pid})`;
    await l.refreshNow();
    const nowMs = l.w.deck.platform.clock.nowNs() / 1_000_000n;
    const stale = `${(nowMs - 61_000n) * 1_000_000n}${l.lock.slice(l.lock.indexOf(':'))}`;
    l.w.deck.store.setKv(lockKey(S1), stale);
    const spawned = l.r.spawned.length;
    assert.deepEqual((await l.launches.resume(S1, SIZE)).lines, [running]);
    assert.equal(l.r.registry.close(l.id), 'ok', 'the bar’s Close (close-terminal)');
    assert.ok(stillRuns(l.program.pid, l.program.procStart), 'program B lives');
    assert.equal(l.launches.refusal(S1), null);
    const again = await l.launches.resume(S1, SIZE);
    assert.equal(again.code, 0, JSON.stringify(again));
    assert.equal(l.r.spawned.length, spawned + 1, 'a second keeper beside program B');
  });
});

describe('the mapping (S2 7.5, 7.9; plan task 21)', () => {
  test('each terminal gets the session it shows; a holder outside every terminal is elsewhere', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    startRunning(d, S1, PID);
    startRunning(d, S2, PID + 1);
    // S2's holder is the terminal's program itself.
    const term = terminal({
      id: 'aaaaaaaaaaaa',
      expectedSessionId: S2,
      program: { pid: PID + 1, procStart: START },
    });
    const f = fixture(t, { d, terminals: [term] });
    await ticks(f, 1);
    assert.deepEqual(f.sessions.at(-1), { id: 'aaaaaaaaaaaa', sessionId: S2, notReported: false });
    assert.deepEqual([...f.tick.elsewhere().keys()], [S1]);
    assert.equal(f.tick.elsewhere().get(S1)?.pid, PID);
  });

  test('a session whose holder cannot be judged keeps its previous answer, and no terminal is closed on it', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    startRunning(d, S1, PID);
    const ended = terminal({
      id: 'eeeeeeeeeeee',
      state: 'ended',
      expectedSessionId: S1,
      sessionId: S1,
      exit: { code: 0, signal: null, atNs: String(T0), notStarted: null },
    });
    const other = terminal({ id: 'bbbbbbbbbbbb', program: { pid: 9999, procStart: 1 } });
    const f = fixture(t, { d, terminals: [other] });
    await ticks(f, 1);
    assert.deepEqual([...f.tick.elsewhere().keys()], [S1]);
    // The holder's parent can no longer be read: unknown (design 5.5).
    d.proc.setProcess(PID, {
      stat: statLine(PID, START).replace(') S 1 ', ') S x '),
      cmdline: ['claude'],
    });
    f.terminals.push(ended);
    await ticks(f, 2);
    assert.deepEqual([...f.tick.elsewhere().keys()], [S1], 'the previous answer is kept');
    assert.deepEqual(f.closed, [], 'nothing is closed on an unknown');
  });
});

describe('a terminal whose own session cannot be judged (review 2)', () => {
  test("keeps that session, also when another session's holder in it can be judged", async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    startRunning(d, S1, PID);
    startRunning(d, S2, PID + 1);
    // The terminal's program 9000; S1's holder is its child, S2's holder a grandchild through 9100.
    d.proc.setProcess(9000, { stat: statLine(9000, 1), cmdline: ['claude'] });
    d.proc.setProcess(9100, {
      stat: statLine(9100, 2).replace(') S 1 ', ') S 9000 '),
      cmdline: ['sh'],
    });
    const child = (pid: number, parent: number): string =>
      statLine(pid, START).replace(') S 1 ', `) S ${parent} `);
    d.proc.setProcess(PID, { stat: child(PID, 9000), cmdline: ['claude'] });
    d.proc.setProcess(PID + 1, { stat: child(PID + 1, 9100), cmdline: ['claude'] });
    const term = terminal({ id: 'aaaaaaaaaaaa', program: { pid: 9000, procStart: 1 } });
    const f = fixture(t, { d, terminals: [term] });
    await ticks(f, 1);
    assert.equal(f.terminals[0]?.sessionId, S1, 'the nearer holder decides');
    // S1's holder can no longer be judged (its parent cannot be read): S2's would win this pass.
    d.proc.setProcess(PID, {
      stat: statLine(PID, START).replace(') S 1 ', ') S x '),
      cmdline: ['claude'],
    });
    await ticks(f, 2);
    assert.equal(f.terminals[0]?.sessionId, S1, 'the previous answer is kept');
  });
});

describe('pull requests (design 7.3)', () => {
  test('the automatic refresh asks about the pull requests of the sessions the pages list', async (t) => {
    const d = testDeck(t);
    writeTranscript(d, S1);
    writeTranscript(d, S2);
    attachManualPr(d.deck, S1, 'https://github.com/o/r/pull/1');
    attachManualPr(d.deck, S2, 'https://github.com/o/r/pull/2');
    const f = fixture(t, { d });
    await ticks(f, 2);
    assert.equal(d.runner.calls.length, 0, 'no page lists anything: nothing is asked');
    f.tick.listed([S1]);
    await ticks(f, 2);
    await f.tick.stop(); // waits for the fetch
    const gh = d.runner.calls.filter((call) => call.command === 'gh');
    assert.equal(gh.length, 1);
    assert.deepEqual(
      gh[0]?.args.filter((arg) => arg.startsWith('n0=') || arg.startsWith('n1=')),
      ['n0=1'],
      'only the pull request of the listed session',
    );
  });
});
