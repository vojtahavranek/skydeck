// server.sock (S2 8.3, 15.1): the server's control handler and the command line's client, over a
// real unix socket in a runtime directory of mode 0o700; the clock is the test platform's fake.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { linkSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { HttpListener, Net } from '../../src/platform/types.ts';
import { createTokens, isNonce, pageProof, raiseAlarm } from '../../src/window/auth.ts';
import type { Tokens } from '../../src/window/auth.ts';
import { controlClient } from '../../src/window/client.ts';
import type { ControlClient } from '../../src/window/client.ts';
import { controlHandler } from '../../src/window/control.ts';
import type { ControlDeps } from '../../src/window/control.ts';
import type { PingAnswer, StatusAnswer } from '../../src/window/protocol.ts';
import { prepareRuntimeDir, runtimeFiles } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { testDeck } from '../helpers/deck.ts';
import type { TestDeck } from '../helpers/deck.ts';
import { BOOT_A, S1, SEC, T0 } from '../helpers/platform.ts';

const PING: PingAnswer = {
  serverId: '0011223344556677',
  bootId: BOOT_A,
  build: '0123456789abcdef',
  protocol: 1,
  pid: 4000,
  port: 47613,
  checkout: '/home/dev/skydeck',
};

const STATUS: StatusAnswer = {
  pages: 1,
  terminals: [
    { id: '0123456789ab', slot: 1, state: 'running', sessionId: S1, pid: 5001 },
    { id: 'abcdef012345', slot: null, state: 'starting', sessionId: null, pid: null },
  ],
  keepAlive: { mode: 'wsl', state: 'running', since: '1794473990000000000', error: null },
  python: { found: true, version: '3.12.3' },
  build: '0123456789abcdef',
  checkout: '/home/dev/skydeck',
  startedAtNs: '1794474000000000000',
  envOrigin: { dir: '/home/dev/projects/api', atNs: '1794473990000000000' },
};

const SN = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8';
const CN = 'YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8';
const ORIGIN = 'http://127.0.0.1:47613';
const UNKNOWN_ID = 'ffffffffffffffffffffffffffffffff';
const LIMIT = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Helpers

interface Control {
  d: TestDeck;
  files: RuntimeFiles;
  client: ControlClient;
  /** The tokens the handler mints with (not counted). */
  tokens: Tokens;
  /** How many times the handler called each dependency. */
  calls: { ping: number; status: number; mint: number; shutdown: number };
  logs: string[];
  listener: HttpListener;
}

/**
 * controlHandler on <SKYDECK_HOME>/run/server.sock, the directory made by prepareRuntimeDir; the
 * tokens on the fake clock, their alarm written to the deck's store. `change` replaces
 * dependencies; `control` is the harness itself, for a replacement that needs the listener.
 */
async function startControl(
  t: TestContext,
  change: (control: () => Control) => Partial<ControlDeps> = () => ({}),
): Promise<Control> {
  const d = testDeck(t);
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  prepareRuntimeDir(d.platform, files);
  const tokens = createTokens(d.clock, d.platform.randomBytes, () => {
    raiseAlarm(d.deck.store, d.clock.nowNs());
  });
  const calls = { ping: 0, status: 0, mint: 0, shutdown: 0 };
  const logs: string[] = [];
  let control: Control | null = null;
  const own = (): Control => {
    assert.ok(control !== null);
    return control;
  };
  const deps: ControlDeps = {
    ping: () => (calls.ping++, PING),
    status: () => (calls.status++, STATUS),
    tokens: {
      ...tokens,
      mint: (seconds) => (calls.mint++, tokens.mint(seconds)),
    },
    shutdown: () => {
      calls.shutdown++;
    },
    log: (line) => {
      logs.push(line);
    },
    ...change(own),
  };
  const listener = await d.platform.net.listenHttp(
    { path: files.serverSock },
    { request: controlHandler(deps) },
  );
  t.after(() => listener.close());
  control = {
    d,
    files,
    client: controlClient(d.platform.net, files.serverSock),
    tokens,
    calls,
    logs,
    listener,
  };
  return control;
}

