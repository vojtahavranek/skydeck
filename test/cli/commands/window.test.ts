// `skydeck window` (S2 5.1, 5.3, 8.2.2, 14; plan task 25). The command runs in the test process
// on a real test platform (A36); the server it starts is a real `bin/skydeck serve` of the
// repository (SKYDECK_TEST_PORT=0, the first interop candidate in the sandbox, A31, A32), and
// `window.edge` is the fake Edge of test/fixtures/fake-edge, which records its arguments and, when
// told, plays the page Edge would open (the handshake in mode launch, once or twice). Hung servers
// and servers of another checkout are the fake `serve` of test/fixtures/fake-serve, started by the
// test itself. No Windows program is ever started: the platform's processes refuse them (A32), and
// every start goes through a recorder.
//
// Cleanup, registered before the sandbox's (t.after is first in, first out): every fake Edge is
// killed through the handle the command's platform got for it; every server is stopped as
// `--stop` stops it, with signals only to the node process of a launcher this test's platform
// started; then the keepers (killKeepersIn, A34) and every program they started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parentPidFromStat } from '../../../src/claude/procstat.ts';
import { realPlatform } from '../../../src/platform/real.ts';
import type {
  Detached,
  Files,
  Net,
  Platform,
  Proc,
  Processes,
} from '../../../src/platform/types.ts';
import { controlClient } from '../../../src/window/client.ts';
import type { ControlClient } from '../../../src/window/client.ts';
import { stopServer } from '../../../src/window/lifecycle.ts';
import { pidLineState } from '../../../src/window/pidline.ts';
import { listKeeperLines, readServerJson } from '../../../src/window/runtime.ts';
import type { ServerJson } from '../../../src/window/runtime.ts';
import { present } from '../../fixtures/fake-edge/page.ts';
import type { Presented } from '../../fixtures/fake-edge/page.ts';
import { run as runSkydeck } from '../../helpers/install.ts';
import { procStartOf, sleep, stillRuns, until } from '../../helpers/keeper.ts';
import { killKeepersIn } from '../../helpers/kill.ts';
import { readRecords } from '../../helpers/standin.ts';
import { connectTestPage, serverSandbox, WAIT_MS } from '../../helpers/window.ts';
import type { ServerSandbox } from '../../helpers/window.ts';

const FAKE_EDGE = fileURLToPath(new URL('../../fixtures/fake-edge/msedge', import.meta.url));
const FAKE_SERVE = fileURLToPath(new URL('../../fixtures/fake-serve/bin/skydeck', import.meta.url));
/** The fixture app root whose bin/skydeck is the fake `serve` (task 22). */
const FAKE_ROOT = realpathSync(
  fileURLToPath(new URL('../../fixtures/fake-serve', import.meta.url)),
);
const REPOSITORY = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
/** window.profileDir of every test: nothing is derived from a Windows folder. */
const PROFILE = 'C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile';
/** The waits of `skydeck window` a test can set (A31): SKYDECK_TEST_WINDOW_TIMES. */
interface WindowTimes {
  pingMs?: number;
  startMs?: number;
  stopMs?: number;
  killMs?: number;
  pageMs?: number;
  reuseMs?: number;
  launchingMs?: number;
  reconnectMs?: number;
}
/**
 * The waits the tests give the command: a real server's start on a loaded machine; a page wait
 * that a passing case never waits out; a second-use wait shorter than the design's 2 s.
 */
const TIMES: WindowTimes = { startMs: 30_000, pageMs: 20_000, reuseMs: 1000, reconnectMs: 2000 };

/** `times` as SKYDECK_TEST_WINDOW_TIMES says it: `name=ms` pairs, separated by commas. */
function timesText(times: WindowTimes): string {
  return Object.entries(times)
    .map(([name, ms]) => `${name}=${String(ms)}`)
    .join(',');
}

// ---------------------------------------------------------------------------------------------
// The harness

interface StartedProgram {
  command: string;
  args: readonly string[];
  child: Detached;
  exited: boolean;
}

interface Request {
  method: string;
  path: string;
  body: unknown;
  answer: { status: number; body: unknown } | null;
  /** When it was sent (performance.now()). */
  atMs: number;
}

interface EdgeRun {
  run: string;
  argv: string[];
  cwd: string;
  wslInterop: string | null;
}

interface Presentation {
  run: string;
  presented: number;
  outcome: string;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  /** The control requests of this run. */
  requests: Request[];
  /** How long it took, in ms, and when it started (performance.now()). */
  ms: number;
  startedAt: number;
}

interface RunOptions {
  /** Over the command's environment; an entry set to undefined removes one. */
  env?: Record<string, string | undefined>;
  times?: WindowTimes;
  /** The checkout the command runs from (default: this repository). */
  appRoot?: string;
  /** Changes the command's /proc (to make a process one that cannot be judged). */
  proc?: (proc: Proc) => Proc;
  /** The command's working directory (default: `project`). */
  cwd?: string;
}

interface Harness {
  d: ServerSandbox;
  /** The working directory of every command: where the server's environment comes from. */
  project: string;
  /** What the commands' platforms started through processes.startDetached, in order. */
  started: StartedProgram[];
  /** Every control request the commands made, with its answer. */
  requests: Request[];
  /** Every signal the commands sent, and when (performance.now()). */
  signals: { pid: number; signal: string; atMs: number }[];
  /** Every path under /mnt/ the commands asked their files for (A32: there must be none). */
  mntAsked: string[];
  run(args: string[], options?: RunOptions): Promise<Result>;
  edgeRuns(): EdgeRun[];
  presentations(): Presentation[];
  /** The server server.json names, and a client of server.sock. */
  server(): ServerJson | null;
  /**
   * server.json once the server answering on server.sock has written it: a server answers its
   * ping before it writes server.json (S2 5.2), so a command can be done before the file is there.
   */
  running(): Promise<ServerJson>;
  client(): ControlClient;
  /** A fake serve started by the test itself, with `env` over the sandbox's; once it is ready. */
  fakeServe(env: Record<string, string>): Promise<ChildProcess>;
  /** The control requests on `path` (`POST /token`, …). */
  asked(method: string, path: string): Request[];
  /** `sleep 60`, a process of the test's own: its pid and process start. */
  liveProcess(): Promise<{ pid: number; procStart: number; child: ChildProcess }>;
  /** A child the test started: killed when the test ends; its pid may be signalled. */
  own(child: ChildProcess): void;
}

function isServe(program: StartedProgram): boolean {
  return program.args.length === 1 && program.args[0] === 'serve';
}

/**
 * The node process a launcher this test started runs `serve` in (the launcher's own child whose
 * command line runs bootstrap.mjs serve); null while there is none. Never another process.
 */
