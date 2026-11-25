/**
 * A session's shell (issue #199, S2 7.10): opening one under a session terminal of the window.
 * The page names only the terminal; the server chooses the program (the account's login shell,
 * `/bin/sh` when none is known), its folder (the terminal's) and its environment (S2 15.1). The
 * rules of who may have one, and when one ends, are the server's (S2 4.3): the end is the
 * registry's (`terminals.ts`, the end rule).
 */
import { basename } from 'node:path';

import type { Files, Platform } from '../platform/types.ts';
import { RESTARTING } from './end-session.ts';
import { shellEnvironment } from './env.ts';
import { KEEPER_PROTOCOL } from './frames.ts';
import type { KeeperExit, ShellSpec } from './frames.ts';
import type { TerminalInfo } from './hub.ts';
import type { RuntimeFiles } from './runtime.ts';
import { KeeperStartError } from './terminals.ts';
import type { Registry } from './terminals.ts';

/** S2 7.1: a shell's keeper must start its program before this (as a new session's must). */
const START_BY_NS = 55_000_000_000n;
/** How long the open waits for the shell's program to start (its T). */
const START_WAIT_MS = 5000;
/** A shell that ends this soon after its T could not run (exit 127) or ends at once: an error. */
const ENDED_AT_ONCE_MS = 400;
const ID_BYTES = 6;
/** A shell's first size when the act's cannot be used. */
const FALLBACK = { cols: 80, rows: 12 };
const MAX_SIZE = 65_535;

export const SHELL_OPEN_TEXTS = {
  stopping: "the window's server is stopping",
  noTerminal: 'this session has no terminal in the window: open the session first',
  ended: 'this session has ended: resume it first',
  notStarted: 'this session has not started yet: open a shell once it runs',
  newer: 'this terminal was started by a newer skydeck; run skydeck window --restart',
  noFolder: "the session's folder is not there any more",
  didNotStart: 'the shell did not start',
  notWithin: `the shell did not start within ${START_WAIT_MS / 1000} seconds`,
} as const;

/**
 * The program of a session's shell: the account's login shell when it is set and `files` finds an
 * executable file there, else `/bin/sh`; started as a login shell, by `argv[0]` `-<name>` (what
 * `login` does: every shell reads or ignores it; a `-l` would make a shell that does not know it
 * refuse to start).
 */
export function shellProgram(
  loginShell: string | null,
  files: Pick<Files, 'stat'>,
): { file: string; argv: [string] } {
  let file = '/bin/sh';
  if (loginShell !== null && loginShell.startsWith('/')) {
    let info: ReturnType<Files['stat']> = null;
    try {
      info = files.stat(loginShell);
    } catch {
      info = null;
    }
    if (info !== null && info.kind === 'file' && (info.mode & 0o111) !== 0) file = loginShell;
  }
  return { file, argv: [`-${basename(file)}`] };
}

/**
 * S2 7.10: why a session terminal cannot have a shell now, or null when it can. A terminal a
 * restart holds, one whose program is over, one held by a newer keeper, and one that shows no
 * session or has no program yet have none.
 */
export function shellRefusal(terminal: TerminalInfo): string | null {
  if (terminal.restarting === true) return RESTARTING;
  const over =
    terminal.state === 'ended' ||
    terminal.state === 'lost' ||
    terminal.state === 'not-started' ||
    terminal.exit !== null;
  if (over) return SHELL_OPEN_TEXTS.ended;
  if (terminal.state === 'newer-keeper') return SHELL_OPEN_TEXTS.newer;
  if (terminal.sessionId === null || terminal.program === null) return SHELL_OPEN_TEXTS.notStarted;
  return null;
}

export interface ShellsDeps {
  registry: Pick<
    Registry,
    'list' | 'shells' | 'spawnShell' | 'start' | 'nextOpenedNs' | 'onChange'
  >;
  files: RuntimeFiles;
  platform: Platform;
  /** The server's environment, cleaned (`serverEnvironment`). */
  serverEnv: Readonly<Record<string, string>>;
  coreSoft: string | null;
  /** The interop link to give the shell, null when there is none (S2 6.4). */
  interop(): string | null;
  /** Points the interop link again before a start (S2 6.4). */
  refreshInterop(): Promise<void>;
  build: string;
  log(line: string): void;
  stopping(): boolean;
}

