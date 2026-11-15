// The command line's requests to the window's server (plan C 2.4, 2.5; task 76): `windowTimes`'
// answer time (C17), `windowServer` (C11), `requestResume` / `requestNew`, and `restoreInWindow`
// (C14's request) with the window a command opens (C12). The server is the fake serve of
// test/fixtures/fake-serve; the platform is realTestPlatform (windowMachine).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { windowTimes } from '../../src/cli/window-open.ts';
import type { WindowTimes } from '../../src/cli/window-open.ts';
import { requestNew, requestResume, windowServer } from '../../src/cli/window-requests.ts';
import { SkydeckError } from '../../src/platform/errors.ts';
import type { LaunchAnswer, NewRequest } from '../../src/window/protocol.ts';
import { S1 } from '../helpers/platform.ts';
import { liveProcess, startFakeServe, windowMachine } from '../helpers/window-machine.ts';
import type { WindowMachine } from '../helpers/window-machine.ts';

/** The waits of these cases: a ping wait of 1 s, an answer time of 2 s. */
const TIMES: WindowTimes = {
  pingMs: 1000,
  pageMs: 300,
  reuseMs: 100,
  launchingMs: 45_000,
  reconnectMs: 7000,
  answerMs: 2000,
};
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
    await rejectsWith(windowServer(m.deck, TIMES, true), line);
    await rejectsWith(windowServer(m.deck, TIMES, false), line);
  });

  test('a server starting past the ping wait: S2 5.1’s line with the ping wait’s seconds', async (t) => {
    const m = windowMachine(t);
    const holder = await liveProcess(t, m);
    const { pid, procStart, bootId } = holder.line;
    m.deck.store.setKv('window_server', `${pid}:${procStart}:${bootId}:${m.platform.appRoot}`);
    const line = `the window's server (pid ${pid}) is starting and did not finish within 1 s; run skydeck window again, or skydeck window --restart to replace it`;
    await rejectsWith(windowServer(m.deck, TIMES, true), line);
    await rejectsWith(windowServer(m.deck, TIMES, false), line);
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
