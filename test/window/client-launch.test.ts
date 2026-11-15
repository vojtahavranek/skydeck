// The command line's client for stage C's routes (plan C 2.4, C2–C5, C11; task 76): `resume`,
// `newSession` and `restore` of controlClient against the fake serve of test/fixtures/fake-serve,
// which answers them with the server's own handler and parser (FAKE_SERVE_LAUNCH, _RESTORE,
// _STATE; FAKE_SERVE_REQUESTS records what reached `launch`). The platform is realTestPlatform.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { Net } from '../../src/platform/types.ts';
import { controlClient } from '../../src/window/client.ts';
import type { ControlClient } from '../../src/window/client.ts';
import type { LaunchAnswer, NewRequest, RestoreOutcomeLine } from '../../src/window/protocol.ts';
import { until } from '../helpers/keeper.ts';
import { S1, S2 } from '../helpers/platform.ts';
import { startFakeServe, windowMachine } from '../helpers/window-machine.ts';
import type { WindowMachine } from '../helpers/window-machine.ts';

const ANSWER: LaunchAnswer = {
  code: 0,
  lines: ['skydeck: original flags unknown; resuming with defaults'],
  sessionId: S1,
};
const NEW: NewRequest = { dir: '/home/dev/projects/api', label: 'x', group: null, flags: ['-p'] };
const OUTCOME: RestoreOutcomeLine = { code: 1, started: 2, timedOut: 0, failed: 1, notStarted: 0 };

const NO_ANSWER = (s: string): string =>
  `the window's server did not answer within ${s} s; it may have started the session: run skydeck to see whether it runs`;
const STOPPED_ANSWERING = "the window's server stopped answering; run skydeck to see what started";
const STOPPING = "the window's server is stopping; run skydeck window, or use --here";

interface Sent {
  path: string;
  body: unknown;
  atMs: number;
}

interface Bench {
  m: WindowMachine;
  /** What reached the fake serve's `launch`, in order (FAKE_SERVE_REQUESTS). */
  requests(): unknown[];
  /** Every request this client sent over the socket. */
  sent: Sent[];
  client: ControlClient;
  /** The fake serve. */
  fake: Awaited<ReturnType<typeof startFakeServe>>;
}

/** A machine, the fake serve with `env` (and FAKE_SERVE_REQUESTS), and a client with the clock. */
async function bench(
  t: Parameters<typeof windowMachine>[0],
  env: Record<string, string>,
): Promise<Bench> {
  const m = windowMachine(t);
  const file = join(m.s.root, 'requests.jsonl');
  const fake = await startFakeServe(t, m, { FAKE_SERVE_REQUESTS: file, ...env });
  const sent: Sent[] = [];
  const net: Net = {
    ...m.platform.net,
    requestUnix(path, request) {
      sent.push({ path: request.path, body: request.body, atMs: performance.now() });
      return m.platform.net.requestUnix(path, request);
    },
  };
  return {
    m,
    fake,
    sent,
    requests: () =>
      existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as unknown)
        : [],
    client: controlClient(net, m.runtime().serverSock, m.platform.clock),
  };
}

/** `promise` rejects with a SkydeckError whose message is `message`. */
async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SkydeckError, String(error));
    assert.equal(error.message, message);
    return true;
  });
}

