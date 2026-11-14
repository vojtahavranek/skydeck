// The failures of S2 14 that can happen inside Linux, and the stop of S2 5.5 (plan task 23):
// python3 missing, the server stopped and started again, the server dropped as a crash leaves it,
// a store migrated under the server, a locked store, a keep-alive that cannot start. In the test
// process (A19) on realTestPlatform, with real keepers running the stand-in.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import type { Terminal } from '@xterm/headless';
import WebSocket from 'ws';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { Platform } from '../../src/platform/types.ts';
import { attachManualPr } from '../../src/sessions/meta.ts';
import { readLock } from '../../src/sessions/resume.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { pageProof } from '../../src/window/auth.ts';
import { controlClient } from '../../src/window/client.ts';
import { encodeFrame, frameReader, parseHello } from '../../src/window/frames.ts';
import type { KeeperHello } from '../../src/window/frames.ts';
import type { ListMessage, SnapMessage } from '../../src/window/protocol.ts';
import { listKeeperLines } from '../../src/window/runtime.ts';
import { keepAliveNotices, ServeExit } from '../../src/window/server.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import { sleep, until, within } from '../helpers/keeper.ts';
import { freshNonce } from '../helpers/pages.ts';
import { S1, S2, S3 } from '../helpers/platform.ts';
import { waitForRecord } from '../helpers/standin.ts';
import { assertSameScreen } from '../helpers/registry.ts';
import { connectTestPage, rowsOf, serverSandbox, WAIT_MS } from '../helpers/window.ts';
import type { ServerSandbox, TestPage, TestServer } from '../helpers/window.ts';

const PYTHON_MISSING =
  'python3 3.9 or newer is needed to open terminals in the window (sudo apt install python3)';

function listed(list: ListMessage, sessionId: string): boolean {
  return rowsOf(list).some((row) => row.id === sessionId);
}

/** A headless terminal showing what a page shows: its snap, then the output after it. */
async function screenOf(snap: SnapMessage, after: string): Promise<Terminal> {
  const { Terminal } = await loadXterm(new URL('../..', import.meta.url).pathname);
  const term = new Terminal({
    cols: snap.cols,
    rows: snap.rows,
    scrollback: 5000,
    allowProposedApi: true,
    logLevel: 'off',
  });
  await new Promise<void>((resolve) => term.write(snap.data + after, resolve));
  return term;
}

/**
 * Resumes S1 in the window from a page, attaches to its terminal, waits for the prompt, types a
 * line and waits for the next prompt; returns the terminal and the screen the page shows.
 */
async function resumedAndTyped(
  t: TestContext,
  d: ServerSandbox,
  test: TestServer,
): Promise<{ page: TestPage; termId: string; screen: Terminal }> {
  const page = await connectTestPage(t, d, test.server);
  const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [term] = test.server.hub.list();
  assert.ok(term !== undefined);
  page.send({ t: 'attach', term: term.id, cols: 80, rows: 24 });
  const snap = await page.next('snap');
  const prompt = `standin ${S1.slice(0, 8)}> `;
  const prompts = (): number => (snap.data + page.output(snap.ch)).split(prompt).length - 1;
  await until(() => prompts() >= 1, 'the prompt', WAIT_MS);
  page.send({ t: 'input', term: term.id, data: 'hello there\r' });
  await until(() => prompts() >= 2, 'the prompt after the typed line', WAIT_MS);
  return { page, termId: term.id, screen: await screenOf(snap, page.output(snap.ch)) };
}

/** A new server on the sandbox finds the terminal again; a page's snap shows `screen`. */
async function rediscovered(
  t: TestContext,
  d: ServerSandbox,
  termId: string,
  screen: Terminal,
): Promise<void> {
  const again = await d.start();
  assert.ok(
    again.server.hub.list().some((term) => term.id === termId && term.state === 'running'),
    'the terminal is found again, running',
  );
  const page = await connectTestPage(t, d, again.server);
  page.send({ t: 'attach', term: termId, cols: 80, rows: 24 });
  const snap = await page.next('snap');
  assertSameScreen(screen, await screenOf(snap, ''));
}

