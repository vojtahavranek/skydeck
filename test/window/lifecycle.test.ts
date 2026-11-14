// The server's lifecycle as the commands see it (S2 5.1, 5.2, 5.5, 16.2): finding the window's
// server, starting one, stopping one. The server is test/fixtures/fake-serve, a fixture app root
// whose bin/skydeck plays `skydeck serve`; every process is one this file started. Signals go to
// a recorder, never to a real process unless the test forwards one to its own child.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import { SkydeckError } from '../../src/platform/errors.ts';
import type { Detached, Net, Processes, Proc } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { computeBuild } from '../../src/window/build.ts';
import { controlHandler } from '../../src/window/control.ts';
import { createTokens } from '../../src/window/auth.ts';
import { findServer, startServe, stopServer } from '../../src/window/lifecycle.ts';
import { formatPidLine } from '../../src/window/pidline.ts';
import type { PingAnswer, StatusAnswer } from '../../src/window/protocol.ts';
import { resolveRuntimeDir, runtimeFiles, writeServerJson } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { deckWith, testDeck } from '../helpers/deck.ts';
import { BOOT_A, realTestPlatform, statLine } from '../helpers/platform.ts';
import type { RealTestPlatform } from '../helpers/platform.ts';
import type { Sandbox } from '../helpers/sandbox.ts';
import { writeWindowConfig } from '../helpers/window-config.ts';

/** The fixture app root; its bin/skydeck is the fake `skydeck serve`. */
const FAKE_ROOT = realpathSync(fileURLToPath(new URL('../fixtures/fake-serve', import.meta.url)));
const FAKE_SKYDECK = join(FAKE_ROOT, 'bin', 'skydeck');
/** window.port in the sandbox's config.json. */
const PORT = 47999;
/** Long enough for a node process to start on a loaded machine; a passing case never waits it. */
const START_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// Helpers

interface SignalCall {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
  /** The process start /proc gave for the pid at the moment of the call; null when it was gone. */
  startAtCall: number | null;
  atMs: number;
}

interface Harness {
  s: Sandbox;
  base: RealTestPlatform;
  /** The command's deck: app root = the fixture, cwd = `project`, processes = the recorder. */
  deck: Deck;
  project: string;
  /** Every signal the code under test sent, in order. Nothing reaches a process by itself. */
  signals: SignalCall[];
  /** Called for every recorded signal: a test forwards one to its own child here. */
  onSignal: (call: SignalCall) => void;
  /** What the code under test started through processes.startDetached. */
  started: { child: Detached; exited: boolean }[];
  /** The runtime directory's files where a command looks (the record, else the rule). */
  files: () => RuntimeFiles;
  build: string;
}

/** The process start of a pid by the real /proc; null when it has none. */
function startOf(proc: Proc, pid: number): number | null {
  const stat = proc.stat(pid);
  return stat === null ? null : procStartFromStat(stat);
}

/**
 * A sandbox, its config.json (window.port = PORT, the Edge stub, keep-alive off) and the deck of a
 * command run in `<sandbox>/project` with the fixture as its app root. `env` is added to the
 * command's environment (which startServe passes on).
 */
function harness(
  t: TestContext,
  env: (s: Sandbox) => Record<string, string> = () => ({}),
): Harness {
  const base = realTestPlatform(t, {
    env: (s) => ({ SKYDECK_NODE: process.execPath, ...env(s) }),
  });
  const s = base.sandbox;
  writeWindowConfig(s, { port: PORT });
  const project = join(s.root, 'project');
  mkdirSync(project);
  const started: Harness['started'] = [];
  const h: Harness = {
    s,
    base,
    deck: undefined as unknown as Deck,
    project,
    signals: [],
    onSignal: () => {},
    started,
    files: () => runtimeFiles(resolveRuntimeDir(h.deck, 'follow').dir),
    build: computeBuild(base.platform.files, FAKE_ROOT),
  };
  const processes: Processes = {
    async startDetached(command, args, options) {
      const child = await base.processes.startDetached(command, args, options);
      const entry = { child, exited: false };
      started.push(entry);
      void child.exited.then(() => {
        entry.exited = true;
      });
      return child;
    },
    signal(pid, signal) {
      const call = { pid, signal, startAtCall: startOf(base.proc, pid), atMs: performance.now() };
      h.signals.push(call);
      h.onSignal(call);
      return true;
    },
  };
  t.after(() => {
    // Only what this test started, and only while it has not been seen to end.
    for (const entry of started) {
      if (!entry.exited) base.processes.signal(entry.child.pid, 'SIGKILL');
    }
  });
  h.deck = openDeck({ ...base.platform, appRoot: FAKE_ROOT, cwd: project, processes });
  t.after(() => {
    h.deck.store.close();
  });
  return h;
}

interface Fake {
  child: ChildProcess;
  pid: number;
  procStart: number;
  /** Resolves when the process has exited and was reaped. */
  exited: Promise<unknown>;
}

/**
 * The fake serve started by the test itself (not through the code under test), with `env` on top
 * of the sandbox's; resolves once it says `ready`. Killed through its own handle when the test ends.
 */
