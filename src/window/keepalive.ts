/**
 * S2 6.1 and 6.2: the keep-alive. With `window.keepAlive` "wsl" the server keeps one Windows client
 * of the distribution alive — `wsl.exe` running `bin/skydeck-keepalive <runtimeDir>` — and starts
 * it again when it ends: after 5 s, 30 s, then every 5 minutes. Its state is what `GET /status` and
 * the page's `welcome` carry; every change reaches the `onChange` listeners, so that the server can
 * tell the pages (`notice keepalive-lost`, `keepalive-back`).
 *
 * The server calls `tick` every second (S2 10.1); everything happens on a tick, the retry timers
 * only say that a start is due. Whether a keep-alive lives is judged by its `keepalive.pid` line
 * (design 5.5's rule, three-valued): a line that cannot be judged counts as alive, so that no
 * second keep-alive is started beside one that may run (S2 4.2). The script inside WSL can outlive
 * a `wsl.exe` ended on the Windows side, and then nothing holds WSL any more (ruled, S2 6.1): for
 * a `wsl.exe` this server started its end counts; a keep-alive it did not start is judged by its
 * `keepalive.interop` socket too (refused or gone: its `wsl.exe` is gone). Such a script is an
 * orphan: its line no longer counts, and it gets one SIGTERM — the server ending its own helper
 * (S2 2, principle 6) — when its identity is known alive, its command line is this directory's
 * keep-alive script, and the end is known rather than inferred; then the schedule starts a new one.
 */

import { basename, join } from 'node:path';

import type { WindowConfig } from '../platform/config.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Detached, Ns, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';
import { startWindowsProgram } from './edge.ts';
import { probeSocket } from './interop.ts';
import type { Interop } from './interop.ts';
import { parsePidLine, pidLineState } from './pidline.ts';
import type { PidLine } from './pidline.ts';
import type { KeepAlivePayload } from './protocol.ts';
import type { RuntimeFiles } from './runtime.ts';

/** S2 6.1: the Windows client the keep-alive is. */
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe';
/** S2 6.1: the waits before the first, the second and every later start after an end. */
const RETRY_MS = [5_000, 30_000, 300_000] as const;
/** A keep-alive that ran this long has ended once, not again: the schedule starts over at 5 s. */
const SCHEDULE_RESET_NS = 300n * NS_PER_SECOND;
/**
 * A found keep-alive's socket that accepted is asked again after this long (ruled, review 2). WSL
 * stops 15 s after its last Windows client (S2 6). Worst case with real timers: 3 s, up to 1 s to
 * the tick that asks, the first 5 s retry, up to 1 s to the tick that starts — a new wsl.exe by
 * just under 10 s, with room for its own start. Do not raise it without redoing that sum.
 */
const SOCKET_TRUSTED_MS = 3_000;
/** The script's file name: the SIGTERM goes only to a process running it for this directory. */
const SCRIPT_NAME = 'skydeck-keepalive';
const NO_DISTRO =
  'WSL_DISTRO_NAME is not set, so wsl.exe cannot be told which distribution to keep running';

export interface KeepAlive {
  /** A copy of the current state. */
  state(): KeepAlivePayload;
  /** S2 6.2: checks the keep-alive, and starts it when it is due. A tick while one runs waits for that one. */
  tick(): Promise<void>;
  /** Called with a copy of the new state after each change (state or error); must not throw. */
  onChange(listener: (state: KeepAlivePayload) => void): void;
}

/** What the server watches: a keep-alive found running, or a `wsl.exe` it started. */
interface Watched {
  /** null for a keep-alive found running (started by an earlier server). */
  child: Detached | null;
  /** How the started `wsl.exe` ended, once it has. */
  ended: { code: number | null; signal: string | null } | null;
  /** The script's live line, once seen. */
  line: PidLine | null;
}

/** What `keepalive.pid` says now. */
type LineState =
  | { kind: 'live'; line: PidLine | null } // alive, or cannot be judged (line null: unreadable)
  | { kind: 'dead' }; // missing, garbled, another boot, gone, reused pid

function sameLine(a: PidLine, b: PidLine): boolean {
  return a.pid === b.pid && a.procStart === b.procStart && a.bootId === b.bootId;
}

function howItEnded(ended: { code: number | null; signal: string | null }): string {
  return ended.code !== null ? `exit ${ended.code}` : `signal ${ended.signal ?? 'unknown'}`;
}

