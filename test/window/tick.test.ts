// The server's tick (S2 10.1; plan task 23, A7, A24): what runs every second, every second tick,
// every 30 seconds and once a minute, step 1's reload rule of the interactive list, the failed
// tick shown once, the migrated store, the settling of ended terminals, the mapping of terminals to
// sessions and the automatic pull-request refresh. On testPlatform's fake clock and /proc, with
// fakes for the registry, the pages, the keep-alive and the interop link.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { attachManualPr } from '../../src/sessions/meta.ts';
import { lockKey } from '../../src/sessions/resume.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { openStore } from '../../src/store/store.ts';
import type { KeeperHello } from '../../src/window/frames.ts';
import type { TerminalInfo } from '../../src/window/hub.ts';
import type { NoticeMessage } from '../../src/window/protocol.ts';
import { createTick } from '../../src/window/tick.ts';
import type { Tick, TickDeps } from '../../src/window/tick.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { S1, S2, SEC, T0, statLine } from '../helpers/platform.ts';
import { startRunning, writeTranscript } from '../helpers/session-files.ts';
import { hookInput, spoolName, spoolText } from '../helpers/spool.ts';

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