function serveNodeOf(launcher: number): number | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${launcher}/task/${launcher}/children`, 'utf8');
  } catch {
    return null;
  }
  for (const word of text.split(/\s+/)) {
    if (!/^[1-9][0-9]*$/.test(word)) continue;
    const pid = Number(word);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (
        parentPidFromStat(stat) === launcher &&
        args.some((arg) => arg.endsWith('bootstrap.mjs')) &&
        args.includes('serve')
      ) {
        return pid;
      }
    } catch {
      // gone meanwhile
    }
  }
  return null;
}

/**
 * Call first in a test. A server sandbox (serverSandbox: keepers run the stand-in, keep-alive off)
 * whose config.json names the fake Edge and a fixed profile folder, and a runner of the command.
 */
function windowHarness(t: TestContext, window: Record<string, unknown> = {}): Harness {
  const started: StartedProgram[] = [];
  const owned: ChildProcess[] = [];
  let sandboxed: ServerSandbox | null = null;
  const real = realPlatform({ refuseWindows: true });

  /** A pid this test holds: a child it started, or what its commands' platforms started. */
  const allowed = (pid: number): boolean =>
    owned.some(
      (child) => child.pid === pid && child.exitCode === null && child.signalCode === null,
    ) ||
    started.some(
      (program) =>
        !program.exited && (program.child.pid === pid || serveNodeOf(program.child.pid) === pid),
    );

  t.after(async () => {
    for (const child of owned) child.kill('SIGKILL'); // nothing once it has exited
    for (const program of started) {
      if (!program.exited && !isServe(program)) real.processes.signal(program.child.pid, 'SIGKILL');
    }
    const d = sandboxed;
    if (d === null) return;
    const launchers = started.filter(isServe);
    if (launchers.some((program) => !program.exited)) {
      const processes: Processes = {
        startDetached: () => Promise.reject(new Error('the cleanup starts nothing')),
        signal: (pid, signal) => (allowed(pid) ? real.processes.signal(pid, signal) : false),
      };
      try {
        await stopServer(
          { ...d.deck, platform: { ...d.deck.platform, processes } },
          {
            stopMs: 15_000,
          },
        );
      } catch {
        // The fallback below ends what is left.
      }
    }
    for (const program of launchers) {
      if (program.exited) continue;
      await Promise.race([program.child.exited, sleep(15_000)]);
      if (program.exited) continue;
      const node = serveNodeOf(program.child.pid);
      if (node !== null) real.processes.signal(node, 'SIGKILL');
      real.processes.signal(program.child.pid, 'SIGKILL');
      await Promise.race([program.child.exited, sleep(5000)]);
    }
    killKeepersIn(d.s, d.box.runtimeDir);
    for (const record of readRecords(d.record)) {
      if (record.ev !== 'start') continue;
      const start = procStartOf(record.pid);
      if (start !== null) {
        await until(() => !stillRuns(record.pid, start), `program ${record.pid} ended`, WAIT_MS);
      }
    }
  });

  const d = serverSandbox(t, { window: { edge: FAKE_EDGE, profileDir: PROFILE, ...window } });
  sandboxed = d;
  d.s.link('mktemp'); // the launcher's handoff file
  const project = join(d.s.root, 'project');
  mkdirSync(project);
  const tmp = join(d.s.root, 'tmp');
  mkdirSync(tmp);
  const edgeRecord = join(d.s.root, 'records', 'edge.jsonl');
  const requests: Request[] = [];
  const signals: Harness['signals'] = [];
  const mntAsked: string[] = [];
  // The commands' files record every path under /mnt/ they are asked for (and read nothing there).
  const baseFiles = d.platform.files as unknown as Record<string, (...args: unknown[]) => unknown>;
  const files = Object.fromEntries(
    Object.entries(baseFiles).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === 'string' && (arg === '/mnt' || arg.startsWith('/mnt/'))) {
            mntAsked.push(`${name} ${arg}`);
            throw Object.assign(new Error(`the test reached ${arg}`), { code: 'EACCES' });
          }
        }
        return method(...args);
      },
    ]),
  ) as unknown as Files;

  const processes: Processes = {
    async startDetached(command, args, options) {
      const child = await d.platform.processes.startDetached(command, args, options);
      const program: StartedProgram = { command, args, child, exited: false };
      started.push(program);
      void child.exited.then(() => {
        program.exited = true;
      });
      return child;
    },
    signal(pid, signal) {
      signals.push({ pid, signal, atMs: performance.now() });
      if (!allowed(pid)) {
        throw new Error(`this test signals only its own processes, not ${pid}`);
      }
      return real.processes.signal(pid, signal);
    },
  };
  const net: Net = {
    ...d.platform.net,
    async requestUnix(path, request) {
      const entry: Request = {
        method: request.method,
        path: request.path,
        body: request.body,
        answer: null,
        atMs: performance.now(),
      };
      requests.push(entry);
      const answer = await d.platform.net.requestUnix(path, request);
      entry.answer = answer;
      return answer;
    },
  };
  const baseEnv: Record<string, string | undefined> = {
    ...d.platform.env,
    SKYDECK_NODE: process.execPath,
    SKYDECK_TEST_PORT: '0',
    SKYDECK_TEST_INTEROP_FIRST: d.interopFirst,
    TMPDIR: tmp,
    FAKE_EDGE_RECORD: edgeRecord,
  };

  const readJsonLines = <T>(): T[] => {
    try {
      return readFileSync(edgeRecord, 'utf8')
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  };

  const h: Harness = {
    d,
    project,
    started,
    requests,
    signals,
    mntAsked,
    async run(args, options = {}) {
      const times = timesText({ ...TIMES, ...options.times });
      const env = Object.fromEntries(
        Object.entries({ ...baseEnv, SKYDECK_TEST_WINDOW_TIMES: times, ...options.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const platform: Platform = {
        ...d.platform,
        env,
        cwd: options.cwd ?? project,
        files,
        processes,
        net,
        appRoot: options.appRoot ?? d.platform.appRoot,
        proc: options.proc?.(d.platform.proc) ?? d.platform.proc,
      };
      const before = requests.length;
      const startedAt = performance.now();
      const r = await runSkydeck(platform, ['window', ...args]);
      return {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        requests: requests.slice(before),
        ms: performance.now() - startedAt,
        startedAt,
      };
    },
    edgeRuns: () =>
      readJsonLines<EdgeRun & { presented?: number }>().filter((e) => e.argv !== undefined),
    presentations: () =>
      readJsonLines<Presentation>().filter((entry) => entry.presented !== undefined),
    server() {
      return readServerJson(d.platform.files, d.files.serverJson);
    },
    client: () => controlClient(d.platform.net, d.files.serverSock),
    async running() {
      const deadline = performance.now() + WAIT_MS;
      for (;;) {
        const json = h.server();
        const ping = await h
          .client()
          .ping(1000)
          .catch(() => null);
        if (json !== null && typeof ping === 'object' && ping?.pid === json.pid) return json;
        if (performance.now() > deadline) assert.fail('no server answering with its server.json');
        await sleep(50);
      }
    },
    async fakeServe(env) {
      const child = spawn(FAKE_SERVE, ['serve'], {
        env: d.s.env({ SKYDECK_NODE: process.execPath, ...env }),
        cwd: '/',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      owned.push(child);
      let out = '';
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      const exited = once(child, 'exit');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fake serve not ready: ${err}`)), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.split('\n').includes('ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        void exited.then(() => {
          clearTimeout(timer);
          reject(new Error(`fake serve ended before it was ready: ${err}`));
        });
      });
      return child;
    },
    asked: (method, path) => requests.filter((r) => r.method === method && r.path === path),
    own(child) {
      owned.push(child);
    },
    async liveProcess() {
      const child = spawn(join(d.s.bin, 'sleep'), ['60'], { env: d.s.env(), stdio: 'ignore' });
      owned.push(child);
      await once(child, 'spawn');
      const pid = child.pid;
      assert.ok(pid !== undefined);
      const procStart = procStartOf(pid);
      assert.ok(procStart !== null);
      return { pid, procStart, child };
    },
  };
  return h;
}