async function startFake(t: TestContext, h: Harness, env: Record<string, string>): Promise<Fake> {
  const child = spawn(FAKE_SKYDECK, ['serve'], {
    env: h.s.env({ SKYDECK_NODE: process.execPath, ...env }),
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL'); // nothing once it has exited
  });
  const exited = once(child, 'exit');
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake serve not ready: ${err}`)), START_MS);
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
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const procStart = startOf(h.base.proc, pid);
  assert.ok(procStart !== null);
  return { child, pid, procStart, exited };
}

/** server.json naming `line` in the directory a command looks in, with otherwise valid values. */
function writeServer(
  h: Harness,
  line: { pid: number; procStart: number; bootId: string },
  checkout = FAKE_ROOT,
): RuntimeFiles {
  const files = h.files();
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  writeServerJson(h.base.platform.files, files.serverJson, {
    ...line,
    port: PORT,
    serverId: '0011223344556677',
    build: h.build,
    checkout,
    startedAt: '1794474000000000000',
    envOrigin: { dir: h.project, atNs: '1794474000000000000' },
  });
  return files;
}

/** terms/<id>.pid in the directory a command looks in, as a keeper of version 2 writes it. */
function writeKeeperLine(
  h: Harness,
  id: string,
  line: { pid: number; procStart: number; bootId: string },
): void {
  const files = h.files();
  mkdirSync(files.termsDir, { recursive: true, mode: 0o700 });
  h.base.platform.files.writeText(
    files.termPid(id),
    formatPidLine({ ...line, keeper: { version: '2', started: true } }),
  );
}

/** This test process as server.json would name it: pid, its real process start, the boot id. */
function ownLine(h: Harness): { pid: number; procStart: number; bootId: string } {
  const procStart = startOf(h.base.proc, process.pid);
  const bootId = h.base.proc.bootId();
  assert.ok(procStart !== null && bootId !== null);
  return { pid: process.pid, procStart, bootId };
}

/** process.kill replaced, for a test in which nothing may be signalled at all. */
function forbidKill(t: TestContext): { calls: () => number } {
  const mock = t.mock.method(process, 'kill', () => {
    throw new Error('this test sends no signal');
  });
  return { calls: () => mock.mock.callCount() };
}

/** A process of the test's own that has ended and been reaped: its line is dead. */
async function endedLine(h: Harness): Promise<{ pid: number; procStart: number; bootId: string }> {
  const child = spawn(join(h.s.bin, 'sleep'), ['60'], { env: h.s.env(), stdio: 'ignore' });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const procStart = startOf(h.base.proc, pid);
  const bootId = h.base.proc.bootId();
  assert.ok(procStart !== null && bootId !== null);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  return { pid, procStart, bootId };
}

/** The lines of <stateDir>/server.log. */
function serverLog(h: Harness): string {
  const path = join(h.deck.places.stateDir, 'server.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function logPath(h: Harness): string {
  return join(h.deck.places.stateDir, 'server.log');
}

// ---------------------------------------------------------------------------------------------
// findServer

test('findServer without server.json: none', async (t) => {
  const h = harness(t);
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build), { kind: 'none' });
});

test('findServer: a server.json of an ended process, or of another boot, is none', async (t) => {
  const h = harness(t);
  writeServer(h, await endedLine(h));
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build), { kind: 'none' });
  writeServer(h, { ...ownLine(h), bootId: 'an-earlier-boot' });
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build), { kind: 'none' });
});

test('findServer: a reused pid (alive, another process start) is none and is never signalled', async (t) => {
  const h = harness(t);
  const kill = forbidKill(t);
  const own = ownLine(h);
  writeServer(h, { ...own, procStart: own.procStart + 1 });
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build), { kind: 'none' });
  assert.deepEqual(h.signals, []);
  assert.equal(kill.calls(), 0);
});

test('findServer: a server of this checkout and build is ours, with its ping', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, {});
  const found = await findServer(h.deck, FAKE_ROOT, h.build);
  assert.equal(found.kind, 'ours');
  assert.ok(found.kind === 'ours');
  assert.equal(found.ping.pid, fake.pid);
  assert.equal(found.ping.checkout, FAKE_ROOT);
  assert.equal(found.ping.build, h.build);
});

test('findServer: a server of another checkout is other-checkout', async (t) => {
  const h = harness(t);
  await startFake(t, h, { FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck' });
  const found = await findServer(h.deck, FAKE_ROOT, h.build);
  assert.equal(found.kind, 'other-checkout');
  assert.ok(found.kind === 'other-checkout');
  assert.equal(found.ping.checkout, '/elsewhere/skydeck');
});

test('findServer: a server of another build, or answering with another boot id, is other-build', async (t) => {
  const h = harness(t);
  const first = await startFake(t, h, { FAKE_SERVE_BUILD: 'ffffffffffffffff' });
  const found = await findServer(h.deck, FAKE_ROOT, h.build);
  assert.equal(found.kind, 'other-build');
  assert.ok(found.kind === 'other-build');
  assert.equal(found.ping.build, 'ffffffffffffffff');
  first.child.kill('SIGKILL');
  await first.exited;

  await startFake(t, h, { FAKE_SERVE_BOOT_ID: 'another-boot' });
  const again = await findServer(h.deck, FAKE_ROOT, h.build);
  assert.equal(again.kind, 'other-build');
});

test('findServer: a live server that does not answer within pingMs is hung, with its pid', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  const before = performance.now();
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build, { pingMs: 300 }), {
    kind: 'hung',
    pid: fake.pid,
  });
  assert.ok(performance.now() - before < START_MS);
});

test('findServer: an answer that cannot be read is no answer: hung, and nothing is thrown', async (t) => {
  const h = harness(t);
  const files = writeServer(h, ownLine(h));
  const garbage = createServer((socket) => {
    socket.end('this is not HTTP\r\n\r\n');
  });
  garbage.listen(files.serverSock);
  await once(garbage, 'listening');
  t.after(() => {
    garbage.close();
  });
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build, { pingMs: 500 }), {
    kind: 'hung',
    pid: process.pid,
  });
});

test('findServer: a server that is gone by the look after a refused ping is none, not hung', async (t) => {
  const h = harness(t);
  const own = ownLine(h);
  writeServer(h, own); // no socket: the ping is refused
  let looks = 0;
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid !== own.pid) return h.base.proc.stat(pid);
        looks += 1;
        return looks === 1 ? h.base.proc.stat(pid) : null;
      },
    },
  });
  assert.deepEqual(await findServer(deck, FAKE_ROOT, h.build), { kind: 'none' });
  assert.equal(looks, 2);
});

test('findServer: a server that cannot be judged at the look after a refused ping is an error, not hung', async (t) => {
  const h = harness(t);
  const own = ownLine(h);
  writeServer(h, own); // no socket: the ping is refused
  let looks = 0;
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid !== own.pid) return h.base.proc.stat(pid);
        looks += 1;
        if (looks > 1) throw new SkydeckError('cannot read /proc/<pid>/stat (EMFILE)');
        return h.base.proc.stat(pid);
      },
    },
  });
  await assert.rejects(findServer(deck, FAKE_ROOT, h.build), SkydeckError);
});

test('findServer: a server.json whose process cannot be judged is an error, not none', async (t) => {
  const h = harness(t);
  const own = ownLine(h);
  writeServer(h, own);
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid === own.pid) throw new SkydeckError('cannot read /proc/<pid>/stat (EACCES)');
        return h.base.proc.stat(pid);
      },
    },
  });
  await assert.rejects(findServer(deck, FAKE_ROOT, h.build), (error: unknown) => {
    assert.ok(error instanceof SkydeckError);
    assert.match(error.message, new RegExp(`pid ${own.pid}`));
    return true;
  });
});

test('findServer follows the store record of the runtime directory', async (t) => {
  const h = harness(t);
  const recorded = join(h.s.root, 'recorded-run');
  mkdirSync(recorded, { mode: 0o700 });
  h.deck.store.setKv('window_runtime_dir', recorded);
  const files = writeServer(h, ownLine(h));
  assert.equal(files.dir, recorded);
  const ping: PingAnswer = {
    serverId: '0011223344556677',
    bootId: ownLine(h).bootId,
    build: h.build,
    protocol: 1,
    pid: process.pid,
    port: PORT,
    checkout: FAKE_ROOT,
  };
  const status = {} as StatusAnswer;
  const listener = await h.base.platform.net.listenHttp(
    { path: files.serverSock },
    {
      request: controlHandler({
        ping: () => ping,
        status: () => status,
        tokens: createTokens(h.base.platform.clock, h.base.platform.randomBytes, () => {}),
        shutdown: () => {},
        log: () => {},
      }),
    },
  );
  t.after(() => listener.close());
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build), { kind: 'ours', ping });
});

// ---------------------------------------------------------------------------------------------
// startServe

test('startServe: bin/skydeck serve detached in /, stdin /dev/null, output to server.log, the command env with SKYDECK_ENV_ORIGIN', async (t) => {
  const h = harness(t, (s) => ({
    FAKE_SERVE_RECORD: join(s.root, 'serve-record.json'),
    LIFECYCLE_TEST_MARK: 'kept',
  }));
  const result = await startServe(h.deck, { startMs: START_MS });
  assert.equal(result.ok, true, result.ok ? '' : result.line);
  assert.equal(h.started.length, 1);
  const recorded = JSON.parse(readFileSync(join(h.s.root, 'serve-record.json'), 'utf8')) as {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    stdin: string;
    sessionLeader: boolean;
  };
  assert.deepEqual(recorded.argv, ['serve']);
  assert.equal(recorded.cwd, '/');
  assert.equal(recorded.stdin, '/dev/null');
  assert.equal(recorded.sessionLeader, true);
  assert.equal(recorded.env.SKYDECK_ENV_ORIGIN, h.project);
  assert.equal(recorded.env.LIFECYCLE_TEST_MARK, 'kept');
  assert.equal(recorded.env.SKYDECK_HOME, h.s.skydeckHome);
  const log = serverLog(h);
  assert.match(log, /fake-serve: a line on stdout/);
  assert.match(log, /fake-serve: a line on stderr/);
});

test('startServe: ok with the ping of the server it started, of this checkout, build and boot', async (t) => {
  const h = harness(t);
  const result = await startServe(h.deck, { startMs: START_MS });
  assert.ok(result.ok, result.ok ? '' : result.line);
  assert.equal(result.ping.pid, h.started[0]?.child.pid);
  assert.equal(result.ping.checkout, FAKE_ROOT);
  assert.equal(result.ping.build, h.build);
  assert.equal(result.ping.bootId, h.base.proc.bootId());
});

test('startServe with a stale runtime directory recorded: finds the server where it records itself', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_DELAY_MS: '600' }));
  const stale = join(h.s.root, 'stale-run');
  mkdirSync(stale, { mode: 0o700 });
  h.deck.store.setKv('window_runtime_dir', stale);
  const result = await startServe(h.deck, { startMs: START_MS });
  assert.ok(result.ok, result.ok ? '' : result.line);
  const now = h.deck.store.getKv('window_runtime_dir');
  assert.notEqual(now, stale);
  assert.equal(now, join(h.s.skydeckHome, 'run'));
  assert.equal(result.ping.pid, h.started[0]?.child.pid);
});

for (const [code, line] of [
  [
    10,
    (h: Harness) =>
      `port ${PORT} on 127.0.0.1 is used by another program; set window.port in ${h.deck.places.configPath}`,
  ],
  [13, () => "the window's server is not started from inside a Claude Code session"],
  [7, (h: Harness) => `the window's server did not start (exit 7); see ${logPath(h)}`],
] as const) {
  test(`startServe: serve exiting ${code} gives its fixed line`, async (t) => {
    const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: String(code) }));
    assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
      ok: false,
      line: line(h),
    });
  });
}