/** One request through the platform's own client (a JSON body, as the commands send them). */
function ask(
  c: Control,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return c.d.platform.net.requestUnix(c.files.serverSock, { method, path, body, timeoutMs: 5000 });
}

/**
 * One request with exactly `body` (bytes or text, not JSON-encoded). `chunked`: without
 * Content-Length, the body sent in pieces of 16 KiB. The status and the answer's text.
 */
function raw(
  socketPath: string,
  method: string,
  path: string,
  body: string | Uint8Array = '',
  chunked = false,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    const req = httpRequest({
      socketPath,
      method,
      path,
      agent: false,
      headers: chunked ? {} : { 'content-length': String(bytes.byteLength) },
    });
    let answered = false;
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    req.on('response', (res) => {
      answered = true;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text });
      });
    });
    if (chunked) {
      for (let at = 0; at < bytes.byteLength; at += 16 * 1024) {
        req.write(bytes.subarray(at, at + 16 * 1024));
      }
      req.end();
    } else {
      req.end(bytes);
    }
  });
}

/** Every regular file under `root` with its bytes (sockets and directories left out). */
function filesUnder(root: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path, { throwIfNoEntry: false });
      if (info?.isDirectory() === true) {
        walk(path);
      } else if (info?.isFile() === true) {
        found.set(path, readFileSync(path));
      }
    }
  };
  walk(root);
  return found;
}

/** A socket file whose connect is refused: a second name of a socket whose listener has gone. */
async function refusingSocket(c: Control, path: string): Promise<void> {
  const live = `${path}.live`;
  const listener = await c.d.platform.net.listenHttp(
    { path: live },
    { request: (_q, r) => r.end() },
  );
  linkSync(live, path);
  await listener.close();
}

/** The page's proof with `token` in mode launch, as a page that was given it would send. */
function useToken(c: Control, token: string): ReturnType<Tokens['check']> {
  const bytes = Buffer.from(token, 'base64url');
  return c.tokens.check(pageProof(bytes, 'launch', SN, CN, ORIGIN), SN, CN, ORIGIN);
}

interface Sent {
  /** The socket. */
  sock: string;
  method: string;
  path: string;
  body: unknown;
  timeoutMs: number;
}

/** A Net whose requestUnix records the request and answers with `answer`; nothing else works. */
function fakeNet(answer: (sent: Sent) => Promise<{ status: number; body: unknown }>): {
  net: Net;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const net: Net = {
    listenHttp: () => Promise.reject(new Error('not in this test')),
    connectUnix: () => Promise.reject(new Error('not in this test')),
    requestUnix: (sock, request) => {
      const one: Sent = {
        sock,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      };
      sent.push(one);
      return answer(one);
    },
  };
  return { net, sent };
}

function failing(code: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(new Error(`failed: ${code}`), { code }));
}

function answering(
  status: number,
  body: unknown,
): () => Promise<{ status: number; body: unknown }> {
  return () => Promise.resolve({ status, body });
}

const SOCK = '/run/user/1000/skydeck-0a1b2c3d/server.sock';
const TOKEN_ID = '00112233445566778899aabbccddeeff';
const TOKEN_TEXT = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

// ---------------------------------------------------------------------------------------------
// Each route through controlClient

test('ping answers what deps.ping gives', async (t) => {
  const c = await startControl(t);
  assert.deepEqual(await c.client.ping(), PING);
  assert.equal(c.calls.ping, 1);
});

test('status answers what deps.status gives', async (t) => {
  const c = await startControl(t);
  assert.deepEqual(await c.client.status(), STATUS);
  assert.equal(c.calls.status, 1);
});

test('token(30) mints a token: 32 bytes in base64url, an id of 32 hex, expiring in 30 s', async (t) => {
  const c = await startControl(t);
  const answer = await c.client.token(30);
  assert.match(answer.id, /^[0-9a-f]{32}$/);
  assert.ok(isNonce(answer.token), answer.token);
  assert.equal(Buffer.from(answer.token, 'base64url').byteLength, 32);
  assert.equal(answer.expiresAtNs, (T0 + 30n * SEC).toString());
  assert.equal(c.calls.mint, 1);
  // It is the token the server holds: a page's proof with it matches.
  assert.equal(useToken(c, answer.token).kind, 'match');
  assert.equal(c.tokens.state(answer.id), 'used');
});

