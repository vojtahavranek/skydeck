/**
 * The window's server as the commands see it (S2 5.1, 5.2, 5.5, 16.2; A23): finding it, starting
 * one, stopping one. `skydeck window`, `doctor` and `uninstall` all go through here, so that every
 * command finds, starts and stops the server the same way.
 *
 * Every command looks where the store's record says (`resolveRuntimeDir` 'follow', S2 4.2) and
 * believes `server.json` only once design 5.5's rule has judged its pid, process start and boot
 * id: nothing is decided on a line that cannot be judged (the command stops with the error).
 * A server that is starting is found too (ruled, server-findable): it holds the `window_server`
 * lock from its first step and writes `server.json` once its port is bound, before `server.sock`
 * answers (S2 5.2), so while `server.json` names no live process a live holder of the lock is
 * such a server, waited for within the ping wait. Only `stopServer` sends a signal, and only to
 * the process `server.json` — or, for a server that has not recorded itself, the lock — names,
 * after that identity was confirmed alive right before each signal — never to a keeper, never to
 * this process (S2 5.1 `--restart`; the keepers and their programs keep running).
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
  readServerLock,
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
  | { kind: 'hung'; pid: number; starting?: true };

/**
 * Timeouts in ms, the design's values by default (A31): ping 5000, start 10000, stop 10000, kill
 * 5000. A time left out or given as undefined is the default; one that is not a whole number from
 * 0 to 2^31 − 1 makes the function reject with a RangeError before it does anything (ruled).
 */
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
/** The longest a single ping of startServe's wait waits, whatever `pingMs` says: then it looks again. */
const START_PING_MS = 1000;

/**
 * Settled (server-findable, review 2): the server this command started, or the one it waited for,
 * is gone before this command could use it — and none of this installation may live. It says not
 * who stopped it. `log` is server.log.
 */
function stoppedBeforeUse(log: string): string {
  return `the window's server stopped before this command could use it; run skydeck window again (its log: ${sanitize(log)})`;
}

/** S2 5.2's exit codes of `serve` that have a line of their own. */
const PORT_USED = 10;
const OTHER_CHECKOUT = 11;
const RUNTIME_DIR = 12;
const IN_CLAUDE_CODE = 13;

/** How a started `serve` ended. */
type Exit = Awaited<Detached['exited']>;

/**
 * The design's defaults with the times `times` gives over them: a time that is missing or
 * undefined is the default (so a caller may pass `{ startMs: options.startMs }` on); RangeError for
 * one that is not a whole number of ms from 0 to 2^31 − 1, which no timer can wait (ruled).
 */
