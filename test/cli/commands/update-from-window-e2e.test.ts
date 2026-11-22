// Update now end to end (F38, milestone 2; S2 16.5 "Update now"): a REAL window server of a
// throwaway copy of skydeck (test/helpers/git-checkout.ts, `content: 'skydeck'`), started by the
// copy's own `skydeck window --print-url` in a server sandbox (port 0, the interop candidate in the
// sandbox, the fake Edge), its checker naming that copy through the seam (updateSeam), its only
// remote a bare repository beside it. A page in mode key stands for the window and sends the acts.
// The server starts the real updater, the copy's `bin/skydeck update --from-window <commit>`; it
// stops the server, fast-forwards the copy and runs the copy's `skydeck window`, which starts the
// new server. Nothing reaches the network, no Windows program is started (A32), no real window is
// opened, and nothing outside the sandbox is touched.
//
// Cleanup, as update-window.test.ts's: the server that runs at the end is stopped as `--stop` stops
// it, with signals only to a node process whose command line runs this test's copy; then the
// server sandbox's own cleanup.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type WebSocket from 'ws';

import { realPlatform } from '../../../src/platform/real.ts';
import type { Platform, Processes } from '../../../src/platform/types.ts';
import { controlClient } from '../../../src/window/client.ts';
import { serverEnvironment } from '../../../src/window/env.ts';
import { stopServer } from '../../../src/window/lifecycle.ts';
import type { ServerMessage, UpdatePayload } from '../../../src/window/protocol.ts';
import { readServerJson } from '../../../src/window/runtime.ts';
import type { ServerJson } from '../../../src/window/runtime.ts';
import { present } from '../../fixtures/fake-edge/page.ts';
import { gitCheckout, gitTestEnv } from '../../helpers/git-checkout.ts';
import type { GitCheckout } from '../../helpers/git-checkout.ts';
import { run as runSkydeck } from '../../helpers/install.ts';
import { procStartOf, sleep, stillRuns, until } from '../../helpers/keeper.ts';
import { killKeepersIn } from '../../helpers/kill.ts';
import { readRecords } from '../../helpers/standin.ts';
import { updateSeam } from '../../helpers/update.ts';
import { serverSandbox, untilStartDone, WAIT_MS } from '../../helpers/window.ts';
import type { ServerSandbox } from '../../helpers/window.ts';

const FAKE_EDGE = fileURLToPath(new URL('../../fixtures/fake-edge/msedge', import.meta.url));
const PROFILE = 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile';
const TIMES = 'startMs=30000,pageMs=20000,reuseMs=1000,reconnectMs=15000';

interface Harness {
  d: ServerSandbox;
  c: GitCheckout;
  root: string;
  project: string;
  platform: Platform;
  edgeRuns(): string[];
  running(notPid?: number): Promise<ServerJson>;
  server(): ServerJson | null;
}

/** Whether `pid` is a node process running this test's copy of skydeck (`bootstrap.mjs serve`). */
function servesCopy(pid: number, root: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return args.includes(join(root, 'bin', 'bootstrap.mjs')) && args.includes('serve');
  } catch {
    return false;
  }
}

/** The server that runs, stopped as `--stop` stops it, signals only to this copy's server. */
async function stopCopy(h: Harness): Promise<void> {
  const real = realPlatform({ refuseWindows: true });
  const { d, root } = h;
  const processes: Processes = {
    startDetached: () => Promise.reject(new Error('the cleanup starts nothing')),
    signal: (pid, signal) => (servesCopy(pid, root) ? real.processes.signal(pid, signal) : false),
  };
  try {
    await stopServer(
      { ...d.deck, platform: { ...d.deck.platform, processes } },
      { stopMs: 15_000 },
    );
  } catch {
    // The sandbox's own cleanup ends what is left of the keepers.
  }
}