/** The address the fake Edge was given, split: port and launch token. */
function appOf(run: EdgeRun): { port: number; token: string } {
  const app = run.argv.find((arg) => arg.startsWith('--app='));
  assert.ok(app !== undefined, `an --app argument: ${JSON.stringify(run.argv)}`);
  const match = /^--app=http:\/\/127\.0\.0\.1:([0-9]+)\/#t=([A-Za-z0-9_-]{43})$/.exec(app);
  assert.ok(match !== null, app);
  return { port: Number(match[1]), token: match[2] ?? '' };
}

/** The id of the launch token the command was given (its one `POST /token`). */
function mintedId(h: Harness): string {
  const minted = h.asked('POST', '/token');
  assert.equal(minted.length, 1, 'one launch token minted');
  const body = minted[0]?.answer?.body as { id?: unknown } | undefined;
  assert.ok(typeof body?.id === 'string');
  return body.id;
}

/** The decoded bytes of a base64url key. */
function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** The `POST /token` requests of a run. */
function tokensAsked(r: Result): Request[] {
  return r.requests.filter((q) => q.method === 'POST' && q.path === '/token');
}

/**
 * A page that comes back as a window does after its server restarted (S2 6.3): once a server
 * other than `oldPid` has written server.json, it connects to that server's port (the tests' port
 * is chosen anew by each server) in mode key with the stored secret, retrying the 503 of a start
 * that is not done. Closed when the test ends.
 */
function reconnectingPage(t: TestContext, h: Harness, oldPid: number): Promise<Presented> {
  const done = (async (): Promise<Presented> => {
    const deadline = performance.now() + WAIT_MS;
    for (;;) {
      const json = h.server();
      const secret = h.d.deck.store.getKv('window_secret');
      if (json !== null && json.pid !== oldPid && secret !== null) {
        return present(json.port, bytesOf(secret), 'key');
      }
      if (performance.now() > deadline) assert.fail('no new server to reconnect to');
      await sleep(50);
    }
  })();
  t.after(async () => {
    const presented = await done.catch(() => null);
    if (presented?.outcome === 'welcome') presented.ws.terminate();
  });
  return done;
}

/** A page of the running server in mode key with the stored secret; closed when the test ends. */
async function keyPage(t: TestContext, h: Harness): Promise<void> {
  const json = await h.running();
  const secret = h.d.deck.store.getKv('window_secret');
  assert.ok(secret !== null);
  const presented = await present(json.port, bytesOf(secret), 'key');
  assert.equal(presented.outcome, 'welcome');
  if (presented.outcome === 'welcome') {
    const { ws } = presented;
    t.after(() => {
      ws.terminate();
    });
  }
}

/** S2 5.1's restart line, on standard error (ruled, task 25: standard output has the result only). */
function restartLine(h: Harness): string {
  return `skydeck: restarting the window's server for the new build; new sessions in the window get the environment of this shell (${h.project})\n`;
}

const SUCCESS = /^skydeck window: http:\/\/127\.0\.0\.1:([0-9]+)\/ \(server pid ([0-9]+)\)\n$/;

// ---------------------------------------------------------------------------------------------
// Without options (S2 5.1)