function timesOf(times: LifecycleTimes): Required<LifecycleTimes> {
  const merged = { ...DEFAULT_TIMES };
  for (const name of Object.keys(DEFAULT_TIMES) as (keyof LifecycleTimes)[]) {
    const ms = times[name];
    if (ms === undefined) continue;
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
      throw new RangeError(`${name} is not a whole number of milliseconds a timer can wait: ${ms}`);
    }
    merged[name] = ms;
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

/**
 * The server server.json names and the line to judge it by; null when there is none. A file that
 * cannot be read (EACCES, EISDIR …) is a SkydeckError naming it.
 *
 * readServerJson takes only a file in which every field of today's ServerJson is valid, so the
 * file's whole shape is a contract between builds: a later build that requires one more field
 * would read an older server's file as "no server" — `skydeck window` would then not find it, and
 * `--restart` and `--stop` would have nothing to stop. Only pid, procStart, bootId and checkout
 * are used here; whoever adds a field to ServerJson keeps it optional for the reader.
 */
function recordedServer(
  deck: Deck,
  files: RuntimeFiles,
): { line: PidLine; checkout: string } | null {
  let json: ReturnType<typeof readServerJson>;
  try {
    json = readServerJson(deck.platform.files, files.serverJson);
  } catch (error) {
    throw new SkydeckError(`cannot read ${files.serverJson} (${describeError(error)})`);
  }
  if (json === null) return null;
  return {
    line: { pid: json.pid, procStart: json.procStart, bootId: json.bootId },
    checkout: json.checkout,
  };
}

/**
 * `GET /ping`: the answer; 'timeout' when none came in time (or `signal` fired); 'refused' when it
 * was refused or failed — EPIPE or ECONNRESET from a server that is closing, an answer that cannot
 * be read — which a later attempt can still get past. Anything that is not a SkydeckError (a
 * RangeError, a mistake of the caller) passes on.
 */
async function pingOnce(
  client: ControlClient,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PingAnswer | 'refused' | 'timeout'> {
  try {
    return await client.ping(timeoutMs, signal);
  } catch (error) {
    if (error instanceof SkydeckError) return 'refused';
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Finding the server

/** The end of a wait, on the platform's clock: `over()` once `ms` have passed, `passed` settles
 *  then, and `signal` aborts then (or at `cancel()`), so that a ping still open is given up. */
interface Deadline {
  over(): boolean;
  passed: Promise<void>;
  signal: AbortSignal;
  cancel(): void;
}

function deadlineIn(platform: Platform, ms: number): Deadline {
  const controller = new AbortController();
  let late = false;
  let stop = (): void => {};
  const passed = new Promise<void>((resolve) => {
    stop = platform.clock.after(ms, () => {
      late = true;
      controller.abort();
      resolve();
    });
  });
  return {
    over: () => late,
    passed,
    signal: controller.signal,
    cancel() {
      stop();
      controller.abort();
    },
  };
}

/** The server a command deals with: the one server.json names, or one only the lock names yet. */
type Found =
  | {
      kind: 'recorded';
      line: PidLine;
      checkout: string;
      files: RuntimeFiles;
      /** Found only after a wait: it was starting (review 2: a 'hung' of it is still starting). */
      waited: boolean;
    }
  | { kind: 'starting'; line: PidLine; checkout: string };

/**
 * The server to deal with (ruled, server-findable): the one server.json names, when its process is
 * alive by design 5.5's rule; otherwise the holder of the window_server lock, when it is alive — a
 * server that is starting: server.json is looked at again every POLL_MS (where the store's record
 * says, looked up again: the start records its directory) until it names a live process (then
 * that one, `waited` when it was not found at the first look), or until `deadline` is over or `stopWaiting` says so for the holder's line
 * (then 'starting', with the identity the lock names). null when neither names a live process:
 * no lock, a value skydeck does not write, its holder dead — also when that comes about during
 * the wait. Rejects with judge's SkydeckError for a server.json line or a holder that cannot be
 * judged, as for a server.json that cannot be read.
 */
async function serverWithin(
  deck: Deck,
  deadline: Deadline,
  stopWaiting: (line: PidLine) => boolean = () => false,
): Promise<Found | null> {
  const { platform } = deck;
  for (let waited = false; ; waited = true) {
    const files = serverFiles(deck);
    const server = recordedServer(deck, files);
    if (server !== null && judge(platform, server.line) === 'alive') {
      return { kind: 'recorded', ...server, files, waited };
    }
    const holder = readServerLock(deck.store);
    if (holder === null || judge(platform, holder.line) === 'dead') return null;
    if (deadline.over() || stopWaiting(holder.line)) return { kind: 'starting', ...holder };
    await Promise.race([platform.clock.sleep(POLL_MS), deadline.passed]);
  }
}

/**
 * S2 5.1 step 1: server.json read; none when it is missing or its process is dead by design
 * 5.5's rule — unless the window_server lock names a live holder: a server that is starting
 * (ruled, server-findable), whose server.json is waited for within `pingMs`; one that has not
 * recorded itself by then is `hung` with `starting: true` and the pid the lock names, and so is
 * one that recorded itself during that wait but gives no answer in what is left (review 2). Then
 * `GET /ping` within what is left of `pingMs`: another checkout → other-checkout, another build or
 * boot → other-build, else ours. After a ping that gets no answer the process is judged again:
 * gone meanwhile → none. A refused or failed ping (a server in its orderly stop no longer accepts,
 * S2 5.5; a starting one listens a moment after it records itself) is tried again every 100 ms
 * until `pingMs` is over (ruled); one that timed out has waited already: a process still alive
 * is then hung. The ping open when `pingMs` is over is aborted, so nothing outlives the call.
 * Rejects with a SkydeckError when server.json cannot be read or the process — or the lock's
 * holder — cannot be judged.
 */
export async function findServer(
  deck: Deck,
  checkout: string,
  build: string,
  times: LifecycleTimes = {},
): Promise<FoundServer> {
  const { pingMs } = timesOf(times);
  const deadline = deadlineIn(deck.platform, pingMs);
  try {
    const found = await serverWithin(deck, deadline);
    if (found === null) return { kind: 'none' };
    if (found.kind === 'starting') return { kind: 'hung', pid: found.line.pid, starting: true };
    const ping = await pingWithin(deck, found.files, found.line, pingMs, deadline);
    if (ping === 'dead') return { kind: 'none' };
    if (ping === 'hung') {
      // Found starting, recorded during the wait, and no answer in what was left: still starting.
      return found.waited
        ? { kind: 'hung', pid: found.line.pid, starting: true }
        : { kind: 'hung', pid: found.line.pid };
    }
    if (ping.checkout !== checkout) return { kind: 'other-checkout', ping };
    if (ping.build !== build || ping.bootId !== found.line.bootId) {
      return { kind: 'other-build', ping };
    }
    return { kind: 'ours', ping };
  } finally {
    deadline.cancel();
  }
}

/**
 * findServer's ping (ruled): the answer, 'dead' when the process is gone by a look after a ping
 * without an answer, 'hung' when it still lives after a ping that timed out or once `deadline` is
 * over. Refused and failed pings are tried again every POLL_MS; the one open at the end is aborted
 * (the caller cancels `deadline`).
 */
async function pingWithin(
  deck: Deck,
  files: RuntimeFiles,
  line: PidLine,
  pingMs: number,
  deadline: Deadline,
): Promise<PingAnswer | 'dead' | 'hung'> {
  const { platform } = deck;
  const client = controlClient(platform.net, files.serverSock);
  for (;;) {
    const answer = await pingOnce(client, pingMs, deadline.signal);
    if (typeof answer === 'object') return answer;
    if (judge(platform, line) === 'dead') return 'dead';
    if (answer === 'timeout' || deadline.over()) return 'hung';
    await Promise.race([platform.clock.sleep(POLL_MS), deadline.passed]);
    if (deadline.over()) return judge(platform, line) === 'dead' ? 'dead' : 'hung';
  }
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
 * Each attempt's ping waits at most `pingMs` and never more than 1 s, so that the runtime
 * directory is looked up again soon (a socket that accepts and does not answer must not hide a
 * server that records another directory); the ping open when the wait ends is aborted, so nothing
 * outlives the call. Rejects with a SkydeckError, starting nothing, when the boot id cannot be read
 * (no server could ever be confirmed), and when the program cannot be started.
 * Started means findable (ruled, task 25): every other command finds a server by server.json; so
 * a matching ping counts only once server.json (where the store's record says, looked up again)
 * names that server — its pid, server id and boot id, its process alive by design 5.5's rule —
 * within the same `startMs`. A server that answers but has not recorded itself by then gives its
 * own line — only while it still answers (asked once more): one that answered and is gone gives
 * stoppedBeforeUse's line, one that lives but answers no more "does not answer". A server of this
 * build writes server.json before server.sock answers (ruled, server-findable), so for it the
 * check passes at its first answer while it lives; it stays for any server that answers before it
 * records itself. Exit 0 with no server of this installation alive or impossible to judge
 * (server.json, the lock) gives stoppedBeforeUse's line at once, not after `startMs` (settled,
 * server-findable, review 2).
 */
export async function startServe(
  deck: Deck,
  times: LifecycleTimes = {},
): Promise<{ ok: true; ping: PingAnswer } | { ok: false; line: string }> {
  const { platform, places } = deck;
  const { pingMs, startMs } = timesOf(times);
  const attemptMs = Math.min(pingMs, START_PING_MS);
  const checkout = platform.appRoot;
  const bootId = currentBootId(platform);
  if (bootId === null) {
    throw new SkydeckError(
      "the window's server is not started: the boot id cannot be read, so no answer of it could be confirmed",
    );
  }
  const build = computeBuild(platform.files, checkout);
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
  const seen: { exit: Exit | null; late: boolean; answered: PingAnswer | null } = {
    exit: null,
    late: false,
    answered: null,
  };
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
  const controller = new AbortController();
  /** Settles at the deadline, and at the exit while the exit is not known yet. */
  const interrupted = (): Promise<null> =>
    Promise.race([deadline, seen.exit === null ? exited : never]).then(() => null);

  try {
    for (;;) {
      if (seen.exit !== null && seen.exit.code !== 0) {
        return { ok: false, line: exitLine(deck, seen.exit, log) };
      }
      // Ruled (server-findable, review 2): its own serve ended with 0 — after a whole start and
      // stop, or because another server held the lock — and no server of this installation may
      // live: nothing is coming any more.
      if (seen.exit !== null && !serverMayLive(deck)) {
        return { ok: false, line: stoppedBeforeUse(log) };
      }
      const client = controlClient(platform.net, serverFiles(deck).serverSock);
      if (seen.late) {
        const answered = seen.answered;
        if (answered === null) {
          return { ok: false, line: didNotStart(`no answer in ${startMs / 1000} s`, log) };
        }
        // Only of a server that still answers (review 2): one that answered while it was
        // stopping has removed its server.json, which it had written before it answered. One
        // that answers no more is gone ("stopped"), or lives silent ("does not answer").
        const again = await pingOnce(client, attemptMs, controller.signal);
        if (typeof again === 'object' && again.serverId === answered.serverId) {
          return {
            ok: false,
            line: `the window's server (pid ${answered.pid}) answers, but did not record itself in ${sanitize(serverFiles(deck).serverJson)} within ${startMs / 1000} s; see ${sanitize(log)}`,
          };
        }
        return answererGone(deck, answered.pid)
          ? { ok: false, line: stoppedBeforeUse(log) }
          : {
              ok: false,
              line: `the window's server (pid ${answered.pid}) does not answer; skydeck window --restart stops it`,
            };
      }
      const ping = await Promise.race([
        pingOnce(client, attemptMs, controller.signal),
        interrupted(),
      ]);
      if (
        typeof ping === 'object' &&
        ping !== null &&
        ping.checkout === checkout &&
        ping.build === build &&
        ping.bootId === bootId
      ) {
        if (recordsItself(deck, ping)) return { ok: true, ping };
        seen.answered = ping;
      }
      await Promise.race([platform.clock.sleep(POLL_MS), interrupted()]);
    }
  } finally {
    cancelDeadline();
    controller.abort(); // the ping still open, if any
  }
}

/**
 * Whether server.json or the window_server lock names a process that is alive or cannot be judged
 * (design 5.5's rule); a file or lock that cannot be read counts as one: nothing is concluded on
 * what cannot be read.
 */
function serverMayLive(deck: Deck): boolean {
  const { platform } = deck;
  const bootId = currentBootId(platform);
  try {
    const json = readServerJson(platform.files, serverFiles(deck).serverJson);
    if (
      json !== null &&
      pidLineState(
        { pid: json.pid, procStart: json.procStart, bootId: json.bootId },
        platform.proc,
        bootId,
      ) !== 'dead'
    ) {
      return true;
    }
    const holder = readServerLock(deck.store);
    return holder !== null && pidLineState(holder.line, platform.proc, bootId) !== 'dead';
  } catch {
    return true;
  }
}

/**
 * Whether the process `pid` that answered a ping is gone — only a line's wording rests on it,
 * never a signal. Judged by design 5.5's rule when server.json or the lock names that pid (pid,
 * process start, boot id: 'dead' only); otherwise by the pid alone: no /proc entry. Anything that
 * cannot be read or judged counts as not gone.
 */
function answererGone(deck: Deck, pid: number): boolean {
  const { platform } = deck;
  const bootId = currentBootId(platform);
  try {
    const json = readServerJson(platform.files, serverFiles(deck).serverJson);
    const holder = readServerLock(deck.store);
    const named = [
      ...(json?.pid === pid ? [{ pid, procStart: json.procStart, bootId: json.bootId }] : []),
      ...(holder?.line.pid === pid ? [holder.line] : []),
    ];
    if (named.length > 0) {
      return named.every((line) => pidLineState(line, platform.proc, bootId) === 'dead');
    }
    return platform.proc.stat(pid) === null;
  } catch {
    return false;
  }
}

/**
 * Whether server.json, where a command looks, names the server that gave `ping`: the same pid,
 * server id and boot id, and its process alive by design 5.5's rule (so the process start too).
 * A file that cannot be read or judged names nothing yet.
 */
function recordsItself(deck: Deck, ping: PingAnswer): boolean {
  try {
    const json = readServerJson(deck.platform.files, serverFiles(deck).serverJson);
    return (
      json !== null &&
      json.pid === ping.pid &&
      json.serverId === ping.serverId &&
      json.bootId === ping.bootId &&
      pidLineState(
        { pid: json.pid, procStart: json.procStart, bootId: json.bootId },
        deck.platform.proc,
        currentBootId(deck.platform),
      ) === 'alive'
    );
  } catch {
    return false;
  }
}

/** S2 5.2's line for an exit of `serve` other than 0. */
function exitLine(deck: Deck, exit: Exit, log: string): string {
  switch (exit.code) {
    case PORT_USED:
      return `port ${deck.config.window.port} on 127.0.0.1 is used by another program; set window.port in ${sanitize(deck.places.configPath)}`;
    case OTHER_CHECKOUT: {
      const server = recordedServer(deck, serverFiles(deck));
      if (server !== null && judge(deck.platform, server.line) === 'alive') {
        return `a window server already runs (pid ${server.line.pid}, from ${sanitize(server.checkout)})`;
      }
      // One that is starting has not recorded itself yet: its lock names it (ruled, server-findable).
      const holder = readServerLock(deck.store);
      return holder !== null &&
        pidLineState(holder.line, deck.platform.proc, currentBootId(deck.platform)) === 'alive'
        ? `a window server already runs (pid ${holder.line.pid}, from ${sanitize(holder.checkout)})`
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
 * S2 5.1 `--restart` and `--stop`, 16.2: a server that answers `GET /ping` is asked to stop
 * (`POST /shutdown`) and is given `stopMs` to end. A ping that is refused or fails is tried again
 * every 100 ms within `pingMs`, as findServer's is (ruled, server-findable, third ruling); one that
 * times out is not; a server gone meanwhile is stopped. One that does not answer within `pingMs`,
 * or does not end in time, gets SIGTERM and, `killMs` later, SIGKILL; each only after server.json's pid, process start
 * and boot id were confirmed alive at that moment, and never when they name a keeper of the
 * runtime directory, this process or pid 1. `stopped` is true when a server was running and is
 * gone. `keepers` is what keeps running in the window (ruled): the keepers whose .pid line in the
 * runtime directory is alive or cannot be judged, counted before the stop whether or not a server
 * runs or answers — the `<n>` of uninstall's "<n> terminals in the window keep running" (16.2).
 * Rejects with a SkydeckError when server.json cannot be read or its process cannot be judged,
 * when it names a process that is not the server's, when the keepers cannot be listed or the
 * system refuses a signal, and when the server outlives SIGKILL by `killMs`.
 * `options.hungPid` (ruled, task 25): the pid of the server the caller has just found not
 * answering (findServer's 'hung'); when server.json still names that pid, it is not pinged again
 * and gets SIGTERM at once (S2 5.1), so that a command's stop does not wait the ping twice.
 * Without it, or for another pid, the server is pinged as above.
 * A server that is starting (ruled, server-findable): while server.json names no live process, a
 * live holder of the window_server lock is waited for within `pingMs` to record itself — then it
 * is pinged in what is left of `pingMs` and stopped as above; one that has not recorded itself by
 * then, or whose pid is `options.hungPid`, gets SIGTERM at once and SIGKILL after `killMs`, to the
 * identity the lock names, under the same checks. A holder that cannot be judged rejects as an
 * unknown server.json line does; nothing is signalled on it.
 */
export async function stopServer(
  deck: Deck,
  times: LifecycleTimes = {},
  options: { hungPid?: number } = {},
): Promise<{ stopped: boolean; keepers: number }> {
  const { platform } = deck;
  const { pingMs, stopMs, killMs } = timesOf(times);
  const deadline = deadlineIn(platform, pingMs);
  let target: { found: Found; answered: boolean } | 'none' | 'gone';
  let keepers: number;
  try {
    keepers = keeperLines(platform, serverFiles(deck)).filter((k) => k.state !== 'dead').length;
    target = await stopTarget(deck, pingMs, deadline, options.hungPid);
  } finally {
    deadline.cancel();
  }
  if (target === 'none') return { stopped: false, keepers };
  if (target === 'gone') return { stopped: true, keepers };
  const { found, answered } = target;
  const { line } = found;
  if (answered && (await gone(platform, line, stopMs))) return { stopped: true, keepers };
  const files = found.kind === 'recorded' ? found.files : serverFiles(deck);
  const source = found.kind === 'recorded' ? files.serverJson : "skydeck's window_server lock";
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (
      !signalServer(platform, files, line, source, signal) ||
      (await gone(platform, line, killMs))
    ) {
      return { stopped: true, keepers };
    }
  }
  throw new SkydeckError(
    `the window's server (pid ${line.pid}) did not end, not even after SIGKILL`,
  );
}

/**
 * stopServer's first step: the server to stop and whether it was asked to (`answered`: it answered
 * the ping and got POST /shutdown); 'none' when no live server is found; 'gone' when the one found
 * ended while it was pinged.
 */
async function stopTarget(
  deck: Deck,
  pingMs: number,
  deadline: Deadline,
  hungPid: number | undefined,
): Promise<{ found: Found; answered: boolean } | 'none' | 'gone'> {
  const found = await serverWithin(deck, deadline, (line) => line.pid === hungPid);
  if (found === null) return 'none';
  if (found.kind === 'starting' || found.line.pid === hungPid) return { found, answered: false };
  // Ruled (server-findable, third ruling): a refused or failed ping is tried again within pingMs,
  // as findServer's is — a server listens a moment after it records itself, and one in its orderly
  // stop no longer accepts; only one that times out, or none answered in time, is no answer.
  const ping = await pingWithin(deck, found.files, found.line, pingMs, deadline);
  if (ping === 'dead') return 'gone';
  const answered = typeof ping === 'object';
  if (answered) {
    const client = controlClient(deck.platform.net, found.files.serverSock);
    await client.shutdown().catch((error: unknown) => {
      if (!(error instanceof SkydeckError)) throw error;
    });
  }
  return { found, answered };
}

/** The keepers' .pid lines (listKeeperLines); a terms/ that cannot be listed is a SkydeckError. */
function keeperLines(platform: Platform, files: RuntimeFiles): ReturnType<typeof listKeeperLines> {
  try {
    return listKeeperLines(platform, files);
  } catch (error) {
    throw new SkydeckError(
      `the keepers in ${files.termsDir} cannot be listed (${describeError(error)})`,
    );
  }
}

/**
 * Sends `signal` to the server when its identity is confirmed alive now; false when it is gone.
 * Throws a SkydeckError, sending nothing, when the identity is that of a keeper of this runtime
 * directory, of this process or of pid 1 (such a server.json, or lock, names no server: `source`
 * says which named it), when the keepers cannot be listed, or when the process cannot be judged;
 * and when the system refuses the signal. The identity is judged last, directly before the
 * signal, so that nothing runs in between.
 */
function signalServer(
  platform: Platform,
  files: RuntimeFiles,
  line: PidLine,
  source: string,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  const keeper = keeperLines(platform, files).some(
    (k) =>
      k.line !== null &&
      k.line.pid === line.pid &&
      k.line.procStart === line.procStart &&
      k.line.bootId === line.bootId,
  );
  if (keeper || line.pid === platform.pid || line.pid === 1) {
    throw new SkydeckError(
      `${source} names pid ${line.pid}, which is not the window's server (${keeper ? 'a keeper' : 'this process or init'}); nothing was signalled`,
    );
  }
  if (judge(platform, line) === 'dead') return false;
  try {
    return platform.processes.signal(line.pid, signal);
  } catch (error) {
    throw new SkydeckError(
      `the window's server (pid ${line.pid}) cannot be sent ${signal} (${describeError(error)})`,
    );
  }
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
