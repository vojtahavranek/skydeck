import type { TestContext } from 'node:test';

import { resolvePlaces } from '../../src/platform/paths.ts';
import type { Places } from '../../src/platform/paths.ts';
import { assertProcessId, realPlatform } from '../../src/platform/real.ts';
import { MAX_TIMER_MS, NS_PER_SECOND, nsFromMs } from '../../src/platform/time.ts';
import type {
  Clock,
  Detached,
  DetachedOptions,
  Ns,
  Platform,
  Proc,
  Processes,
  RunOptions,
  RunResult,
  Runner,
} from '../../src/platform/types.ts';
import { sandbox } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';

/** 2026-11-12T09:00:00.000Z */
export const T0: Ns = 1_794_474_000_000_000_000n;
export const SEC: Ns = NS_PER_SECOND;
export const S1 = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';
export const S2 = '1c6a4d2f-9e3b-4a7c-8d4e-3f2a1b0c9d8e';
export const S3 = '2d7b5e3a-0f4c-4b8d-9e5f-4a3b2c1d0e9f';
export const BOOT_A = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
export const BOOT_B = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';

export interface FakeClock extends Clock {
  /**
   * Jumps to `ns`. No timer is called; each running one of `every` is next due one period after
   * `ns`, as a real interval is after the wall clock jumped, and one of `after` keeps the time it
   * had left (a real timeout counts on a clock that does not jump). A step of the wall clock:
   * `monotonicNs` (from 0 at the start) does not move.
   */
  setNs(ns: Ns): void;
  /**
   * Moves the time on by `ms`, `monotonicNs` with it. Every timer of `every` and `after` that falls
   * due on the way is called at its time (nowNs() answers that time meanwhile), once per period, in time order; of
   * two due at once, the one started first. `sleep(ms)` calls this and resolves on the next
   * microtask. A timer that steps the wall clock (setNs) during it takes nothing from
   * `monotonicNs`'s `ms`; after a step forward, the timers due in the rest of the advance are not
   * called (the advance ends where it would have on the wall clock), while `monotonicNs` counts
   * that rest.
   */
  advanceMs(ms: number): void;
  /** How many timers run: those of `every` not stopped, those of `after` not fired or cancelled. */
  timers(): number;
}

interface FakeTimer {
  /** null for a timer of `after`, which fires once. */
  periodNs: Ns | null;
  dueNs: Ns;
  callback: () => void;
}

export function fakeClock(startNs: Ns): FakeClock {
  let now = startNs;
  /** The reading of monotonicNs: it moves with advanceMs (and so sleep) only, never with setNs. */
  let mono: Ns = 0n;
  const running = new Set<FakeTimer>();
  /** The timer due first at or before `endNs`; of two due at once, the one started first. */
  const nextDue = (endNs: Ns): FakeTimer | undefined => {
    let next: FakeTimer | undefined;
    for (const timer of running) {
      if (timer.dueNs <= endNs && (next === undefined || timer.dueNs < next.dueNs)) {
        next = timer;
      }
    }
    return next;
  };
  const advanceMs = (ms: number): void => {
    const endNs = now + nsFromMs(ms);
    // monotonicNs moves by the advance itself, `ms` in all: a callback that steps the wall clock
    // (setNs) moves `now` but takes nothing from it and adds nothing to it.
    let leftNs = nsFromMs(ms);
    const pass = (ns: Ns): void => {
      const taken = ns < leftNs ? ns : leftNs;
      mono += taken;
      leftNs -= taken;
    };
    for (let timer = nextDue(endNs); timer !== undefined; timer = nextDue(endNs)) {
      if (timer.dueNs > now) {
        pass(timer.dueNs - now);
        now = timer.dueNs;
      }
      if (timer.periodNs === null) {
        running.delete(timer);
      } else {
        timer.dueNs += timer.periodNs;
      }
      timer.callback();
    }
    if (endNs > now) {
      now = endNs;
    }
    pass(leftNs);
  };
  /** Starts a timer; the returned function stops it. Sets keep insertion order: first started, first called. */
  const start = (timer: FakeTimer): (() => void) => {
    running.add(timer);
    return () => {
      running.delete(timer);
    };
  };
  return {
    nowNs: () => now,
    monotonicNs: () => mono,
    sleep: (ms) => {
      advanceMs(ms);
      return Promise.resolve();
    },
    every: (ms, callback) => {
      if (!Number.isSafeInteger(ms) || ms < 1) {
        throw new RangeError(`not a positive whole number of milliseconds: ${ms}`);
      }
      return start({ periodNs: nsFromMs(ms), dueNs: now + nsFromMs(ms), callback });
    },
    after: (ms, callback) => {
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
        throw new RangeError(`not a whole number of milliseconds a timer can wait: ${ms}`);
      }
      return start({ periodNs: null, dueNs: now + nsFromMs(ms), callback });
    },
    setNs: (ns) => {
      for (const timer of running) {
        if (timer.periodNs === null) {
          const left = timer.dueNs - now;
          timer.dueNs = ns + (left > 0n ? left : 0n);
        } else {
          timer.dueNs = ns + timer.periodNs;
        }
      }
      now = ns;
    },
    advanceMs,
    timers: () => running.size,
  };
}