describe('controlClient: POST /resume and POST /new (plan C2, C4, C11)', () => {
  test('each request as plan C 2.2 says; the answer as it came', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });

    assert.deepEqual(await b.client.resume(S1), ANSWER);
    assert.deepEqual(await b.client.newSession(NEW), ANSWER);
    assert.deepEqual(
      await b.client.newSession({ dir: '/d', label: null, group: 'g', flags: [] }),
      ANSWER,
    );

    assert.deepEqual(b.requests(), [
      { route: 'resume', sessionId: S1 },
      { route: 'new', ...NEW },
      { route: 'new', dir: '/d', label: null, group: 'g', flags: [] },
    ]);
  });

  test('503 starting twice, then the answer: asked again 500 ms later each time', async (t) => {
    const b = await bench(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
      FAKE_SERVE_STATE: 'starting:2',
    });

    assert.deepEqual(await b.client.resume(S1, 10_000), ANSWER);

    const asked = b.sent.filter((s) => s.path === '/resume');
    assert.equal(asked.length, 3);
    for (let i = 1; i < asked.length; i++) {
      const gap = (asked[i]?.atMs ?? 0) - (asked[i - 1]?.atMs ?? 0);
      assert.ok(gap >= 490, `asked again after 500 ms (${gap} ms)`);
    }
    assert.deepEqual(b.requests(), [{ route: 'resume', sessionId: S1 }], 'started once');
  });

  test('503 starting for the whole answer time: the start line, never "it may have started the session"', async (t) => {
    const b = await bench(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
      FAKE_SERVE_STATE: 'starting',
    });

    const started = performance.now();
    await rejectsWith(
      b.client.newSession(NEW, 1200),
      "the window's server did not finish its start within 1.2 s; it started nothing: run skydeck window again, or use --here",
    );
    const took = performance.now() - started;
    assert.ok(took >= 1100 && took < 10_000, `within the answer time (${took} ms)`);
    assert.ok(b.sent.filter((s) => s.path === '/new').length >= 2, 'asked again');
    assert.deepEqual(b.requests(), []);
  });

  test('503 stopping: its line', async (t) => {
    const b = await bench(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}`,
      FAKE_SERVE_STATE: 'stopping',
    });

    await rejectsWith(b.client.resume(S1), STOPPING);
    await rejectsWith(b.client.newSession(NEW), STOPPING);
    assert.equal(b.sent.length, 2, 'asked once each');
  });

  test('no answer within answerMs: the no-answer line, in answerMs’ seconds', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: 'silent' });

    const started = performance.now();
    await rejectsWith(b.client.resume(S1, 300), NO_ANSWER('0.3'));
    const took = performance.now() - started;
    assert.ok(took >= 290 && took < 10_000, `after answerMs (${took} ms)`);
    await rejectsWith(b.client.newSession(NEW, 1000), NO_ANSWER('1'));
    assert.deepEqual(b.requests(), [
      { route: 'resume', sessionId: S1 },
      { route: 'new', ...NEW },
    ]);
  });

  test('a server before stage C (404 route: unknown): unknown-route', async (t) => {
    const b = await bench(t, {});

    assert.equal(await b.client.resume(S1), 'unknown-route');
    assert.equal(await b.client.newSession(NEW), 'unknown-route');
    assert.equal(
      await b.client.restore({ sessionIds: [S1], all: false }, () => {}),
      'unknown-route',
    );
  });

  test('400 for the body (a label of 1,025 bytes, the real parser) and 413: the refused-request line', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });
    await rejectsWith(
      b.client.newSession({ ...NEW, label: 'x'.repeat(1025) }),
      "the window's server refused the request (body.label: too long); use --here",
    );
    assert.deepEqual(b.requests(), [], 'nothing reached launch');

    const c = await bench(t, { FAKE_SERVE_LAUNCH: 'status:413' });
    await rejectsWith(
      c.client.resume(S1),
      "the window's server refused the request (body: too long); use --here",
    );
    await rejectsWith(
      c.client.newSession(NEW),
      "the window's server refused the request (body: too long); use --here",
    );
  });

  test('500 failed: the line says that the session may have been started', async (t) => {
    // FAKE_SERVE_RESTORE alone: `launch` is there, and its resume and new fail.
    const b = await bench(t, { FAKE_SERVE_RESTORE: '[]' });

    const line =
      "the window's server failed while it answered the request (500: failed); it may have started the session: run skydeck to see whether it runs";
    await rejectsWith(b.client.resume(S1), line);
    await rejectsWith(b.client.newSession(NEW), line);
  });

  test('an answer of another shape cannot be read', async (t) => {
    const m = windowMachine(t);
    for (const answer of [
      [],
      'ok',
      null,
      { ...ANSWER, code: '0' },
      { ...ANSWER, code: 1.5 },
      { lines: ANSWER.lines, sessionId: S1 },
      { ...ANSWER, lines: 'skydeck: x' },
      { ...ANSWER, lines: ['a', 1] },
      { ...ANSWER, sessionId: 'not-a-session-id' },
      { ...ANSWER, sessionId: S1.toUpperCase() },
      { code: 0, lines: [] },
    ]) {
      const fake = await startFakeServe(t, m, {
        FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(answer)}`,
      });
      const client = controlClient(m.platform.net, m.runtime().serverSock, m.platform.clock);
      await rejectsWith(
        client.resume(S1),
        "the window's server gave an answer to POST /resume that cannot be read",
      );
      fake.child.kill('SIGKILL');
      await fake.exited;
    }
  });

  test('the socket fails after the request reached the server (it went away): the line says that the session may have been started (ruled, task 76)', async (t) => {
    for (const ask of [
      (c: ControlClient) => c.resume(S1),
      (c: ControlClient) => c.newSession(NEW),
    ]) {
      const b = await bench(t, { FAKE_SERVE_LAUNCH: 'silent' });
      const asked = ask(b.client);
      await until(() => b.requests().length === 1, 'the request reached launch', 10_000);
      b.fake.child.kill('SIGKILL');

      await assert.rejects(asked, (error: unknown) => {
        assert.ok(error instanceof SkydeckError, String(error));
        assert.equal(
          error.message.replace(/\((E[A-Z]+)\)/, '(<code>)'),
          `the window's server cannot be asked on ${b.m.runtime().serverSock} (<code>); it may have started the session: run skydeck to see whether it runs`,
        );
        return true;
      });
    }
  });

  test('nothing sent — no socket: today’s line, nothing started (ruled, task 76)', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });
    const missing = join(b.m.runtime().dir, 'nothing-here.sock');
    const client = controlClient(b.m.platform.net, missing, b.m.platform.clock);
    const line = `the window's server does not run (nothing answers on ${missing})`;

    await rejectsWith(client.resume(S1), line);
    await rejectsWith(client.newSession(NEW), line);
    await rejectsWith(
      client.restore({ sessionIds: [S1], all: false }, () => {}),
      line,
    );
    assert.deepEqual(b.requests(), []);
  });

  test('a body over the server’s 64 KiB: the 413 row’s line, and nothing is sent (ruled, task 76)', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });
    const line = "the window's server refused the request (body: too large); use --here";

    await rejectsWith(b.client.newSession({ ...NEW, flags: ['p'.repeat(64 * 1024)] }), line);
    await rejectsWith(
      b.client.restore(
        { sessionIds: Array.from({ length: 2000 }, (_, i) => `${S1}-${i}`), all: false },
        () => {},
      ),
      line,
    );
    assert.deepEqual(b.sent, []);
    // At the limit it is sent, and the server takes it.
    const flags = ['x'];
    const within = { ...NEW, flags };
    flags[0] = 'p'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(within)) + 1);
    assert.equal(Buffer.byteLength(JSON.stringify(within)), 64 * 1024);
    assert.deepEqual(await b.client.newSession(within), ANSWER);
    assert.equal(b.sent.length, 1);
  });

  test('a 404 of a kind that is not a route’s: a refusal, not unknown-route', async (t) => {
    const m = windowMachine(t);
    const net: Net = {
      ...m.platform.net,
      requestUnix: () => Promise.resolve({ status: 404, body: { error: 'token: unknown' } }),
    };
    const client = controlClient(net, '/nowhere.sock', m.platform.clock);

    await rejectsWith(
      client.resume(S1),
      "the window's server refused POST /resume (404: token: unknown)",
    );
  });

  test('a field a newer server adds is left out; sessionId null is read', async (t) => {
    const b = await bench(t, {
      FAKE_SERVE_LAUNCH: `answer:${JSON.stringify({ code: 4, lines: [], sessionId: null, extra: 1 })}`,
    });

    assert.deepEqual(await b.client.resume(S1), { code: 4, lines: [], sessionId: null });
  });

  test('a client made without a clock refuses the three requests before anything is sent (ruled, task 76)', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });
    const sent: string[] = [];
    const net: Net = {
      ...b.m.platform.net,
      requestUnix(path, request) {
        sent.push(request.path);
        return b.m.platform.net.requestUnix(path, request);
      },
    };
    const client = controlClient(net, b.m.runtime().serverSock);

    await assert.rejects(client.resume(S1), TypeError);
    await assert.rejects(client.newSession(NEW), TypeError);
    await assert.rejects(
      client.restore({ sessionIds: [S1], all: false }, () => {}),
      TypeError,
    );
    assert.deepEqual(sent, []);
    assert.equal((await client.ping()) !== 'refused', true, 'stage A’s requests need none');
  });

  test('an answer time no timer can wait is a RangeError, and nothing is sent', async (t) => {
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });

    for (const ms of [-1, 1.5, 2 ** 31, Number.NaN]) {
      await assert.rejects(b.client.resume(S1, ms), RangeError, String(ms));
      await assert.rejects(b.client.newSession(NEW, ms), RangeError, String(ms));
      await assert.rejects(
        b.client.restore({ sessionIds: [S1], all: false }, () => {}, ms),
        RangeError,
        String(ms),
      );
    }
    assert.deepEqual(b.sent, []);
  });
});

