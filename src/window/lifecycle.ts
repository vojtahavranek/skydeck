/**
 * The window's server as the commands see it (S2 5.1, 5.2, 5.5, 16.2; A23): finding it, starting
 * one, stopping one. `skydeck window`, `doctor` and `uninstall` all go through here, so that every
 * command finds, starts and stops the server the same way.
 *
 * Every command looks where the store's record says (`resolveRuntimeDir` 'follow', S2 4.2) and
 * believes `server.json` only once design 5.5's rule has judged its pid, process start and boot
 * id: nothing is decided on a line that cannot be judged (the command stops with the error).
 * Only `stopServer` sends a signal, and only to the process `server.json` names, after that
 * identity was confirmed alive right before each signal — never to a keeper, never to this
 * process (S2 5.1 `--restart`; the keepers and their programs keep running).
 */

import { join } from 'node:path';

import { SkydeckError } from '../platform/errors.ts';
import { MAX_TIMER_MS } from '../platform/time.ts';
import type { Detached, Files, Platform } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { describeError } from '../sessions/problems.ts';
import { sanitize } from '../text/sanitize.ts';
import { computeBuild } from './build.ts';
import { controlClient } from './client.ts';
import type { ControlClient } from './client.ts';
import { pidLineState } from './pidline.ts';
import type { PidLine, PidLineState } from './pidline.ts';
import type { PingAnswer } from './protocol.ts';
import {
  listKeeperLines,
  prepareRuntimeDir,
  readServerJson,
  resolveRuntimeDir,
  runtimeFiles,
  RuntimeDirError,
} from './runtime.ts';
import type { RuntimeFiles } from './runtime.ts';

export type FoundServer =
  | { kind: 'none' }
  | { kind: 'ours'; ping: PingAnswer }
  | { kind: 'other-build'; ping: PingAnswer }
  | { kind: 'other-checkout'; ping: PingAnswer }
  | { kind: 'hung'; pid: number };

/** Timeouts in ms, the design's values by default (A31): ping 5000, start 10000, stop 10000, kill 5000. */
export interface LifecycleTimes {
  pingMs?: number;
  startMs?: number;
  stopMs?: number;
  killMs?: number;
}

const DEFAULT_TIMES: Required<LifecycleTimes> = {
  pingMs: 5000,
  startMs: 10_000,
  stopMs: 10_000,
  killMs: 5000,
};

/** How often a wait looks again: for the server's answer, or for its process to be gone. */
const POLL_MS = 100;

/** S2 5.2's exit codes of `serve` that have a line of their own. */
const PORT_USED = 10;
const OTHER_CHECKOUT = 11;
const RUNTIME_DIR = 12;
const IN_CLAUDE_CODE = 13;

const NOT_RUNNING = { stopped: false, terminals: 0 } as const;

/** How a started `serve` ended. */
type Exit = Awaited<Detached['exited']>;

/** The design's defaults with `times` over them; RangeError for a time no timer can wait. */
function timesOf(times: LifecycleTimes): Required<LifecycleTimes> {
  const merged = { ...DEFAULT_TIMES, ...times };
  for (const [name, ms] of Object.entries(merged)) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
      throw new RangeError(`${name} is not a whole number of milliseconds a timer can wait: ${ms}`);
    }
  }
  return merged;
}

/** The runtime directory's files where a command looks (S2 4.2: the record first). */
function serverFiles(deck: Deck): RuntimeFiles {
  return runtimeFiles(resolveRuntimeDir(deck, 'follow').dir);
}

/** The current boot id; null when it cannot be read. */
function currentBootId(platform: Platform): string | null {
  try {
    return platform.proc.bootId();
  } catch {
    return null;
  }
}

/**
 * Design 5.5 on the server's line. 'unknown' is not an answer a command decides anything on
 * (design 5.5: the command stops with the error), so it is thrown here.
 */
function judge(platform: Platform, line: PidLine): 'alive' | 'dead' {
  const state: PidLineState = pidLineState(line, platform.proc, currentBootId(platform));
  if (state === 'unknown') {
    throw new SkydeckError(
      `cannot tell whether the window's server (pid ${line.pid}) still runs: the boot id or its /proc entry cannot be read`,
    );
  }
  return state;
}

/** The server server.json names and the line to judge it by; null when there is none. */
function recordedServer(
  deck: Deck,
): { files: RuntimeFiles; line: PidLine; checkout: string } | null {
  const files = serverFiles(deck);
  const json = readServerJson(deck.platform.files, files.serverJson);
  if (json === null) return null;
  return {
    files,
    line: { pid: json.pid, procStart: json.procStart, bootId: json.bootId },
    checkout: json.checkout,
  };
}

/**
 * `GET /ping`, or null when it gives no answer: refused, not in time, or failed (EPIPE or
 * ECONNRESET from a server that is closing, an answer that cannot be read). Anything that is not
 * a SkydeckError (a RangeError, a mistake of the caller) passes on.
 */