function harness(t: TestContext): Harness {
  let h: Harness | null = null;
  t.after(async () => {
    if (h !== null) await stopCopy(h);
  });
  const d = serverSandbox(t, { window: { edge: FAKE_EDGE, profileDir: PROFILE } });
  d.s.link('mktemp'); // the launcher's handoff file
  const c = gitCheckout(d.s, { content: 'skydeck' });
  const root = c.root;
  const project = join(d.s.root, 'project');
  mkdirSync(project);
  const tmp = join(d.s.root, 'tmp');
  mkdirSync(tmp);
  const edgeRecord = join(d.s.root, 'records', 'edge.jsonl');
  const env = Object.fromEntries(
    Object.entries({
      ...d.platform.env,
      ...gitTestEnv(d.s),
      ...updateSeam(d.s, c),
      SKYDECK_NODE: process.execPath,
      SKYDECK_TEST_PORT: '0',
      SKYDECK_TEST_INTEROP_FIRST: d.interopFirst,
      SKYDECK_TEST_WINDOW_TIMES: TIMES,
      TMPDIR: tmp,
      FAKE_EDGE_RECORD: edgeRecord,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const platform: Platform = { ...d.platform, env, cwd: project, appRoot: root };
  const server = (): ServerJson | null => readServerJson(d.platform.files, d.files.serverJson);
  h = {
    d,
    c,
    root,
    project,
    platform,
    edgeRuns: () => {
      try {
        return readFileSync(edgeRecord, 'utf8').split('\n').slice(0, -1);
      } catch {
        return [];
      }
    },
    server,
    async running(notPid) {
      const deadline = performance.now() + 2 * WAIT_MS;
      for (;;) {
        const json = server();
        const ping = await controlClient(d.platform.net, d.files.serverSock)
          .ping(1000)
          .catch(() => null);
        if (
          json !== null &&
          json.pid !== notPid &&
          typeof ping === 'object' &&
          ping?.pid === json.pid
        ) {
          await untilStartDone(() => d.serverLog().join('\n'), json.serverId);
          return json;
        }
        if (performance.now() > deadline) assert.fail('no server answering with its server.json');
        await sleep(50);
      }
    },
  };
  return h;
}

function secretOf(h: Harness): Uint8Array {
  const secret = h.d.deck.store.getKv('window_secret');
  assert.ok(secret !== null);
  return new Uint8Array(Buffer.from(secret, 'base64url'));
}

/** A page in mode key, its messages collected, its acts answered by id. */
interface TestWindow {
  ws: WebSocket;
  messages: ServerMessage[];
  act(action: Record<string, unknown>): Promise<Extract<ServerMessage, { t: 'result' }>>;
  /** The next `update` message whose state passes `test` (those that came already count). */
  update(test: (u: UpdatePayload) => boolean, what: string): Promise<UpdatePayload>;
}

let actIds = 0;

async function openWindow(t: TestContext, h: Harness, port: number): Promise<TestWindow> {
  const presented = await present(port, secretOf(h), 'key');
  assert.equal(presented.outcome, 'welcome');
  assert.ok(presented.outcome === 'welcome');
  const { ws } = presented;
  t.after(() => {
    ws.terminate();
  });
  const messages: ServerMessage[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(String(data)) as ServerMessage);
  });
  ws.send(JSON.stringify({ t: 'view', filter: '', unfolded: [], showDone: false, selected: null }));
  return {
    ws,
    messages,
    async act(action) {
      const id = ++actIds;
      ws.send(JSON.stringify({ t: 'act', id, ...action }));
      let found: Extract<ServerMessage, { t: 'result' }> | undefined;
      await until(
        () => {
          found = messages.find(
            (m): m is Extract<ServerMessage, { t: 'result' }> => m.t === 'result' && m.id === id,
          );
          return found !== undefined;
        },
        `the answer to act ${String(action['kind'])}`,
        2 * WAIT_MS,
      );
      assert.ok(found !== undefined);
      return found;
    },
    async update(test, what) {
      let found: UpdatePayload | undefined;
      await until(
        () => {
          found = messages
            .flatMap((m) => (m.t === 'update' ? [m.update] : []))
            .find((u) => test(u));
          return found !== undefined;
        },
        what,
        2 * WAIT_MS,
      );
      assert.ok(found !== undefined);
      return found;
    },
  };
}

/** The page that comes back: once a server other than `oldPid` answers, a page of it. */
async function comingBack(t: TestContext, h: Harness, oldPid: number): Promise<TestWindow> {
  const json = await h.running(oldPid);
  return openWindow(t, h, json.port);
}

/** `/proc/<pid>/environ` as the server's environment (serverEnvironment), SHLVL left out. */
function environmentOf(pid: number): Record<string, string> {
  const env = Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        const at = entry.indexOf('=');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
  );
  const made = serverEnvironment(env).env;
  // A /bin/sh that counts it (bash) adds to SHLVL at each launcher of the chain, as for the typed
  // command; dash does not. It is no variable a session depends on.
  delete made['SHLVL'];
  return made;
}

