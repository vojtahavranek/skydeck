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
 * second keep-alive is started beside one that may run (S2 4.2). For a `wsl.exe` this server
 * started, its end counts too: the script inside WSL can outlive a `wsl.exe` ended on the Windows
 * side, and then nothing holds WSL any more.
 */

import { join } from 'node:path';

import type { WindowConfig } from '../platform/config.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Detached, Ns, Platform } from '../platform/types.ts';
import { describeError } from '../sessions/problems.ts';
import { startWindowsProgram } from './edge.ts';
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
  | { kind: 'alive'; line: PidLine | null } // alive, or cannot be judged (line null: unreadable)
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
  /** The line of a keep-alive whose wsl.exe ended: it holds nothing, whatever it says. */
  let orphan: PidLine | null = null;
  let startDue = true;
  /** How many starts after an end so far: the index into RETRY_MS. */
  let retries = 0;
  let runningSinceNs: Ns | null = null;
  let ticking: Promise<void> | null = null;

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

  const readLine = (): LineState => {
    let text: string | null;
    try {
      text = platform.files.readText(files.keepalivePid);
    } catch {
      return { kind: 'alive', line: null }; // it is there but cannot be read: cannot tell
    }
    const line = text === null ? null : parsePidLine(text);
    if (line === null) {
      return { kind: 'dead' };
    }
    let bootId: string | null;
    try {
      bootId = platform.proc.bootId();
    } catch {
      bootId = null;
    }
    return pidLineState(line, platform.proc, bootId) === 'dead'
      ? { kind: 'dead' }
      : { kind: 'alive', line };
  };

  /** The keep-alive is gone: failed with `error`, and a start due after the schedule's wait. */
  const lost = (error: string): void => {
    watched = null;
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
    const seen = now.kind === 'alive' ? now.line : null;
    const alive =
      now.kind === 'alive' && !(seen !== null && orphan !== null && sameLine(seen, orphan));
    if (watched !== null) {
      const watch = watched;
      if (watch.ended !== null) {
        // Its script may live on: its line no longer means that WSL is held. A live line seen now
        // is that script's too, even if no earlier tick saw it (the script wrote it and wsl.exe
        // ended between two ticks): a start happens only while no live line other than an
        // orphan's exists, and only the script writes keepalive.pid.
        const line = watch.line ?? seen;
        if (line !== null) {
          orphan = line;
        }
        lost(
          line === null
            ? `wsl.exe ended before the keep-alive started (${howItEnded(watch.ended)})`
            : `the keep-alive ended (wsl.exe ${howItEnded(watch.ended)})`,
        );
        return;
      }
      if (alive) {
        watch.line ??= seen;
        set('running', null);
        return;
      }
      if (watch.child === null || watch.line !== null) {
        lost('the keep-alive ended (its process is gone)');
      }
      return; // started, and its script has not written its line yet
    }
    if (!startDue) {
      return;
    }
    if (alive) {
      watched = { child: null, ended: null, line: seen };
      set('running', null);
      return;
    }
    await start();
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
