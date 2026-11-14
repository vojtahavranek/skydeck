/**
 * The window's server (plan task 23) under test, in the test process (A19): `runServer` on a
 * keeper sandbox (test/helpers/keeper.ts: realTestPlatform, A36), with real keepers running the
 * stand-in as `claudeCommand`, the sandbox `config.json` of `writeWindowConfig` (the Edge stub,
 * keep-alive off, A32), a port the system picks (A6) and the first interop candidate inside the
 * sandbox (A32). `TestPage` is a `ws` client that has done the handshake of S2 8.2.2 in mode key.
 *
 * At the test's end every server still running is stopped, every keeper killed through
 * `killKeepersIn` (A34) and every program the servers' keepers started waited for, before the
 * sandbox is removed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import WebSocket from 'ws';

import type { Clock, HttpListener, Net, Platform } from '../../src/platform/types.ts';
import { isoFromNs } from '../../src/platform/time.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import type { Deck } from '../../src/sessions/deck.ts';
import { ensureSecret, pageProof } from '../../src/window/auth.ts';
import type {
  ActMessage,
  ListMessage,
  ResultMessage,
  ServerMessage,
  ViewMessage,
  WelcomeMessage,
} from '../../src/window/protocol.ts';
import { runtimeFiles } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { runServer } from '../../src/window/server.ts';
import type { RunningServer, ServerOptions } from '../../src/window/server.ts';
import { keeperSandbox, stillRuns, until } from './keeper.ts';
import type { KeeperBox } from './keeper.ts';
import { killKeepersIn } from './kill.ts';
import { freshNonce, windowId } from './pages.ts';
import type { Sandbox } from './sandbox.ts';
import { standinCommand } from './standin.ts';
import { writeWindowConfig } from './window-config.ts';

/** How long a test waits for something a real process does (this machine is shared and loaded). */
export const WAIT_MS = 20_000;

/**
 * Whether `log` — a server's log text: `server.log`, or the stderr of `serve --foreground` — holds
 * the line the server `serverId` logs last in its start (server.ts). From that line on its start is
 * done: pages are served and `/status` no longer says `starting`. `server.json` comes earlier,
 * before `server.sock` answers (ruled by the plan owner, follow-up "server-findable"), so
 * "server.json exists" does not mean "ready": a test that needs a ready server waits for this.
 */
export function startDone(log: string, serverId: string): boolean {
  return log.includes(`server: ${serverId} listening on`);
}

/** Waits (at most `ms`) until `log()` says that the start of the server `serverId` is done. */
export async function untilStartDone(
  log: () => string,
  serverId: string,
  ms = WAIT_MS,
): Promise<void> {
  await until(() => startDone(log(), serverId), `the start of server ${serverId} done`, ms);
}

export interface ServerSandboxOptions {
  /** Over the sandbox's environment of the servers (an entry set to undefined removes one). */
  env?: Record<string, string | undefined>;
  /** What the servers' /proc reports as the boot id (A36). */
  bootId?: string;
  /** More keys of config.json (claudeCommand is the stand-in's unless given). */
  config?: Record<string, unknown>;
  /** `window` keys over writeWindowConfig's (the Edge stub, keepAlive off). */
  window?: Record<string, unknown>;
}

/** One server a test started, and what a crash of it would leave behind. */
export interface TestServer {
  server: RunningServer;
  /** Every line the server logged (also appended to server.log). */
  logs(): string[];
  /**
   * The server as a crash would leave it: every timer stopped, every socket and listener closed
   * (pages and keeper connections cut, nothing parked), its lock left behind naming a process that
   * is dead by design 5.5's rule (in this process the pid itself lives on). server.json and
   * server.pid stay. Its store connection is NOT closed (ruled, task 23's review 1): runServer's
   * contract gives no handle to it, and a seam for tests alone would change that contract. With
   * every timer and connection gone nothing calls it any more, and an idle WAL connection holds
   * no lock, so the next server sees what it would see after a crash.
   */
  drop(): Promise<void>;
}

/** runServer's options for a test server; `platform` changes the sandbox's platform. */
export type StartOptions = Partial<Omit<ServerOptions, 'platform'>> & {
  platform?: (p: Platform) => Platform;
};