export function createKeepAlive(deps: {
  platform: Platform;
  window: WindowConfig;
  files: RuntimeFiles;
  appRoot: string;
  interop: Interop;
}): KeepAlive {
  const { platform, window, files, appRoot, interop } = deps;
  const { clock } = platform;
  const mode = window.keepAlive;
  const distro = platform.env.WSL_DISTRO_NAME ?? '';
  const listeners: ((state: KeepAlivePayload) => void)[] = [];

  /** Nothing ever to do: mode off, or no distribution to name (the environment does not change). */
  const idle = mode === 'off' || distro === '';
  let payload: KeepAlivePayload =
    mode === 'off'
      ? { mode, state: 'off', since: null, error: null }
      : {
          mode,
          state: distro === '' ? 'failed' : 'starting',
          since: String(clock.nowNs()),
          error: distro === '' ? NO_DISTRO : null,
        };
  let watched: Watched | null = null;
  /** The line of a script whose wsl.exe is gone: it holds nothing, whatever it says. */
  let orphan: PidLine | null = null;
  let startDue = true;
  /** How many starts after an end so far: the index into RETRY_MS. */
  let retries = 0;
  let runningSinceNs: Ns | null = null;
  let ticking: Promise<void> | null = null;
  /** A found keep-alive's socket accepted less than 3 s ago: it is not asked again yet. */
  let socketTrusted = false;
  let stopTrusting = (): void => {};

  const copy = (): KeepAlivePayload => ({ ...payload });

  const set = (state: KeepAlivePayload['state'], error: string | null): void => {
    if (payload.state === state && payload.error === error) {
      return;
    }
    const since = payload.state === state ? payload.since : String(clock.nowNs());
    payload = { mode, state, since, error };
    runningSinceNs = state === 'running' ? (runningSinceNs ?? clock.nowNs()) : null;
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener(copy());
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  };

  /** design 5.5's rule for `line` now: the boot id read afresh (null, so unknown, when it cannot be). */
  const stateOf = (line: PidLine): 'alive' | 'dead' | 'unknown' => {
    let bootId: string | null;
    try {
      bootId = platform.proc.bootId();
    } catch {
      bootId = null;
    }
    return pidLineState(line, platform.proc, bootId);
  };

  const readLine = (): LineState => {
    let text: string | null;
    try {
      text = platform.files.readText(files.keepalivePid);
    } catch {
      return { kind: 'live', line: null }; // it is there but cannot be read: cannot tell
    }
    const line = text === null ? null : parsePidLine(text);
    if (line === null || stateOf(line) === 'dead') {
      return { kind: 'dead' };
    }
    return { kind: 'live', line };
  };

  /**
   * Whether process `pid` runs this runtime directory's keep-alive script (ruled, review 2): one
   * argument's last path component is `skydeck-keepalive` and one argument is `files.dir`. So the
   * SIGTERM can never reach a keeper, `claude` or anything else, whatever keepalive.pid says.
   */
  const runsOurScript = (pid: number): boolean => {
    const bytes = platform.proc.cmdline(pid);
    if (bytes === null) {
      return false;
    }
    const args = new TextDecoder().decode(bytes).split('\0');
    return args.some((arg) => basename(arg) === SCRIPT_NAME) && args.includes(files.dir);
  };

  /**
   * `line`'s script holds nothing (its wsl.exe is gone): from now on its line does not count. With
   * `terminate`, when its identity is known alive — never on 'unknown' — and it runs this
   * directory's keep-alive script, it gets ONE SIGTERM (its trap removes keepalive.pid at once).
   * Called only with a live line that is not the orphan already — a line that is the orphan is
   * never live (see `check`) — so each orphan gets one SIGTERM at most.
   */
  const orphaned = (line: PidLine | null, terminate: boolean): void => {
    if (line === null) {
      return;
    }
    orphan = line;
    if (!terminate || stateOf(line) !== 'alive' || !runsOurScript(line.pid)) {
      return;
    }
    try {
      platform.processes.signal(line.pid, 'SIGTERM');
    } catch {
      // Nothing more to do: it no longer counts, and a new keep-alive is started all the same.
    }
  };

  /**
   * What keepalive.interop's socket says (ruled): 'refused' — refused or not there — means the
   * Windows side of that keep-alive is gone. No file, one that cannot be read, a path that is not
   * absolute, another error or no answer is 'unknown': no judgement.
   */
  const socketSays = async (): Promise<'accepts' | 'refused' | 'unknown'> => {
    let text: string | null;
    try {
      text = platform.files.readText(files.keepaliveInterop);
    } catch {
      return 'unknown';
    }
    return probeSocket(platform, text);
  };

  /** No connection again for 3 s after one that was accepted (ruled: it sends nothing). */
  const trustSocket = (trusted: boolean): void => {
    stopTrusting();
    stopTrusting = (): void => {};
    socketTrusted = trusted;
    if (trusted) {
      stopTrusting = clock.after(SOCKET_TRUSTED_MS, () => {
        socketTrusted = false;
      });
    }
  };

  /**
   * Whether the Windows side of a keep-alive this server did not start is gone. One being watched
   * whose socket accepted less than 3 s ago is not asked again; any other is asked now.
   */
  const windowsSideGone = async (watching: boolean): Promise<boolean> => {
    if (watching && socketTrusted) {
      return false;
    }
    const answer = await socketSays();
    trustSocket(answer === 'accepts');
    return answer === 'refused';
  };

  /** The keep-alive is gone: failed with `error`, and a start due after the schedule's wait. */
  const lost = (error: string): void => {
    watched = null;
    trustSocket(false);
    const ranNs = runningSinceNs === null ? null : clock.nowNs() - runningSinceNs;
    if (ranNs !== null && ranNs >= SCHEDULE_RESET_NS) {
      retries = 0;
    }
    const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)] ?? RETRY_MS[2];
    retries++;
    startDue = false;
    clock.after(wait, () => {
      startDue = true;
    });
    set('failed', error);
  };

  const start = async (): Promise<void> => {
    const args = [
      '-d',
      distro,
      '-u',
      platform.userName,
      '--exec',
      '/bin/sh',
      join(appRoot, 'bin', 'skydeck-keepalive'),
      files.dir,
    ];
    let child: Detached;
    try {
      child = await startWindowsProgram(platform, WSL_EXE, args, interop.current());
    } catch (error) {
      lost(`wsl.exe could not be started: ${describeError(error)}`);
      return;
    }
    const watch: Watched = { child, ended: null, line: null };
    void child.exited.then((ended) => {
      watch.ended = ended;
    });
    watched = watch;
    set('starting', null);
  };

  const check = async (): Promise<void> => {
    const now = readLine();
    const seen = now.kind === 'live' ? now.line : null;
    const live =
      now.kind === 'live' && !(seen !== null && orphan !== null && sameLine(seen, orphan));
    const watch = watched;
    if (watch !== null && watch.child !== null) {
      // A wsl.exe this server started: its end counts, and its script's line.
      if (watch.ended !== null) {
        // Its script may live on. A live line seen now that is not an earlier orphan's is taken
        // for that script's too, even if no earlier tick saw it (the script wrote it and wsl.exe
        // ended between two ticks): a start happens only while no live line other than an
        // orphan's exists. It no longer counts; but on that inference alone it is not signalled
        // (another server's keep-alive can be the one seen): only when its socket says refused.
        const line = watch.line ?? (live ? seen : null);
        const terminate =
          watch.line !== null || (line !== null && (await socketSays()) === 'refused');
        orphaned(line, terminate);
        lost(
          line === null
            ? `wsl.exe ended before the keep-alive started (${howItEnded(watch.ended)})`
            : `the keep-alive ended (wsl.exe ${howItEnded(watch.ended)})`,
        );
        return;
      }
      if (live) {
        watch.line ??= seen;
        set('running', null);
      } else if (watch.line !== null) {
        lost('the keep-alive ended (its process is gone)');
      } // else: started, and its script has not written its line yet
      return;
    }
    if (watch === null && !startDue) {
      return;
    }
    // A keep-alive this server did not start: its line, and its Windows side.
    const gone = live && (await windowsSideGone(watch !== null));
    if (gone) {
      orphaned(seen, true);
    }
    if (live && !gone) {
      watched ??= { child: null, ended: null, line: seen };
      set('running', null);
    } else if (watch !== null) {
      lost(
        gone
          ? "the keep-alive's wsl.exe is gone (its keepalive.interop socket refuses)"
          : 'the keep-alive ended (its process is gone)',
      );
    } else {
      await start();
    }
  };

  return {
    state: copy,
    tick() {
      if (idle) {
        return Promise.resolve();
      }
      ticking ??= check().finally(() => {
        ticking = null;
      });
      return ticking;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