describe('skydeck window: no server running (S2 5.1, 5.2, 5.3)', () => {
  test('a server is started, Edge gets the four arguments, the page uses the token: the line, exit 0; the token dropped; no key or token printed', async (t) => {
    const h = windowHarness(t);

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    const json = h.server();
    assert.ok(json !== null, 'server.json written');
    const match = SUCCESS.exec(r.stdout);
    assert.ok(match !== null, r.stdout);
    assert.equal(Number(match[1]), json.port);
    assert.equal(Number(match[2]), json.pid);
    assert.equal(r.stderr, '');
    assert.equal(json.checkout, REPOSITORY);
    assert.equal(json.envOrigin.dir, h.project, 'the environment comes from the command (A29)');

    const runs = h.edgeRuns();
    assert.equal(runs.length, 1, 'Edge started once');
    const run = runs[0];
    assert.ok(run !== undefined);
    const { port, token } = appOf(run);
    assert.equal(port, json.port);
    assert.deepEqual(run.argv, [
      `--app=http://127.0.0.1:${json.port}/#t=${token}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    assert.equal(run.cwd, h.d.cDrive, 'Edge runs in the C: drive (its stand-in)');
    assert.deepEqual(
      h.presentations().map((p) => p.outcome),
      ['welcome'],
    );

    const id = mintedId(h);
    assert.deepEqual(h.asked('POST', '/token')[0]?.body, { seconds: 30 });
    const drops = h.asked('POST', '/token/drop');
    assert.equal(drops.length, 1, 'the token is given up');
    assert.deepEqual(drops[0]?.body, { id });
    assert.equal(drops[0]?.answer?.status, 200);
    assert.equal(await h.client().tokenState(id), 'used');

    const secret = h.d.deck.store.getKv('window_secret');
    assert.ok(secret !== null);
    for (const text of [r.stdout, r.stderr]) {
      assert.ok(!text.includes(token), 'no launch token printed');
      assert.ok(!text.includes(secret), 'no key printed');
    }
    assert.equal(h.d.deck.store.getKv('window_launching'), null, 'window_launching released');
    assert.deepEqual(h.mntAsked, [], 'nothing under /mnt asked for');
  });

  test('without window.profileDir the profile folder is derived from the C: drive (its stand-in): nothing under /mnt is read', async (t) => {
    const h = windowHarness(t, { profileDir: null });
    mkdirSync(join(h.d.cDrive, 'Users', 'me', 'AppData', 'Local', 'Microsoft', 'Edge'), {
      recursive: true,
    });

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      h
        .edgeRuns()[0]
        ?.argv.includes('--user-data-dir=C:\\Users\\me\\AppData\\Local\\skydeck\\edge-profile'),
      JSON.stringify(h.edgeRuns()),
    );
    assert.deepEqual(h.mntAsked, []);
  });

  test('the fake Edge does not connect: exit 1 naming --print-url, the token dropped, the server still running', async (t) => {
    const h = windowHarness(t);

    const r = await h.run([], { times: { pageMs: 1500 } });

    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^skydeck: .*--print-url.*\n$/);
    assert.equal(h.edgeRuns().length, 1);
    const id = mintedId(h);
    assert.equal(h.asked('POST', '/token/drop').length, 1, 'the token is given up');
    assert.equal(await h.client().tokenState(id), 'dropped');
    const run = h.edgeRuns()[0];
    assert.ok(run !== undefined);
    const { port, token } = appOf(run);
    const late = await present(port, bytesOf(token), 'launch');
    assert.deepEqual(
      late.outcome === 'closed' ? late.code : late.outcome,
      4003,
      'a dropped token opens nothing',
    );
    const ping = await h.client().ping();
    assert.ok(typeof ping === 'object', 'the server still runs');
  });

  test('the token presented twice: the alarm line naming --new-secret, exit 1, window_alarm set', async (t) => {
    const h = windowHarness(t);

    const r = await h.run([], {
      env: { FAKE_EDGE_PAGE: 'twice', FAKE_EDGE_SECOND_DELAY_MS: '300' },
      times: { reuseMs: 4000 },
    });

    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(
      r.stderr,
      "skydeck: this window's launch address was used by another program, which may now have skydeck's key; run skydeck window --new-secret\n",
    );
    assert.deepEqual(
      h.presentations().map((p) => p.outcome),
      ['welcome', 'closed 4004'],
    );
    assert.notEqual(h.d.deck.store.getKv('window_alarm'), null, 'window_alarm set');
    assert.equal(h.asked('POST', '/token/drop').length, 1, 'the token is given up');
  });

  test('success only after the second-use wait: the command waits reuseMs after the use', async (t) => {
    const h = windowHarness(t);
    const startedAt = performance.now();

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, times: { reuseMs: 2500 } });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(performance.now() - startedAt >= 2500, 'waited for a second use');
  });

  test('window_alarm set earlier: the extra line naming --new-secret, and it goes on', async (t) => {
    const h = windowHarness(t);
    h.d.deck.store.setKv('window_alarm', '1794474000000000000');

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.equal(
      r.stderr,
      "skydeck: skydeck's key may be known to another program since 2026-11-12T09:00:00.000Z; run skydeck window --new-secret\n",
    );
    assert.equal(h.edgeRuns().length, 1);
  });

  test('Edge missing: S2 5.3 line (sanitised), exit 1, the token dropped, the server keeps running', async (t) => {
    const missing = '/nowhere/edge\x1b[31m/msedge';
    const h = windowHarness(t, { edge: missing });

    const r = await h.run([]);

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `skydeck: Edge was not found at /nowhere/edge/msedge; set window.edge in ${h.d.s.skydeckHome}/config/config.json, or open the window in any browser with skydeck window --print-url\n`,
    );
    assert.equal(h.asked('POST', '/token/drop').length, 1, 'the token is given up');
    const ping = await h.client().ping();
    assert.ok(typeof ping === 'object', 'the server keeps running');
  });

  test('the server stops before a window used the token: the line saying so, exit 1', async (t) => {
    const h = windowHarness(t);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);

    const pending = h.run([]); // the fake Edge only records: no page comes
    await until(() => h.edgeRuns().length === 1, 'Edge started', WAIT_MS);
    await h.client().shutdown();
    const r = await pending;

    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(
      r.stderr,
      "skydeck: the window's server stopped or restarted before a window used its launch address; run skydeck window again\n",
    );
  });

  test("a serve that exits: S2 5.2's line for its code, exit 1, Edge not started", async (t) => {
    const h = windowHarness(t);
    const config = `${h.d.s.skydeckHome}/config/config.json`;
    const cases: [string, string][] = [
      ['10', `port 47613 on 127.0.0.1 is used by another program; set window.port in ${config}`],
      ['13', "the window's server is not started from inside a Claude Code session"],
      [
        '7',
        `the window's server did not start (exit 7); see ${h.d.s.skydeckHome}/state/server.log`,
      ],
    ];
    for (const [code, line] of cases) {
      const r = await h.run([], {
        env: { FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: code },
        appRoot: FAKE_ROOT,
      });
      assert.equal(r.code, 1, code);
      assert.equal(r.stderr, `skydeck: ${line}\n`, code);
    }
    assert.equal(h.edgeRuns().length, 0);
    assert.deepEqual(
      h.requests.filter((r) => r.path !== '/ping'),
      [],
      'no token asked for',
    );
  });

  test('CLAUDECODE set: the refusal, exit 1, nothing started — with every option, --stop included', async (t) => {
    const h = windowHarness(t);

    for (const args of [[], ['--stop'], ['--print-url'], ['--restart'], ['--new-secret']]) {
      const r = await h.run(args, { env: { CLAUDECODE: '1' } });

      assert.equal(r.code, 1, args.join(' '));
      assert.equal(
        r.stderr,
        "skydeck: the window's server is not started from inside a Claude Code session: every session in the window would inherit that session's environment; run skydeck window in a terminal of your own\n",
      );
    }
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.requests, []);
    assert.equal(h.server(), null);
  });
});