/** cmdline is encoded as each argument followed by NUL; [] encodes to zero bytes. */
export interface FakeProcess {
  stat: string;
  cmdline: readonly string[];
}

export interface FakeProc extends Proc {
  setBootId(id: string | null): void;
  setProcess(pid: number, p: FakeProcess | null): void;
  setMemAvailableMb(mb: number | null): void;
  /** What fdTarget(pid, fd) answers; null: nothing (the default). */
  setFdTarget(pid: number, fd: number, target: string | null): void;
  /** The ports tcpListening finds listening; null: /proc/net/tcp* cannot be read. */
  setTcpListening(ports: readonly number[] | null): void;
}

export function fakeProc(
  init: {
    bootId?: string | null;
    processes?: Record<number, FakeProcess>;
    memAvailableMb?: number | null;
    /** Default []: nothing listens. */
    tcpListening?: readonly number[] | null;
    /** What kernelRelease answers; default '6.6.0-test' (follow-up F20). */
    kernelRelease?: string | null;
  } = {},
): FakeProc {
  let bootId = init.bootId ?? null;
  const kernelRelease = init.kernelRelease === undefined ? '6.6.0-test' : init.kernelRelease;
  let memAvailableMb = init.memAvailableMb ?? null;
  let listening = init.tcpListening === undefined ? [] : init.tcpListening;
  const fdTargets = new Map<string, string>();
  const processes = new Map<number, FakeProcess>(
    Object.entries(init.processes ?? {}).map(([pid, p]) => [Number(pid), p]),
  );
  return {
    fdTarget: (pid, fd) => fdTargets.get(`${pid}/${fd}`) ?? null,
    tcpListening: (port) => (listening === null ? null : listening.includes(port)),
    setFdTarget: (pid, fd, target) => {
      if (target === null) {
        fdTargets.delete(`${pid}/${fd}`);
      } else {
        fdTargets.set(`${pid}/${fd}`, target);
      }
    },
    setTcpListening: (ports) => {
      listening = ports;
    },
    bootId: () => bootId,
    stat: (pid) => processes.get(pid)?.stat ?? null,
    cmdline(pid) {
      const p = processes.get(pid);
      return p === undefined
        ? null
        : new TextEncoder().encode(p.cmdline.map((a) => `${a}\0`).join(''));
    },
    memAvailableMb: () => memAvailableMb,
    kernelRelease: () => kernelRelease,
    setBootId: (id) => {
      bootId = id;
    },
    setProcess: (pid, p) => {
      if (p === null) {
        processes.delete(pid);
      } else {
        processes.set(pid, p);
      }
    },
    setMemAvailableMb: (mb) => {
      memAvailableMb = mb;
    },
  };
}

/**
 * A realistic /proc/<pid>/stat line (52 fields) whose field 22 is `procStart`.
 * `comm` may contain spaces and ')'.
 */
