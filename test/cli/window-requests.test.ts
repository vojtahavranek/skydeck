// The command line's requests to the window's server (plan C 2.4, 2.5; task 76): `windowTimes`'
// answer time (C17), `windowServer` (C11), `requestResume` / `requestNew`, and `restoreInWindow`
// (C14's request) with the window a command opens (C12). The server is the fake serve of
// test/fixtures/fake-serve; the platform is realTestPlatform (windowMachine).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { windowTimes } from '../../src/cli/window-open.ts';
import type { WindowTimes } from '../../src/cli/window-open.ts';
import {
  requestNew,
  requestResume,
  restoreInWindow,
  windowServer,
} from '../../src/cli/window-requests.ts';
import { SkydeckError } from '../../src/platform/errors.ts';
import type { Net } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import type {
  LaunchAnswer,
  NewRequest,
  RestoreOutcomeLine,
  RestoreStreamLine,
} from '../../src/window/protocol.ts';
import { capture } from '../helpers/capture.ts';
import { deckWith } from '../helpers/deck.ts';
import { until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { writeWindowConfig } from '../helpers/window-config.ts';
import { liveProcess, startFakeServe, windowMachine } from '../helpers/window-machine.ts';
import type { WindowMachine } from '../helpers/window-machine.ts';

/** The waits of these cases: long, so that no load runs them out where a case expects none. */
const TIMES: WindowTimes = {
  pingMs: 5000,
  pageMs: 300,
  reuseMs: 100,
  launchingMs: 45_000,
  reconnectMs: 7000,
  answerMs: 20_000,
};
/** The cases that wait for a wait to run out: a ping wait of 1 s, an answer time of 2 s. */
const SHORT: WindowTimes = { ...TIMES, pingMs: 1000, answerMs: 2000 };
const ANSWER: LaunchAnswer = { code: 0, lines: ['skydeck: started'], sessionId: S1 };
const NEW: NewRequest = { dir: '/home/dev/projects/api', label: null, group: null, flags: [] };

const NOT_RUNNING = 'the window is not running; run skydeck window first';
const OLDER =
  "the window's server is older than this command and cannot start sessions for it; run skydeck window to restart it";

/** `promise` rejects with a SkydeckError (exit 1) whose message is `message`. */
async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SkydeckError, String(error));
    assert.equal(error.message, message);
    assert.equal(error.exitCode, 1);
    return true;
  });
}

/** Both forms of a line: with `tail` for a command with --here, without it for restore and R. */
async function bothForms(
  ask: (here: boolean) => Promise<unknown>,
  line: string,
  tail: string,
): Promise<void> {
  await rejectsWith(ask(true), `${line}${tail}`);
  await rejectsWith(ask(false), line);
}

describe('windowTimes: answerMs (plan C17)', () => {
  test('30 s by default; SKYDECK_TEST_WINDOW_TIMES sets it only in a test sandbox', () => {
    assert.equal(windowTimes({}).answerMs, 30_000);
    assert.equal(
      windowTimes({ SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_WINDOW_TIMES: 'answerMs=300' })
        .answerMs,
      300,
    );
    assert.equal(windowTimes({ SKYDECK_TEST_WINDOW_TIMES: 'answerMs=300' }).answerMs, 30_000);
    assert.deepEqual(
      windowTimes({ SKYDECK_TEST_NO_WINDOWS: '1', SKYDECK_TEST_WINDOW_TIMES: 'pageMs=5' }),
      { pageMs: 5, reuseMs: 2000, launchingMs: 45_000, reconnectMs: 7000, answerMs: 30_000 },
    );
  });
});