test('token(600) mints a token expiring in 600 s', async (t) => {
  const c = await startControl(t);
  const answer = await c.client.token(600);
  assert.equal(answer.expiresAtNs, (T0 + 600n * SEC).toString());
  assert.equal(c.tokens.state(answer.id), 'waiting');
});

test('tokenState follows a token through waiting, used and reused', async (t) => {
  const c = await startControl(t);
  const { id, token } = await c.client.token(30);
  assert.equal(await c.client.tokenState(id), 'waiting');
  assert.equal(useToken(c, token).kind, 'match');
  assert.equal(await c.client.tokenState(id), 'used');
  assert.equal(useToken(c, token).kind, 'reused');
  assert.equal(await c.client.tokenState(id), 'reused');
});

test('tokenState says expired once the token has outlived its seconds', async (t) => {
  const c = await startControl(t);
  const { id } = await c.client.token(30);
  c.d.clock.advanceMs(30_000);
  assert.equal(await c.client.tokenState(id), 'expired');
});

test('dropToken gives the token up: dropped, and a proof with it matches nothing', async (t) => {
  const c = await startControl(t);
  const { id, token } = await c.client.token(30);
  await c.client.dropToken(id);
  assert.equal(await c.client.tokenState(id), 'dropped');
  assert.deepEqual(useToken(c, token), { kind: 'none' });
});