export interface Shells {
  /**
   * Opens a shell under session terminal `termId` with the first size `size`; `{ ok: true }` also
   * when it has one already (nothing is started then). From the list read to the spawn nothing is
   * awaited, so two opens at once meet at the registry's list and open one.
   */
  open(
    termId: string,
    size: { cols: number; rows: number },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

const failureKind = (error: unknown): string => (error as Error)?.name ?? 'error';

function sizeOf(size: { cols: number; rows: number }): { cols: number; rows: number } {
  const fits = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE;
  return fits(size.cols) && fits(size.rows) ? { cols: size.cols, rows: size.rows } : FALLBACK;
}

/** Whether a directory is at `path` (one that cannot be read counts as none). */
function isDir(files: Pick<Files, 'stat'>, path: string): boolean {
  try {
    return files.stat(path)?.kind === 'dir';
  } catch {
    return false;
  }
}

function exitText(exit: KeeperExit): string {
  return exit.signal !== null ? `signal ${exit.signal}` : `status ${exit.code ?? 0}`;
}

export function createShells(deps: ShellsDeps): Shells {
  const { registry, platform } = deps;
  const clock = platform.clock;

  /** After G: the program's start, then a short wait for an end at once. */
  function waitForShell(
    id: string,
    ended: Promise<KeeperExit>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      let done = false;
      const cleanups: (() => void)[] = [];
      const finish = (answer: { ok: true } | { ok: false; error: string }): void => {
        if (done) return;
        done = true;
        for (const cleanup of cleanups) cleanup();
        resolve(answer);
      };
      void ended.then((exit) => {
        finish({
          ok: false,
          error:
            exit.notStarted === null
              ? `the shell ended at once (${exitText(exit)})`
              : SHELL_OPEN_TEXTS.didNotStart,
        });
      });
      let started = false;
      const check = (): void => {
        if (done || started) return;
        const shell = registry.shells().find((one) => one.id === id);
        if (shell === undefined) {
          // Gone from the shells before its T: the exit (told to `ended`) says how, at once.
          clock.after(0, () => finish({ ok: false, error: SHELL_OPEN_TEXTS.didNotStart }));
          return;
        }
        if (shell.program === null) return;
        started = true;
        cleanups.push(clock.after(ENDED_AT_ONCE_MS, () => finish({ ok: true })));
      };
      cleanups.push(registry.onChange(check));
      cleanups.push(
        clock.after(START_WAIT_MS, () => {
          if (!started) finish({ ok: false, error: SHELL_OPEN_TEXTS.notWithin });
        }),
      );
      check();
    });
  }

  return {
    async open(termId, size) {
      try {
        await deps.refreshInterop(); // S2 6.4: the link is pointed again when a terminal starts
      } catch (error) {
        deps.log(`interop: the link was not pointed (${failureKind(error)})`);
      }
      // From here to the spawn: no await.
      if (deps.stopping()) return { ok: false, error: SHELL_OPEN_TEXTS.stopping };
      const terminal = registry.list().find((one) => one.id === termId);
      if (terminal === undefined) return { ok: false, error: SHELL_OPEN_TEXTS.noTerminal };
      const refusal = shellRefusal(terminal);
      if (refusal !== null) return { ok: false, error: refusal };
      if (registry.shells().some((one) => one.of === termId)) return { ok: true };
      const dir = terminal.dir;
      if (!isDir(platform.files, dir)) return { ok: false, error: SHELL_OPEN_TEXTS.noFolder };
      const id = Buffer.from(platform.randomBytes(ID_BYTES)).toString('hex');
      const { file, argv } = shellProgram(platform.loginShell, platform.files);
      const spec: ShellSpec = {
        protocol: KEEPER_PROTOCOL,
        id,
        socket: deps.files.termSock(id),
        ...sizeOf(size),
        cwd: dir,
        file,
        argv,
        env: shellEnvironment(deps.serverEnv, { cwd: dir, interop: deps.interop() }),
        startBy: String(clock.nowNs() + START_BY_NS),
        lock: null,
        coreSoft: deps.coreSoft,
        meta: {
          kind: 'shell',
          of: termId,
          openedNs: String(registry.nextOpenedNs()), // never one another terminal has (#213)
          build: deps.build,
          dir,
        },
      };
      let resolveEnded: (exit: KeeperExit) => void = () => {};
      const ended = new Promise<KeeperExit>((resolve) => {
        resolveEnded = resolve;
      });
      try {
        await registry.spawnShell(spec, resolveEnded);
      } catch (error) {
        const kind = error instanceof KeeperStartError ? error.kind : failureKind(error);
        deps.log(`terminal ${termId}: no shell was opened (${kind})`);
        return { ok: false, error: (error as Error)?.message ?? SHELL_OPEN_TEXTS.didNotStart };
      }
      deps.log(`terminal ${id}: a shell is opened under terminal ${termId}`);
      registry.start(id);
      const answer = await waitForShell(id, ended);
      if (!answer.ok) deps.log(`terminal ${id}: the shell did not open (${answer.error})`);
      return answer;
    },
  };
}