test('startServe: serve exiting 11 names the running server from server.json', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '11' }));
  writeServer(h, ownLine(h), '/elsewhere/skydeck');
  assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
    ok: false,
    line: `a window server already runs (pid ${process.pid}, from /elsewhere/skydeck)`,
  });
});

test('startServe: serve exiting 11 with no live server in server.json gives the general line', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '11' }));
  writeServer(h, await endedLine(h), '/elsewhere/skydeck');
  assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
    ok: false,
    line: `the window's server did not start (exit 11); see ${logPath(h)}`,
  });
});

test('startServe: serve exiting 12 names the directory and why it cannot be used', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '12' }));
  const open = join(h.s.root, 'open-run');
  mkdirSync(open, { mode: 0o755 });
  h.deck.store.setKv('window_runtime_dir', open);
  assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
    ok: false,
    line: `the runtime directory ${open} cannot be used: it has mode 755; it must be 700; see skydeck doctor`,
  });
});

test('startServe: serve exiting 12 for a directory that is missing now creates nothing and points to the log', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '12' }));
  const missing = join(h.s.root, 'missing-run');
  h.deck.store.setKv('window_runtime_dir', missing);
  assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
    ok: false,
    line: `the runtime directory ${missing} cannot be used: the reason is in ${logPath(h)}; see skydeck doctor`,
  });
  assert.equal(existsSync(missing), false);
});