export function statLine(pid: number, procStart: number, comm = 'claude'): string {
  const afterName = [
    'S', //                      3 state
    '1', //                      4 ppid
    String(pid), //              5 pgrp
    String(pid), //              6 session
    '0', //                      7 tty_nr
    '-1', //                     8 tpgid
    '4194304', //                9 flags
    '1000', //                  10 minflt
    '0', //                     11 cminflt
    '0', //                     12 majflt
    '0', //                     13 cmajflt
    '10', //                    14 utime
    '5', //                     15 stime
    '0', //                     16 cutime
    '0', //                     17 cstime
    '20', //                    18 priority
    '0', //                     19 nice
    '1', //                     20 num_threads
    '0', //                     21 itrealvalue
    String(procStart), //       22 starttime
    '123456789', //             23 vsize
    '5000', //                  24 rss
    '18446744073709551615', //  25 rsslim
    '4194304', //               26 startcode
    '4300000', //               27 endcode
    '140732000000000', //       28 startstack
    ...Array<string>(23).fill('0'), // 29-51
    '0', //                     52 exit_code
  ];
  return `${pid} (${comm}) ${afterName.join(' ')}`;
}

export interface RunCall {
  command: string;
  args: readonly string[];
  options: RunOptions | undefined;
}

export interface FakeRunner extends Runner {
  calls: RunCall[];
  interactiveCalls: RunCall[];
}

/** A result with the defaults of a program that ran and succeeded. */
export function runResult(partial: Partial<RunResult>): RunResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, notFound: false, ...partial };
}

/** What the runners reject with when their signal fires. */
function abortError(): Error {
  return new DOMException('the run was aborted', 'AbortError');
}

/**
 * `handler` answers run(); runInteractive() answers with `interactive` (default 0). run() honours
 * `options.signal` as the real runner does: an aborted signal rejects with an AbortError at once and
 * records no call; one that fires while the handler's answer is pending rejects the same way.
 */
