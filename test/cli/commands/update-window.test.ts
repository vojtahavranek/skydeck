// `skydeck update` with a REAL window server (F8, U5 and U8: the order with a server). The
// checkout is a throwaway git repository holding a copy of skydeck (test/helpers/git-checkout.ts),
// whose server a `skydeck window --print-url` of this test starts (a real `bin/skydeck serve` of
// that copy, in a server sandbox: port 0, the interop candidate in the sandbox, the fake Edge);
// a page in mode key stands for the window. The update runs in the test process; the new server is
// started by the child it runs, the copy's own `bin/skydeck window`. Nothing reaches the network,
// no Windows program is started (A32), and no real window is opened.
//
// Cleanup, registered before the sandbox's (t.after is first in, first out): the server that runs
// at the end is stopped as `--stop` stops it, with signals only to a node process whose command
// line runs this test's copy of skydeck; then the server sandbox's own cleanup.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { realPlatform } from '../../../src/platform/real.ts';
import type { Platform, Processes, Runner } from '../../../src/platform/types.ts';
import { controlClient } from '../../../src/window/client.ts';
import { stopServer } from '../../../src/window/lifecycle.ts';
import { readServerJson } from '../../../src/window/runtime.ts';
import type { ServerJson } from '../../../src/window/runtime.ts';
import { present } from '../../fixtures/fake-edge/page.ts';
import type { Presented } from '../../fixtures/fake-edge/page.ts';
import { gitCheckout, gitTestEnv } from '../../helpers/git-checkout.ts';
import type { GitCheckout } from '../../helpers/git-checkout.ts';
import { run as runSkydeck } from '../../helpers/install.ts';
import { sleep, until } from '../../helpers/keeper.ts';
import { runUpdate } from '../../helpers/update.ts';
import { serverSandbox, untilStartDone, WAIT_MS } from '../../helpers/window.ts';
import type { ServerSandbox } from '../../helpers/window.ts';

const FAKE_EDGE = fileURLToPath(new URL('../../fixtures/fake-edge/msedge', import.meta.url));
/** window.profileDir: nothing is derived from a Windows folder. */
const PROFILE = 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile';
/** A start on a loaded machine; a page wait no passing case waits out; the old window's wait. */
const TIMES = 'startMs=30000,pageMs=20000,reuseMs=1000,reconnectMs=15000';