test('startServe: serve ended by a signal gives the general line naming it', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'kill' }));
  assert.deepEqual(await startServe(h.deck, { startMs: START_MS }), {
    ok: false,
    line: `the window's server did not start (ended by SIGKILL); see ${logPath(h)}`,
  });
});

test('startServe: serve that never answers gives the no-answer line and is left running', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'idle' }));
  assert.deepEqual(await startServe(h.deck, { startMs: 1500 }), {
    ok: false,
    line: `the window's server did not start (no answer in 1.5 s); see ${logPath(h)}`,
  });
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0]?.exited, false);
  assert.ok(startOf(h.base.proc, h.started[0].child.pid) !== null);
  assert.deepEqual(h.signals, []);
});

test('startServe: serve exiting 0 while a server of this checkout answers: that server is used', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '0' }));
  const other = await startFake(t, h, { FAKE_SERVE_MODE: 'serve' });
  const result = await startServe(h.deck, { startMs: START_MS });
  assert.ok(result.ok, result.ok ? '' : result.line);
  assert.equal(result.ping.pid, other.pid);
  assert.notEqual(result.ping.pid, h.started[0]?.child.pid);
});

test('startServe: serve exiting 0 while only a server of another build answers: no answer', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '0' }));
  await startFake(t, h, { FAKE_SERVE_MODE: 'serve', FAKE_SERVE_BUILD: 'ffffffffffffffff' });
  assert.deepEqual(await startServe(h.deck, { startMs: 1500 }), {
    ok: false,
    line: `the window's server did not start (no answer in 1.5 s); see ${logPath(h)}`,
  });
});

test('startServe: serve exiting 0 while only a server of another checkout answers: no answer', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '0' }));
  await startFake(t, h, { FAKE_SERVE_MODE: 'serve', FAKE_SERVE_CHECKOUT: '/elsewhere/skydeck' });
  assert.deepEqual(await startServe(h.deck, { startMs: 1500 }), {
    ok: false,
    line: `the window's server did not start (no answer in 1.5 s); see ${logPath(h)}`,
  });
});

test('startServe: an app root without bin/skydeck is an error naming it', async (t) => {
  const h = harness(t);
  const empty = join(h.s.root, 'empty-checkout');
  mkdirSync(empty);
  const deck = { ...h.deck, platform: { ...h.deck.platform, appRoot: empty } };
  await assert.rejects(startServe(deck, { startMs: START_MS }), (error: unknown) => {
    assert.ok(error instanceof SkydeckError);
    assert.ok(error.message.includes(join(empty, 'bin', 'skydeck')), error.message);
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// stopServer

test('stopServer without server.json: nothing to stop, nothing signalled', async (t) => {
  const h = harness(t);
  assert.deepEqual(await stopServer(h.deck), { stopped: false, keepers: 0 });
  assert.deepEqual(h.signals, []);
});

test('stopServer: a server.json naming an ended process, another boot or a reused pid: nothing signalled', async (t) => {
  const h = harness(t);
  const ended = await endedLine(h);
  const kill = forbidKill(t);
  const own = ownLine(h);
  for (const line of [
    ended,
    { ...own, bootId: 'an-earlier-boot' },
    { ...own, procStart: own.procStart + 1 },
  ]) {
    writeServer(h, line);
    assert.deepEqual(await stopServer(h.deck), { stopped: false, keepers: 0 });
  }
  assert.deepEqual(h.signals, []);
  assert.equal(kill.calls(), 0);
});

test('stopServer: a server that ends on /shutdown is stopped without a signal; keepers are counted by their lines, not by /status', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_TERMINALS: '5' });
  writeKeeperLine(h, '0000000000a1', (await liveSleep(t, h)).line);
  writeKeeperLine(h, '0000000000a2', (await liveSleep(t, h)).line);
  writeKeeperLine(h, '0000000000a3', await endedLine(h)); // an ended terminal's keeper: dead
  assert.deepEqual(await stopServer(h.deck, { stopMs: START_MS }), { stopped: true, keepers: 2 });
  assert.deepEqual(h.signals, []);
  await fake.exited;
  assert.equal(existsSync(h.files().serverJson), false);
});

test('stopServer: a server that answers but does not end gets SIGTERM after stopMs, then SIGKILL after killMs', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_ON_SHUTDOWN: 'stay' });
  h.onSignal = (call) => {
    if (call.signal === 'SIGKILL') fake.child.kill('SIGKILL'); // the test's own child
  };
  const before = performance.now();
  assert.deepEqual(await stopServer(h.deck, { stopMs: 400, killMs: 400 }), {
    stopped: true,
    keepers: 0,
  });
  assert.deepEqual(
    h.signals.map(({ pid, signal, startAtCall }) => ({ pid, signal, startAtCall })),
    [
      { pid: fake.pid, signal: 'SIGTERM', startAtCall: fake.procStart },
      { pid: fake.pid, signal: 'SIGKILL', startAtCall: fake.procStart },
    ],
  );
  const [term, kill] = h.signals;
  assert.ok(term !== undefined && kill !== undefined);
  assert.ok(term.atMs - before >= 390, `SIGTERM after ${term.atMs - before} ms`);
  assert.ok(kill.atMs - term.atMs >= 390, `SIGKILL ${kill.atMs - term.atMs} ms after SIGTERM`);
});