describe('windowServer: the server a command sends to (plan C11, 2.5)', () => {
  test('no server: the not-running line, ", or use --here" only for a command with --here', async (t) => {
    const m = windowMachine(t);
    await bothForms((here) => windowServer(m.deck, TIMES, here), NOT_RUNNING, ', or use --here');
  });

  test('a server that does not answer: S2 5.1’s line, the same for both', async (t) => {
    const m = windowMachine(t);
    const fake = await startFakeServe(t, m, { FAKE_SERVE_MODE: 'silent' });
    const line = `the window's server (pid ${fake.pid}) does not answer; skydeck window --restart stops it`;
    await rejectsWith(windowServer(m.deck, SHORT, true), line);
    await rejectsWith(windowServer(m.deck, SHORT, false), line);
  });

  test('a server starting past the ping wait: S2 5.1’s line with the ping wait’s seconds', async (t) => {
    const m = windowMachine(t);
    const holder = await liveProcess(t, m);
    const { pid, procStart, bootId } = holder.line;
    m.deck.store.setKv('window_server', `${pid}:${procStart}:${bootId}:${m.platform.appRoot}`);
    const line = `the window's server (pid ${pid}) is starting and did not finish within 1 s; run skydeck window again, or skydeck window --restart to replace it`;
    await rejectsWith(windowServer(m.deck, SHORT, true), line);
    await rejectsWith(windowServer(m.deck, SHORT, false), line);
  });

  test('a server of another checkout: its line, the checkout sanitised', async (t) => {
    const m = windowMachine(t);
    await startFakeServe(t, m, { FAKE_SERVE_CHECKOUT: '/elsewhere/\u001b[31mskydeck' });
    await bothForms(
      (here) => windowServer(m.deck, TIMES, here),
      "the window's server runs from /elsewhere/skydeck, not from this checkout; skydeck window --restart here replaces it",
      ', or use --here',
    );
  });

  test('a server of this checkout is used whatever its build; its client has the clock; here as asked', async (t) => {
    const m = windowMachine(t);
    for (const build of [undefined, 'ffffffffffffffff']) {
      const fake = await startFakeServe(t, m, {
        FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
        ...(build === undefined ? {} : { FAKE_SERVE_BUILD: build }),
      });
      for (const here of [true, false]) {
        const server = await windowServer(m.deck, TIMES, here);
        assert.equal(server.ping.pid, fake.pid, String(build));
        assert.equal(server.here, here);
        assert.deepEqual(await server.client.resume(S1), ANSWER, 'a client with a clock');
      }
      fake.child.kill('SIGKILL');
      await fake.exited;
    }
  });
});

/** The server of `m` with the fake serve's `env`, for a command with --here or without. */
async function serverOf(
  t: TestContext,
  env: Record<string, string>,
): Promise<{ m: WindowMachine; ask: (here: boolean) => ReturnType<typeof windowServer> }> {
  const m = windowMachine(t);
  await startFakeServe(t, m, env);
  return { m, ask: (here) => windowServer(m.deck, TIMES, here) };
}