describe('skydeck window: a server running (S2 5.1, 14)', () => {
  test('a page connected: "a window is already open", Edge not started; --new-window starts Edge', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);
    const pid = h.server()?.pid;

    const again = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, 'skydeck window: a window is already open\n');
    assert.equal(h.edgeRuns().length, 1, 'Edge not started again');
    assert.equal(h.server()?.pid, pid, 'the same server');
    assert.equal(h.started.filter(isServe).length, 1, 'no second serve');

    const another = await h.run(['--new-window'], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(another.code, 0, another.stderr);
    assert.match(another.stdout, SUCCESS);
    assert.equal(h.edgeRuns().length, 2, '--new-window starts Edge');
  });

  test('--print-url: the address with a token valid 10 minutes, Edge not started, the token still waiting', async (t) => {
    const h = windowHarness(t);

    const r = await h.run(['--print-url']);

    assert.equal(r.code, 0, r.stderr);
    const json = await h.running();
    const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/#t=([A-Za-z0-9_-]{43})\n$/.exec(r.stdout);
    assert.ok(match !== null, r.stdout);
    assert.equal(Number(match[1]), json.port);
    assert.equal(h.edgeRuns().length, 0, 'Edge not started');
    assert.deepEqual(h.asked('POST', '/token')[0]?.body, { seconds: 600 });
    const id = mintedId(h);
    assert.equal(h.asked('POST', '/token/drop').length, 0, 'the token is not given up');
    assert.equal(await h.client().tokenState(id), 'waiting');
    const answer = h.asked('POST', '/token')[0]?.answer?.body as { token?: string };
    assert.equal(answer.token, match[2]);
  });

  test('two skydeck window at once: one server, one Edge start, both exit 0', async (t) => {
    const h = windowHarness(t);

    const [a, b] = await Promise.all([
      h.run([], { env: { FAKE_EDGE_PAGE: 'once' } }),
      h.run([], { env: { FAKE_EDGE_PAGE: 'once' } }),
    ]);

    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(h.edgeRuns().length, 1, 'one Edge start');
    const json = h.server();
    assert.ok(json !== null);
    for (const r of [a, b]) {
      assert.equal(SUCCESS.exec(r.stdout)?.[2], String(json.pid), 'both use the one server');
    }
    assert.equal(h.d.deck.store.getKv('window_launching'), null);
  });

  test('a hung server: its line naming --restart, exit 1, nothing started', async (t) => {
    const h = windowHarness(t);
    const fake = await h.fakeServe({ FAKE_SERVE_MODE: 'silent', FAKE_SERVE_CHECKOUT: REPOSITORY });

    const r = await h.run([], { times: { pingMs: 1000 } });

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      `skydeck: the window's server (pid ${fake.pid}) does not answer; skydeck window --restart stops it\n`,
    );
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.signals, []);
  });

  test('a server of another checkout: its line (sanitised), exit 1, nothing started', async (t) => {
    const h = windowHarness(t);
    await h.fakeServe({ FAKE_SERVE_CHECKOUT: '/elsewhere/\x1b[31mskydeck' });

    const r = await h.run([]);

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      "skydeck: the window's server runs from /elsewhere/skydeck; run skydeck window there, or skydeck window --restart here to replace it\n",
    );
    assert.deepEqual(h.started, []);
  });

  test('a server of this checkout with another build: restarted with the line', async (t) => {
    const h = windowHarness(t);
    const checkout = join(h.d.s.root, 'checkout');
    for (const name of ['bin', 'src', 'web', 'vendor', 'package.json']) {
      cpSync(join(REPOSITORY, name), join(checkout, name), { recursive: true });
    }
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, appRoot: checkout });
    assert.equal(first.code, 0, first.stderr);
    const old = h.server();
    assert.ok(old !== null);
    assert.equal(old.checkout, checkout);
    writeFileSync(join(checkout, 'src', 'added.ts'), 'export {};\n');
    const back = reconnectingPage(t, h, old.pid);

    const r = await h.run([], {
      env: { FAKE_EDGE_PAGE: 'once' },
      appRoot: checkout,
      times: { reconnectMs: 15_000 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, restartLine(h));
    assert.equal(
      r.stdout,
      'skydeck window: a window is already open\n',
      'the window that was open came back: no second one (ruled, task 25)',
    );
    assert.equal((await back).outcome, 'welcome');
    const now = h.server();
    assert.ok(now !== null);
    assert.notEqual(now.pid, old.pid, 'a new server');
    assert.notEqual(now.build, old.build);
    assert.equal(h.edgeRuns().length, 1, 'Edge not started again');
    assert.deepEqual(tokensAsked(r), [], 'no token minted');
  });
});

// ---------------------------------------------------------------------------------------------
// Options that stop the server (S2 5.1)

/** A terminal opened on the running server through a page: its keeper's id and pid line. */
async function openTerminal(
  t: TestContext,
  h: Harness,
): Promise<{ id: string; pid: number; procStart: number }> {
  const json = h.server();
  assert.ok(json !== null);
  const dir = join(h.d.s.home, 'work');
  mkdirSync(dir);
  const page = await connectTestPage(t, h.d, { port: json.port });
  await page.next('list', 'the first list');
  const result = await page.act({
    kind: 'new',
    dir,
    label: '',
    group: '',
    flags: '',
    cols: 80,
    rows: 24,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  let keeper: { id: string; pid: number; procStart: number } | null = null;
  await until(
    () => {
      const line = listKeeperLines(h.d.platform, h.d.files).find((k) => k.line !== null);
      if (line?.line === null || line === undefined) return false;
      keeper = { id: line.id, pid: line.line.pid, procStart: line.line.procStart };
      return true;
    },
    'a keeper',
    WAIT_MS,
  );
  await page.close();
  assert.ok(keeper !== null);
  return keeper;
}

describe('skydeck window --restart, --stop, --new-secret (S2 5.1, 5.5)', () => {
  test('--restart: the restart line, a new server pid; the keeper alive and rediscovered', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);
    const old = h.server();
    assert.ok(old !== null);
    const keeper = await openTerminal(t, h);

    const r = await h.run(['--restart'], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, restartLine(h));
    assert.match(r.stdout, SUCCESS);
    const now = h.server();
    assert.ok(now !== null);
    assert.notEqual(now.pid, old.pid, 'a new server');
    assert.ok(stillRuns(keeper.pid, keeper.procStart), 'the keeper keeps running');
    let ids: string[] = [];
    const client = h.client();
    const deadline = performance.now() + WAIT_MS;
    while (!ids.includes(keeper.id) && performance.now() < deadline) {
      ids = (await client.status()).terminals.map((term) => term.id);
      if (!ids.includes(keeper.id)) await sleep(100);
    }
    assert.ok(ids.includes(keeper.id), 'the new server found the keeper');
    assert.ok(
      h.signals.every((s) => s.pid !== keeper.pid),
      'no keeper signalled',
    );
  });

  test('--stop: no server any more, the keeper alive, the line counts it', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);
    const keeper = await openTerminal(t, h);

    const r = await h.run(['--stop']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      "stopped skydeck's window server; 1 terminal in the window keeps running\n",
    );
    assert.equal(h.server(), null);
    assert.equal(await h.client().ping(), 'refused');
    assert.ok(stillRuns(keeper.pid, keeper.procStart), 'the keeper keeps running');
    assert.equal(h.edgeRuns().length, 1, 'nothing started');
    assert.equal(h.started.filter(isServe).length, 1, 'no server started');
  });

  test('--stop with no server: says so, exit 0, starts nothing', async (t) => {
    const h = windowHarness(t);

    const r = await h.run(['--stop']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "the window's server is not running\n");
    assert.deepEqual(h.started, []);
  });

  test('--new-secret: a page holding the old key is refused (4003), the alarm cleared, a window opened', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);
    const oldSecret = h.d.deck.store.getKv('window_secret');
    assert.ok(oldSecret !== null);
    const old = h.server();
    assert.ok(old !== null);
    h.d.deck.store.setKv('window_alarm', '1794474000000000000');

    const r = await h.run(['--new-secret'], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.equal(r.stderr, '', 'the alarm is cleared before it would be named');
    assert.equal(h.d.deck.store.getKv('window_alarm'), null, 'the alarm cleared');
    const newSecret = h.d.deck.store.getKv('window_secret');
    assert.ok(newSecret !== null);
    assert.notEqual(newSecret, oldSecret);
    const now = h.server();
    assert.ok(now !== null);
    assert.notEqual(now.pid, old.pid, 'the server was restarted');
    const refused = await present(now.port, bytesOf(oldSecret), 'key');
    assert.deepEqual(refused.outcome === 'closed' ? refused.code : refused.outcome, 4003);
    const accepted = await present(now.port, bytesOf(newSecret), 'key');
    assert.equal(accepted.outcome, 'welcome');
    if (accepted.outcome === 'welcome') accepted.ws.terminate();
    assert.equal(h.edgeRuns().length, 2);
  });
});