/** One claim of a keeper as the server makes it (C, then its H), closed again; the hello. */
async function claimHello(d: ServerSandbox, termId: string): Promise<KeeperHello> {
  const socket = await d.platform.net.connectUnix(d.files.termSock(termId));
  try {
    const reader = frameReader();
    socket.write(encodeFrame('C', new Uint8Array(0)));
    return await new Promise<KeeperHello>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        const frames = reader.push(chunk);
        if ('error' in frames) {
          reject(new Error(frames.error));
          return;
        }
        const frame = frames.find((f) => f.type === 'H');
        if (frame === undefined) return;
        const hello = parseHello(frame.payload);
        if (hello.ok) resolve(hello.value);
        else reject(new Error(hello.kind));
      });
    });
  } finally {
    socket.destroy();
  }
}

/** A platform change whose python3 check (runServer's, at start) waits until `open()`. */
function heldStart(): {
  change: (p: Platform) => Platform;
  reached: Promise<void>;
  open: () => void;
  port: () => number;
} {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reach = (): void => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let port = 0;
  return {
    reached,
    open,
    port: () => port,
    change: (p) => ({
      ...p,
      runner: {
        ...p.runner,
        async run(command, args, options) {
          if (command === 'python3') {
            reach();
            await gate;
          }
          return p.runner.run(command, args, options);
        },
      },
      net: {
        ...p.net,
        async listenHttp(where, handlers) {
          const listener = await p.net.listenHttp(where, handlers);
          if (!('path' in where)) port = listener.port;
          return listener;
        },
      },
    }),
  };
}

/** S2 6.1: the Windows client the keep-alive is. */
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';

/** claudeCommand becomes a script `name` of the sandbox with `text`. */
function claudeCommandScript(d: ServerSandbox, name: string, text: string): void {
  const script = join(d.s.bin, name);
  writeFileSync(script, text, { mode: 0o755 });
  const configPath = join(d.s.skydeckHome, 'config', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, claudeCommand: script }));
}

/** claudeCommand becomes a script that ends at once (exit 3), as a claude that fails at start. */
function failingClaude(d: ServerSandbox): void {
  claudeCommandScript(d, 'claude-fails', '#!/bin/sh\nexit 3\n');
}

/** A unix socket that accepts connections (an interop socket, S2 6.4), closed at the test's end. */
async function listeningSocket(t: TestContext, path: string): Promise<{ path: string }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path };
}

/** Another process's write lock on the sandbox's store (the fixture's BEGIN IMMEDIATE in a worker). */
function holdWriteLock(t: TestContext, d: ServerSandbox): { held: Promise<void>; release(): void } {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const holder = new Worker(new URL('../fixtures/hold-write-lock.ts', import.meta.url), {
    workerData: { path: join(d.s.skydeckHome, 'data', 'skydeck.db'), signal },
  });
  const release = (): void => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  t.after(async () => {
    release();
    await holder.terminate();
  });
  return {
    held: new Promise<void>((resolve) => holder.once('message', () => resolve())),
    release,
  };
}

/** The close code a page gets when it sends a proper hello in mode key (the stored secret). */
async function helloCloseCode(t: TestContext, d: ServerSandbox, port: number): Promise<number> {
  const secret = d.deck.store.getKv('window_secret');
  assert.ok(secret !== null);
  const origin = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  t.after(() => {
    ws.terminate();
  });
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const challenge = await new Promise<{ nonce: string }>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as { nonce: string })),
  );
  const cN = freshNonce();
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: 1,
      mode: 'key',
      nonce: cN,
      proof: pageProof(Buffer.from(secret, 'base64url'), 'key', challenge.nonce, cN, origin),
    }),
  );
  return closed;
}