describe('controlClient: POST /restore (plan C5, C14)', () => {
  test('each line to onLine as it arrives, in order; the outcome; the request as 2.2 says', async (t) => {
    const stream = [{ line: 'started a' }, { line: 'waiting for 1 session' }, { outcome: OUTCOME }];
    const b = await bench(t, { FAKE_SERVE_RESTORE: JSON.stringify(stream) });
    const seen: { line: string; atMs: number }[] = [];

    const outcome = await b.client.restore({ sessionIds: [S1, S2], all: true }, (line) => {
      seen.push({ line, atMs: performance.now() });
    });

    assert.deepEqual(outcome, OUTCOME);
    assert.deepEqual(
      seen.map((s) => s.line),
      ['started a', 'waiting for 1 session'],
    );
    const gap = (seen[1]?.atMs ?? 0) - (seen[0]?.atMs ?? 0);
    assert.ok(gap >= 50, `the first line came before the second was written (${gap} ms)`);
    assert.deepEqual(b.requests(), [{ route: 'restore', sessionIds: [S1, S2], all: true }]);
  });

  test('silent-after:1: the line, then the stopped-answering line after answerMs', async (t) => {
    const b = await bench(t, { FAKE_SERVE_RESTORE: 'silent-after:1' });
    const seen: string[] = [];

    const started = performance.now();
    await rejectsWith(
      b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line), 600),
      STOPPED_ANSWERING,
    );
    const took = performance.now() - started;
    assert.ok(took >= 590 && took < 10_000, `after answerMs of silence (${took} ms)`);
    assert.deepEqual(seen, ['line 1']);
  });

  test('a server that dies after the first line (its connection reset): the stopped-answering line', async (t) => {
    const b = await bench(t, { FAKE_SERVE_RESTORE: 'silent-after:1' });
    const seen: string[] = [];

    const asked = b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line));
    await until(() => seen.length === 1, 'the first line', 10_000);
    b.fake.child.kill('SIGKILL');

    await rejectsWith(asked, STOPPED_ANSWERING);
    assert.deepEqual(seen, ['line 1']);
  });

  test('a server that dies after the request reached it and before the first line: the line says that the restore may have started (ruled, task 76)', async (t) => {
    const b = await bench(t, { FAKE_SERVE_RESTORE: 'silent-after:0' });
    const seen: string[] = [];

    const asked = b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line));
    await until(() => b.requests().length === 1, 'the request reached launch', 10_000);
    b.fake.child.kill('SIGKILL');

    await assert.rejects(asked, (error: unknown) => {
      assert.ok(error instanceof SkydeckError, String(error));
      assert.equal(
        error.message.replace(/\((E[A-Z]+)\)/, '(<code>)'),
        `the window's server cannot be asked on ${b.m.runtime().serverSock} (<code>); it may have started the restore: run skydeck to see what started`,
      );
      return true;
    });
    assert.deepEqual(seen, []);
  });

  test('a stream that keeps coming is not cut off by answerMs', async (t) => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ line: `line ${i}` }));
    const b = await bench(t, {
      FAKE_SERVE_RESTORE: JSON.stringify([...lines, { outcome: OUTCOME }]),
    });
    const seen: string[] = [];

    // 12 lines 100 ms apart: about 1.2 s in all, never 600 ms without one.
    assert.deepEqual(
      await b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line), 600),
      OUTCOME,
    );
    assert.equal(seen.length, 12);
  });

  test('a stream that ends without an outcome: the stopped-answering line', async (t) => {
    const b = await bench(t, { FAKE_SERVE_RESTORE: JSON.stringify([{ line: 'started a' }]) });
    const seen: string[] = [];

    await rejectsWith(
      b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line)),
      STOPPED_ANSWERING,
    );
    assert.deepEqual(seen, ['started a']);
  });

  test('a stream line of another shape, or one after the outcome, cannot be read', async (t) => {
    const m = windowMachine(t);
    for (const stream of [
      [{ line: 5 }, { outcome: OUTCOME }],
      ['started a', { outcome: OUTCOME }],
      [{ outcome: { ...OUTCOME, code: 2 } }],
      [{ outcome: { ...OUTCOME, started: -1 } }],
      [{ outcome: { code: 0 } }],
      [{ outcome: OUTCOME }, { line: 'late' }],
      [{ outcome: OUTCOME }, { outcome: OUTCOME }],
    ]) {
      const fake = await startFakeServe(t, m, { FAKE_SERVE_RESTORE: JSON.stringify(stream) });
      const client = controlClient(m.platform.net, m.runtime().serverSock, m.platform.clock);
      const seen: string[] = [];
      await rejectsWith(
        client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line)),
        "the window's server gave an answer to POST /restore that cannot be read",
      );
      assert.ok(!seen.includes('late'), JSON.stringify(stream));
      fake.child.kill('SIGKILL');
      await fake.exited;
    }
  });

  test('503 starting, then the stream: asked again; 503 stopping: its line; no refusal body reaches onLine', async (t) => {
    const stream = [{ line: 'started a' }, { outcome: OUTCOME }];
    const b = await bench(t, {
      FAKE_SERVE_RESTORE: JSON.stringify(stream),
      FAKE_SERVE_STATE: 'starting:1',
    });
    const seen: string[] = [];
    assert.deepEqual(
      await b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line), 10_000),
      OUTCOME,
    );
    assert.deepEqual(seen, ['started a']);
    assert.equal(b.sent.filter((s) => s.path === '/restore').length, 2);

    const c = await bench(t, {
      FAKE_SERVE_RESTORE: JSON.stringify(stream),
      FAKE_SERVE_STATE: 'stopping',
    });
    const none: string[] = [];
    await rejectsWith(
      c.client.restore({ sessionIds: [S1], all: false }, (line) => none.push(line)),
      STOPPING,
    );
    assert.deepEqual(none, []);
  });

  test('500 before any line (the run failed at once): the line says to look at what started', async (t) => {
    // FAKE_SERVE_LAUNCH alone: `launch` is there, and its restore fails.
    const b = await bench(t, { FAKE_SERVE_LAUNCH: `answer:${JSON.stringify(ANSWER)}` });
    const seen: string[] = [];

    await rejectsWith(
      b.client.restore({ sessionIds: [S1], all: false }, (line) => seen.push(line)),
      "the window's server failed while it answered the request (500: failed); run skydeck to see what started",
    );
    assert.deepEqual(seen, []);
  });
});