export function fakeRunner(
  handler?: (call: RunCall) => RunResult | Promise<RunResult>,
  interactive?: (call: RunCall) => number | null,
): FakeRunner {
  const calls: RunCall[] = [];
  const interactiveCalls: RunCall[] = [];
  return {
    calls,
    interactiveCalls,
    async run(command, args, options) {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        throw abortError();
      }
      const call = { command, args, options };
      calls.push(call);
      const answer = Promise.resolve(handler === undefined ? runResult({}) : handler(call));
      if (signal === undefined) {
        return answer;
      }
      return new Promise<RunResult>((resolve, reject) => {
        const abort = (): void => {
          reject(abortError());
        };
        signal.addEventListener('abort', abort, { once: true });
        answer.then(
          (result) => {
            signal.removeEventListener('abort', abort);
            resolve(result);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', abort);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    runInteractive(command, args, options) {
      const call = { command, args, options };
      interactiveCalls.push(call);
      return Promise.resolve(interactive === undefined ? 0 : interactive(call));
    },
  };
}

export interface DetachedCall {
  command: string;
  args: readonly string[];
  options: DetachedOptions;
}

export interface SignalCall {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
}

export interface FakeProcesses extends Processes {
  /** Every startDetached call, in order, Windows commands included. */
  calls: DetachedCall[];
  /** Every signal call, in order. */
  signals: SignalCall[];
  /** The pids signal() finds alive; the test changes it. signal() itself does not. */
  live: Set<number>;
}

/**
 * Processes that start nothing. Every startDetached call is recorded and `handler` answers it (a
 * rejection is the rejection); without one each call gets the next pid from 5001 and an `exited`
 * that never settles. A Windows command is recorded and answered like any other, so that a test
 * can assert the command line Edge or the keep-alive would get: only what can start a real
 * process refuses one (ruling on A32). signal() refuses what the real one refuses (a RangeError
 * for a pid that is not a positive whole number), records the call and answers whether `live`
 * holds the pid.
 */
export function fakeProcesses(
  handler?: (call: DetachedCall) => Detached | Promise<Detached>,
  live: Iterable<number> = [],
): FakeProcesses {
  const calls: DetachedCall[] = [];
  const signals: SignalCall[] = [];
  const alive = new Set(live);
  let nextPid = 5000;
  return {
    calls,
    signals,
    live: alive,
    startDetached(command, args, options) {
      const call = { command, args, options };
      calls.push(call);
      if (handler === undefined) {
        return Promise.resolve({ pid: ++nextPid, exited: new Promise(() => {}) });
      }
      try {
        return Promise.resolve(handler(call));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    signal(pid, signal) {
      assertProcessId(pid); // as the real one: a RangeError for 0, -1, NaN, 1.5
      signals.push({ pid, signal });
      return alive.has(pid);
    },
  };
}

export interface TestPlatformOptions {
  /** Passed to sandbox.env(); a function gets the sandbox first (for paths inside it). */
  env?: Record<string, string | undefined> | ((s: Sandbox) => Record<string, string | undefined>);
  /** Fake clock start, default T0. */
  startNs?: Ns;
  /** Fake /proc boot id, default BOOT_A. */
  bootId?: string;
  /** Default 8000. */
  memAvailableMb?: number;
  /**
   * Real processes, which refuse Windows programs always (A32), instead of fakeProcesses(). Their
   * signal() reaches only a process they started that still runs: beside the fake /proc it throws
   * for any other pid.
   */
  realProcesses?: boolean;
}

/**
 * A platform for a test and the parts it is made of. The type parameters say which parts are
 * fakes a test can steer: all of them for testPlatform, none for realTestPlatform.
 */
export interface TestPlatform<
  C extends Clock = FakeClock,
  P extends Proc = FakeProc,
  R extends Runner = FakeRunner,
  X extends Processes = FakeProcesses,
> {
  /**
   * testPlatform: real Files and net; fake clock, proc, runner and processes; env =
   * sandbox.env(options.env); homeDir and cwd = sandbox.home; uuid() returns
   * 00000000-0000-4000-8000-00000000000<n> (n = 1, 2, …); randomBytes 0, 1, 2, … across calls;
   * pid 4000, the real uid, userName 'tester'; nodePath process.execPath; nodeVersion '24.19.0';
   * appRoot = the repository root.
   */
  platform: Platform;
  sandbox: Sandbox;
  clock: C;
  proc: P;
  runner: R;
  processes: X;
  /** resolvePlaces(platform.env, sandbox.home, null) */
  places: Places;
}

/** realTestPlatform's: every part real. */
export type RealTestPlatform = TestPlatform<Clock, Proc, Runner, Processes>;

/**
 * The test platform for logic: fake clock, /proc, runner and processes (see TestPlatform). Pass
 * `realProcesses: true` as a literal, so that the type of `processes` says they are real.
 */
export function testPlatform(
  t: TestContext,
  options: TestPlatformOptions & { realProcesses: true },
): TestPlatform<FakeClock, FakeProc, FakeRunner, Processes>;
export function testPlatform(t: TestContext, options?: TestPlatformOptions): TestPlatform;
export function testPlatform(
  t: TestContext,
  options: TestPlatformOptions = {},
): TestPlatform<FakeClock, FakeProc, FakeRunner, Processes> {
  const s = sandbox(t);
  const env = s.env(typeof options.env === 'function' ? options.env(s) : options.env);
  const clock = fakeClock(options.startNs ?? T0);
  const proc = fakeProc({
    bootId: options.bootId ?? BOOT_A,
    memAvailableMb: options.memAvailableMb ?? 8000,
  });
  const runner = fakeRunner();
  const real = realPlatform({ refuseWindows: true });
  const processes =
    options.realProcesses === true ? ownProcessesOnly(real.processes) : fakeProcesses();
  let uuids = 0;
  let randoms = 0;
  const platform: Platform = {
    clock,
    files: real.files,
    proc,
    runner,
    processes,
    net: real.net,
    env,
    homeDir: s.home,
    cwd: s.home,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
    randomBytes: (count) => Uint8Array.from({ length: count }, () => randoms++ & 0xff),
    pid: 4000,
    uid: real.uid,
    userName: 'tester',
    nodePath: process.execPath,
    nodeVersion: '24.19.0',
    appRoot: real.appRoot,
  };
  return {
    platform,
    sandbox: s,
    clock,
    proc,
    runner,
    processes,
    places: resolvePlaces(env, s.home, null),
  };
}

/**
 * Real processes that signal only what they started and what still runs. Beside a fake /proc,
 * design 5.5's identity check answers from fixtures, and a fixture's pid may be a real process of
 * the developer's: so signal() throws for any other pid, and sends nothing.
 */
function ownProcessesOnly(real: Processes): Processes {
  const running = new Set<number>();
  return {
    async startDetached(command, args, options) {
      const child = await real.startDetached(command, args, options);
      running.add(child.pid);
      void child.exited.then(() => {
        running.delete(child.pid);
      });
      return child;
    },
    signal(pid, signal) {
      if (!running.has(pid)) {
        throw new Error(
          `testPlatform signals only the processes it started and that still run, not ${pid}`,
        );
      }
      return real.signal(pid, signal);
    },
  };
}

/** What a keeper, the stand-in, the hook and the launcher run, linked into the sandbox's bin. */
const REAL_PROGRAMS = [
  'python3',
  'sh',
  'sleep',
  'date',
  'cat',
  'base64',
  'mkdir',
  'mv',
  'rm',
  'dirname',
  'readlink',
];

/**
 * A platform for tests that start a keeper, the stand-in or a server, or judge a real process
 * alive (A36): the real clock, /proc (and so the boot id, unless `options.bootId` overrides what
 * bootId() reports), runner (a run without env or cwd gets the sandbox's environment and home),
 * processes, net and randomBytes; pid = process.pid, the real uid and
 * userName; homeDir and cwd = the sandbox's home, appRoot = the repository, env =
 * sandbox.env(options.env). Its runner and processes refuse Windows programs always (A32), whatever
 * any environment says. python3, sh and the other programs of REAL_PROGRAMS are linked into the
 * sandbox's bin.
 */
export function realTestPlatform(
  t: TestContext,
  options: { bootId?: string; env?: TestPlatformOptions['env'] } = {},
): RealTestPlatform {
  const s = sandbox(t);
  s.link(...REAL_PROGRAMS);
  const env = s.env(typeof options.env === 'function' ? options.env(s) : options.env);
  const real = realPlatform({ refuseWindows: true });
  const { bootId } = options;
  const proc: Proc = bootId === undefined ? real.proc : { ...real.proc, bootId: () => bootId };
  // A run without env or cwd would get the developer's (Node's spawn falls back to process.env):
  // here it gets the sandbox's environment and home, as platform.env says.
  const runner: Runner = {
    run: (command, args, runOptions = {}) =>
      real.runner.run(command, args, {
        ...runOptions,
        env: runOptions.env ?? env,
        cwd: runOptions.cwd ?? s.home,
      }),
    runInteractive: (command, args, runOptions = {}) =>
      real.runner.runInteractive(command, args, {
        ...runOptions,
        env: runOptions.env ?? env,
        cwd: runOptions.cwd ?? s.home,
      }),
  };
  const platform: Platform = {
    clock: real.clock,
    files: real.files,
    proc,
    runner,
    processes: real.processes,
    net: real.net,
    env,
    homeDir: s.home,
    cwd: s.home,
    uuid: real.uuid,
    randomBytes: real.randomBytes,
    pid: real.pid,
    uid: real.uid,
    userName: real.userName,
    nodePath: real.nodePath,
    nodeVersion: real.nodeVersion,
    appRoot: real.appRoot,
  };
  return {
    platform,
    sandbox: s,
    clock: real.clock,
    proc,
    runner,
    processes: real.processes,
    places: resolvePlaces(env, s.home, null),
  };
}