/**
 * Opens a held start and waits for it to be done (or to fail), so that its server is in the
 * sandbox's list, which the cleanup stops: called in a `finally`, a test that fails while the
 * start is held never leaves a half-started server behind (review 2, R1).
 */
async function finishStart(held: { open(): void }, starting: Promise<unknown>): Promise<void> {
  held.open();
  await within(
    starting.catch(() => {}),
    'the held start to end',
    WAIT_MS,
  );
}

/** A page's hello in mode launch with `token`: 0 when it is welcomed, else the close code. */
async function presentToken(t: TestContext, port: number, token: Uint8Array): Promise<number> {
  const origin = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  t.after(() => {
    ws.terminate();
  });
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const challenge = await new Promise<{ nonce: string }>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as { nonce: string })),
  );
  const cN = freshNonce();
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: 1,
      mode: 'launch',
      nonce: cN,
      proof: pageProof(token, 'launch', challenge.nonce, cN, origin),
    }),
  );
  const answer = await within(
    Promise.race([
      new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data)))),
      closed.then((code) => `closed ${code}`),
    ]),
    'the answer to the hello',
    WAIT_MS,
  );
  if (answer.includes('"welcome"')) {
    ws.close();
    return 0;
  }
  return within(closed, 'the close', WAIT_MS);
}

describe('python3 missing (S2 14)', () => {
  test("the server runs and lists; a resume answers S2 14's message; status says python3 is not found", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const bin = join(d.s.root, 'bin-without-python');
    mkdirSync(bin);
    symlinkSync('/bin/sh', join(bin, 'sh'));
    const test = await d.start({ platform: (p) => ({ ...p, env: { ...p.env, PATH: bin } }) });
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => listed(list, S1), 'the list works');
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, false);
    assert.ok(
      result.lines.some((line) => line.includes(PYTHON_MISSING)),
      JSON.stringify(result.lines),
    );
    const status = await controlClient(d.platform.net, d.files.serverSock).status();
    assert.deepEqual(status.python, { found: false, version: null });
  });
});

describe('stopping (S2 5.5) and starting again (S2 7.3, 14)', () => {
  test('stop: every page gets bye; keepers keep running; server.json, server.pid, server.sock and the lock go; a new server finds the terminals', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const first = await d.start();
    const { page, termId, screen } = await resumedAndTyped(t, d, first);
    const other = await connectTestPage(t, d, first.server);

    await first.server.stop('skydeck window --stop');
    for (const p of [page, other]) {
      const bye = await p.next('bye');
      assert.equal(bye.reason, 'skydeck window --stop');
      await within(p.closed, 'the page closed', WAIT_MS);
    }
    assert.equal(await first.server.done, 0);
    const lines = listKeeperLines(d.platform, d.files);
    assert.deepEqual(
      lines.map((line) => [line.id, line.state]),
      [[termId, 'alive']],
      'the keeper keeps running',
    );
    for (const path of [d.files.serverJson, d.files.serverPid, d.files.serverSock]) {
      assert.equal(existsSync(path), false, `${path} is gone`);
    }
    assert.equal(d.deck.store.getKv('window_server'), null, 'the lock is released');
    assert.equal(await controlClient(d.platform.net, d.files.serverSock).ping(), 'refused');
    // S2 5.5: every keeper was parked before its connection closed — a claim's hello says the
    // snapshot covers every record.
    const hello = await claimHello(d, termId);
    assert.equal(hello.snapSeq, hello.seq, 'the park covers the whole stream');
    assert.ok(hello.seq > 0);

    await rediscovered(t, d, termId, screen);
  });

  test('a SIGTERM on top of a stop does not cut it short: stop() twice is one stop', async (t) => {
    const d = serverSandbox(t);
    const first = await d.start();
    const page = await connectTestPage(t, d, first.server);
    const one = first.server.stop('first');
    const two = first.server.stop('second');
    await Promise.all([one, two]);
    assert.equal((await page.next('bye')).reason, 'first');
    assert.equal(await first.server.done, 0);
    assert.equal(existsSync(d.files.serverJson), false);
  });

  test('dropped without a stop (as a crash leaves it): a new server finds the terminals and a page the same screen', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const first = await d.start();
    const { page, termId, screen } = await resumedAndTyped(t, d, first);
    await first.drop();
    await within(page.closed, 'the page closed', WAIT_MS);
    assert.equal(existsSync(d.files.serverJson), true, 'a crash leaves server.json');
    await rediscovered(t, d, termId, screen);
  });
});