describe('--restart replaces any server (S2 5.1)', () => {
  test('--restart with no server running: no restart line, a server and a window', async (t) => {
    const h = windowHarness(t);

    const r = await h.run(['--restart'], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.equal(r.stderr, '', 'no restart line');
    assert.equal(h.edgeRuns().length, 1);
  });

  test('--restart replaces a server that does not answer: SIGTERM to it only, no wait for its pages', async (t) => {
    const h = windowHarness(t);
    const fake = await h.fakeServe({ FAKE_SERVE_MODE: 'silent', FAKE_SERVE_CHECKOUT: REPOSITORY });
    const exited = once(fake, 'exit');

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { pingMs: 1000, reconnectMs: 60_000 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, restartLine(h));
    assert.match(r.stdout, SUCCESS);
    await exited;
    assert.deepEqual(
      h.signals.map(({ pid, signal }) => ({ pid, signal })),
      [{ pid: fake.pid, signal: 'SIGTERM' }],
    );
    assert.notEqual(h.server()?.pid, fake.pid);
    assert.ok(r.ms < 30_000, 'no wait for a page of a server that did not answer');
    assert.equal(h.edgeRuns().length, 1);
  });

  test('--restart: a server found not answering is not pinged again — SIGTERM within one ping wait (ruled, task 25)', async (t) => {
    const h = windowHarness(t);
    const fake = await h.fakeServe({ FAKE_SERVE_MODE: 'silent', FAKE_SERVE_CHECKOUT: REPOSITORY });

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { pingMs: 4000 },
    });

    assert.equal(r.code, 0, r.stderr);
    const [term] = h.signals;
    assert.ok(term !== undefined && term.pid === fake.pid && term.signal === 'SIGTERM');
    const pings = r.requests.filter((q) => q.path === '/ping' && q.atMs < term.atMs);
    assert.equal(pings.length, 1, "findServer's ping only: the stop sends none (S2 5.1: at once)");
    assert.ok(
      term.atMs - r.startedAt < 7000,
      `SIGTERM within one ping wait (${term.atMs - r.startedAt} ms; two would be 8000)`,
    );
  });

  test('--restart replaces a server of another checkout', async (t) => {
    const h = windowHarness(t);
    const fake = await h.fakeServe({ FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck' });
    const exited = once(fake, 'exit');

    const r = await h.run(['--restart'], { env: { FAKE_EDGE_PAGE: 'once' } });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, restartLine(h));
    assert.match(r.stdout, SUCCESS);
    await exited;
    assert.deepEqual(h.signals, [], 'it stopped on POST /shutdown');
    assert.equal(h.server()?.checkout, REPOSITORY);
  });
});

describe('after a restart, the window that was open comes back (ruled, task 25)', () => {
  test('--restart with a window open: its page reconnects within the wait — "already open", no token, no Edge', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);
    const old = h.server();
    assert.ok(old !== null);
    const back = reconnectingPage(t, h, old.pid);

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { reconnectMs: 15_000 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, restartLine(h));
    assert.equal(r.stdout, 'skydeck window: a window is already open\n');
    assert.equal((await back).outcome, 'welcome');
    assert.deepEqual(tokensAsked(r), [], 'no token minted');
    assert.equal(h.edgeRuns().length, 1, 'Edge not started again');
  });

  test('--restart with a window open whose page does not come back: Edge only after the wait', async (t) => {
    const h = windowHarness(t);
    const first = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' } });
    assert.equal(first.code, 0, first.stderr);

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { reconnectMs: 3000 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.ok(r.ms >= 3000, `waited for the page to come back (${r.ms} ms)`);
    assert.equal(tokensAsked(r).length, 1);
    assert.equal(h.edgeRuns().length, 2);
  });

  test('the old server answered /status with a page count that is not a whole number ("3", 2.5, beyond the safe integers): 0 pages, no wait', async (t) => {
    const h = windowHarness(t);
    // Each would count as pages > 0 if it were taken as it is: refused, it must mean no wait.
    for (const [pages, answered] of [
      ['json:"3"', '3'],
      ['json:2.5', 2.5],
      ['json:9007199254740993', 9007199254740992],
    ] as const) {
      await h.fakeServe({ FAKE_SERVE_CHECKOUT: REPOSITORY, FAKE_SERVE_PAGES: pages });

      const r = await h.run(['--restart'], {
        env: { FAKE_EDGE_PAGE: 'once' },
        times: { reconnectMs: 60_000 },
      });

      assert.equal(r.code, 0, `${pages}: ${r.stderr}`);
      assert.ok(r.ms < 30_000, `${pages}: no wait (${r.ms} ms)`);
      const status = r.requests.find((q) => q.path === '/status');
      assert.equal(
        (status?.answer?.body as { pages?: unknown } | undefined)?.pages,
        answered,
        `${pages}: the fake answered a count that is not a whole number`,
      );
      const stop = await h.run(['--stop']);
      assert.equal(stop.code, 0, stop.stderr);
    }
    assert.equal(h.edgeRuns().length, 3);
  });

  test('a fake old server with pages (the control for the case above): the command waits for them', async (t) => {
    const h = windowHarness(t);
    await h.fakeServe({ FAKE_SERVE_CHECKOUT: REPOSITORY, FAKE_SERVE_PAGES: '2' });

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { reconnectMs: 2500 },
    });

    assert.equal(r.code, 0, r.stderr);
    // Counted, not timed: without the wait a run looks at /status twice (the old server's pages,
    // one look at the new one's), with it every 100 ms for 2.5 s.
    const looks = r.requests.filter((q) => q.path === '/status').length;
    assert.ok(looks >= 10, `waited for the pages to come back: ${looks} looks at /status`);
    assert.equal(h.edgeRuns().length, 1);
  });

  test('no wait: an old server with no page, --new-window, --print-url, --new-secret', async (t) => {
    const h = windowHarness(t);
    const times = { reconnectMs: 60_000 };
    const url = await h.run(['--print-url']); // a server with no page
    assert.equal(url.code, 0, url.stderr);
    await h.running();

    const none = await h.run(['--restart'], { env: { FAKE_EDGE_PAGE: 'once' }, times });
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stderr, restartLine(h), 'the server of --print-url was restarted');
    assert.ok(none.ms < 30_000, `no page before: no wait (${none.ms} ms)`);
    assert.equal(h.edgeRuns().length, 1);

    // From here a window is open (the fake Edge's page of the run above).
    const another = await h.run(['--restart', '--new-window'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times,
    });
    assert.equal(another.code, 0, another.stderr);
    assert.ok(another.ms < 30_000, `--new-window: no wait (${another.ms} ms)`);
    assert.equal(h.edgeRuns().length, 2);

    const printed = await h.run(['--restart', '--print-url'], { times });
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /^http:\/\/127\.0\.0\.1:[0-9]+\/#t=[A-Za-z0-9_-]{43}\n$/);
    assert.ok(printed.ms < 30_000, `--print-url: no wait (${printed.ms} ms)`);

    await keyPage(t, h);
    const secret = await h.run(['--new-secret'], { env: { FAKE_EDGE_PAGE: 'once' }, times });
    assert.equal(secret.code, 0, secret.stderr);
    assert.match(secret.stdout, SUCCESS);
    assert.ok(secret.ms < 30_000, `--new-secret: no wait (${secret.ms} ms)`);
    assert.equal(h.edgeRuns().length, 3);
  });
});

