/**
 * A machine for the tests of `doctor`, `install` and `uninstall` as the window changes them (S2 16):
 * a real test deck (A36) whose Windows side is a folder of the sandbox (SKYDECK_TEST_MNT_C, ruled
 * by the plan owner, task 24), the fake `skydeck serve` of test/fixtures/fake-serve started by the
 * test itself, keeper `.pid` lines naming processes the test started, and keeper sockets that count
 * the connections they get. Nothing here signals a process the test did not start through its own
 * handle.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { procStartFromStat } from '../../src/claude/procstat.ts';
import type { WindowConfig } from '../../src/platform/config.ts';
import type { Platform, Processes } from '../../src/platform/types.ts';
import { computeBuild } from '../../src/window/build.ts';
import { formatPidLine } from '../../src/window/pidline.ts';
import type { PidLine } from '../../src/window/pidline.ts';
import { resolveRuntimeDir, runtimeFiles } from '../../src/window/runtime.ts';
import type { RuntimeFiles } from '../../src/window/runtime.ts';
import { testDeck } from './deck.ts';
import type { RealTestDeck } from './deck.ts';
import { run } from './install.ts';
import type { Run } from './install.ts';
import type { Sandbox } from './sandbox.ts';
import { writeWindowConfig } from './window-config.ts';

/** The fixture app root whose bin/skydeck is the fake `skydeck serve` (task 22). */
const FAKE_SKYDECK = fileURLToPath(new URL('../fixtures/fake-serve/bin/skydeck', import.meta.url));
/** Long enough for node to start on a loaded machine; a passing case never waits it. */
const START_MS = 30_000;
/** The Windows user of the stand-in drive. */
export const WINDOWS_USER = 'me';

export interface WindowMachine extends RealTestDeck {
  s: Sandbox;
  /** The folder standing for /mnt/c; null when the machine has no C: drive. */
  drive: string | null;
  /** The runtime directory a command looks in (the store's record, else the rule). */
  runtime(): RuntimeFiles;
  /** Creates the runtime directory and terms/ with mode 0o700, as a server does. */
  makeRuntime(): RuntimeFiles;
}

export interface MachineOptions {
  /** Added to the sandbox's environment; a value undefined removes a variable. */
  env?: (s: Sandbox) => Record<string, string | undefined>;
  /** config.json's `window` (over writeWindowConfig's stub and `keepAlive: off`). */
  window?: Partial<WindowConfig> & Record<string, unknown>;
  /** window_secret set: the window was used (S2 16.3). Default true. */
  used?: boolean;
  /** A stand-in C: drive with Windows/ and one user's Edge folder. Default true. */
  drive?: boolean;
}

/**
 * The machine. Its C: drive (unless `drive: false`) holds `Windows/` and
 * `Users/me/AppData/Local/Microsoft/Edge/`, so the profile folder can be derived; WSL_INTEROP names
 * a path in the sandbox; SKYDECK_NODE is this node (for the fake serve).
 */