describe('while the server starts (S2 5.2, 7.3)', () => {
  test('an upgrade before the keepers are found and the rows loaded is answered 503; then a resume of a session whose terminal runs is refused', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    // A terminal of S1 an earlier server opened: its program runs and holds no live file (claude
    // at a dialog before SessionStart), and no resume lock is left.
    const keeper = await d.box.start({ spec: { argv: ['sh', '-c', 'exec sleep 120'] } });
    const { client } = await keeper.claim();
    client.send('G');
    await client.next('T', WAIT_MS);
    client.socket.destroy();

    const held = heldStart();
    const starting = d.start({ platform: held.change });
    let status = 0;
    try {
      await within(held.reached, 'the start reaching its python3 check', WAIT_MS);
      assert.ok(held.port() > 0, 'the port is bound');
      const origin = `http://127.0.0.1:${held.port()}`;
      const ws = new WebSocket(`ws://127.0.0.1:${held.port()}/ws`, { origin });
      t.after(() => {
        ws.terminate();
      });
      ws.on('error', () => {});
      status = await within(
        new Promise<number>((resolve, reject) => {
          ws.once('open', () => reject(new Error('the upgrade was accepted while starting')));
          ws.once('unexpected-response', (req, res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
            req.destroy();
          });
        }),
        'the answer to the upgrade',
        WAIT_MS,
      );
    } finally {
      await finishStart(held, starting); // also when the test fails here (review 2, R1)
    }
    assert.equal(status, 503, 'the server is starting');
    const test = await starting;
    const page = await connectTestPage(t, d, test.server);
    const list = await page.next('list', 'the first list');
    assert.deepEqual(
      list.terminals.map((term) => [term.id, term.state]),
      [[keeper.spec.id, 'running']],
      'the first list has the terminal found',
    );
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, 'this session is already open in the window');
    assert.equal(test.server.hub.list().length, 1, 'no second terminal');
  });

  test('POST /shutdown while the server starts: it stops once the start is done', async (t) => {
    const d = serverSandbox(t);
    const held = heldStart();
    const starting = d.start({ platform: held.change });
    try {
      await within(held.reached, 'the start reaching its python3 check', WAIT_MS);
      await controlClient(d.platform.net, d.files.serverSock).shutdown();
    } finally {
      await finishStart(held, starting);
    }
    const test = await starting;
    assert.equal(await within(test.server.done, 'the stop asked for during the start', WAIT_MS), 0);
    assert.equal(existsSync(d.files.serverJson), false);
    assert.equal(d.deck.store.getKv('window_server'), null);
  });
});