test('POST /token/drop answers { ok } — false for an id the server does not know', async (t) => {
  const c = await startControl(t);
  const { id } = await c.client.token(30);
  assert.deepEqual(await ask(c, 'POST', '/token/drop', { id }), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual(await ask(c, 'POST', '/token/drop', { id: UNKNOWN_ID }), {
    status: 200,
    body: { ok: false },
  });
  await c.client.dropToken(UNKNOWN_ID); // nothing to give up: not an error
});

test('shutdown answers { ok: true } and only then calls deps.shutdown, once', async (t) => {
  // The dependency does what the server does: it closes the listener and every connection. The
  // answer still arrives, so it was sent before.
  const c = await startControl(t, (control) => ({
    shutdown: () => {
      control().calls.shutdown++;
      void control().listener.close();
    },
  }));
  assert.deepEqual(await ask(c, 'POST', '/shutdown'), { status: 200, body: { ok: true } });
  await waitFor(() => c.calls.shutdown === 1);
  assert.equal(c.calls.shutdown, 1);
  assert.equal(await c.client.ping(1000), 'refused');
});

test('shutdown through the client resolves, and a second request does not call deps.shutdown again', async (t) => {
  const c = await startControl(t);
  await c.client.shutdown();
  await waitFor(() => c.calls.shutdown === 1);
  assert.deepEqual(await ask(c, 'POST', '/shutdown', {}), { status: 200, body: { ok: true } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.calls.shutdown, 1);
  assert.ok(
    c.logs.some((line) => line.includes('shutdown')),
    c.logs.join('\n'),
  );
});

test('a connection that does not read its answers does not keep POST /shutdown from the next asker', async (t) => {
  // Answers big enough that 80 of them fill the socket: the stalled connection's /shutdown is
  // parsed, but its answer waits behind them for as long as nobody reads. 80 answers are about
  // 1.7 MB, eight times a unix socket's buffer by Linux's default (net.core.wmem_default, 212,992
  // bytes); on a host whose buffer holds them all, the first assertion of 0 calls fails falsely.
  const big: StatusAnswer = {
    ...STATUS,
    terminals: Array.from({ length: 200 }, (_, n) => ({
      id: n.toString(16).padStart(12, '0'),
      slot: null,
      state: 'running',
      sessionId: S1,
      pid: 5001 + n,
    })),
  };
  const c = await startControl(t, () => ({ status: () => big }));
  const stalled = createConnection({ path: c.files.serverSock });
  t.after(() => {
    stalled.destroy();
  });
  await once(stalled, 'connect');
  stalled.pause();
  const status = 'GET /status HTTP/1.1\r\nHost: skydeck\r\n\r\n';
  stalled.write(
    status.repeat(80) + 'POST /shutdown HTTP/1.1\r\nHost: skydeck\r\nContent-Length: 0\r\n\r\n',
  );
  await waitFor(() => c.logs.includes('server.sock: shutdown asked for'));
  assert.equal(c.calls.shutdown, 0);
  await c.client.shutdown();
  await waitFor(() => c.calls.shutdown === 1);
  await c.client.shutdown();
  stalled.destroy(); // its answer is given up now: still no second call
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.calls.shutdown, 1);
});

async function waitFor(condition: () => boolean): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    assert.ok(performance.now() - start < 5000, 'waited 5 s');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------------------------
// Refusals

test('POST /token with an unknown field, seconds 60 or invalid JSON is 400, and nothing is minted', async (t) => {
  const c = await startControl(t);
  const bodies = ['{"seconds":30,"for":"edge"}', '{"seconds":60}', '{"seconds":30', '', '[30]'];
  for (const body of bodies) {
    const answer = await raw(c.files.serverSock, 'POST', '/token', body);
    assert.equal(answer.status, 400, body);
  }
  assert.equal(c.calls.mint, 0);
});

test('a refused body is logged by its kind, never by its text', async (t) => {
  const c = await startControl(t);
  await raw(c.files.serverSock, 'POST', '/token', '{"seconds": 30, "proof": "MARKER-a1b2"');
  await raw(c.files.serverSock, 'POST', '/token', '{"MARKER-c3d4": 30}');
  assert.equal(c.logs.length, 2, c.logs.join('\n'));
  assert.ok(c.logs[0]?.includes('body: not JSON'), c.logs[0]);
  assert.ok(c.logs[1]?.includes('body: unknown field'), c.logs[1]);
  assert.ok(!c.logs.join('\n').includes('MARKER'), c.logs.join('\n'));
});

test('the answer of a refusal names the kind, as JSON', async (t) => {
  const c = await startControl(t);
  assert.deepEqual(await ask(c, 'POST', '/token', { seconds: 60 }), {
    status: 400,
    body: { error: 'body.seconds: wrong value' },
  });
});

test('a body over 64 KiB is 413 and nothing is minted; one of exactly 64 KiB is read', async (t) => {
  const c = await startControl(t);
  const exact = `{"seconds":30${' '.repeat(LIMIT - '{"seconds":30}'.length)}}`;
  assert.equal(Buffer.byteLength(exact), LIMIT);
  const over = `{"seconds":30${' '.repeat(LIMIT + 1 - '{"seconds":30}'.length)}}`;
  assert.equal((await raw(c.files.serverSock, 'POST', '/token', over)).status, 413);
  assert.equal((await raw(c.files.serverSock, 'POST', '/token', over, true)).status, 413);
  assert.equal(c.calls.mint, 0);
  assert.equal((await raw(c.files.serverSock, 'POST', '/token', exact)).status, 200);
  assert.equal((await raw(c.files.serverSock, 'POST', '/token', exact, true)).status, 200);
  assert.equal(c.calls.mint, 2);
  // A much bigger one, as the commands' client sends it, and the server still answers after.
  const huge = await ask(c, 'POST', '/token', { seconds: 30, pad: 'x'.repeat(1024 * 1024) });
  assert.deepEqual(huge, { status: 413, body: { error: 'body: too large' } });
  assert.deepEqual(await c.client.ping(), PING);
  assert.equal(c.calls.mint, 2);
});

test('a body that is not UTF-8 is 400', async (t) => {
  const c = await startControl(t);
  const bytes = Buffer.concat([
    Buffer.from('{"seconds":30,"x":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const answer = await raw(c.files.serverSock, 'POST', '/token', bytes);
  assert.equal(answer.status, 400);
  assert.deepEqual(JSON.parse(answer.text), { error: 'body: not UTF-8' });
  assert.equal(c.calls.mint, 0);
});

test('GET /token/<an id never minted> is 404', async (t) => {
  const c = await startControl(t);
  assert.deepEqual(await ask(c, 'GET', `/token/${UNKNOWN_ID}`), {
    status: 404,
    body: { error: 'token: unknown' },
  });
  await assert.rejects(c.client.tokenState(UNKNOWN_ID), (error: unknown) => {
    assert.ok(error instanceof SkydeckError);
    assert.match(error.message, /404/);
    return true;
  });
});

test('an unknown route, a wrong method or a malformed token id is 404', async (t) => {
  const c = await startControl(t);
  const requests: ['GET' | 'POST', string][] = [
    ['GET', '/'],
    ['GET', '/pong'],
    ['GET', '/ping/'],
    ['GET', '/ping?x=1'],
    ['POST', '/ping'],
    ['GET', '/shutdown'],
    ['GET', '/token'],
    ['GET', '/token/0123'],
    ['GET', '/token/0123456789ABCDEF0123456789ABCDEF'],
    ['GET', '/token/drop'],
  ];
  for (const [method, path] of requests) {
    const answer = await ask(c, method, path);
    assert.equal(answer.status, 404, `${method} ${path}`);
  }
  assert.deepEqual(c.calls, { ping: 0, status: 0, mint: 0, shutdown: 0 });
});

test('POST /resume, /new and /restore (stage C) are 404, and nothing is started', async (t) => {
  const c = await startControl(t);
  const requests: [string, unknown][] = [
    ['/resume', { sessionId: S1 }],
    ['/new', { dir: '/home/dev', label: 'x', group: '', flags: [] }],
    ['/restore', { sessionIds: [S1], all: false }],
  ];
  for (const [path, body] of requests) {
    assert.deepEqual(await ask(c, 'POST', path, body), {
      status: 404,
      body: { error: 'route: unknown' },
    });
  }
  assert.deepEqual(c.d.processes.calls, []);
  assert.deepEqual(c.d.runner.calls, []);
  assert.deepEqual(c.calls, { ping: 0, status: 0, mint: 0, shutdown: 0 });
});

test('a GET with a body, or POST /shutdown with a field, is 400 and does nothing', async (t) => {
  const c = await startControl(t);
  assert.equal((await raw(c.files.serverSock, 'GET', '/ping', '{}')).status, 400);
  assert.equal((await raw(c.files.serverSock, 'POST', '/shutdown', '{"now":true}')).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(c.calls, { ping: 0, status: 0, mint: 0, shutdown: 0 });
});

test('a dependency that throws is 500, logged by its name without its message; the next request is answered', async (t) => {
  const c = await startControl(t, () => ({
    status: () => {
      throw new TypeError('MARKER-e5f6 cannot be read');
    },
  }));
  assert.deepEqual(await ask(c, 'GET', '/status'), { status: 500, body: { error: 'failed' } });
  assert.equal(c.logs.length, 1);
  assert.ok(c.logs[0]?.includes('status') && c.logs[0].includes('TypeError'), c.logs[0]);
  assert.ok(!c.logs[0]?.includes('MARKER'), c.logs[0]);
  await assert.rejects(c.client.status(), SkydeckError);
  assert.deepEqual(await c.client.ping(), PING);
});

test("a failure's log line carries the error's code too, never its message", async (t) => {
  // The store's errors are plain Errors with a code: the code is what tells them apart.
  const locked = Object.assign(new Error('MARKER-a7b8 database is locked'), {
    code: 'ERR_SQLITE_ERROR',
  });
  const c = await startControl(t, () => ({
    ping: () => {
      throw locked;
    },
  }));
  assert.deepEqual(await ask(c, 'GET', '/ping'), { status: 500, body: { error: 'failed' } });
  assert.deepEqual(c.logs, ['server.sock: ping failed (Error (ERR_SQLITE_ERROR))']);
});

// ---------------------------------------------------------------------------------------------
// Tokens in memory only; the socket's place

test('tokens are never written to a file, the store or the log', async (t) => {
  const c = await startControl(t);
  const kvBefore = c.d.deck.store.kvEntries('');
  const filesBefore = filesUnder(c.d.sandbox.root);
  const minted = [await c.client.token(30), await c.client.token(600)];
  for (const { id } of minted) {
    await c.client.tokenState(id);
  }
  await c.client.dropToken(minted[0]?.id ?? '');
  const filesAfter = filesUnder(c.d.sandbox.root);
  assert.deepEqual(filesAfter, filesBefore);
  assert.deepEqual(c.d.deck.store.kvEntries(''), kvBefore);
  // deps.log is the handler's one way to write (server.log, in the server): these requests log
  // nothing at all, so no encoding of a token can be in it.
  assert.deepEqual(c.logs, []);
  const logged = Buffer.from(c.logs.join('\n'), 'utf8');
  for (const { id, token } of minted) {
    const needles = [Buffer.from(token), Buffer.from(token, 'base64url'), Buffer.from(id)];
    for (const [path, bytes] of [...filesAfter, ['the log', logged] as const]) {
      for (const needle of needles) {
        assert.equal(bytes.indexOf(needle), -1, `${path} holds a token`);
      }
    }
  }
});

test('server.sock has mode 0o600, in the runtime directory of mode 0o700', async (t) => {
  const c = await startControl(t);
  const sock = statSync(c.files.serverSock);
  assert.ok(sock.isSocket());
  assert.equal(sock.mode & 0o777, 0o600);
  assert.equal(statSync(c.files.dir).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------------------------
// ping without a server

test("ping against a socket file nobody listens on is 'refused'", async (t) => {
  const c = await startControl(t);
  const dead = join(c.files.dir, 'dead.sock');
  await refusingSocket(c, dead);
  assert.equal(await controlClient(c.d.platform.net, dead).ping(), 'refused');
});

test("ping against a missing socket is 'refused'", async (t) => {
  const c = await startControl(t);
  assert.equal(
    await controlClient(c.d.platform.net, join(c.files.dir, 'none.sock')).ping(),
    'refused',
  );
});

test("ping against a server that never answers is 'timeout' after the given time", async (t) => {
  const c = await startControl(t);
  const hung = join(c.files.dir, 'hung.sock');
  const listener = await c.d.platform.net.listenHttp({ path: hung }, { request: () => {} });
  t.after(() => listener.close());
  const start = performance.now();
  assert.equal(await controlClient(c.d.platform.net, hung).ping(300), 'timeout');
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 250 && elapsed < 4000, `${elapsed} ms`);
});

test("ping with a signal that fires is 'timeout' at once, and its connection is ended", async (t) => {
  const c = await startControl(t);
  const hung = join(c.files.dir, 'hung.sock');
  const sockets: import('node:net').Socket[] = [];
  const listener = await c.d.platform.net.listenHttp(
    { path: hung },
    { request: (req) => void sockets.push(req.socket) },
  );
  t.after(() => listener.close());
  const controller = new AbortController();
  const start = performance.now();
  const pinged = controlClient(c.d.platform.net, hung).ping(10_000, controller.signal);
  while (sockets.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const closed = once(sockets[0] as import('node:net').Socket, 'close');
  controller.abort();
  assert.equal(await pinged, 'timeout');
  let guard: NodeJS.Timeout | undefined;
  await Promise.race([
    closed,
    new Promise((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('the connection was not closed')), 5000);
    }),
  ]);
  clearTimeout(guard);
  assert.ok(performance.now() - start < 9000, `${performance.now() - start} ms`);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await controlClient(c.d.platform.net, hung).ping(5000, aborted.signal), 'timeout');
  assert.equal(sockets.length, 1); // nothing was sent for the signal that had fired already
});

// ---------------------------------------------------------------------------------------------
// The client alone (a fake Net)

test('the client sends each request as S2 8.3 says, ping with 5 s by default', async () => {
  const answers: Record<string, unknown> = {
    'GET /ping': PING,
    'GET /status': STATUS,
    'POST /token': { id: TOKEN_ID, token: TOKEN_TEXT, expiresAtNs: '1794474030000000000' },
    [`GET /token/${TOKEN_ID}`]: { state: 'waiting' },
    'POST /token/drop': { ok: true },
    'POST /shutdown': { ok: true },
  };
  const { net, sent } = fakeNet((one) =>
    Promise.resolve({ status: 200, body: answers[`${one.method} ${one.path}`] }),
  );
  const client = controlClient(net, SOCK);
  assert.deepEqual(await client.ping(), PING);
  await client.ping(250);
  await client.status();
  assert.deepEqual(await client.token(600), answers['POST /token']);
  assert.equal(await client.tokenState(TOKEN_ID), 'waiting');
  await client.dropToken(TOKEN_ID);
  await client.shutdown();
  assert.deepEqual(
    sent.map(({ sock, method, path, body }) => ({ sock, method, path, body })),
    [
      { sock: SOCK, method: 'GET', path: '/ping', body: undefined },
      { sock: SOCK, method: 'GET', path: '/ping', body: undefined },
      { sock: SOCK, method: 'GET', path: '/status', body: undefined },
      { sock: SOCK, method: 'POST', path: '/token', body: { seconds: 600 } },
      { sock: SOCK, method: 'GET', path: `/token/${TOKEN_ID}`, body: undefined },
      { sock: SOCK, method: 'POST', path: '/token/drop', body: { id: TOKEN_ID } },
      { sock: SOCK, method: 'POST', path: '/shutdown', body: undefined },
    ],
  );
  assert.equal(sent[0]?.timeoutMs, 5000);
  assert.equal(sent[1]?.timeoutMs, 250);
});

test("ping: ECONNREFUSED and ENOENT are 'refused', ETIMEDOUT and EAGAIN (a full queue) 'timeout'", async () => {
  for (const [code, expected] of [
    ['ECONNREFUSED', 'refused'],
    ['ENOENT', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['EAGAIN', 'timeout'],
  ] as const) {
    const { net } = fakeNet(failing(code));
    assert.equal(await controlClient(net, SOCK).ping(), expected, code);
  }
});

test('ping rejects with a SkydeckError for another failure, another status or an answer it cannot read', async () => {
  const cases: [string, () => Promise<{ status: number; body: unknown }>, RegExp][] = [
    ['EACCES', failing('EACCES'), /EACCES/],
    ['ECONNRESET', failing('ECONNRESET'), /ECONNRESET/],
    ['not HTTP', failing('HPE_INVALID_CONSTANT'), /answer to GET \/ping that cannot be read/],
    ['500', answering(500, { error: 'failed' }), /500/],
    ['text', answering(200, 'pong'), /cannot be read/],
    ['no build', answering(200, { ...PING, build: undefined }), /cannot be read/],
    ['protocol 2', answering(200, { ...PING, protocol: 2 }), /cannot be read/],
    ['port 0', answering(200, { ...PING, port: 0 }), /cannot be read/],
    ['pid as text', answering(200, { ...PING, pid: '4000' }), /cannot be read/],
  ];
  for (const [name, answer, message] of cases) {
    const { net } = fakeNet(answer);
    await assert.rejects(controlClient(net, SOCK).ping(), (error: unknown) => {
      assert.ok(error instanceof SkydeckError, name);
      assert.match(error.message, message, name);
      return true;
    });
  }
});

test('a peer that does not speak HTTP gives an answer that cannot be read', async (t) => {
  const c = await startControl(t);
  const path = join(c.files.dir, 'garbage.sock');
  const garbage = createServer((socket) => {
    socket.end('garbage that is not HTTP\r\n\r\n');
  });
  garbage.listen(path);
  await once(garbage, 'listening');
  t.after(() => {
    garbage.close();
  });
  const client = controlClient(c.d.platform.net, path);
  for (const call of [() => client.ping(), () => client.status()]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof SkydeckError, String(error));
      assert.match(error.message, /that cannot be read/);
      return true;
    });
  }
});

test('ping ignores a field a newer server adds', async () => {
  const { net } = fakeNet(answering(200, { ...PING, uptime: 12 }));
  assert.deepEqual(await controlClient(net, SOCK).ping(), PING);
});

test('the other requests reject with a SkydeckError that says what went wrong, never a token', async () => {
  const ask: [string, (client: ControlClient) => Promise<unknown>][] = [
    ['status', (client) => client.status()],
    ['token', (client) => client.token(30)],
    ['tokenState', (client) => client.tokenState(TOKEN_ID)],
    ['dropToken', (client) => client.dropToken(TOKEN_ID)],
    ['shutdown', (client) => client.shutdown()],
  ];
  const failures: [() => Promise<{ status: number; body: unknown }>, RegExp][] = [
    [failing('ECONNREFUSED'), /does not run.*server\.sock/],
    [failing('ENOENT'), /does not run.*server\.sock/],
    [failing('ETIMEDOUT'), /did not answer .* within 5 s/],
    [failing('EACCES'), /EACCES/],
    [failing('HPE_INVALID_CONSTANT'), /cannot be read/],
    [answering(400, { error: 'body: unknown field' }), /refused .*\(400: body: unknown field\)/],
    [answering(404, 'not found'), /refused .*\(404\)/],
    [answering(200, { surprise: TOKEN_TEXT }), /cannot be read/],
    [answering(200, null), /cannot be read/],
  ];
  for (const [name, call] of ask) {
    for (const [answer, message] of failures) {
      const { net } = fakeNet(answer);
      await assert.rejects(call(controlClient(net, SOCK)), (error: unknown) => {
        assert.ok(error instanceof SkydeckError, name);
        assert.match(error.message, message, `${name}: ${error.message}`);
        assert.ok(!error.message.includes(TOKEN_TEXT), error.message);
        return true;
      });
    }
  }
});

test("a refusal's kind reaches the message only as printable text", async () => {
  const { net } = fakeNet(answering(400, { error: 'body\x1b[31m:  wrong' }));
  await assert.rejects(controlClient(net, SOCK).status(), (error: unknown) => {
    assert.ok(error instanceof SkydeckError);
    assert.ok(!/[\x00-\x1f\x7f-￿]/.test(error.message), JSON.stringify(error.message));
    return true;
  });
});

test('token rejects an answer whose token is not 32 bytes of base64url, or whose id is not a token id', async () => {
  const good = { id: TOKEN_ID, token: TOKEN_TEXT, expiresAtNs: '1794474030000000000' };
  for (const body of [
    { ...good, token: `${TOKEN_TEXT}=` },
    { ...good, token: TOKEN_TEXT.slice(1) },
    { ...good, id: TOKEN_ID.toUpperCase() },
    { ...good, expiresAtNs: 1794474030000000000 },
    { ...good, expiresAtNs: '-1' },
  ]) {
    const { net } = fakeNet(answering(200, body));
    await assert.rejects(controlClient(net, SOCK).token(30), /cannot be read/);
  }
});

test('tokenState rejects a state it does not know; status an answer of the wrong shape', async () => {
  const { net } = fakeNet(answering(200, { state: 'lost' }));
  await assert.rejects(controlClient(net, SOCK).tokenState(TOKEN_ID), /cannot be read/);
  for (const body of [
    { ...STATUS, pages: -1 },
    { ...STATUS, terminals: [{ ...STATUS.terminals[0], pid: '5001' }] },
    { ...STATUS, keepAlive: { ...STATUS.keepAlive, mode: 'always' } },
    { ...STATUS, python: { found: 'yes', version: null } },
    { ...STATUS, envOrigin: { dir: '/home/dev' } },
  ]) {
    const status = fakeNet(answering(200, body));
    await assert.rejects(controlClient(status.net, SOCK).status(), /cannot be read/);
  }
});

test('the client refuses an argument the server would refuse, and sends nothing', async () => {
  const { net, sent } = fakeNet(answering(200, { ok: true }));
  const client = controlClient(net, SOCK);
  await assert.rejects(client.token(60 as 30), RangeError);
  await assert.rejects(client.tokenState('../shutdown'), RangeError);
  await assert.rejects(client.dropToken(TOKEN_ID.toUpperCase()), RangeError);
  assert.deepEqual(sent, []);
});

test('ping passes on the RangeError of a time no timer can wait, as an error of the caller', async (t) => {
  const c = await startControl(t);
  await assert.rejects(c.client.ping(-1), RangeError);
  await assert.rejects(c.client.ping(1.5), RangeError);
  assert.equal(c.calls.ping, 0);
});
