/**
 * The keeper (`bin/skydeck-keeper`, S2 7.1) under test: spawned with real python3 in a sandbox's
 * runtime directory, driven over its unix socket through task 1's frame codec (plan A2), with the
 * stand-in of plan 2.4 as its program. Every keeper a test starts is killed when the test ends,
 * through `killKeepersIn` (A34), before the sandbox is removed.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import {
  decodeSnapshot,
  encodeFrame,
  frameReader,
  parseExit,
  parseHello,
  parseResize,
  parseStarted,
} from '../../src/window/frames.ts';
import type {
  Frame,
  FrameType,
  KeeperExit,
  KeeperHello,
  KeeperSpec,
  KeeperStarted,
} from '../../src/window/frames.ts';
import { parsePidLine } from '../../src/window/pidline.ts';
import type { PidLine } from '../../src/window/pidline.ts';
import { killKeepersIn } from './kill.ts';
import { realTestPlatform } from './platform.ts';
import type { RealTestPlatform } from './platform.ts';
import type { Sandbox } from './sandbox.ts';
import { standinCommand } from './standin.ts';

export const KEEPER = fileURLToPath(new URL('../../bin/skydeck-keeper', import.meta.url));
export const SESSION = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';

/** What the stand-in asks at start, and answers a terminal would give. */
export const DA1 = '\x1b[c';
export const CPR = '\x1b[6n';
export const DA1_ANSWER = '\x1b[?1;2c';
export const CPR_ANSWER = '\x1b[1;1R';
export const PROMPT = `standin ${SESSION.slice(0, 8)}> `;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` every 10 ms until it is true; throws `what` (described when it throws) after `timeoutMs`. */
export async function until(
  check: () => boolean,
  what: string | (() => string),
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`${typeof what === 'string' ? what : what()}: not within ${timeoutMs} ms`);
    }
    await sleep(10);
  }
}

/** `promise`, or a rejection naming `what` after `timeoutMs`. */
export async function within<T>(promise: Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A record of the keeper's stream: an output chunk or a resize (S2 3). */
export function isRecord(frame: Frame): boolean {
  return frame.type === 'D' || frame.type === 'R';
}

/** Field 22 of /proc/<pid>/stat, or null when there is no such process (or no number). */
export function procStartOf(pid: number): number | null {
  try {
    return procStartFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether the process `pid` with the process start `procStart` still runs (design 5.5). */
export function stillRuns(pid: number, procStart: number): boolean {
  return procStartOf(pid) === procStart;
}

export function hello(frame: Frame): KeeperHello {
  assert.equal(frame.type, 'H');
  const parsed = parseHello(frame.payload);
  assert.ok(parsed.ok, `hello refused by the codec: ${parsed.ok ? '' : parsed.kind}`);
  return parsed.value;
}

export function started(frame: Frame): KeeperStarted {
  assert.equal(frame.type, 'T');
  const parsed = parseStarted(frame.payload);
  assert.ok(parsed.ok, `started refused by the codec: ${parsed.ok ? '' : parsed.kind}`);
  return parsed.value;
}

export function exit(frame: Frame): KeeperExit {
  assert.equal(frame.type, 'X');
  const parsed = parseExit(frame.payload);
  assert.ok(parsed.ok, `exit refused by the codec: ${parsed.ok ? '' : parsed.kind}`);
  return parsed.value;
}

export function resize(frame: Frame): { cols: number; rows: number } {
  assert.equal(frame.type, 'R');
  const parsed = parseResize(frame.payload);
  assert.ok(parsed.ok, `resize refused by the codec: ${parsed.ok ? '' : parsed.kind}`);
  return parsed.value;
}

export function snapshot(frame: Frame): { seq: number; cols: number; rows: number; data: string } {
  assert.equal(frame.type, 'S');
  const decoded = decodeSnapshot(frame.payload);
  assert.ok(decoded, 'snapshot refused by the codec');
  return decoded;
}

/** One frame's bytes, for comparing two streams. */
export function frameKey(frame: Frame): string {
  return `${frame.type}:${Buffer.from(frame.payload).toString('hex')}`;
}

/** A connection to a keeper, reading every frame it sends through task 1's frame reader. */
export interface KeeperClient {
  readonly socket: Socket;
  /** Every frame received so far, in order. */
  readonly frames: Frame[];
  /** Encodes and writes one frame; the result of `socket.write` (false: it waits in Node). */
  send(type: FrameType, payload?: Uint8Array | string): boolean;
  /** Writes bytes as they are, for frames the codec would refuse to build. */
  sendRaw(bytes: Uint8Array): void;
  /**
   * The first frame matching `match` among those not yet taken by an earlier `next` (waits for
   * it); every frame up to it is taken.
   */
  next(match: FrameType | ((frame: Frame) => boolean), timeoutMs?: number): Promise<Frame>;
  /** Every D payload so far, concatenated, as UTF-8. */
  output(): string;
  /** Waits until the output from byte `from` (of the UTF-8 text) contains `needle`; its end. */
  waitForOutput(needle: string, timeoutMs?: number, from?: number): Promise<number>;
  /** Settles when the keeper (or the client) closed the connection. */
  closed: Promise<void>;
  isClosed(): boolean;
  /** The frame reader's error, when the keeper sent something the codec refuses. */
  readerError(): string | null;
}

function toBytes(payload: Uint8Array | string | undefined): Uint8Array {
  if (payload === undefined) {
    return new Uint8Array(0);
  }
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
}

function keeperClient(socket: Socket, onFrame: (frame: Frame) => void): KeeperClient {
  const reader = frameReader();
  const frames: Frame[] = [];
  const decoder = new StringDecoder('utf8');
  let text = '';
  let taken = 0;
  let closed = false;
  let error: string | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    socket.on('close', () => {
      closed = true;
      resolve();
    });
  });
  socket.on('error', () => {}); // a closed connection is what some tests expect
  socket.on('data', (chunk: Buffer) => {
    const result = reader.push(chunk);
    if ('error' in result) {
      error = result.error;
      socket.destroy();
      return;
    }
    for (const frame of result) {
      frames.push(frame);
      if (frame.type === 'D') {
        text += decoder.write(Buffer.from(frame.payload));
      }
      onFrame(frame);
    }
  });
  const output = (): string => text;
  return {
    socket,
    frames,
    send(type, payload) {
      return socket.write(encodeFrame(type, toBytes(payload)));
    },
    sendRaw(bytes) {
      socket.write(bytes);
    },
    async next(match, timeoutMs = 5000) {
      const test = typeof match === 'string' ? (f: Frame) => f.type === match : match;
      let found = -1;
      let searched = taken;
      await until(
        () => {
          for (; searched < frames.length; searched++) {
            if (test(frames[searched] as Frame)) {
              found = searched;
              return true;
            }
          }
          return false;
        },
        () =>
          `frame ${typeof match === 'string' ? match : 'matching'} (have ${frames.map((f) => f.type).join('')}${closed ? ', closed' : ''})`,
        timeoutMs,
      );
      taken = found + 1;
      return frames[found] as Frame;
    },
    output,
    async waitForOutput(needle, timeoutMs = 5000, from = 0) {
      let at = -1;
      await until(
        () => {
          at = output().indexOf(needle, from);
          return at !== -1;
        },
        () => `${JSON.stringify(needle)} in the output ${JSON.stringify(output().slice(-300))}`,
        timeoutMs,
      );
      return at + needle.length;
    },
    closed: closedPromise,
    isClosed: () => closed,
    readerError: () => error,
  };
}

export interface Keeper {
  spec: KeeperSpec;
  /** The keeper's own pid. */
  pid: number;
  procStart: number;
  /** The keeper process's exit. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  hasExited(): boolean;
  /** `terms/<id>.pid`. */
  pidFile: string;
  /** The stand-in's record file (STANDIN_RECORD) of this keeper's program. */
  record: string;
  /** The keeper's pid line, or null when there is none. */
  pidLine(): PidLine | null;
  connect(): Promise<KeeperClient>;
  /** Connects, claims (C) and waits for the hello. */
  claim(): Promise<{ client: KeeperClient; hello: KeeperHello }>;
  /** SIGKILL to the keeper, a process this test started (asserted to be still that process). */
  kill(): void;
  /** SIGSTOP or SIGCONT to the keeper, a process this test started (and that still runs). */
  pause(on: boolean): void;
}

export interface StartOptions {
  /** Merged over the default spec. */
  spec?: Partial<KeeperSpec>;
  /** The keeper's own environment, over the sandbox's (SKYDECK_TEST_KEEPER_* go here). */
  env?: Record<string, string | undefined>;
  /** Written to stdin instead of the spec, as it is. */
  rawSpec?: string;
  /** Wait for the socket and the pid line (default true). */
  waitReady?: boolean;
  /**
   * Modules (name → python source) put before the standard library's, to make the keeper fail
   * where no input can: the keeper then runs without -I, with PYTHONPATH naming them.
   */
  faults?: Record<string, string>;
}

export interface KeeperBox {
  tp: RealTestPlatform;
  s: Sandbox;
  /** `<SKYDECK_HOME>/run`, where the runtime directory is when SKYDECK_HOME is set (S2 4.2). */
  runtimeDir: string;
  termsDir: string;
  /** `<SKYDECK_HOME>/state/keepers.log`: the keepers' stderr. */
  keepersLog: string;
  /** A spec for the stand-in: start deadline in 60 s, 80x24, cwd the sandbox's home. */
  spec(overrides?: Partial<KeeperSpec>): KeeperSpec;
  start(options?: StartOptions): Promise<Keeper>;
  /** The lines of keepers.log so far. */
  logLines(): string[];
}

function terminalId(tp: RealTestPlatform): string {
  return Buffer.from(tp.platform.randomBytes(6)).toString('hex');
}

/**
 * A sandbox for keepers. Call it before anything else of the test: its cleanup is registered
 * before the sandbox's own (t.after runs first in, first out), so that every keeper is killed —
 * and its program has ended — before the sandbox is removed.
 */
export function keeperSandbox(t: TestContext): KeeperBox {
  const keepers: Keeper[] = [];
  const clients: KeeperClient[] = [];
  const programs: { pid: number; procStart: number }[] = [];
  let box: KeeperBox | null = null;
  t.after(async () => {
    for (const client of clients) {
      client.socket.destroy();
    }
    if (box === null) {
      return;
    }
    killKeepersIn(box.s, box.runtimeDir);
    for (const keeper of keepers) {
      if (!keeper.hasExited()) {
        // No pid line (it never wrote one): signalled only while it is still the process started.
        await Promise.race([keeper.exited, sleep(2000)]);
        if (!keeper.hasExited() && stillRuns(keeper.pid, keeper.procStart)) {
          keeper.kill();
        }
      }
      await within(keeper.exited, `keeper ${keeper.pid} ended`);
    }
    // Each program got SIGHUP from its pty: wait for it (and its SessionEnd hook) to end, so that
    // nothing writes into the sandbox while it is removed.
    for (const program of programs) {
      await until(() => !stillRuns(program.pid, program.procStart), `program ${program.pid} ended`);
    }
  });

  const tp = realTestPlatform(t);
  const s = tp.sandbox;
  const runtimeDir = join(s.skydeckHome, 'run');
  const termsDir = join(runtimeDir, 'terms');
  mkdirSync(termsDir, { recursive: true, mode: 0o700 });
  const stateDir = join(s.skydeckHome, 'state');
  mkdirSync(stateDir, { recursive: true });
  const keepersLog = join(stateDir, 'keepers.log');
  const recordDir = join(s.root, 'records');
  mkdirSync(recordDir, { recursive: true });

  const spec = (overrides: Partial<KeeperSpec> = {}): KeeperSpec => {
    const id = overrides.id ?? terminalId(tp);
    const now = tp.platform.clock.nowNs();
    const record = join(recordDir, `${id}.jsonl`);
    return {
      protocol: 1,
      id,
      socket: join(termsDir, `${id}.sock`),
      cols: 80,
      rows: 24,
      cwd: s.home,
      argv: [standinCommand(s), '--session-id', SESSION],
      env: s.env({
        STANDIN_RECORD: record,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PWD: overrides.cwd ?? s.home,
      }),
      startBy: String(now + 60_000_000_000n),
      lock: `${now} 4242 51234567`,
      coreSoft: '1',
      meta: {
        sessionId: SESSION,
        kind: 'resume',
        slot: 3,
        openedNs: String(now),
        build: 'test-build',
        label: null,
        dir: s.home,
      },
      ...overrides,
    };
  };

  const start = async (options: StartOptions = {}): Promise<Keeper> => {
    const keeperSpec = spec(options.spec);
    let args = ['-I', KEEPER];
    let env = s.env(options.env);
    if (options.faults !== undefined) {
      // Without -I, so that PYTHONPATH puts these modules before the standard library's.
      const faults = join(s.root, `faults-${keeperSpec.id}`);
      mkdirSync(faults);
      for (const [name, source] of Object.entries(options.faults)) {
        writeFileSync(join(faults, `${name}.py`), source);
      }
      args = ['-s', KEEPER];
      env = { ...env, PYTHONPATH: faults };
    }
    const child = await tp.platform.processes.startDetached('python3', args, {
      cwd: '/',
      env,
      input: options.rawSpec ?? JSON.stringify(keeperSpec),
      stderrTo: keepersLog,
    });
    let ended = false;
    void child.exited.then(() => {
      ended = true;
    });
    const procStart = procStartOf(child.pid);
    const pidFile = join(termsDir, `${keeperSpec.id}.pid`);
    // The programs this keeper started, from its T frames and hellos: waited for at the end.
    const remember = (frame: Frame): void => {
      const parsed =
        frame.type === 'T'
          ? parseStarted(frame.payload)
          : frame.type === 'H'
            ? parseHello(frame.payload)
            : null;
      if (parsed === null || !parsed.ok) {
        return;
      }
      const { pid, procStart: start } = parsed.value;
      if (pid !== null && start !== null && !programs.some((p) => p.pid === pid)) {
        programs.push({ pid, procStart: start });
      }
    };
    const keeper: Keeper = {
      spec: keeperSpec,
      pid: child.pid,
      procStart: procStart ?? -1,
      exited: child.exited,
      hasExited: () => ended,
      pidFile,
      record: join(recordDir, `${keeperSpec.id}.jsonl`),
      pidLine: () => (existsSync(pidFile) ? parsePidLine(readFileSync(pidFile, 'utf8')) : null),
      async connect() {
        const socket = await tp.platform.net.connectUnix(keeperSpec.socket);
        const client = keeperClient(socket, remember);
        clients.push(client);
        return client;
      },
      async claim() {
        const client = await keeper.connect();
        client.send('C');
        const helloFrame = await client.next('H');
        return { client, hello: hello(helloFrame) };
      },
      kill() {
        assert.ok(stillRuns(child.pid, keeper.procStart), 'the keeper no longer runs');
        tp.platform.processes.signal(child.pid, 'SIGKILL');
      },
      pause(on) {
        assert.ok(stillRuns(child.pid, keeper.procStart), 'the keeper no longer runs');
        process.kill(child.pid, on ? 'SIGSTOP' : 'SIGCONT');
      },
    };
    keepers.push(keeper);
    if (options.waitReady ?? true) {
      await until(
        () => ended || (existsSync(keeperSpec.socket) && keeper.pidLine() !== null),
        'the keeper made its socket and pid line',
      );
      assert.ok(!ended, `the keeper ended at start; keepers.log: ${logText()}`);
    }
    return keeper;
  };

  const logText = (): string => (existsSync(keepersLog) ? readFileSync(keepersLog, 'utf8') : '');

  box = {
    tp,
    s,
    runtimeDir,
    termsDir,
    keepersLog,
    spec,
    start,
    logLines: () => logText().split('\n').slice(0, -1),
  };
  return box;
}

/** Answers the stand-in's DA1 and CPR at start, as a screen side does, and waits for its prompt. */
export async function answerStart(client: KeeperClient): Promise<void> {
  // Node.js starting the stand-in can take seconds on a loaded machine.
  await client.waitForOutput(DA1, 15_000);
  client.send('I', DA1_ANSWER);
  await client.waitForOutput(CPR, 15_000);
  client.send('I', CPR_ANSWER);
  await client.waitForOutput(PROMPT, 15_000);
  // The stand-in gave up on its DA1 after 2 s (a loaded machine): the late answer would become
  // typed input and fail a later step, far from the cause.
  assert.equal(
    client.output().includes('no answer to DA1'),
    false,
    'the stand-in timed out its DA1',
  );
}

/** Claims, sends G, answers the start queries and waits for the prompt. */
export async function startProgram(
  keeper: Keeper,
): Promise<{ client: KeeperClient; hello: KeeperHello; started: KeeperStarted }> {
  const { client, hello: first } = await keeper.claim();
  client.send('G');
  const startedFrame = await client.next('T', 15_000);
  await answerStart(client);
  return { client, hello: first, started: started(startedFrame) };
}

/** Types `text` and Enter, and waits until one more prompt than before is on the screen. */
export async function typeLine(
  client: KeeperClient,
  text: string,
  timeoutMs = 5000,
): Promise<void> {
  const prompts = (): number => client.output().split(PROMPT).length - 1;
  const before = prompts();
  client.send('I', `${text}\r`);
  await until(() => prompts() > before, `a prompt after ${JSON.stringify(text)}`, timeoutMs);
}

/** The spool events the stand-in's hook wrote: event name and the input's reason. */
export function spoolEvents(s: Sandbox): { event: string; reason: unknown }[] {
  const dir = join(s.skydeckHome, 'state', 'spool');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ev') && !name.startsWith('.'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      const marker = text.indexOf('\n--\n');
      const event = /^event=(.*)$/m.exec(text.slice(0, marker))?.[1] ?? '';
      const input = JSON.parse(text.slice(marker + 4)) as Record<string, unknown>;
      return { event, reason: input['reason'] };
    });
}