describe('what the server wires together', () => {
  test('an exit is settled: a resumed program that ends before it reports a start gives its lock back', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    failingClaude(d);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(
      () => test.server.hub.list().some((term) => term.exit?.code === 3),
      'the program ended',
      WAIT_MS,
    );
    // Two ticks; the lock itself would hold for 60 s.
    await until(() => readLock(d.deck, S1) === null, 'the lock given back', WAIT_MS);
  });

  test('an exit not settled yet when the server stops is settled by the stop', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    failingClaude(d);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(
      () => test.server.hub.list().some((term) => term.exit !== null),
      'the program ended',
      WAIT_MS,
    );
    await test.server.stop('at once'); // before the next refresh tick could settle it
    assert.equal(readLock(d.deck, S1), null, 'the stop gave the lock back');
  });

  test('the interop link is pointed before the first keep-alive check (S2 6.4; task 19)', async (t) => {
    const d = serverSandbox(t, { env: { WSL_DISTRO_NAME: 'Test' }, window: { keepAlive: 'wsl' } });
    const socket = await listeningSocket(t, join(d.s.root, 'interop-socket'));
    const envs: (string | undefined)[] = [];
    await d.start({
      interopFirst: socket.path,
      platform: (p) => ({
        ...p,
        processes: {
          startDetached(command, args, options) {
            if (command !== WSL_EXE) return p.processes.startDetached(command, args, options);
            envs.push(options.env.WSL_INTEROP); // nothing is started: a wsl.exe that runs on
            return Promise.resolve({ pid: 2147483646, exited: new Promise(() => {}) });
          },
          signal: () => false,
        },
      }),
    });
    assert.deepEqual(envs, [d.files.interop], 'the first wsl.exe already has the link');
    assert.equal(realpathSync(d.files.interop), socket.path);
  });

  test('the interop link is pointed again when a terminal opens (S2 6.4)', async (t) => {
    const d = serverSandbox(t);
    const path = join(d.s.root, 'interop-socket');
    d.resumable(S1);
    const test = await d.start({ interopFirst: path });
    assert.equal(existsSync(d.files.interop), false, 'nothing accepts yet: no link');
    await listeningSocket(t, path);
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, true, JSON.stringify(result));
    const start = await waitForRecord(d.record, (record) => record.ev === 'start', WAIT_MS);
    assert.ok(start.ev === 'start');
    assert.equal(start.env.WSL_INTEROP, d.files.interop);
  });

  test("an action's own writes reload the rows (A24's sixth trigger)", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => listed(list, S1), 'the first list');
    // A transcript that only the action's refresh (prepareResumeById) saves: the tick's next
    // refresh then finds nothing new, and no change mark moves.
    d.resumable(S2, join(d.s.home, 'other'));
    const result = await page.act({ kind: 'resume', sessionId: S3, cols: 80, rows: 24 });
    assert.equal(result.ok, false, 'S3 is no session');
    await page.list((list) => listed(list, S2), 'the new session listed', WAIT_MS);
  });

  test("a late keeper's decision reloads the rows (A24's sixth trigger)", async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    // A program that writes no live file and does not end: nothing but the decision's own
    // refresh changes the store, and no change mark moves.
    claudeCommandScript(d, 'claude-sleeps', '#!/bin/sh\nexec sleep 120\n');
    // The keeper's socket refuses connections for 6 s after the first try: its hello comes after
    // spawn's 5 s, as a late one, and goes through decideFoundKeeper (which refreshes).
    let unblockAt: number | null = null;
    const test = await d.start({
      platform: (p) => ({
        ...p,
        net: {
          ...p.net,
          async connectUnix(path) {
            if (path.startsWith(`${d.files.termsDir}/`)) {
              unblockAt ??= performance.now() + 6000;
              if (performance.now() < unblockAt) {
                throw Object.assign(new Error('refused for the test'), { code: 'ECONNREFUSED' });
              }
              if (!existsSync(join(d.s.claudeHome, 'projects', 'project', `${S2}.jsonl`))) {
                // Only the decision's refresh can save it before the tick's refresh comes.
                d.resumable(S2, join(d.s.home, 'other'));
              }
            }
            return p.net.connectUnix(path);
          },
        },
      }),
    });
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, false, 'no hello within 5 s: answered as a timeout');
    await until(
      () => test.server.hub.list().some((term) => term.program !== null),
      'the late keeper started its program',
      WAIT_MS,
    );
    await page.list((list) => listed(list, S2), 'the new session listed', WAIT_MS);
  });

  test('a launch token presented a second time raises the alarm (window_alarm)', async (t) => {
    const d = serverSandbox(t);
    const test = await d.start();
    const minted = await controlClient(d.platform.net, d.files.serverSock).token(30);
    const token = Buffer.from(minted.token, 'base64url');
    assert.equal(await presentToken(t, test.server.port, token), 0, 'the first use is welcomed');
    assert.equal(d.deck.store.getKv('window_alarm'), null);
    assert.equal(await presentToken(t, test.server.port, token), 4004, 'the second is refused');
    assert.match(d.deck.store.getKv('window_alarm') ?? '', /^[1-9][0-9]*$/, 'the alarm is raised');
  });

  test('a launch hello that meets a locked store is closed 1013 and uses up no token: the same token is welcomed at the next hello, and no alarm is raised (ruled, task 26)', async (t) => {
    const d = serverSandbox(t);
    const test = await d.start();
    const client = controlClient(d.platform.net, d.files.serverSock);
    const minted = await client.token(30);
    const token = Buffer.from(minted.token, 'base64url');
    const lock = holdWriteLock(t, d);
    await lock.held;

    assert.equal(await presentToken(t, test.server.port, token), 1013, 'busy: try again later');
    assert.equal(await client.tokenState(minted.id), 'waiting', 'the token still waits');
    lock.release();
    d.deck.store.transaction(() => {}); // waits until the other skydeck has let go

    assert.equal(await presentToken(t, test.server.port, token), 0, 'the same token is welcomed');
    assert.equal(await client.tokenState(minted.id), 'used');
    assert.equal(d.deck.store.getKv('window_alarm'), null, 'no alarm');
  });

  test('the pull requests of the sessions a page lists are refreshed automatically (design 7.3)', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    d.resumable(S2, join(d.s.home, 'other'));
    attachManualPr(d.deck, S1, 'https://github.com/o/r/pull/1');
    const asked: (readonly string[])[] = [];
    const test = await d.start({
      platform: (p) => ({
        ...p,
        runner: {
          ...p.runner,
          run(command, args, options) {
            if (command !== 'gh') return p.runner.run(command, args, options);
            asked.push(args);
            return Promise.resolve({
              code: 1,
              stdout: '',
              stderr: 'not here',
              timedOut: false,
              notFound: false,
            });
          },
        },
      }),
    });
    assert.equal(asked.length, 0, 'nothing is asked while no page lists anything');
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => rowsOf(list).length === 2, 'both sessions listed');
    await until(() => asked.length > 0, 'gh asked', WAIT_MS);
    assert.ok(asked[0]?.includes('n0=1'), JSON.stringify(asked[0]));
  });
});