export interface ServerSandbox {
  box: KeeperBox;
  s: Sandbox;
  /** The platform the servers get: the sandbox's, with STANDIN_RECORD in its environment. */
  platform: Platform;
  /** The test's own connection to the sandbox's store, as a command has one. */
  deck: Deck;
  /** The runtime directory's files (`<SKYDECK_HOME>/run`, S2 4.2). */
  files: RuntimeFiles;
  /** The record file of every stand-in the servers' keepers start. */
  record: string;
  /** The stand-in's script: claudeCommand. */
  standin: string;
  /** The arguments of every run of the Edge stub, in order. */
  edgeCalls(): string[][];
  /** The first interop candidate the servers are given: inside the sandbox, nothing there. */
  interopFirst: string;
  /** `SKYDECK_TEST_MNT_C` of the servers (task 24): the directory that stands for /mnt/c. */
  cDrive: string;
  /**
   * Makes `sessionId` resumable: a transcript with one user record a minute ago whose directory is
   * `dir` (created; default a project directory in the sandbox's home). Returns the directory.
   */
  resumable(sessionId: string, dir?: string): string;
  /** Starts a server on this sandbox: port 0, foreground false, interopFirst in the sandbox. */
  start(options?: StartOptions): Promise<TestServer>;
  /** The lines of `<stateDir>/server.log` so far. */
  serverLog(): string[];
}

/**
 * Call first in a test (its cleanup must run before the keeper sandbox's): a sandbox for servers,
 * none started yet.
 */
export function serverSandbox(t: TestContext, options: ServerSandboxOptions = {}): ServerSandbox {
  const started: { test: TestServer; dropped: boolean }[] = [];
  /** pid → process start of every program a server's keeper started. */
  const programs = new Map<number, number>();
  let box: KeeperBox | null = null;
  let deck: Deck | null = null;
  t.after(async () => {
    for (const entry of started) {
      if (!entry.dropped) await entry.test.server.stop('the test ended');
    }
    deck?.store.close();
    if (box === null) return;
    killKeepersIn(box.s, box.runtimeDir);
    for (const [pid, procStart] of programs) {
      await until(() => !stillRuns(pid, procStart), `program ${pid} ended`, WAIT_MS);
    }
  });
  box = keeperSandbox(t);
  const kb = box;
  const { s, tp } = kb;
  const record = join(s.root, 'records', 'server-programs.jsonl');
  // Task 24's stand-in for /mnt/c (drive.ts): a Windows program is started in it, never in /mnt/c.
  const cDrive = join(s.root, 'c-drive');
  mkdirSync(cDrive);
  const env = s.env({ STANDIN_RECORD: record, SKYDECK_TEST_MNT_C: cDrive, ...options.env });
  const realProc = tp.platform.proc;
  const bootId = options.bootId;
  const platform: Platform = {
    ...tp.platform,
    env,
    proc: bootId === undefined ? realProc : { ...realProc, bootId: () => bootId },
  };
  const standin = standinCommand(s);
  const configDir = join(s.skydeckHome, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ claudeCommand: standin, ...options.config }),
  );
  const { edgeCalls } = writeWindowConfig(s, options.window ?? {});
  mkdirSync(join(s.claudeHome, 'projects'), { recursive: true });
  mkdirSync(join(s.claudeHome, 'sessions'), { recursive: true });
  const opened = openDeck(platform);
  deck = opened;
  const files = runtimeFiles(kb.runtimeDir);
  const interopFirst = join(s.root, 'no-interop', '1_interop');
  const serverLogPath = join(s.skydeckHome, 'state', 'server.log');

  const resumable = (sessionId: string, dir = join(s.home, 'project')): string => {
    mkdirSync(dir, { recursive: true });
    const folder = join(s.claudeHome, 'projects', 'project');
    mkdirSync(folder, { recursive: true });
    const line = {
      type: 'user',
      sessionId,
      timestamp: isoFromNs(platform.clock.nowNs() - 60_000_000_000n),
      cwd: dir,
      entrypoint: 'cli',
    };
    writeFileSync(join(folder, `${sessionId}.jsonl`), `${JSON.stringify(line)}\n`);
    return dir;
  };

  const serverLog = (): string[] => {
    try {
      return readFileSync(serverLogPath, 'utf8').split('\n').slice(0, -1);
    } catch {
      return [];
    }
  };

  const start: ServerSandbox['start'] = async (more = {}) => {
    const { platform: change, ...serverOptions } = more;
    const crash = crashable(change === undefined ? platform : change(platform));
    const before = serverLog().length;
    const server = await runServer({
      platform: crash.platform,
      port: 0,
      foreground: false,
      interopFirst,
      ...serverOptions,
    });
    server.hub.onChange(() => {
      for (const term of server.hub.list()) {
        if (term.program !== null) programs.set(term.program.pid, term.program.procStart);
      }
    });
    const entry = {
      dropped: false,
      test: {
        server,
        logs: () => serverLog().slice(before),
        async drop() {
          entry.dropped = true;
          await crash.drop();
          // The lock names this process, which lives on: as a crashed server's, it must name a
          // process that is dead by design 5.5's rule — the same pid with another process start.
          const lock = opened.store.getKv('window_server');
          const match = lock === null ? null : /^([0-9]+):([0-9]+):(.*)$/.exec(lock);
          if (match !== null) {
            opened.store.setKv('window_server', `${match[1]}:${Number(match[2]) + 1}:${match[3]}`);
          }
        },
      },
    };
    started.push(entry);
    return entry.test;
  };

  return {
    box: kb,
    s,
    platform,
    deck: opened,
    files,
    record,
    standin,
    edgeCalls,
    interopFirst,
    cDrive,
    resumable,
    start,
    serverLog,
  };
}

