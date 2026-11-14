/**
 * The window terminal (S2 11.2; plan task 21): the `window` adapter of step 1's `Terminal`, which
 * the server passes to `launchPrepared` and `runRestore`. Its `open(spec)` spawns a keeper (S2 7.1)
 * for the prepared launch and starts the program in it, so that a session starts in the window
 * through exactly step 1's guard, lock and command builders (S2 11.1).
 */
import { SHORT_ID_LENGTH } from '../sessions/list.ts';
import { lockTakenNs } from '../sessions/resume.ts';
import type { Platform } from '../platform/types.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../terminals/types.ts';
import { programEnvironment } from './env.ts';
import type { KeeperExit, KeeperSpec } from './frames.ts';
import { KEEPER_PROTOCOL } from './frames.ts';
import type { RuntimeFiles } from './runtime.ts';
import { KeeperStartError } from './terminals.ts';
import type { Registry } from './terminals.ts';

export interface WindowTerminalDeps {
  registry: Registry;
  files: RuntimeFiles;
  platform: Platform;
  /** serverEnvironment(...).env and .coreSoft (task 8). */
  serverEnv: Readonly<Record<string, string>>;
  coreSoft: string | null;
  interop(): string | null;
  build: string;
}

/** S2 11.2: no T within this long after G is a timeout (the keeper may still start the program). */
const START_MS = 5000;
/** A21: a terminal id is 12 lowercase hex characters from 6 random bytes. */
const ID_BYTES = 6;

function terminalId(platform: Platform): string {
  return Buffer.from(platform.randomBytes(ID_BYTES)).toString('hex');
}

/** What a terminal that ended before its program was reported started says (S2 7.3's words). */
function notStartedText(exit: KeeperExit): string {
  return exit.notStarted !== null
    ? `not started: ${exit.notStarted}`
    : "the terminal's keeper ended before it reported the program started";
}

/**
 * After the hello: sends G and resolves on what the registry's list() then shows for the terminal —
 * the program (T, also when it has exited since: a failed exec is a program that ran) → ok; an exit
 * without a program (X with notStarted, or a keeper lost before T) or a terminal forgotten → not
 * started; neither within START_MS → timed out. Followed through onChange, subscribed before G.
 *
 * Ruled by the plan owner (task 21, review 2): every failure after the spawn is answered with
 * `timedOut: true`, so that step 1 shows no command to run by hand — a keeper may run, or the
 * terminal offers Resume itself (S2 11.2: `timedOut: false` only where no keeper process was ever
 * started, or it is known dead with no terminal left). Where the program was not started the error
 * says so and why ("not started: <reason>"); the terminal is listed with its exit, and
 * settleEndedTerminal gives back the lock and a new session's label and group (S2 7.8).
 */
function startAndWait(deps: WindowTerminalDeps, id: string): Promise<OpenResult> {
  const { registry, platform } = deps;
  return new Promise<OpenResult>((resolve) => {
    let done = false;
    let off = (): void => {};
    let cancel = (): void => {};
    const finish = (result: OpenResult): void => {
      if (!done) {
        done = true;
        off();
        cancel();
        resolve(result);
      }
    };
    const check = (): void => {
      const term = registry.list().find((candidate) => candidate.id === id);
      if (term === undefined) {
        finish({
          ok: false,
          error: 'the terminal was closed before its program started',
          timedOut: true,
        });
      } else if (term.program !== null) {
        finish({ ok: true });
      } else if (term.exit !== null) {
        finish({ ok: false, error: notStartedText(term.exit), timedOut: true });
      }
    };
    off = registry.onChange(check);
    cancel = platform.clock.after(START_MS, () => {
      finish({
        ok: false,
        error: `the program did not start within ${START_MS / 1000} seconds`,
        timedOut: true,
      });
    });
    registry.start(id);
    check();
  });
}

/**
 * One adapter per launch: `size` is the first size of S2 8.2.6. open() spawns a keeper with
 * programEnvironment(...), the next slot and meta (A28), sends G on a hello that arrives within
 * its 5-second wait, and resolves { ok: true } on T; { ok: false, timedOut: false, error } on
 * KeeperStartError 'python-missing', 'path-too-long' or 'spawn-failed' (no keeper process was
 * started, or it is known dead with no terminal left); and, ruled by the plan owner (task 21,
 * review 2; S2 11.2), { ok: false, timedOut: true, error } on KeeperStartError 'no-hello' or
 * 'stopping' (the keeper may run), on X with notStarted or a keeper that ends before T ("not
 * started: <reason>"), and on no T within 5 s after G. After open() has answered, it sends
 * nothing: a hello that comes later is a found keeper, and goes through decideFoundKeeper before
 * any G (task 23 wires events.hello).
 *
 * A resume whose spec's lock is null or not a lock skydeck writes (`lockTakenNs` null) is
 * protected by no lock of its own: it is answered { ok: false, timedOut: false } without spawning
 * (contract 2.6, ruled in #39). Any other throw (a spec the registry cannot take) rejects, which
 * `openSafely` turns into a failed open.
 */
export function windowTerminal(
  deps: WindowTerminalDeps,
  size: { cols: number; rows: number },
): Terminal {
  return {
    name: 'window',
    opensTabs: true,
    async open(spec: LaunchSpec): Promise<OpenResult> {
      if (spec.kind === 'resume' && (spec.lock === null || lockTakenNs(spec.lock) === null)) {
        return {
          ok: false,
          error: `the resume of ${spec.sessionId.slice(0, SHORT_ID_LENGTH)} holds no lock skydeck wrote; the window does not start it`,
          timedOut: false,
        };
      }
      const { registry, files, platform } = deps;
      const id = terminalId(platform);
      // The slot and the spawn without an await between them: the registry lists the terminal
      // (and so holds its slot) as soon as spawn is called.
      const keeperSpec: KeeperSpec = {
        protocol: KEEPER_PROTOCOL,
        id,
        socket: files.termSock(id),
        cols: size.cols,
        rows: size.rows,
        cwd: spec.cwd,
        argv: [...spec.argv],
        env: programEnvironment(deps.serverEnv, { cwd: spec.cwd, interop: deps.interop() }),
        startBy: String(spec.startByNs),
        lock: spec.lock,
        coreSoft: deps.coreSoft,
        meta: {
          sessionId: spec.sessionId,
          kind: spec.kind,
          slot: registry.nextSlot(),
          openedNs: String(platform.clock.nowNs()),
          build: deps.build,
          label: spec.label,
          dir: spec.cwd,
        },
      };
      try {
        await registry.spawn(keeperSpec);
      } catch (error) {
        if (error instanceof KeeperStartError) {
          // Ruled (M1): once the keeper was started and is not known to have ended, the answer
          // is a timeout — a hand-run claude could double the session.
          const mayRun = error.kind === 'no-hello' || error.kind === 'stopping';
          return { ok: false, error: error.message, timedOut: mayRun };
        }
        throw error;
      }
      return startAndWait(deps, id);
    },
  };
}