/** The raw SKYDECK_CORE_SOFT of `pid`'s environment. */
function coreSoftOf(pid: number): string | null {
  const entry = readFileSync(`/proc/${pid}/environ`, 'utf8')
    .split('\0')
    .find((e) => e.startsWith('SKYDECK_CORE_SOFT='));
  return entry === undefined ? null : entry.slice('SKYDECK_CORE_SOFT='.length);
}

/** The soft "Max core file size" of `pid`. */
function softCoreLimit(pid: number): string {
  const line = readFileSync(`/proc/${pid}/limits`, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Max core file size'));
  return line?.split(/\s+/)[4] ?? '';
}

/** The files under `dir` whose name ends with `.lock`. */
function locks(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.lock'));
}

const short = (id: string): string => id.slice(0, 7);

describe('Update now end to end: a real server, the real launcher, a real fast-forward', () => {
  test('applied: the old server ends, the copy is at the pushed commit, a new server of another build runs with the same environment and core limit, the page that comes back gets `updated to <id>`, the log ends with it, no Edge, a terminal keeps running', async (t) => {
    const h = harness(t);
    const opened = await runSkydeck(h.platform, ['window', '--print-url']);
    assert.equal(opened.code, 0, opened.stderr);
    const before = await h.running();
    const win = await openWindow(t, h, before.port);
    await until(
      () => h.d.deck.store.getKv('window_pages_open') === '1',
      'the server recorded its page',
      WAIT_MS,
    );
    // A terminal of the window, opened before the update.
    const started = await win.act({
      kind: 'new',
      dir: h.project,
      label: 'kept',
      group: '',
      flags: '',
      cols: 80,
      rows: 24,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    await until(
      () => readRecords(h.d.record).some((r) => r.ev === 'start'),
      'the stand-in started',
      WAIT_MS,
    );
    const standin = readRecords(h.d.record).find((r) => r.ev === 'start');
    assert.ok(standin !== undefined);
    const standinStart = procStartOf(standin.pid);
    assert.ok(standinStart !== null);
    const oldEnv = environmentOf(before.pid);
    const oldCoreSoft = coreSoftOf(before.pid);
    const oldStatus = await controlClient(h.d.platform.net, h.d.files.serverSock).status();

    const made = h.c.push('a change of the page', { 'web/added.txt': 'new\n' });
    const checked = await win.act({ kind: 'update-check' });
    assert.ok(checked.update?.check?.state === 'available', JSON.stringify(checked));
    assert.equal(checked.update.check.to, made);
    const applied = await win.act({ kind: 'update-apply', to: made });
    assert.equal(applied.ok, true, JSON.stringify(applied));

    const back = await comingBack(t, h, before.pid);
    const told = await back.update((u) => u.result !== null, 'the result after the update');
    assert.deepEqual(told.result, { ok: true, text: `updated to ${short(made)}` });
    const after = h.server();
    assert.ok(after !== null);
    assert.notEqual(after.pid, before.pid);
    assert.notEqual(after.build, before.build, 'another build');
    assert.equal(h.c.id(), made, 'HEAD of the copy is the pushed commit');
    assert.equal(procStartOf(before.pid), null, 'the old server has ended');
    // The updater's last line comes once its `skydeck window` has seen the page come back.
    const logPath = join(h.d.deck.places.stateDir, 'update.log');
    await until(
      () => readFileSync(logPath, 'utf8').endsWith(`\nupdated to ${short(made)}\n`),
      `update.log ends with updated to ${short(made)}`,
      2 * WAIT_MS,
    );
    assert.match(
      readFileSync(logPath, 'utf8'),
      new RegExp(` update to ${short(made)} started from the window\\n`),
    );
    assert.deepEqual(h.edgeRuns(), [], 'the Edge stub was not run');
    assert.deepEqual(
      environmentOf(after.pid),
      oldEnv,
      'the same environment, variable for variable',
    );
    assert.equal(softCoreLimit(after.pid), '1', "the new server's soft core limit is 1 byte");
    assert.equal(coreSoftOf(after.pid), oldCoreSoft, "SKYDECK_CORE_SOFT is the old server's");
    assert.deepEqual(locks(join(h.root, '.git')), []);
    const status = await controlClient(h.d.platform.net, h.d.files.serverSock).status();
    assert.equal(status.envOrigin.dir, oldStatus.envOrigin.dir);
    assert.ok(stillRuns(standin.pid, standinStart), 'the terminal opened before still runs');
    assert.equal(h.d.deck.store.getKv('window_update_run'), null, 'the entry was read and removed');

    // The terminal ends before the sandbox goes: the server stopped, its keeper killed, the
    // stand-in gone, so that nothing writes into the sandbox while it is removed.
    await stopCopy(h);
    killKeepersIn(h.d.s, h.d.box.runtimeDir);
    await until(() => !stillRuns(standin.pid, standinStart), 'the stand-in ended', WAIT_MS);
  });

  test('an untracked file where the new commit puts one: the merge is refused, a server of the same build comes back, the page gets the reason, HEAD unmoved', async (t) => {
    const h = harness(t);
    const opened = await runSkydeck(h.platform, ['window', '--print-url']);
    assert.equal(opened.code, 0, opened.stderr);
    const before = await h.running();
    const win = await openWindow(t, h, before.port);
    await until(
      () => h.d.deck.store.getKv('window_pages_open') === '1',
      'the server recorded its page',
      WAIT_MS,
    );
    const old = h.c.id();
    const made = h.c.push('add new.txt', { 'new.txt': 'from the remote\n' });
    writeFileSync(join(h.root, 'new.txt'), 'my own\n');
    const checked = await win.act({ kind: 'update-check' });
    assert.ok(checked.update?.check?.state === 'available', JSON.stringify(checked));
    assert.equal(checked.update.check.blocked, null, 'an untracked file blocks nothing');
    const applied = await win.act({ kind: 'update-apply', to: made });
    assert.equal(applied.ok, true, JSON.stringify(applied));

    const back = await comingBack(t, h, before.pid);
    const told = await back.update((u) => u.result !== null, 'the result after the update');
    assert.equal(told.result?.ok, false);
    assert.match(
      told.result?.text ?? '',
      /^the update could not be applied: error: .*; the checkout is as it was$/,
    );
    const after = h.server();
    assert.ok(after !== null);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.build, before.build, 'the same build');
    assert.equal(h.c.id(), old, 'HEAD unmoved');
    assert.equal(readFileSync(join(h.root, 'new.txt'), 'utf8'), 'my own\n');
    // The updater's last line comes once its `skydeck window` has seen the page come back: the
    // cleanup starts only after it, as in the first case.
    const logPath = join(h.d.deck.places.stateDir, 'update.log');
    await until(
      () => /; the checkout is as it was\n$/.test(readFileSync(logPath, 'utf8')),
      'update.log ends with the refused merge',
      2 * WAIT_MS,
    );
  });

  test('a tracked file changed between the check and the click: update-apply refused, nothing started, the server never stopped', async (t) => {
    const h = harness(t);
    const opened = await runSkydeck(h.platform, ['window', '--print-url']);
    assert.equal(opened.code, 0, opened.stderr);
    const before = await h.running();
    const win = await openWindow(t, h, before.port);
    const made = h.c.push('a change', { 'README.md': 'two\n' });
    const checked = await win.act({ kind: 'update-check' });
    assert.ok(checked.update?.check?.state === 'available', JSON.stringify(checked));
    writeFileSync(join(h.root, 'package.json'), '{}\n');

    const refused = await win.act({ kind: 'update-apply', to: made });

    assert.equal(refused.ok, false);
    assert.match(
      refused.error ?? '',
      /^this checkout has changes that are not committed .*; open the dialog again once that is set right$/,
    );
    await sleep(1500);
    assert.equal(h.server()?.pid, before.pid, 'the same server');
    assert.ok(procStartOf(before.pid) !== null, 'it still runs');
    assert.equal(h.d.deck.store.getKv('window_update_run'), null);
    assert.equal(
      existsSync(join(h.d.deck.places.stateDir, 'update.log')),
      false,
      'no updater was started',
    );
  });
});