async function pingOnce(client: ControlClient, timeoutMs: number): Promise<PingAnswer | null> {
  try {
    const answer = await client.ping(timeoutMs);
    return typeof answer === 'string' ? null : answer;
  } catch (error) {
    if (error instanceof SkydeckError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Finding the server

/**
 * S2 5.1 step 1: server.json read; none when it is missing or its process is dead by design
 * 5.5's rule; otherwise `GET /ping` within `pingMs`: another checkout → other-checkout, another
 * build or boot → other-build, else ours. A process that is alive but gives no answer is hung —
 * unless a second look finds it gone meanwhile, which is none. Rejects with a SkydeckError when
 * the process cannot be judged.
 */
export async function findServer(
  deck: Deck,
  checkout: string,
  build: string,
  times: LifecycleTimes = {},
): Promise<FoundServer> {
  const { pingMs } = timesOf(times);
  const server = recordedServer(deck);
  if (server === null || judge(deck.platform, server.line) === 'dead') {
    return { kind: 'none' };
  }
  const ping = await pingOnce(controlClient(deck.platform.net, server.files.serverSock), pingMs);
  if (ping === null) {
    return judge(deck.platform, server.line) === 'dead'
      ? { kind: 'none' }
      : { kind: 'hung', pid: server.line.pid };
  }
  if (ping.checkout !== checkout) return { kind: 'other-checkout', ping };
  if (ping.build !== build || ping.bootId !== server.line.bootId) {
    return { kind: 'other-build', ping };
  }
  return { kind: 'ours', ping };
}

// ---------------------------------------------------------------------------------------------
// Starting one

/**
 * Starts `<appRoot>/bin/skydeck serve` detached (S2 5.2): working directory `/`, stdin
 * `/dev/null`, stdout and stderr appended to `<stateDir>/server.log`, the command's environment
 * with SKYDECK_ENV_ORIGIN = its working directory (A29). Then waits at most `startMs` for the
 * first of: `GET /ping` answered by a server of this checkout, the current build and the current
 * boot id — looking where the store's record says before every attempt, since a starting server
 * that found a stale record chooses and records another directory — or the process's exit, which
 * becomes S2 5.2's line for its code. Exit 0 means a server of this checkout holds the lock: that
 * one is waited for within the same time. After the time is up the process is left running.
 * Rejects with a SkydeckError when the program cannot be started.
 */
export async function startServe(
  deck: Deck,
  times: LifecycleTimes = {},
): Promise<{ ok: true; ping: PingAnswer } | { ok: false; line: string }> {
  const { platform, places } = deck;
  const { pingMs, startMs } = timesOf(times);
  const checkout = platform.appRoot;
  const build = computeBuild(platform.files, checkout);
  const bootId = currentBootId(platform);
  const log = join(places.stateDir, 'server.log');
  const program = join(checkout, 'bin', 'skydeck');
  // fromEntries defines own properties: a variable named __proto__ stays a variable.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(platform.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.SKYDECK_ENV_ORIGIN = platform.cwd;

  let child: Detached;
  try {
    child = await platform.processes.startDetached(program, ['serve'], {
      cwd: '/',
      env,
      stdoutTo: log,
      stderrTo: log,
    });
  } catch (error) {
    throw new SkydeckError(`cannot start ${program} (${describeError(error)})`);
  }

  // Set from callbacks; an object, so that the reads below are not narrowed to the first value.
  const seen: { exit: Exit | null; late: boolean } = { exit: null, late: false };
  const exited = child.exited.then((value) => {
    seen.exit = value;
  });
  let cancelDeadline = (): void => {};
  const deadline = new Promise<void>((resolve) => {
    cancelDeadline = platform.clock.after(startMs, () => {
      seen.late = true;
      resolve();
    });
  });
  const never = new Promise<void>(() => {});
  /** Settles at the deadline, and at the exit while the exit is not known yet. */
  const interrupted = (): Promise<null> =>
    Promise.race([deadline, seen.exit === null ? exited : never]).then(() => null);

  try {
    for (;;) {
      if (seen.exit !== null && seen.exit.code !== 0) {
        return { ok: false, line: exitLine(deck, seen.exit, log) };
      }
      if (seen.late) {
        return { ok: false, line: didNotStart(`no answer in ${startMs / 1000} s`, log) };
      }
      const client = controlClient(platform.net, serverFiles(deck).serverSock);
      const ping = await Promise.race([pingOnce(client, pingMs), interrupted()]);
      if (
        ping !== null &&
        ping.checkout === checkout &&
        ping.build === build &&
        bootId !== null &&
        ping.bootId === bootId
      ) {
        return { ok: true, ping };
      }
      await Promise.race([platform.clock.sleep(POLL_MS), interrupted()]);
    }
  } finally {
    cancelDeadline();
  }
}

/** S2 5.2's line for an exit of `serve` other than 0. */
function exitLine(deck: Deck, exit: Exit, log: string): string {
  switch (exit.code) {
    case PORT_USED:
      return `port ${deck.config.window.port} on 127.0.0.1 is used by another program; set window.port in ${sanitize(deck.places.configPath)}`;
    case OTHER_CHECKOUT: {
      const server = recordedServer(deck);
      return server !== null && judge(deck.platform, server.line) === 'alive'
        ? `a window server already runs (pid ${server.line.pid}, from ${sanitize(server.checkout)})`
        : didNotStart(`exit ${exit.code}`, log);
    }
    case RUNTIME_DIR: {
      const dir = resolveRuntimeDir(deck, 'follow').dir;
      const reason = refusalReason(deck.platform, dir) ?? `the reason is in ${log}`;
      return `the runtime directory ${sanitize(dir)} cannot be used: ${sanitize(reason)}; see skydeck doctor`;
    }
    case IN_CLAUDE_CODE:
      return "the window's server is not started from inside a Claude Code session";
    case null:
      return didNotStart(`ended by ${exit.signal ?? 'a signal'}`, log);
    default:
      return didNotStart(`exit ${exit.code}`, log);
  }
}

function didNotStart(why: string, log: string): string {
  return `the window's server did not start (${why}); see ${sanitize(log)}`;
}

/**
 * Why `serve` refused the runtime directory `dir` (exit 12), as prepareRuntimeDir judges it — but
 * a command creates nothing there: where prepareRuntimeDir would create the directory or terms/,
 * the reason is not known here (null), as it is not when nothing is wrong any more.
 */
function refusalReason(platform: Platform, dir: string): string | null {
  let wouldCreate = false;
  const refuse = (): never => {
    wouldCreate = true;
    throw new Error('a command creates no runtime directory');
  };
  const files: Files = { ...platform.files, mkdirp: refuse, chmod: refuse };
  try {
    prepareRuntimeDir({ ...platform, files }, runtimeFiles(dir));
  } catch (error) {
    if (error instanceof RuntimeDirError && !wouldCreate) return error.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Stopping it

/**
 * S2 5.1 `--restart` and `--stop`, 16.2: a server that answers `GET /ping` is asked for its
 * terminals (`GET /status`) and to stop (`POST /shutdown`), and is given `stopMs` to end. One that
 * does not answer, or does not end in time, gets SIGTERM and, `killMs` later, SIGKILL; each only
 * after server.json's pid, process start and boot id were confirmed alive at that moment, and
 * never when they name a keeper of the runtime directory, this process or pid 1. `stopped` is
 * true when a server was running and is gone; `terminals` is how many the server listed (0 when
 * it did not answer). Rejects with a SkydeckError when the process cannot be judged, when
 * server.json names a process that is not the server's, or when it outlives SIGKILL by `killMs`.
 */
export async function stopServer(
  deck: Deck,
  times: LifecycleTimes = {},
): Promise<{ stopped: boolean; terminals: number }> {
  const { platform } = deck;
  const { pingMs, stopMs, killMs } = timesOf(times);
  const server = recordedServer(deck);
  if (server === null || judge(platform, server.line) === 'dead') {
    return NOT_RUNNING;
  }
  const { files, line } = server;
  const client = controlClient(platform.net, files.serverSock);
  let terminals = 0;
  if ((await pingOnce(client, pingMs)) !== null) {
    terminals = await terminalCount(client);
    await client.shutdown().catch((error: unknown) => {
      if (!(error instanceof SkydeckError)) throw error;
    });
    if (await gone(platform, line, stopMs)) return { stopped: true, terminals };
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!signalServer(platform, files, line, signal) || (await gone(platform, line, killMs))) {
      return { stopped: true, terminals };
    }
  }
  throw new SkydeckError(
    `the window's server (pid ${line.pid}) did not end, not even after SIGKILL`,
  );
}

/** How many terminals the server lists; 0 when it does not say. */
async function terminalCount(client: ControlClient): Promise<number> {
  try {
    return (await client.status()).terminals.length;
  } catch (error) {
    if (error instanceof SkydeckError) return 0;
    throw error;
  }
}

/**
 * Sends `signal` to the server when its identity is confirmed alive now; false when it is gone.
 * Throws, sending nothing, when it cannot be judged, or when the identity is that of a keeper of
 * this runtime directory, of this process or of pid 1: such a server.json names no server.
 */
function signalServer(
  platform: Platform,
  files: RuntimeFiles,
  line: PidLine,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  if (judge(platform, line) === 'dead') return false;
  const keeper = listKeeperLines(platform, files).some(
    (k) =>
      k.line !== null &&
      k.line.pid === line.pid &&
      k.line.procStart === line.procStart &&
      k.line.bootId === line.bootId,
  );
  if (keeper || line.pid === platform.pid || line.pid === 1) {
    throw new SkydeckError(
      `${files.serverJson} names pid ${line.pid}, which is not the window's server (${keeper ? 'a keeper' : 'this process or init'}); nothing was signalled`,
    );
  }
  return platform.processes.signal(line.pid, signal);
}

/** Whether the server's process is gone (dead by design 5.5) within `ms`. */
async function gone(platform: Platform, line: PidLine, ms: number): Promise<boolean> {
  let late = false;
  const cancel = platform.clock.after(ms, () => {
    late = true;
  });
  try {
    for (;;) {
      if (pidLineState(line, platform.proc, currentBootId(platform)) === 'dead') return true;
      if (late) return false;
      await platform.clock.sleep(POLL_MS);
    }
  } finally {
    cancel();
  }
}