test('stopServer: a server that does not answer at all gets SIGTERM, then SIGKILL', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  h.onSignal = (call) => {
    if (call.signal === 'SIGKILL') fake.child.kill('SIGKILL');
  };
  assert.deepEqual(await stopServer(h.deck, { pingMs: 300, stopMs: 400, killMs: 400 }), {
    stopped: true,
    keepers: 0,
  });
  assert.deepEqual(
    h.signals.map(({ pid, signal, startAtCall }) => ({ pid, signal, startAtCall })),
    [
      { pid: fake.pid, signal: 'SIGTERM', startAtCall: fake.procStart },
      { pid: fake.pid, signal: 'SIGKILL', startAtCall: fake.procStart },
    ],
  );
});

test('stopServer: a server that ends on SIGTERM gets no SIGKILL', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  h.onSignal = (call) => {
    if (call.signal === 'SIGTERM') fake.child.kill('SIGTERM');
  };
  assert.deepEqual(await stopServer(h.deck, { pingMs: 300, stopMs: 400, killMs: START_MS }), {
    stopped: true,
    keepers: 0,
  });
  assert.deepEqual(
    h.signals.map(({ signal }) => signal),
    ['SIGTERM'],
  );
});

test('stopServer: a server gone after SIGTERM (its pid has another process start now) gets no SIGKILL', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  let reused = false;
  h.onSignal = (call) => {
    if (call.signal === 'SIGTERM') reused = true;
  };
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) =>
        reused && pid === fake.pid
          ? statLine(pid, fake.procStart + 1, 'sleep')
          : h.base.proc.stat(pid),
    },
  });
  assert.deepEqual(await stopServer(deck, { pingMs: 300, stopMs: 400, killMs: 400 }), {
    stopped: true,
    keepers: 0,
  });
  assert.deepEqual(
    h.signals.map(({ signal }) => signal),
    ['SIGTERM'],
  );
});

test('stopServer: a server that outlives SIGKILL is an error naming its pid', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  await assert.rejects(
    stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 }),
    (error: unknown) => {
      assert.ok(error instanceof SkydeckError);
      assert.match(error.message, new RegExp(`pid ${fake.pid}`));
      return true;
    },
  );
  assert.deepEqual(
    h.signals.map(({ pid, signal }) => ({ pid, signal })),
    [
      { pid: fake.pid, signal: 'SIGTERM' },
      { pid: fake.pid, signal: 'SIGKILL' },
    ],
  );
});

test('stopServer never signals a keeper: a live keeper line beside the server gets nothing', async (t) => {
  const h = harness(t);
  const keeper = spawn(join(h.s.bin, 'sleep'), ['60'], { env: h.s.env(), stdio: 'ignore' });
  t.after(() => {
    keeper.kill('SIGKILL');
  });
  await once(keeper, 'spawn');
  const keeperPid = keeper.pid;
  assert.ok(keeperPid !== undefined);
  const keeperStart = startOf(h.base.proc, keeperPid);
  const bootId = h.base.proc.bootId();
  assert.ok(keeperStart !== null && bootId !== null);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  const files = h.files();
  h.base.platform.files.writeText(
    files.termPid('0123456789ab'),
    formatPidLine({
      pid: keeperPid,
      procStart: keeperStart,
      bootId,
      keeper: { version: '2', started: true },
    }),
  );
  h.onSignal = (call) => {
    if (call.signal === 'SIGKILL' && call.pid === fake.pid) fake.child.kill('SIGKILL');
  };
  await stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 });
  assert.deepEqual(
    h.signals.map(({ pid }) => pid),
    [fake.pid, fake.pid],
  );

  // server.json naming the keeper itself: refused, nothing signalled.
  h.signals.length = 0;
  writeServer(h, { pid: keeperPid, procStart: keeperStart, bootId });
  await assert.rejects(stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 }), SkydeckError);
  assert.deepEqual(h.signals, []);
  assert.ok(startOf(h.base.proc, keeperPid) === keeperStart);
});

test('stopServer: a server.json naming this very process is refused, nothing signalled', async (t) => {
  const h = harness(t);
  const kill = forbidKill(t);
  writeServer(h, ownLine(h));
  await assert.rejects(stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 }), SkydeckError);
  assert.deepEqual(h.signals, []);
  assert.equal(kill.calls(), 0);
});

test('stopServer: a server whose process cannot be judged is an error, nothing signalled', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid === fake.pid) throw new SkydeckError('cannot read /proc/<pid>/stat (EACCES)');
        return h.base.proc.stat(pid);
      },
    },
  });
  await assert.rejects(stopServer(deck, { pingMs: 300, stopMs: 300, killMs: 300 }), SkydeckError);
  assert.deepEqual(h.signals, []);
});

// ---------------------------------------------------------------------------------------------
// LifecycleTimes

test('a time given as undefined is the default, for every function (ruled, review 1)', async (t) => {
  const h = harness(t);
  const unset = { pingMs: undefined, startMs: undefined, stopMs: undefined, killMs: undefined };
  assert.deepEqual(await findServer(h.deck, FAKE_ROOT, h.build, unset), { kind: 'none' });
  assert.deepEqual(await stopServer(h.deck, unset), { stopped: false, keepers: 0 });
  const quick = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '7' }));
  assert.deepEqual(await startServe(quick.deck, unset), {
    ok: false,
    line: `the window's server did not start (exit 7); see ${logPath(quick)}`,
  });
});