/**
 * `base` with its clock's timers and its sockets recorded, so that `drop()` can stop them all at
 * once as a crash would: no timer fires afterwards, every listener and connection is closed, and
 * no new connection to a keeper is made.
 */
function crashable(base: Platform): { platform: Platform; drop(): Promise<void> } {
  let dropped = false;
  const timers = new Set<() => void>();
  const sockets: Socket[] = [];
  const listeners: HttpListener[] = [];
  const timer = (
    start: (callback: () => void) => () => void,
    callback: () => void,
  ): (() => void) => {
    if (dropped) return () => {};
    const stop = start(() => {
      if (!dropped) callback();
    });
    timers.add(stop);
    return () => {
      timers.delete(stop);
      stop();
    };
  };
  const clock: Clock = {
    nowNs: () => base.clock.nowNs(),
    sleep: (ms) => base.clock.sleep(ms),
    every: (ms, callback) => timer((cb) => base.clock.every(ms, cb), callback),
    after: (ms, callback) => timer((cb) => base.clock.after(ms, cb), callback),
  };
  const net: Net = {
    ...base.net,
    async listenHttp(where, handlers) {
      const listener = await base.net.listenHttp(where, handlers);
      listeners.push(listener);
      return listener;
    },
    async connectUnix(path) {
      if (dropped) {
        throw Object.assign(new Error('the server was dropped'), { code: 'ECONNREFUSED' });
      }
      const socket = await base.net.connectUnix(path);
      sockets.push(socket);
      return socket;
    },
  };
  return {
    platform: { ...base, clock, net },
    async drop() {
      dropped = true;
      for (const stop of [...timers]) stop();
      for (const socket of sockets) socket.destroy();
      await Promise.all(listeners.map((listener) => listener.close()));
    },
  };
}

/** startTestServer's answer: the server, its sandbox, and pages connected to it. */
export interface StartedServer {
  server: RunningServer;
  test: TestServer;
  d: ServerSandbox;
  /** A page that has done the handshake (mode key, the stored secret) and sent `start`. */
  page(options?: PageOptions): Promise<TestPage>;
}

/** Contract 2.5: a sandbox (serverSandbox) and one server started on it. */
export async function startTestServer(
  t: TestContext,
  options: ServerSandboxOptions & { server?: StartOptions } = {},
): Promise<StartedServer> {
  const d = serverSandbox(t, options);
  const test = await d.start(options.server);
  return {
    server: test.server,
    test,
    d,
    page: (pageOptions) => connectTestPage(t, d, test.server, pageOptions),
  };
}

// ---------------------------------------------------------------------------------------------
// Pages

export interface PageOptions {
  focused?: boolean;
  /** Sends this view after `start` (default: the empty view); null sends none. */
  view?: Partial<Omit<ViewMessage, 't'>> | null;
}

export type Received = { text: ServerMessage } | { binary: Uint8Array };