export function windowMachine(t: TestContext, options: MachineOptions = {}): WindowMachine {
  const withDrive = options.drive !== false;
  const d = testDeck(t, {
    real: true,
    env: (s) => ({
      SKYDECK_NODE: process.execPath,
      WSL_INTEROP: join(s.root, 'wsl-interop.sock'),
      WSL_DISTRO_NAME: 'Ubuntu',
      ...(withDrive ? { SKYDECK_TEST_MNT_C: join(s.root, 'c') } : {}),
      ...options.env?.(s),
    }),
  });
  const s = d.sandbox;
  const drive = withDrive ? join(s.root, 'c') : null;
  if (drive !== null) {
    mkdirSync(join(drive, 'Windows'), { recursive: true });
    mkdirSync(join(drive, 'Users', WINDOWS_USER, 'AppData', 'Local', 'Microsoft', 'Edge'), {
      recursive: true,
    });
  }
  writeWindowConfig(s, options.window ?? {});
  if (options.used !== false) {
    d.deck.store.setKv('window_secret', 'A'.repeat(43));
  }
  const runtime = (): RuntimeFiles => runtimeFiles(resolveRuntimeDir(d.deck, 'follow').dir);
  return {
    ...d,
    s,
    drive,
    runtime,
    makeRuntime() {
      const files = runtime();
      for (const dir of [files.dir, files.termsDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      }
      return files;
    },
  };
}

/** A command's output as lines, with the problems apart. */
export interface Lines extends Run {
  lines: string[];
  problems: string[];
}

/** `skydeck <argv>` on the machine's platform with `override` over it. */
export async function runOn(
  m: WindowMachine,
  argv: string[],
  override: Partial<Platform> = {},
): Promise<Lines> {
  const r = await run({ ...m.platform, ...override }, argv);
  const lines = r.stdout.split('\n').filter((line) => line !== '');
  return { ...r, lines, problems: lines.filter((line) => line.startsWith('problem  ')) };
}

/** The one line of `r` of `kind` that matches `pattern`; fails the test when there is none. */
export function lineOf(r: Lines, kind: 'ok' | 'info' | 'problem', pattern: RegExp): string {
  const found = r.lines.filter((line) => line.startsWith(kind.padEnd(9)) && pattern.test(line));
  assert.equal(found.length, 1, `one ${kind} line matching ${pattern}:\n${r.stdout}${r.stderr}`);
  return found[0] ?? '';
}

/** No line of `r` matches `pattern`. */
export function noLine(r: Lines, pattern: RegExp): void {
  assert.ok(
    !r.lines.some((line) => pattern.test(line)),
    `no line matching ${pattern}:\n${r.stdout}`,
  );
}

/**
 * Processes that start nothing and signal only `allowed` pids (processes the test started): every
 * call is recorded, so a test can assert that a command started or signalled nothing else.
 */
export function guardedProcesses(
  base: Processes,
  allowed: () => readonly number[] = () => [],
): Processes & { started: string[]; signalled: number[] } {
  const started: string[] = [];
  const signalled: number[] = [];
  return {
    started,
    signalled,
    startDetached(command) {
      started.push(command);
      return Promise.reject(new Error(`this test starts nothing detached: ${command}`));
    },
    signal(pid, signal) {
      signalled.push(pid);
      if (!allowed().includes(pid)) {
        throw new Error(`this test signals only its own processes, not ${pid}`);
      }
      return base.signal(pid, signal);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Processes the test owns

export interface Owned {
  pid: number;
  /** The pid line of this process: its real process start and the boot id. */
  line: PidLine;
  child: ChildProcess;
  exited: Promise<unknown>;
}

function lineOfPid(m: WindowMachine, pid: number): PidLine {
  const stat = m.proc.stat(pid);
  const procStart = stat === null ? null : procStartFromStat(stat);
  const bootId = m.proc.bootId();
  assert.ok(procStart !== null && bootId !== null, `the process ${pid} cannot be judged`);
  return { pid, procStart, bootId };
}

/** `sleep 60` from the sandbox's bin, killed through its own handle when the test ends. */
export async function liveProcess(t: TestContext, m: WindowMachine): Promise<Owned> {
  const child = spawn(join(m.s.bin, 'sleep'), ['60'], { env: m.s.env(), stdio: 'ignore' });
  t.after(() => {
    child.kill('SIGKILL'); // nothing once it has exited
  });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);
  return { pid, line: lineOfPid(m, pid), child, exited };
}

/** The pid line of a process of the test's own that has ended and been reaped: dead. */
export async function endedLine(t: TestContext, m: WindowMachine): Promise<PidLine> {
  const owned = await liveProcess(t, m);
  owned.child.kill('SIGKILL');
  await owned.exited;
  return owned.line;
}

/** Whether a process the test started still runs (its pid with the same process start). */
export function stillRuns(m: WindowMachine, owned: Owned): boolean {
  const stat = m.proc.stat(owned.pid);
  return stat !== null && procStartFromStat(stat) === owned.line.procStart;
}

/**
 * The fake serve of test/fixtures/fake-serve, started by the test itself with `env` over the
 * sandbox's; by default it answers as a server of this checkout and its build. Resolves once it
 * says `ready`; killed through its own handle when the test ends.
 */
export async function startFakeServe(
  t: TestContext,
  m: WindowMachine,
  env: Record<string, string> = {},
): Promise<Owned> {
  const { appRoot } = m.platform;
  const child = spawn(FAKE_SKYDECK, ['serve'], {
    env: m.s.env({
      SKYDECK_NODE: process.execPath,
      FAKE_SERVE_CHECKOUT: appRoot,
      FAKE_SERVE_BUILD: computeBuild(m.platform.files, appRoot),
      ...env,
    }),
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
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
  return { pid, line: lineOfPid(m, pid), child, exited };
}

// ---------------------------------------------------------------------------------------------
// Keepers by their files

/** terms/<id>.pid in `files`, as a keeper of version 2 writes it. */
export function writeKeeperLine(
  files: RuntimeFiles,
  id: string,
  line: PidLine,
  started = true,
): string {
  mkdirSync(files.termsDir, { recursive: true, mode: 0o700 });
  const path = files.termPid(id);
  writeFileSync(path, formatPidLine({ ...line, keeper: { version: '2', started } }));
  return path;
}

/** A unix socket at `path` that counts the connections it is given (a keeper's that records them). */
export async function countingSocket(
  t: TestContext,
  path: string,
): Promise<{ connections(): number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => {
    server.close();
  });
  return { connections: () => connections };
}