test('a time that is not a whole number of ms a timer can wait is a RangeError, and nothing is started or sent', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 31]) {
    for (const name of ['pingMs', 'startMs', 'stopMs', 'killMs'] as const) {
      const times = { [name]: bad };
      await assert.rejects(findServer(h.deck, FAKE_ROOT, h.build, times), RangeError);
      await assert.rejects(startServe(h.deck, times), RangeError);
      await assert.rejects(stopServer(h.deck, times), RangeError);
    }
  }
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.signals, []);
  assert.equal(startOf(h.base.proc, fake.pid), fake.procStart);
});

// ---------------------------------------------------------------------------------------------
// Review 2: the checks around each signal, the requests, the start's own pings, the errors

/** A real process of the test's own (`sleep 60`) as server.json would name it. */
async function liveSleep(
  t: TestContext,
  h: Harness,
): Promise<{ child: ChildProcess; line: { pid: number; procStart: number; bootId: string } }> {
  const child = spawn(join(h.s.bin, 'sleep'), ['60'], { env: h.s.env(), stdio: 'ignore' });
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const procStart = startOf(h.base.proc, pid);
  const bootId = h.base.proc.bootId();
  assert.ok(procStart !== null && bootId !== null);
  return { child, line: { pid, procStart, bootId } };
}

test('stopServer: an identity that changed after the first look gets no SIGTERM', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  let looks = 0;
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid !== fake.pid) return h.base.proc.stat(pid);
        looks += 1;
        return looks === 1 ? h.base.proc.stat(pid) : statLine(pid, fake.procStart + 1, 'sleep');
      },
    },
  });
  assert.deepEqual(await stopServer(deck, { pingMs: 300, stopMs: 400, killMs: 400 }), {
    stopped: true,
    keepers: 0,
  });
  assert.deepEqual(h.signals, []);
});

for (const at of ['SIGTERM', 'SIGKILL'] as const) {
  test(`stopServer judges the identity right before ${at}: one gone while the keepers are listed gets none`, async (t) => {
    const h = harness(t);
    const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
    // The first keeper listing counts the keepers (before the stop); each later one is the last
    // thing before the identity check of a signal: the second SIGTERM's, the third SIGKILL's.
    let listings = 0;
    let reused = false;
    const files = h.files();
    const deck = deckWith(h.deck, {
      files: {
        list: (dir) => {
          if (dir === files.termsDir) {
            listings += 1;
            if (listings === (at === 'SIGTERM' ? 2 : 3)) reused = true;
          }
          return h.base.platform.files.list(dir);
        },
      },
      proc: {
        stat: (pid) =>
          reused && pid === fake.pid
            ? statLine(pid, fake.procStart + 1, 'sleep')
            : h.base.proc.stat(pid),
      },
    });
    assert.deepEqual(await stopServer(deck, { pingMs: 300, stopMs: 300, killMs: 300 }), {
      stopped: true,
      keepers: 0,
    });
    assert.deepEqual(
      h.signals.map(({ signal }) => signal),
      at === 'SIGTERM' ? [] : ['SIGTERM'],
    );
  });
}

test('stopServer: a server that cannot be judged any more while it is waited for is an error, nothing signalled', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_ON_SHUTDOWN: 'stay' });
  let looks = 0;
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (pid !== fake.pid) return h.base.proc.stat(pid);
        looks += 1;
        if (looks > 1) throw new SkydeckError('cannot read /proc/<pid>/stat (EMFILE)');
        return h.base.proc.stat(pid);
      },
    },
  });
  await assert.rejects(stopServer(deck, { stopMs: 400, killMs: 400 }), SkydeckError);
  assert.deepEqual(h.signals, []);
});

test('stopServer: a server that cannot be judged any more after SIGTERM gets no SIGKILL: an error', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  let unknown = false;
  h.onSignal = (call) => {
    if (call.signal === 'SIGTERM') unknown = true;
  };
  const deck = deckWith(h.deck, {
    proc: {
      stat: (pid) => {
        if (unknown && pid === fake.pid) {
          throw new SkydeckError('cannot read /proc/<pid>/stat (EMFILE)');
        }
        return h.base.proc.stat(pid);
      },
    },
  });
  await assert.rejects(stopServer(deck, { pingMs: 300, stopMs: 400, killMs: 400 }), SkydeckError);
  assert.deepEqual(
    h.signals.map(({ signal }) => signal),
    ['SIGTERM'],
  );
});

test('stopServer: a server.json naming pid 1 is refused, nothing signalled', async (t) => {
  const h = harness(t);
  const kill = forbidKill(t);
  const start = startOf(h.base.proc, 1);
  const bootId = h.base.proc.bootId();
  assert.ok(start !== null && bootId !== null);
  writeServer(h, { pid: 1, procStart: start, bootId });
  await assert.rejects(stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 }), SkydeckError);
  assert.deepEqual(h.signals, []);
  assert.equal(kill.calls(), 0);
});

test('stopServer: a server that gives no ping answer gets SIGTERM at once, not after stopMs', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  h.onSignal = (call) => {
    if (call.signal === 'SIGTERM') fake.child.kill('SIGTERM');
  };
  const before = performance.now();
  assert.deepEqual(await stopServer(h.deck, { pingMs: 300, stopMs: START_MS, killMs: START_MS }), {
    stopped: true,
    keepers: 0,
  });
  const [term] = h.signals;
  assert.ok(term !== undefined);
  assert.ok(term.atMs - before < START_MS / 2, `SIGTERM after ${term.atMs - before} ms`);
});

