// The failures of S2 14 that can happen inside Linux, and the stop of S2 5.5 (plan task 23):
// python3 missing, the server stopped and started again, the server dropped as a crash leaves it,
// a store migrated under the server, a locked store, a keep-alive that cannot start. In the test
// process (A19) on realTestPlatform, with real keepers running the stand-in.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Terminal } from '@xterm/headless';

import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { controlClient } from '../../src/window/client.ts';
import type { ListMessage, SnapMessage } from '../../src/window/protocol.ts';
import { listKeeperLines } from '../../src/window/runtime.ts';
import { keepAliveNotices } from '../../src/window/server.ts';
import { loadXterm } from '../../src/window/xterm.ts';
import { sleep, until } from '../helpers/keeper.ts';
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
    assert.equal(await test.server.done, 0);
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