describe('the store (S2 10.1, 14)', () => {
  test('migrated by another connection: the next write is refused, every page gets bye with the update text, done is 0, nothing written', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => listed(list, S1), 'the first list');
    const lock = d.deck.store.getKv('window_server');
    const db = new DatabaseSync(join(d.s.skydeckHome, 'data', 'skydeck.db'));
    db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();
    d.resumable(S2); // a transcript the next refresh must save
    const bye = await page.next('bye', 'the bye', WAIT_MS);
    assert.equal(bye.reason, 'skydeck was updated; run skydeck window');
    assert.equal(await within(test.server.done, 'the stop', WAIT_MS), 0);
    assert.equal(
      d.deck.store.transcripts().some((row) => row.sessionId === S2),
      false,
      'the transcript was not saved',
    );
    assert.equal(d.deck.store.getKv('window_server'), lock, 'not even the lock was removed');
    assert.equal(existsSync(d.files.serverJson), false);
  });

  test('locked by another skydeck: the server never freezes, terminals keep flowing; one notice tick-failed; an action and a hello are told to try again; once free the list updates', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const { page, termId } = await resumedAndTyped(t, d, test);
    await page.list((list) => listed(list, S1), 'the first list');

    const lock = holdWriteLock(t, d);
    await lock.held;
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    d.resumable(S2); // the refresh must write, and meets the lock
    const notice = await page.next('notice', 'the tick-failed notice', WAIT_MS);
    assert.equal(notice.kind, 'tick-failed');
    assert.equal(notice.term, null);
    assert.match(notice.text, /^skydeck could not refresh the list: .+; it tries again$/);

    // The terminals do not depend on the store (S2 14): typing is echoed at once.
    const before = page.all.length;
    const sent = performance.now();
    page.send({ t: 'input', term: termId, data: 'flowing' });
    await until(
      () =>
        page.all
          .slice(before)
          .some((item) => 'binary' in item && Buffer.from(item.binary).includes('flowing')),
      'the echo while the store is locked',
      WAIT_MS,
    );
    assert.ok(performance.now() - sent < 2000, 'echoed within 2 s');

    // An action and a hello that need the store are told to try again.
    const result = await page.act({ kind: 'resume', sessionId: S2, cols: 80, rows: 24 });
    assert.deepEqual(
      { ok: result.ok, error: result.error },
      { ok: false, error: "skydeck's database is busy; try again" },
    );
    assert.equal(
      await helloCloseCode(t, d, test.server.port),
      1013,
      'a page that cannot read the secret now',
    );

    await sleep(4000); // two more refreshes meet the lock
    delay.disable();
    lock.release();
    // Ruled (review 2): never blocked for long — 250 ms per piece of work, not the 5 s of commands.
    assert.ok(delay.max / 1e6 < 1500, `the loop was blocked ${Math.round(delay.max / 1e6)} ms`);
    await page.list((list) => listed(list, S2), 'the list with the new session', WAIT_MS);
    assert.equal(
      page.all.filter((item) => 'text' in item && item.text.t === 'notice').length,
      1,
      'one notice only',
    );
    assert.equal(
      test.logs().filter((line) => line.includes('tick: the refresh failed')).length,
      1,
      'one log line while it lasts',
    );
  });

  test('a start that meets a store another process keeps locked fails at once with a line that says so, and leaves nothing (ruled)', async (t) => {
    const d = serverSandbox(t);
    const lock = holdWriteLock(t, d);
    await lock.held;
    const began = performance.now();
    await assert.rejects(d.start(), (error: unknown) => {
      assert.ok(error instanceof SkydeckError && !(error instanceof ServeExit), String(error));
      assert.equal(
        error.message,
        "the window's server cannot start: skydeck's database is busy (another skydeck holds it); try again",
      );
      return true;
    });
    assert.ok(performance.now() - began < 3000, 'without waiting out 5 s');
    lock.release();
    assert.equal(d.deck.store.getKv('window_server'), null, 'no lock');
    for (const path of [d.files.serverJson, d.files.serverPid, d.files.serverSock]) {
      assert.equal(existsSync(path), false, `no ${path}`);
    }
  });

  test('a found keeper whose decision meets a locked store is not refused: it is decided again once the store is free', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    claudeCommandScript(d, 'claude-sleeps', '#!/bin/sh\nexec sleep 120\n');
    // The keeper's socket refuses connections until the test opens it (after spawn's 5 s): its
    // hello comes late, through decideFoundKeeper, while another process holds the write lock.
    let shut = true;
    const test = await d.start({
      platform: (p) => ({
        ...p,
        net: {
          ...p.net,
          async connectUnix(path) {
            if (shut && path.startsWith(`${d.files.termsDir}/`)) {
              throw Object.assign(new Error('refused for the test'), { code: 'ECONNREFUSED' });
            }
            return p.net.connectUnix(path);
          },
        },
      }),
    });
    const page = await connectTestPage(t, d, test.server);
    const result = await page.act({ kind: 'resume', sessionId: S1, cols: 80, rows: 24 });
    assert.equal(result.ok, false, 'no hello within 5 s: answered as a timeout');
    // In this order (review 2): the lock first, then what the decision's refresh must write, then
    // the socket — so that no refresh can save it before the decision meets the lock.
    const lock = holdWriteLock(t, d);
    await lock.held;
    d.resumable(S2, join(d.s.home, 'other'));
    shut = false;
    await until(
      () => test.logs().some((line) => line.includes('the store is busy; decided later')),
      'the decision put off',
      WAIT_MS,
    );
    const [term] = test.server.hub.list();
    assert.ok(term !== undefined);
    assert.equal(term.exit, null, 'not refused');
    assert.equal(term.program, null, 'not started either');
    lock.release();
    await until(
      () => test.server.hub.list().some((candidate) => candidate.program !== null),
      'started once the store is free',
      WAIT_MS,
    );
  });
});

