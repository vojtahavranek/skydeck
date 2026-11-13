import type { TestContext } from 'node:test';

import { resolvePlaces } from '../../src/platform/paths.ts';
import type { Places } from '../../src/platform/paths.ts';
import { realPlatform } from '../../src/platform/real.ts';
import { NS_PER_SECOND, nsFromMs } from '../../src/platform/time.ts';
import type {
  Clock,
  Ns,
  Platform,
  Proc,
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
   * Jumps to `ns`. No timer of `every` is called; each running one is next due one period after
   * `ns`, as a real interval is after the wall clock jumped.
   */
  setNs(ns: Ns): void;
  /**
   * Moves the time on by `ms`. Every timer of `every` that falls due on the way is called at its
   * time (nowNs() answers that time meanwhile), once per period, in time order. `sleep(ms)` calls
   * this and resolves on the next microtask.
   */
  advanceMs(ms: number): void;
  /** How many timers of `every` run: started and not stopped. */
  timers(): number;
}

interface FakeTimer {
  periodNs: Ns;
  dueNs: Ns;
  callback: () => void;
}

export function fakeClock(startNs: Ns): FakeClock {
  let now = startNs;
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
    for (let timer = nextDue(endNs); timer !== undefined; timer = nextDue(endNs)) {
      if (timer.dueNs > now) {
        now = timer.dueNs;
      }
      timer.dueNs += timer.periodNs;
      timer.callback();
    }
    if (endNs > now) {
      now = endNs;
    }
  };
  return {
    nowNs: () => now,
    sleep: (ms) => {
      advanceMs(ms);
      return Promise.resolve();
    },
    every: (ms, callback) => {
      if (!Number.isSafeInteger(ms) || ms < 1) {
        throw new RangeError(`not a positive whole number of milliseconds: ${ms}`);
      }
      const timer = { periodNs: nsFromMs(ms), dueNs: now + nsFromMs(ms), callback };
      running.add(timer);
      return () => {
        running.delete(timer);
      };
    },
    setNs: (ns) => {
      now = ns;
      for (const timer of running) {
        timer.dueNs = ns + timer.periodNs;
      }
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
}

export function fakeProc(
  init: {
    bootId?: string | null;
    processes?: Record<number, FakeProcess>;
    memAvailableMb?: number | null;
  } = {},
): FakeProc {
  let bootId = init.bootId ?? null;
  let memAvailableMb = init.memAvailableMb ?? null;
  const processes = new Map<number, FakeProcess>(
    Object.entries(init.processes ?? {}).map(([pid, p]) => [Number(pid), p]),
  );
  return {
    bootId: () => bootId,
    stat: (pid) => processes.get(pid)?.stat ?? null,
    cmdline(pid) {
      const p = processes.get(pid);
      return p === undefined
        ? null
        : new TextEncoder().encode(p.cmdline.map((a) => `${a}\0`).join(''));
    },
    memAvailableMb: () => memAvailableMb,
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

export interface TestPlatformOptions {
  /** Passed to sandbox.env(); a function gets the sandbox first (for paths inside it). */
  env?: Record<string, string | undefined> | ((s: Sandbox) => Record<string, string | undefined>);
  /** Fake clock start, default T0. */
  startNs?: Ns;
  /** Fake /proc boot id, default BOOT_A. */
  bootId?: string;
  /** Default 8000. */
  memAvailableMb?: number;
}

export interface TestPlatform {
  /**
   * Real Files; fake clock, proc and runner; env = sandbox.env(options.env); homeDir and cwd =
   * sandbox.home; uuid() returns 00000000-0000-4000-8000-00000000000<n> (n = 1, 2, …);
   * nodePath process.execPath; nodeVersion '24.19.0'; appRoot = the repository root.
   */
  platform: Platform;
  sandbox: Sandbox;
  clock: FakeClock;
  proc: FakeProc;
  runner: FakeRunner;
  /** resolvePlaces(platform.env, sandbox.home, null) */
  places: Places;
}

export function testPlatform(t: TestContext, options: TestPlatformOptions = {}): TestPlatform {
  const s = sandbox(t);
  const env = s.env(typeof options.env === 'function' ? options.env(s) : options.env);
  const clock = fakeClock(options.startNs ?? T0);
  const proc = fakeProc({
    bootId: options.bootId ?? BOOT_A,
    memAvailableMb: options.memAvailableMb ?? 8000,
  });
  const runner = fakeRunner();
  const real = realPlatform();
  let uuids = 0;
  const platform: Platform = {
    clock,
    files: real.files,
    proc,
    runner,
    env,
    homeDir: s.home,
    cwd: s.home,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
    nodePath: process.execPath,
    nodeVersion: '24.19.0',
    appRoot: real.appRoot,
  };
  return { platform, sandbox: s, clock, proc, runner, places: resolvePlaces(env, s.home, null) };
}