export interface TestPage {
  ws: WebSocket;
  welcome: WelcomeMessage;
  windowId: string;
  send(message: unknown): void;
  sendRaw(text: string): void;
  /** The next message of type `t` not taken yet (messages of other types stay for their own next). */
  next<K extends ServerMessage['t']>(
    t: K,
    what?: string,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { t: K }>>;
  /** The next output frame not taken yet: its channel and bytes. */
  nextBinary(what?: string, timeoutMs?: number): Promise<{ channel: number; bytes: Uint8Array }>;
  /** Takes lists until one satisfies `test`; that one. */
  list(
    test: (list: ListMessage) => boolean,
    what: string,
    timeoutMs?: number,
  ): Promise<ListMessage>;
  /** Sends `view` (the empty view with `view` over it). */
  view(view?: Partial<Omit<ViewMessage, 't'>>): void;
  /** Sends `act` with a fresh id and waits for its result. */
  act(action: ActWithoutId, timeoutMs?: number): Promise<ResultMessage>;
  /** Every message received, in order. */
  all: Received[];
  /** The text the terminal's output frames on `channel` carried so far (UTF-8). */
  output(channel: number): string;
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

/** An `act` message without its `t` and `id`. */
export type ActWithoutId = ActMessage extends infer A
  ? A extends ActMessage
    ? Omit<A, 't' | 'id'>
    : never
  : never;

let acts = 0;

/**
 * A page of the server on `server.port` (one of sandbox `d`, in this process or a child): the
 * handshake of S2 8.2.2 in mode key with the stored secret, then `start`.
 */
export async function connectTestPage(
  t: TestContext,
  d: ServerSandbox,
  server: Pick<RunningServer, 'port'>,
  options: PageOptions = {},
): Promise<TestPage> {
  const origin = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin });
  ws.binaryType = 'nodebuffer';
  t.after(() => {
    ws.terminate();
  });
  const all: Received[] = [];
  const pending: Received[] = [];
  const outputs = new Map<number, Uint8Array[]>();
  let wake = (): void => {};
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    const buffer = data as Buffer;
    const item: Received = isBinary
      ? { binary: new Uint8Array(buffer) }
      : { text: JSON.parse(buffer.toString('utf8')) as ServerMessage };
    if ('binary' in item) {
      const view = new DataView(item.binary.buffer, item.binary.byteOffset, item.binary.length);
      const channel = view.getUint32(1);
      outputs.set(channel, [...(outputs.get(channel) ?? []), item.binary.subarray(5)]);
    }
    all.push(item);
    pending.push(item);
    wake();
  });
  let isClosed = false;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      isClosed = true;
      resolve({ code, reason: reason.toString() });
      wake();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`refused with ${res.statusCode}`)),
    );
    ws.once('close', () => reject(new Error('closed before open')));
  });

  /** Waits until `take` finds something among the pending messages. */
  const wait = async <T>(
    take: () => T | undefined,
    what: string,
    timeoutMs: number,
  ): Promise<T> => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = take();
      if (found !== undefined) return found;
      if (isClosed) assert.fail(`closed while waiting for ${what}`);
      const left = deadline - performance.now();
      if (left <= 0) assert.fail(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 200));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  const next = <K extends ServerMessage['t']>(
    type: K,
    what = `a ${type} message`,
    timeoutMs = WAIT_MS,
  ): Promise<Extract<ServerMessage, { t: K }>> =>
    wait(
      () => {
        const index = pending.findIndex((item) => 'text' in item && item.text.t === type);
        if (index === -1) return undefined;
        const [item] = pending.splice(index, 1);
        return (item as { text: Extract<ServerMessage, { t: K }> }).text;
      },
      what,
      timeoutMs,
    );

  const secret = ensureSecret(d.deck.store, d.platform.randomBytes);
  const challenge = await next('challenge', 'the challenge');
  const cN = freshNonce();
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: 1,
      mode: 'key',
      nonce: cN,
      proof: pageProof(secret, 'key', challenge.nonce, cN, origin),
    }),
  );
  const welcome = await next('welcome', 'the welcome');
  const id = windowId();
  ws.send(
    JSON.stringify({
      t: 'start',
      assetVersion: welcome.assetVersion,
      windowId: id,
      focused: options.focused ?? true,
      theme: { fg: '#ffffff', bg: '#000000' },
    }),
  );
  const emptyView = { filter: '', unfolded: [], showDone: false, selected: null };
  const page: TestPage = {
    ws,
    welcome,
    windowId: id,
    send: (message) => ws.send(JSON.stringify(message)),
    sendRaw: (text) => ws.send(text),
    next,
    nextBinary: (what = 'an output frame', timeoutMs = WAIT_MS) =>
      wait(
        () => {
          const index = pending.findIndex((item) => 'binary' in item);
          if (index === -1) return undefined;
          const [item] = pending.splice(index, 1);
          const bytes = (item as { binary: Uint8Array }).binary;
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
          return { channel: view.getUint32(1), bytes: bytes.subarray(5) };
        },
        what,
        timeoutMs,
      ),
    async list(test, what, timeoutMs = WAIT_MS) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const list = await next('list', what, Math.max(1, deadline - performance.now()));
        if (test(list)) return list;
      }
    },
    view: (view = {}) => ws.send(JSON.stringify({ t: 'view', ...emptyView, ...view })),
    async act(action, timeoutMs = WAIT_MS) {
      const actId = ++acts;
      ws.send(JSON.stringify({ t: 'act', id: actId, ...action }));
      return wait(
        () => {
          const index = pending.findIndex(
            (item) => 'text' in item && item.text.t === 'result' && item.text.id === actId,
          );
          if (index === -1) return undefined;
          const [item] = pending.splice(index, 1);
          return (item as { text: ResultMessage }).text;
        },
        `the result of act ${action.kind}`,
        timeoutMs,
      );
    },
    all,
    output: (channel) =>
      Buffer.concat((outputs.get(channel) ?? []).map((bytes) => Buffer.from(bytes))).toString(
        'utf8',
      ),
    closed,
    async close() {
      ws.close();
      await closed;
    },
  };
  if (options.view !== null) page.view(options.view ?? {});
  return page;
}

/** Every row of a list's sections. */
export function rowsOf(list: ListMessage): ListMessage['sections'][number]['rows'] {
  return list.sections.flatMap((section) => section.rows);
}