test('stopServer: a /status that cannot be read and a /shutdown cut off still stop a server that ends', async (t) => {
  const h = harness(t);
  const { child, line } = await liveSleep(t, h);
  const files = writeServer(h, line);
  const ping: PingAnswer = {
    serverId: '0011223344556677',
    bootId: line.bootId,
    build: h.build,
    protocol: 1,
    pid: line.pid,
    port: PORT,
    checkout: FAKE_ROOT,
  };
  const listener = await h.base.platform.net.listenHttp(
    { path: files.serverSock },
    {
      request: (req, res) => {
        if (req.url === '/ping') {
          res.end(JSON.stringify(ping));
        } else if (req.url === '/status') {
          res.end(JSON.stringify({ of: 'another build' }));
        } else {
          child.kill('SIGKILL'); // the test's own "server" ends without answering /shutdown
          req.socket.destroy();
        }
      },
    },
  );
  t.after(() => listener.close());
  assert.deepEqual(await stopServer(h.deck, { stopMs: START_MS }), { stopped: true, keepers: 0 });
  assert.deepEqual(h.signals, []);
});

test('startServe: serve exiting 0 while only a server answering with another boot id answers: no answer', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'exit', FAKE_SERVE_EXIT: '0' }));
  await startFake(t, h, { FAKE_SERVE_MODE: 'serve', FAKE_SERVE_BOOT_ID: 'another-boot' });
  assert.deepEqual(await startServe(h.deck, { startMs: 1500 }), {
    ok: false,
    line: `the window's server did not start (no answer in 1.5 s); see ${logPath(h)}`,
  });
});

/**
 * `net` whose requests to `sock` are recorded and never answered: each ends only by its own
 * timeout (ETIMEDOUT) or its signal (AbortError), as a request to a server that does not answer.
 * Requests to any other path go to the real net.
 */
function silentNet(
  real: Net,
  sock: () => string,
): { net: Net; outcomes: string[]; pending: () => number } {
  const outcomes: string[] = [];
  let open = 0;
  const net: Net = {
    ...real,
    requestUnix: (path, request) => {
      if (path !== sock()) return real.requestUnix(path, request);
      open += 1;
      return new Promise((_resolve, reject) => {
        const end = (outcome: string, error: Error): void => {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', aborted);
          open -= 1;
          outcomes.push(outcome);
          reject(error);
        };
        const aborted = (): void => {
          end('aborted', new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          end('timed out', Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' }));
        }, request.timeoutMs);
        if (request.signal?.aborted === true) aborted();
        else request.signal?.addEventListener('abort', aborted, { once: true });
      });
    },
  };
  return { net, outcomes, pending: () => open };
}

test('startServe leaves no ping open when it gives up: the one in flight is aborted', async (t) => {
  const h = harness(t, () => ({ FAKE_SERVE_MODE: 'idle' }));
  const silent = silentNet(h.deck.platform.net, () => h.files().serverSock);
  const deck = { ...h.deck, platform: { ...h.deck.platform, net: silent.net } };
  assert.deepEqual(await startServe(deck, { startMs: 1500 }), {
    ok: false,
    line: `the window's server did not start (no answer in 1.5 s); see ${logPath(h)}`,
  });
  assert.equal(silent.pending(), 0);
  // The attempts wait at most 1 s each: the first timed out, the one open at 1.5 s was aborted.
  assert.deepEqual(silent.outcomes, ['timed out', 'aborted']);
});

test('findServer leaves no ping open: the one in flight at the end of pingMs is aborted', async (t) => {
  const h = harness(t);
  writeServer(h, ownLine(h));
  const files = h.files();
  const silent = silentNet(h.deck.platform.net, () => files.serverSock);
  let calls = 0;
  const net: Net = {
    ...silent.net,
    requestUnix: (path, request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      }
      return silent.net.requestUnix(path, request);
    },
  };
  const deck = { ...h.deck, platform: { ...h.deck.platform, net } };
  assert.deepEqual(await findServer(deck, FAKE_ROOT, h.build, { pingMs: 1000 }), {
    kind: 'hung',
    pid: process.pid,
  });
  assert.equal(silent.pending(), 0);
  assert.deepEqual(silent.outcomes, ['aborted']);
});

test('startServe: a boot id that cannot be read is an error before anything is started', async (t) => {
  const h = harness(t);
  for (const bootId of [
    () => null,
    () => {
      throw new SkydeckError('cannot read the boot id (EACCES)');
    },
  ]) {
    const deck = deckWith(h.deck, { proc: { bootId } });
    await assert.rejects(startServe(deck, { startMs: START_MS }), SkydeckError);
  }
  assert.deepEqual(h.started, []);
});

test('a server.json that cannot be read is a SkydeckError naming it', async (t) => {
  const h = harness(t);
  const files = h.files();
  mkdirSync(files.serverJson, { recursive: true }); // a directory: EISDIR
  for (const call of [() => findServer(h.deck, FAKE_ROOT, h.build), () => stopServer(h.deck)]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof SkydeckError);
      assert.ok(error.message.includes(files.serverJson), error.message);
      return true;
    });
  }
  assert.deepEqual(h.signals, []);
});

test('stopServer: keepers that cannot be listed, or a signal the system refuses, are a SkydeckError', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  const files = h.files();
  const unlisted = deckWith(h.deck, {
    files: {
      list: (dir) => {
        if (dir === files.termsDir) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return h.base.platform.files.list(dir);
      },
    },
  });
  await assert.rejects(
    stopServer(unlisted, { pingMs: 300, stopMs: 300, killMs: 300 }),
    SkydeckError,
  );
  assert.deepEqual(h.signals, []);

  h.onSignal = () => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  };
  await assert.rejects(
    stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: 300 }),
    (error: unknown) => {
      assert.ok(error instanceof SkydeckError);
      assert.match(error.message, /EPERM/);
      assert.match(error.message, new RegExp(`pid ${fake.pid}`));
      return true;
    },
  );
});

