// The failures of S2 14 that can happen inside Linux, and the stop of S2 5.5 (plan task 23):
// python3 missing, the server stopped and started again, the server dropped as a crash leaves it,
// a store migrated under the server, a locked store, a keep-alive that cannot start. In the test
// process (A19) on realTestPlatform, with real keepers running the stand-in.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Terminal } from '@xterm/headless';
import WebSocket from 'ws';

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
import { keepAliveNotices } from '../../src/window/server.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import { sleep, until, within } from '../helpers/keeper.ts';
import { freshNonce } from '../helpers/pages.ts';
import { S1, S2 } from '../helpers/platform.ts';
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
      await p.closed;
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
    await page.closed;
    assert.equal(existsSync(d.files.serverJson), true, 'a crash leaves server.json');
    await rediscovered(t, d, termId, screen);
  });
});

describe('while the server starts (S2 5.2, 7.3)', () => {
  test('a page that connects before the keepers are found waits for them: no second terminal of a session', async (t) => {
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
    await held.reached;
    assert.ok(held.port() > 0, 'the port is bound');
    let connected = false;
    const connecting = connectTestPage(t, d, { port: held.port() }).then((page) => {
      connected = true;
      return page;
    });
    await sleep(500);
    assert.equal(connected, false, 'the page waits while the server starts');
    held.open();
    const test = await starting;
    const page = await connecting;
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
    await held.reached;
    await controlClient(d.platform.net, d.files.serverSock).shutdown();
    held.open();
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
    const script = join(d.s.bin, 'claude-fails');
    writeFileSync(script, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const configPath = join(d.s.skydeckHome, 'config', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, claudeCommand: script }));
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
    await until(() => readLock(d.deck, S1) === null, 'the lock given back', 6000);
  });

  test('a launch token presented a second time raises the alarm (window_alarm)', async (t) => {
    const d = serverSandbox(t);
    const test = await d.start();
    const minted = await controlClient(d.platform.net, d.files.serverSock).token(30);
    const token = Buffer.from(minted.token, 'base64url');
    const origin = `http://127.0.0.1:${test.server.port}`;
    const present = async (): Promise<number> => {
      const ws = new WebSocket(`ws://127.0.0.1:${test.server.port}/ws`, { origin });
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
      const answer = await Promise.race([
        new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data)))),
        closed.then((code) => `closed ${code}`),
      ]);
      if (answer.includes('"welcome"')) {
        ws.close();
        return 0;
      }
      return closed;
    };
    assert.equal(await present(), 0, 'the first use is welcomed');
    assert.equal(d.deck.store.getKv('window_alarm'), null);
    assert.equal(await present(), 4004, 'the second is refused');
    assert.match(d.deck.store.getKv('window_alarm') ?? '', /^[1-9][0-9]*$/, 'the alarm is raised');
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

  test('locked by another skydeck: one notice tick-failed, not repeated; once it is free the list updates again', async (t) => {
    const d = serverSandbox(t);
    d.resumable(S1);
    const test = await d.start();
    const page = await connectTestPage(t, d, test.server);
    await page.list((list) => listed(list, S1), 'the first list');

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
    await new Promise<void>((resolve) => holder.once('message', () => resolve()));
    d.resumable(S2); // the refresh must write, and waits out the busy timeout
    const notice = await page.next('notice', 'the tick-failed notice', 30_000);
    assert.equal(notice.kind, 'tick-failed');
    assert.equal(notice.term, null);
    assert.match(notice.text, /^skydeck could not refresh the list: .+; it tries again$/);
    await sleep(12_000); // two more refreshes fail (each waits out the 5 s busy timeout)
    release();
    await page.list((list) => listed(list, S2), 'the list with the new session', 30_000);
    assert.equal(
      page.all.filter((item) => 'text' in item && item.text.t === 'notice').length,
      1,
      'one notice only',
    );
    assert.ok(
      test.logs().some((line) => line.includes('tick: the refresh failed')),
      test.logs().join('\n'),
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