/**
 * The sandbox's python3 made slow (3 s) for the server's version check (`python3 -I -c …`), which
 * it makes between answering its first ping and writing server.json (S2 5.2): the gap widened.
 * Everything else (the keepers: `python3 -I <keeper>`) runs the real python3 at once.
 */
function slowServerStart(h: Harness): void {
  const link = join(h.d.s.bin, 'python3');
  const real = realpathSync(link);
  unlinkSync(link);
  writeFileSync(
    link,
    `#!/bin/sh\nif [ "$1" = -I ] && [ "$2" = -c ]; then sleep 3; fi\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
}

describe('a started server is findable when the command returns (ruled, task 25, review 2)', () => {
  test('with the gap between the ping and server.json widened: --stop right after --print-url finds the server', async (t) => {
    const h = windowHarness(t);
    slowServerStart(h);

    const url = await h.run(['--print-url']);
    assert.equal(url.code, 0, url.stderr);
    assert.ok(h.server() !== null, 'server.json is written when the command returns');
    const stop = await h.run(['--stop']);

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(
      stop.stdout,
      "stopped skydeck's window server; 0 terminals in the window keep running\n",
    );
  });

  test('with the gap widened: --restart right after a start restarts, and --new-secret stops the server, so a token minted before opens nothing', async (t) => {
    const h = windowHarness(t);
    slowServerStart(h);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    const old = h.server();
    assert.ok(old !== null);

    const restarted = await h.run(['--restart', '--print-url']);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.equal(restarted.stderr, restartLine(h));
    assert.notEqual(h.server()?.pid, old.pid);
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(restarted.stdout)?.[1];
    assert.ok(token !== undefined);

    const renewed = await h.run(['--new-secret', '--print-url']);
    assert.equal(renewed.code, 0, renewed.stderr);
    const now = h.server();
    assert.ok(now !== null);
    const late = await present(now.port, bytesOf(token), 'launch');
    assert.equal(
      late.outcome === 'closed' ? late.code : late.outcome,
      4003,
      'the old token is gone',
    );
  });
});

describe('foreign text, test seams and fixtures (review 2 of task 25)', () => {
  test('the restart line names the working directory sanitised (an ESC sequence and a newline in its name)', async (t) => {
    const h = windowHarness(t);
    const odd = join(h.d.s.root, 'proj\x1b[31m\nx');
    mkdirSync(odd);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    await h.running();

    const r = await h.run(['--restart', '--print-url'], { cwd: odd });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      `skydeck: restarting the window's server for the new build; new sessions in the window get the environment of this shell (${h.d.s.root}/proj x)\n`,
    );
  });

  test('outside a test sandbox SKYDECK_TEST_WINDOW_TIMES changes nothing (not even a malformed value)', async (t) => {
    const h = windowHarness(t);

    const r = await h.run(['--stop'], {
      env: { SKYDECK_TEST_NO_WINDOWS: undefined, SKYDECK_TEST_WINDOW_TIMES: 'garbage' },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "the window's server is not running\n");
    assert.deepEqual(h.started, []);
  });

  test("the old server's page count is read on its own: a /status without its other fields still counts its pages", async (t) => {
    const h = windowHarness(t);
    await h.fakeServe({
      FAKE_SERVE_CHECKOUT: REPOSITORY,
      FAKE_SERVE_PAGES: '2',
      FAKE_SERVE_STATUS: 'pages-only',
    });

    const r = await h.run(['--restart'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { reconnectMs: 2500 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.requests.find((q) => q.path === '/status')?.answer?.body, { pages: 2 });
    // Counted, not timed: without the wait a run looks at /status twice (the old server's pages,
    // one look at the new one's), with it every 100 ms for 2.5 s.
    const looks = r.requests.filter((q) => q.path === '/status').length;
    assert.ok(looks >= 10, `waited for the 2 pages: ${looks} looks at /status`);
  });

  test("the fake Edge never knocks at the default port 47613 (the user's real server may listen there)", async (t) => {
    const h = windowHarness(t);
    const record = join(h.d.s.root, 'records', 'edge-direct.jsonl');
    const token = Buffer.alloc(32, 7).toString('base64url');
    const child = spawn(FAKE_EDGE, [`--app=http://127.0.0.1:47613/#t=${token}`], {
      env: h.d.s.env({
        SKYDECK_NODE: process.execPath,
        FAKE_EDGE_PAGE: 'once',
        FAKE_EDGE_RECORD: record,
      }),
      stdio: 'ignore',
    });
    h.own(child);
    const [code] = (await once(child, 'exit')) as [number | null];

    assert.equal(code, 0);
    const lines = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { outcome?: string });
    assert.deepEqual(
      lines.map((line) => line.outcome).filter((o) => o !== undefined),
      ['not connected: 47613 is the default port of a real server'],
    );
  });
});

describe('skydeck window: usage', () => {
  test('--help prints the usage; an unknown option or argument and the contradicting options are usage errors (exit 2)', async (t) => {
    const h = windowHarness(t);

    const help = await h.run(['--help']);
    assert.equal(help.code, 0);
    assert.match(
      help.stdout,
      /^skydeck window \[--print-url\] \[--new-window\] \[--restart\] \[--stop\] \[--new-secret\]\n/,
    );

    for (const args of [
      ['--bogus'],
      ['extra'],
      ['--stop', '--restart'],
      ['--stop', '--print-url'],
      ['--stop', '--new-secret'],
      ['--stop', '--new-window'],
      ['--print-url', '--new-window'],
    ]) {
      const r = await h.run(args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /^skydeck: /);
    }
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.requests, []);
  });
});

// ---------------------------------------------------------------------------------------------
// The one command that starts Edge: kv window_launching (S2 5.1)