test('stopServer counts the keepers alive or unknown by their lines, also for a hung server; a dead line is not counted', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, { FAKE_SERVE_MODE: 'silent' });
  writeKeeperLine(h, '0000000000b1', (await liveSleep(t, h)).line);
  writeKeeperLine(h, '0000000000b2', (await liveSleep(t, h)).line);
  writeKeeperLine(h, '0000000000b3', await endedLine(h));
  h.onSignal = (call) => {
    if (call.signal === 'SIGTERM') fake.child.kill('SIGTERM');
  };
  assert.deepEqual(await stopServer(h.deck, { pingMs: 300, stopMs: 300, killMs: START_MS }), {
    stopped: true,
    keepers: 2,
  });
  assert.deepEqual(
    h.signals.map(({ pid }) => pid),
    [fake.pid],
  );
});

test('stopServer counts a keeper line that cannot be read (unknown: it may keep running)', async (t) => {
  const h = harness(t);
  const fake = await startFake(t, h, {});
  writeKeeperLine(h, '0000000000c1', (await liveSleep(t, h)).line);
  writeKeeperLine(h, '0000000000c2', await endedLine(h));
  const unreadable = h.files().termPid('0000000000c2');
  const deck = deckWith(h.deck, {
    files: {
      readText: (path) => {
        if (path === unreadable) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return h.base.platform.files.readText(path);
      },
    },
  });
  assert.deepEqual(await stopServer(deck, { stopMs: START_MS }), { stopped: true, keepers: 2 });
  await fake.exited;
});

test('stopServer without a live server still counts the keepers', async (t) => {
  const h = harness(t);
  writeKeeperLine(h, '0000000000d1', (await liveSleep(t, h)).line);
  writeServer(h, await endedLine(h));
  assert.deepEqual(await stopServer(h.deck), { stopped: false, keepers: 1 });
  assert.deepEqual(h.signals, []);
});

// ---------------------------------------------------------------------------------------------
// findServer after a refused or failed ping (ruled, review 2 C2), on the fake clock

/** A fake-clock deck whose server.json names pid 4242 (alive in the fake /proc until removed). */
function fakeServerDeck(t: TestContext): {
  d: ReturnType<typeof testDeck>;
  files: RuntimeFiles;
  ping: PingAnswer;
} {
  const d = testDeck(t);
  d.proc.setProcess(4242, { stat: statLine(4242, 777, 'node'), cmdline: [] });
  const files = runtimeFiles(join(d.sandbox.skydeckHome, 'run'));
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  writeServerJson(d.platform.files, files.serverJson, {
    pid: 4242,
    procStart: 777,
    bootId: BOOT_A,
    port: PORT,
    serverId: '0011223344556677',
    build: '0123456789abcdef',
    checkout: '/checkout',
    startedAt: '1794474000000000000',
    envOrigin: { dir: '/checkout', atNs: '1794474000000000000' },
  });
  const ping: PingAnswer = {
    serverId: '0011223344556677',
    bootId: BOOT_A,
    build: '0123456789abcdef',
    protocol: 1,
    pid: 4242,
    port: PORT,
    checkout: '/checkout',
  };
  return { d, files, ping };
}

/** The deck with its net's requestUnix replaced; `attempts` counts the calls. */
function withRequests(
  deck: Deck,
  answer: (attempt: number, real: Net['requestUnix']) => ReturnType<Net['requestUnix']>,
): { deck: Deck; attempts: () => number } {
  let attempts = 0;
  const real = deck.platform.net;
  const net: Net = {
    ...real,
    requestUnix: (path, request) => answer(++attempts, () => real.requestUnix(path, request)),
  };
  return { deck: { ...deck, platform: { ...deck.platform, net } }, attempts: () => attempts };
}

const refused = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));

test('findServer: a refused ping is tried again every 100 ms; still refused at pingMs → hung', async (t) => {
  const { d } = fakeServerDeck(t);
  const asked = withRequests(d.deck, refused);
  const before = d.clock.nowNs();
  assert.deepEqual(
    await findServer(asked.deck, '/checkout', '0123456789abcdef', { pingMs: 1000 }),
    {
      kind: 'hung',
      pid: 4242,
    },
  );
  assert.equal(asked.attempts(), 10); // at 0, 100, …, 900 ms; the one due at 1000 ms is the end
  assert.ok(d.clock.nowNs() - before >= 1_000_000_000n);
});

test('findServer: refused to the end of pingMs, the process gone in its last 100 ms → none', async (t) => {
  const { d } = fakeServerDeck(t);
  d.clock.after(950, () => d.proc.setProcess(4242, null));
  const asked = withRequests(d.deck, refused);
  assert.deepEqual(
    await findServer(asked.deck, '/checkout', '0123456789abcdef', { pingMs: 1000 }),
    {
      kind: 'none',
    },
  );
  assert.equal(asked.attempts(), 10);
});

test('findServer: refused, then the process is gone → none', async (t) => {
  const { d } = fakeServerDeck(t);
  const asked = withRequests(d.deck, (attempt) => {
    if (attempt === 3) d.proc.setProcess(4242, null);
    return refused();
  });
  assert.deepEqual(await findServer(asked.deck, '/checkout', '0123456789abcdef'), { kind: 'none' });
  assert.equal(asked.attempts(), 3);
});

test('findServer: refused or failed, then an answer → classified by it', async (t) => {
  const { d, ping } = fakeServerDeck(t);
  const asked = withRequests(d.deck, (attempt) => {
    if (attempt === 1) return refused();
    if (attempt === 2) {
      return Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    }
    return Promise.resolve({ status: 200, body: ping });
  });
  assert.deepEqual(await findServer(asked.deck, '/checkout', '0123456789abcdef'), {
    kind: 'ours',
    ping,
  });
  assert.equal(asked.attempts(), 3);
});

test('findServer: a ping that timed out is not tried again → hung at once', async (t) => {
  const { d } = fakeServerDeck(t);
  const asked = withRequests(d.deck, () =>
    Promise.reject(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })),
  );
  assert.deepEqual(await findServer(asked.deck, '/checkout', '0123456789abcdef'), {
    kind: 'hung',
    pid: 4242,
  });
  assert.equal(asked.attempts(), 1);
});