describe('the keep-alive (S2 6.1, 6.2)', () => {
  test('one that cannot start: welcome and status say failed; a retry that fails another way tells the pages once', async (t) => {
    // wsl.exe is refused by the test platform (A32): nothing is started. From the second start
    // on, the wrapper fails it with another reason (and starts nothing either).
    const d = serverSandbox(t, { env: { WSL_DISTRO_NAME: 'Test' }, window: { keepAlive: 'wsl' } });
    let starts = 0;
    const test = await d.start({
      platform: (p) => ({
        ...p,
        processes: {
          ...p.processes,
          startDetached(command, args, options) {
            if (command.endsWith('wsl.exe') && ++starts > 1) {
              return Promise.reject(Object.assign(new Error('no wsl.exe'), { code: 'ENOENT' }));
            }
            return p.processes.startDetached(command, args, options);
          },
        },
      }),
    });
    const page = await connectTestPage(t, d, test.server);
    assert.equal(page.welcome.keepAlive.mode, 'wsl');
    assert.equal(page.welcome.keepAlive.state, 'failed');
    assert.match(page.welcome.keepAlive.error ?? '', /^wsl\.exe could not be started: EWINDOWS/);
    const status = await controlClient(d.platform.net, d.files.serverSock).status();
    assert.equal(status.keepAlive.state, 'failed');

    const notice = await page.next('notice', 'the keepalive-lost notice', WAIT_MS);
    assert.deepEqual(
      { kind: notice.kind, term: notice.term, text: notice.text },
      {
        kind: 'keepalive-lost',
        term: null,
        text: 'WSL is not kept running: wsl.exe could not be started: ENOENT; skydeck tries again',
      },
    );
    assert.equal(starts, 2, 'the retry came after 5 s');
  });

  test('keepAliveNotices: lost when it fails with a new reason, back when it runs again', () => {
    const notices = keepAliveNotices();
    const state = (s: 'running' | 'starting' | 'failed', error: string | null = null) => ({
      mode: 'wsl' as const,
      state: s,
      since: '1',
      error,
    });
    assert.equal(notices(state('running')), null, 'running from the start: nothing to say');
    assert.deepEqual(notices(state('failed', 'gone')), {
      kind: 'keepalive-lost',
      text: 'WSL is not kept running: gone; skydeck tries again',
    });
    assert.equal(notices(state('starting')), null);
    assert.equal(notices(state('failed', 'gone')), null, 'the same reason again');
    assert.deepEqual(notices(state('failed', 'other')), {
      kind: 'keepalive-lost',
      text: 'WSL is not kept running: other; skydeck tries again',
    });
    assert.deepEqual(notices(state('running')), {
      kind: 'keepalive-back',
      text: 'WSL is kept running again',
    });
    assert.equal(notices(state('running')), null);
    assert.deepEqual(
      notices(state('failed', 'gone')),
      {
        kind: 'keepalive-lost',
        text: 'WSL is not kept running: gone; skydeck tries again',
      },
      'after it ran, the old reason is new again',
    );
  });
});