describe('requestResume and requestNew (plan C11, 2.5)', () => {
  test('a socket that fails after the request reached the server: the may-have-started line, the same for both (ruled, task 76)', async (t) => {
    for (const here of [true, false]) {
      const m = windowMachine(t);
      const file = join(m.s.root, 'requests.jsonl');
      const fake = await startFakeServe(t, m, {
        FAKE_SERVE_REQUESTS: file,
        FAKE_SERVE_LAUNCH: 'silent',
      });
      const server = await windowServer(m.deck, TIMES, here);
      const asked = requestResume(server, S1, TIMES);
      await until(() => existsSync(file) && readFileSync(file, 'utf8') !== '', 'sent', 10_000);
      fake.child.kill('SIGKILL');
      await assert.rejects(asked, (error: unknown) => {
        assert.ok(error instanceof SkydeckError, String(error));
        assert.match(
          error.message,
          /^the window's server cannot be asked on \S+ \(E[A-Z]+\); it may have started the session: run skydeck to see whether it runs$/,
          String(here),
        );
        return true;
      });
    }
  });

  test('the answer as it came, whatever its code; the request as sent', async (t) => {
    const s = await serverOf(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify({ ...ANSWER, code: 4 })}`,
    });
    const server = await s.ask(true);
    assert.deepEqual(await requestResume(server, S1, TIMES), { ...ANSWER, code: 4 });
    assert.deepEqual(await requestNew(server, NEW, TIMES), { ...ANSWER, code: 4 });
  });

  test('a server before stage C: C11’s older-server line', async (t) => {
    const s = await serverOf(t, {});
    await bothForms(
      async (here) => requestResume(await s.ask(here), S1, TIMES),
      OLDER,
      ', or use --here',
    );
    await bothForms(
      async (here) => requestNew(await s.ask(here), NEW, TIMES),
      OLDER,
      ', or use --here',
    );
  });

  test('stopping, a refused body and a start that does not end: "--here" only for a command with --here (ruled, task 76)', async (t) => {
    const stopping = await serverOf(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
      FAKE_SERVE_STATE: 'stopping',
    });
    await bothForms(
      async (here) => requestResume(await stopping.ask(here), S1, TIMES),
      "the window's server is stopping; run skydeck window",
      ', or use --here',
    );

    const refused = await serverOf(t, { FAKE_SERVE_LAUNCH: 'status:413' });
    await bothForms(
      async (here) => requestNew(await refused.ask(here), NEW, TIMES),
      "the window's server refused the request (body: too long)",
      '; use --here',
    );

    const starting = await serverOf(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
      FAKE_SERVE_STATE: 'starting',
    });
    await bothForms(
      async (here) => requestResume(await starting.ask(here), S1, { ...TIMES, answerMs: 600 }),
      "the window's server did not finish its start within 0.6 s; it started nothing: run skydeck window again",
      ', or use --here',
    );
  });

  test('no answer within times.answerMs: the no-answer line, the same for both', async (t) => {
    const s = await serverOf(t, { FAKE_SERVE_LAUNCH: 'silent' });
    const line =
      "the window's server did not answer within 0.3 s; it may have started the session: run skydeck to see whether it runs";
    for (const here of [true, false]) {
      await rejectsWith(requestResume(await s.ask(here), S1, { ...TIMES, answerMs: 300 }), line);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// restoreInWindow (plan C14's request, C12's window before it; ruled, task 76: the deck second)

const OUTCOME: RestoreOutcomeLine = { code: 0, started: 2, timedOut: 0, failed: 0, notStarted: 0 };
const STREAM: RestoreStreamLine[] = [
  { line: 'started 0b5f3c1e one' },
  { line: 'started 1c6a4d2f two' },
  { line: 'restore finished: 2 started' },
  { outcome: OUTCOME },
];
const NO_PAGE_CONNECTED =
  'skydeck: the window could not be opened: Edge was started, but no window connected within 0.3 seconds; open the window in any browser with skydeck window --print-url; run skydeck window\n';

interface RestoreBench {
  m: WindowMachine;
  /** The deck the function is given: the machine's, with `env` and a net that records. */
  deck: Deck;
  /** `METHOD path` of every control request, in order. */
  asked: string[];
  edgeCalls(): string[][];
  requests(): unknown[];
  /** restoreInWindow for `sessionIds` (all false) with a captured context. */
  restore(
    sessionIds?: string[],
    times?: WindowTimes,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

async function restoreBench(
  t: TestContext,
  env: Record<string, string>,
  options: {
    platformEnv?: Record<string, string>;
    window?: Record<string, unknown>;
    /** Changes the deck the function is given. */
    deck?: (deck: Deck) => Deck;
  } = {},
): Promise<RestoreBench> {
  const m = windowMachine(t);
  const stub = writeWindowConfig(m.s, options.window ?? {});
  const file = join(m.s.root, 'requests.jsonl');
  await startFakeServe(t, m, { FAKE_SERVE_REQUESTS: file, ...env });
  const asked: string[] = [];
  const net: Net = {
    ...m.platform.net,
    requestUnix(path, request) {
      asked.push(`${request.method} ${request.path}`);
      return m.platform.net.requestUnix(path, request);
    },
  };
  const platform = { ...m.platform, net, env: { ...m.platform.env, ...options.platformEnv } };
  // Opened after config.json names the Edge stub (the machine's own deck read it before).
  const opened = openDeck(platform);
  t.after(() => {
    opened.store.close();
  });
  const deck = options.deck?.(opened) ?? opened;
  return {
    m,
    deck,
    asked,
    edgeCalls: () => stub.edgeCalls(),
    requests: () =>
      existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    async restore(sessionIds = [S1, S2], times = TIMES) {
      const captured = capture();
      const server = await windowServer(deck, times, false);
      const code = await restoreInWindow(
        { io: captured.io, platform },
        deck,
        server,
        { sessionIds, all: false },
        times,
      );
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    },
  };
}

describe('restoreInWindow (plan C12, C14)', () => {
  test('no page connected: the window is tried BEFORE the request (C12’s line), then every line on stdout as it arrives, the outcome’s code', async (t) => {
    const b = await restoreBench(t, { FAKE_SERVE_RESTORE: JSON.stringify(STREAM) });

    const r = await b.restore();

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, NO_PAGE_CONNECTED);
    assert.equal(
      r.stdout,
      'started 0b5f3c1e one\nstarted 1c6a4d2f two\nrestore finished: 2 started\n',
    );
    await until(() => b.edgeCalls().length === 1, 'the Edge stub ran', 10_000);
    const dropped = b.asked.indexOf('POST /token/drop');
    const restored = b.asked.indexOf('POST /restore');
    assert.ok(dropped >= 0 && restored > dropped, `the window first: ${JSON.stringify(b.asked)}`);
    assert.deepEqual(b.requests(), [{ route: 'restore', sessionIds: [S1, S2], all: false }]);
  });

  test('Edge missing: C12’s line, and the restore goes on with its request', async (t) => {
    const b = await restoreBench(
      t,
      { FAKE_SERVE_RESTORE: JSON.stringify(STREAM) },
      { window: { edge: '/nowhere/msedge' } },
    );

    const r = await b.restore();

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.startsWith('skydeck: the window could not be opened: '), r.stderr);
    assert.ok(r.stderr.endsWith('; run skydeck window\n'), r.stderr);
    assert.ok(r.stdout.endsWith('restore finished: 2 started\n'), r.stdout);
    assert.equal(b.requests().length, 1);
  });

  test('the store fails while the window’s lock is taken: C12’s line with the failure, and the restore still sends its request (review 2)', async (t) => {
    const locked = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    const b = await restoreBench(
      t,
      { FAKE_SERVE_RESTORE: JSON.stringify(STREAM) },
      {
        deck: (deck) =>
          deckWith(deck, {
            store: {
              transaction: () => {
                throw locked;
              },
            },
          }),
      },
    );

    const r = await b.restore();

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      `skydeck: the window could not be opened: the database ${b.deck.store.path} failed: database is locked; run skydeck window\n`,
    );
    assert.ok(r.stdout.endsWith('restore finished: 2 started\n'), r.stdout);
    assert.equal(b.requests().length, 1);
    assert.deepEqual(b.edgeCalls(), []);
  });

  test('under CLAUDECODE: no window, C12’s line, the request sent', async (t) => {
    const b = await restoreBench(
      t,
      { FAKE_SERVE_RESTORE: JSON.stringify(STREAM) },
      { platformEnv: { CLAUDECODE: '1' } },
    );

    const r = await b.restore([S1]);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      'skydeck: no window is open; run skydeck window in a terminal of your own\n',
    );
    assert.ok(!b.asked.includes('POST /token'), JSON.stringify(b.asked));
    assert.deepEqual(b.edgeCalls(), []);
    assert.deepEqual(b.requests(), [{ route: 'restore', sessionIds: [S1], all: false }]);
  });

  test('a page connected: no window; the lines sanitised; the outcome’s code 1', async (t) => {
    const b = await restoreBench(t, {
      FAKE_SERVE_PAGES: '1',
      FAKE_SERVE_RESTORE: JSON.stringify([
        { line: 'failed \u001b[31m0b5f3c1e\u001b[0m:\rbad' },
        { outcome: { ...OUTCOME, code: 1, started: 0, failed: 1 } },
      ]),
    });

    const r = await b.restore();

    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, 'failed 0b5f3c1e: bad\n');
    assert.equal(r.stderr, '');
    assert.ok(!b.asked.includes('POST /token'), JSON.stringify(b.asked));
  });

  test('an outcome with code 5: C14’s line on stderr, exit 5', async (t) => {
    const b = await restoreBench(t, {
      FAKE_SERVE_PAGES: '1',
      FAKE_SERVE_RESTORE: JSON.stringify([
        { line: 'stopped: the window\u2019s server is stopping' },
        { outcome: { ...OUTCOME, code: 5, started: 0, notStarted: 2 } },
      ]),
    });

    const r = await b.restore();

    assert.equal(r.code, 5);
    assert.equal(r.stderr, 'skydeck: restore stopped before it finished; see above\n');
  });

  test('a server before stage C, one that stopped answering: their lines, without ", or use --here"', async (t) => {
    const older = await restoreBench(t, { FAKE_SERVE_PAGES: '1' });
    await rejectsWith(older.restore(), OLDER);

    const silent = await restoreBench(t, {
      FAKE_SERVE_PAGES: '1',
      FAKE_SERVE_RESTORE: 'silent-after:1',
    });
    await rejectsWith(
      silent.restore(undefined, SHORT),
      "the window's server stopped answering; run skydeck to see what started",
    );
  });

  test('a server that is stopping: its line without ", or use --here"', async (t) => {
    const b = await restoreBench(t, {
      FAKE_SERVE_PAGES: '1',
      FAKE_SERVE_RESTORE: JSON.stringify(STREAM),
      FAKE_SERVE_STATE: 'stopping',
    });
    await rejectsWith(b.restore(), "the window's server is stopping; run skydeck window");
  });
});