describe('the fake serve’s stage C options', () => {
  test('a value of another form ends the fake with exit 2, so that a typo cannot pass as another answer', async (t) => {
    const m = windowMachine(t);
    const fake = fileURLToPath(new URL('../fixtures/fake-serve/bin/skydeck', import.meta.url));
    for (const [name, value] of [
      ['FAKE_SERVE_LAUNCH', 'answer:{'],
      ['FAKE_SERVE_LAUNCH', 'silently'],
      ['FAKE_SERVE_LAUNCH', 'status:4130'],
      ['FAKE_SERVE_RESTORE', '[{"line":'],
      ['FAKE_SERVE_RESTORE', 'silent-after:x'],
      ['FAKE_SERVE_STATE', 'starting:-1'],
      ['FAKE_SERVE_STATE', 'stopped'],
      ['FAKE_SERVE_REQUESTS', 'requests.jsonl'],
    ] as const) {
      const child = spawn(fake, ['serve'], {
        env: m.s.env({ SKYDECK_NODE: process.execPath, [name]: value }),
        cwd: '/',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => {
        child.kill('SIGKILL');
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      const [code] = (await once(child, 'close')) as [number | null];

      assert.equal(code, 2, `${name}=${value}: ${err}`);
      assert.match(err, new RegExp(`fake-serve: ${name} is not `), `${name}=${value}`);
      assert.ok(!out.split('\n').includes('ready'), `${name}=${value}: never ready`);
    }
  });
});