interface Harness {
  d: ServerSandbox;
  c: GitCheckout;
  /** The checkout's real path: the app root of every command. */
  root: string;
  /** The working directory of every command. */
  project: string;
  /** What happened, in order: `POST /shutdown`, `git <sub>`, `launch <program> <args>`. */
  events: string[];
  platform: Platform;
  edgeRuns(): string[];
  /** server.json once its server answers and its start is done. */
  running(): Promise<ServerJson>;
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

function harness(t: TestContext): Harness {
  const real = realPlatform({ refuseWindows: true });
  let h: Harness | null = null;
  t.after(async () => {
    if (h === null) return;
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
      // The sandbox's own cleanup ends what is left of the keepers; a server without its
      // SKYDECK_HOME ends itself.
    }
  });
  const d = serverSandbox(t, { window: { edge: FAKE_EDGE, profileDir: PROFILE } });
  d.s.link('mktemp'); // the launcher's handoff file
  const c = gitCheckout(d.s, { content: 'skydeck' });
  const root = realpathSync(c.root);
  const project = join(d.s.root, 'project');
  mkdirSync(project);
  const tmp = join(d.s.root, 'tmp');
  mkdirSync(tmp);
  const edgeRecord = join(d.s.root, 'records', 'edge.jsonl');
  const events: string[] = [];
  const env = Object.fromEntries(
    Object.entries({
      ...d.platform.env,
      ...gitTestEnv(d.s),
      SKYDECK_NODE: process.execPath,
      SKYDECK_TEST_PORT: '0',
      SKYDECK_TEST_INTEROP_FIRST: d.interopFirst,
      SKYDECK_TEST_WINDOW_TIMES: TIMES,
      TMPDIR: tmp,
      FAKE_EDGE_RECORD: edgeRecord,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const runner: Runner = {
    run(command, args, options) {
      if (command === 'git' && args.includes('merge')) events.push('git merge');
      return d.platform.runner.run(command, args, options);
    },
    runInteractive(command, args, options) {
      events.push(
        command === 'git' ? `git ${args[2] ?? ''}` : `launch ${command} ${args.join(' ')}`,
      );
      return d.platform.runner.runInteractive(command, args, options);
    },
  };
  const platform: Platform = {
    ...d.platform,
    env,
    cwd: project,
    appRoot: root,
    runner,
    net: {
      ...d.platform.net,
      requestUnix(path, request) {
        if (request.path === '/shutdown') events.push('POST /shutdown');
        return d.platform.net.requestUnix(path, request);
      },
    },
  };
  const server = (): ServerJson | null => readServerJson(d.platform.files, d.files.serverJson);
  h = {
    d,
    c,
    root,
    project,
    events,
    platform,
    edgeRuns: () => {
      try {
        return readFileSync(edgeRecord, 'utf8').split('\n').slice(0, -1);
      } catch {
        return [];
      }
    },
    server,
    async running() {
      const deadline = performance.now() + WAIT_MS;
      for (;;) {
        const json = server();
        const ping = await controlClient(d.platform.net, d.files.serverSock)
          .ping(1000)
          .catch(() => null);
        if (json !== null && typeof ping === 'object' && ping?.pid === json.pid) {
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

/** The secret's bytes, as a page holding the key presents them. */
function secretOf(h: Harness): Uint8Array {
  const secret = h.d.deck.store.getKv('window_secret');
  assert.ok(secret !== null);
  return new Uint8Array(Buffer.from(secret, 'base64url'));
}

/** A page of the running server in mode key, kept open until the test ends; once it is recorded. */
async function openPage(t: TestContext, h: Harness, json: ServerJson): Promise<void> {
  const presented = await present(json.port, secretOf(h), 'key');
  assert.equal(presented.outcome, 'welcome');
  if (presented.outcome === 'welcome') {
    const { ws } = presented;
    t.after(() => {
      ws.terminate();
    });
  }
  // The server's refresh records it (plan C20): the next server then expects the window back.
  await until(
    () => h.d.deck.store.getKv('window_pages_open') === '1',
    'the running server recorded its page (window_pages_open)',
    WAIT_MS,
  );
}

/**
 * The window coming back after its server was stopped (S2 6.3): once a server other than `oldPid`
 * has written server.json, a page connects to its port in mode key with the stored secret, trying
 * again on the 503 of a start that is not done. Closed when the test ends.
 */
function comingBack(t: TestContext, h: Harness, oldPid: number): Promise<Presented> {
  const done = (async (): Promise<Presented> => {
    const deadline = performance.now() + 2 * WAIT_MS;
    for (;;) {
      const json = h.server();
      if (json !== null && json.pid !== oldPid) return present(json.port, secretOf(h), 'key');
      if (performance.now() > deadline) assert.fail('no new server to come back to');
      await sleep(50);
    }
  })();
  t.after(async () => {
    const presented = await done.catch(() => null);
    if (presented?.outcome === 'welcome') presented.ws.terminate();
  });
  return done;
}

const short = (id: string): string => id.slice(0, 7);

describe('skydeck update with a real window server (U5, U8)', () => {
  test('a window open: the server stopped before the merge, the new code’s server started after it by the copy’s own launcher; the window comes back — no Edge', async (t) => {
    const h = harness(t);
    const old = h.c.id();
    const made = h.c.push('a new module', { 'src/added.ts': 'export {};\n' });
    const opened = await runSkydeck(h.platform, ['window', '--print-url']);
    assert.equal(opened.code, 0, opened.stderr);
    const before = await h.running();
    assert.equal(before.checkout, h.root);
    await openPage(t, h, before);
    const back = comingBack(t, h, before.pid);

    const r = await runUpdate(h.platform, h.d.s);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      `1 new commit on origin/main (${short(old)}..${short(made)}):\n  ${short(made)}  a new module\nupdated to ${short(made)}\n`,
    );
    assert.equal(
      r.stderr,
      "skydeck: stopped skydeck's window server; 0 terminals in the window keep running\n",
    );
    assert.deepEqual(h.events, [
      'git fetch',
      'POST /shutdown',
      'git merge',
      `launch ${join(h.root, 'bin', 'skydeck')} window`,
    ]);
    assert.equal((await back).outcome, 'welcome', 'the window came back to the new server');
    const after = h.server();
    assert.ok(after !== null);
    assert.notEqual(after.pid, before.pid, 'a new server');
    assert.notEqual(after.build, before.build, 'of the new code');
    assert.equal(after.checkout, h.root);
    assert.equal(h.c.id(), made);
    assert.deepEqual(h.edgeRuns(), [], 'no Edge: the window that was open came back');
  });

  test('no window open: the server stopped, the update merged, nothing started', async (t) => {
    const h = harness(t);
    const made = h.c.push('a new module', { 'src/added.ts': 'export {};\n' });
    const opened = await runSkydeck(h.platform, ['window', '--print-url']);
    assert.equal(opened.code, 0, opened.stderr);
    await h.running();

    const r = await runUpdate(h.platform, h.d.s);

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`\\nupdated to ${short(made)}\\n$`));
    assert.equal(
      r.stderr,
      "skydeck: stopped skydeck's window server; 0 terminals in the window keep running\n" +
        "skydeck: the window's server was stopped for the update; skydeck window starts it again\n",
    );
    assert.deepEqual(h.events, ['git fetch', 'POST /shutdown', 'git merge']);
    assert.equal(h.server(), null, 'no server');
    assert.equal(h.c.id(), made);
    assert.deepEqual(h.edgeRuns(), []);
  });
});