/** window_launching as a command writes it: `<16 hex> <taken ns> <pid> <process start> <boot id>`. */
function launchingValue(
  h: Harness,
  holder: { pid: number; procStart: number },
  takenNs: bigint,
): string {
  const bootId = h.d.platform.proc.bootId();
  assert.ok(bootId !== null);
  return `0123456789abcdef ${takenNs} ${holder.pid} ${holder.procStart} ${bootId}`;
}

describe('window_launching (S2 5.1: one command starts Edge at a time)', () => {
  test('held by a command that has ended: taken over at once, Edge started', async (t) => {
    const h = windowHarness(t);
    const ended = await h.liveProcess();
    ended.child.kill('SIGKILL');
    await once(ended.child, 'exit');
    assert.equal(
      pidLineState(
        { ...ended, bootId: h.d.platform.proc.bootId() ?? '' },
        h.d.platform.proc,
        h.d.platform.proc.bootId(),
      ),
      'dead',
    );
    const value = launchingValue(h, ended, h.d.platform.clock.nowNs());
    h.d.deck.store.setKv('window_launching', value);

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, times: { launchingMs: 60_000 } });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 30_000, `taken over at once, not after the 60 s (${r.ms} ms)`);
    assert.equal(h.edgeRuns().length, 1);
    assert.equal(h.d.deck.store.getKv('window_launching'), null, 'released at the end');
  });

  test('held longer than a launch can take (stale): taken over, Edge started', async (t) => {
    const h = windowHarness(t);
    const live = await h.liveProcess();
    const value = launchingValue(h, live, h.d.platform.clock.nowNs() - 60_000_000_000n);
    h.d.deck.store.setKv('window_launching', value);

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, times: { launchingMs: 45_000 } });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.edgeRuns().length, 1);
  });

  test('held by a live command whose page does not come: waits until the lock is stale, then starts Edge itself', async (t) => {
    const h = windowHarness(t);
    const live = await h.liveProcess();
    const first = await h.run(['--print-url']); // the server, so that the wait below is the lock's
    assert.equal(first.code, 0, first.stderr);
    h.d.deck.store.setKv('window_launching', launchingValue(h, live, h.d.platform.clock.nowNs()));
    const startedAt = performance.now();

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, times: { launchingMs: 2500 } });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(performance.now() - startedAt >= 2000, 'it waited for the other command');
    assert.equal(h.edgeRuns().length, 1, 'then started Edge itself');
  });

  test("held by a live command: done when that command's page connects — no token, no Edge", async (t) => {
    const h = windowHarness(t);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    const live = await h.liveProcess();
    const held = launchingValue(h, live, h.d.platform.clock.nowNs());
    h.d.deck.store.setKv('window_launching', held);
    const statuses = h.asked('GET', '/status').length;

    const pending = h.run([], { times: { launchingMs: 60_000 } });
    // The second look at the pages is the wait's own: the command waits for the other's page.
    await until(() => h.asked('GET', '/status').length >= statuses + 2, 'waiting', WAIT_MS);
    await keyPage(t, h);
    const r = await pending;

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.deepEqual(tokensAsked(r), [], 'no token minted');
    assert.equal(h.edgeRuns().length, 0, 'Edge not started');
    assert.equal(
      h.d.deck.store.getKv('window_launching'),
      held,
      "the other command's lock is left as it is",
    );
  });

  test("--new-window is not done by another command's page: it waits for the lock, then starts Edge", async (t) => {
    const h = windowHarness(t);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    await keyPage(t, h);
    const live = await h.liveProcess();
    h.d.deck.store.setKv('window_launching', launchingValue(h, live, h.d.platform.clock.nowNs()));

    const r = await h.run(['--new-window'], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { launchingMs: 2500 },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, SUCCESS);
    assert.ok(r.ms >= 2000, `it waited for the lock (${r.ms} ms)`);
    assert.equal(h.edgeRuns().length, 1);
  });

  test('held by a command that cannot be judged (its /proc entry unreadable): it holds the lock until stale, nothing taken over on it', async (t) => {
    const h = windowHarness(t);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    const live = await h.liveProcess();
    h.d.deck.store.setKv('window_launching', launchingValue(h, live, h.d.platform.clock.nowNs()));
    const unreadable = (proc: Proc): Proc => ({
      ...proc,
      stat: (pid) => {
        if (pid === live.pid) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return proc.stat(pid);
      },
    });
    assert.equal(
      pidLineState(
        { pid: live.pid, procStart: live.procStart, bootId: h.d.platform.proc.bootId() ?? '' },
        unreadable(h.d.platform.proc),
        h.d.platform.proc.bootId(),
      ),
      'unknown',
    );
    live.child.kill('SIGKILL'); // dead in fact: only the unreadable entry keeps it "unknown"
    await once(live.child, 'exit');

    const r = await h.run([], {
      env: { FAKE_EDGE_PAGE: 'once' },
      times: { launchingMs: 2500 },
      proc: unreadable,
    });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms >= 2000, `held until stale (${r.ms} ms)`);
    assert.equal(h.edgeRuns().length, 1);
  });

  test('a command releases only its own value: one taken over meanwhile is left as it is', async (t) => {
    const h = windowHarness(t);
    const first = await h.run(['--print-url']);
    assert.equal(first.code, 0, first.stderr);
    const live = await h.liveProcess();

    // The fake Edge only records: the command holds the lock for its whole page wait.
    const pending = h.run([], { times: { launchingMs: 1000, pageMs: 4000 } });
    await until(() => h.edgeRuns().length === 1, 'Edge started', WAIT_MS);
    const own = h.d.deck.store.getKv('window_launching');
    assert.ok(own !== null, 'the command holds the lock');
    await sleep(1200); // stale now: another command may take it over
    const other = launchingValue(h, live, h.d.platform.clock.nowNs());
    h.d.deck.store.setKv('window_launching', other);
    const r = await pending;

    assert.equal(r.code, 1, 'no page came');
    assert.equal(h.d.deck.store.getKv('window_launching'), other, 'the other one is left');
  });

  test('a value that does not parse holds nothing', async (t) => {
    const h = windowHarness(t);
    h.d.deck.store.setKv('window_launching', 'garbage');

    const r = await h.run([], { env: { FAKE_EDGE_PAGE: 'once' }, times: { launchingMs: 60_000 } });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.edgeRuns().length, 1);
  });
});

describe('the test seam SKYDECK_TEST_WINDOW_TIMES (A31)', () => {
  test('a value that is not name=ms pairs of known names is refused in a sandbox, nothing started', async (t) => {
    const h = windowHarness(t);
    for (const bad of [
      'pageMs',
      'pageMs=x',
      'nope=10',
      'pageMs=10;reuseMs=1',
      'pageMs=99999999999',
    ]) {
      const r = await h.run([], { env: { SKYDECK_TEST_WINDOW_TIMES: bad } });
      assert.equal(r.code, 1, bad);
      assert.match(r.stderr, /^skydeck: SKYDECK_TEST_WINDOW_TIMES /, bad);
    }
    assert.deepEqual(h.started, []);
  });
});
