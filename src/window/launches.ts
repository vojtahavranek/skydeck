/**
 * The one way to start a session in the window (plan C1, S2 11.1): a page's `act resume` and `act
 * new`, `POST /resume` and `POST /new` over `server.sock`, and every session a restore opens go
 * through here, and through step 1's own functions only — the guard on freshly refreshed rows
 * (`prepareResumeById`), the lock, `prepareNew`'s checks of the directory, the label, the group
 * and the flags (design 7.6, 7.7), the command builders with the configured `claudeCommand`, and
 * `launchPrepared`. Nothing a request carries is checked here a second time with another rule, and
 * no request can name a program or an argument list (S2 8.3): a `POST /new` body's label, group,
 * directory and flags reach `prepareNew` exactly as the command line's options do.
 *
 * What the window adds (stage A's actions, moved here unchanged): the refusal "this session is
 * already open in the window" before the guard while a terminal of the session may still run (S2
 * 11.1) — and, plan task 82, `<short> is running (pid <p>)` while a lost terminal's program may
 * still run, which the guard cannot see before that program reports its session start (S2 7.8) —,
 * the session's terminals that are over closed before its new one opens (S2 7.8), a
 * terminal whose `open()` rejects or throws answered as an open that timed out (S2 11.3), and the
 * lock given back after a throw before `open()`. For restore (task 73): `refusal`, `gone` and
 * `restoreTerminal`, which never throw (a hook that throws would end the whole run, task 71).
 *
 * Logs carry kinds only (S2 2, 5.2): never a label, a group, a directory, a flag or an error's
 * message. Each line names what it was part of (`resume: …`, `new: …`, `restore: …`); the caller's
 * `log` puts its own prefix before it.
 */
import { SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { launchPrepared } from '../sessions/launch.ts';
import { SHORT_ID_LENGTH } from '../sessions/list.ts';
import type { LaunchOutcome } from '../sessions/launch.ts';
import { prepareNew, readLock, releaseLock } from '../sessions/resume.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { prepareResumeById } from '../sessions/resume-by-id.ts';
import type { OpenResult, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import type { TerminalHub, TerminalInfo } from './hub.ts';
import { lives, lostProgramMayRun } from './mapping.ts';
import type { NewRequest } from './protocol.ts';
import { MAY_START } from './view/sections.ts';

type Size = { cols: number; rows: number };

export interface LaunchesDeps {
  deck: Deck;
  hub: TerminalHub;
  /** As stage A's ActionDeps.terminalFor: it only builds the object, nothing is spawned before open(). */
  terminalFor(size: Size): Terminal;
  log: (line: string) => void;
}

export interface Launched {
  /** C2's codes: 0 started; a SkydeckError's exitCode; 4 for "already open"; launchPrepared's code. */
  code: number;
  /** launchPrepared's lines as it gives them (each `skydeck: …` but the printable command line,
   *  which has none) after a launch; a refusal's message lines, no prefix. Sanitised. */
  lines: string[];
  /** Nothing was prepared or started: the window's refusal, the guard, the lock, RefError, a
   *  usage error. */
  refused: boolean;
  /** The session started; null unless code is 0. */
  sessionId: string | null;
}

export interface Launches {
  resume(sessionId: string, size: Size): Promise<Launched>;
  newSession(request: NewRequest, size: Size): Promise<Launched>;
  /** S2 11.1: "this session is already open in the window" while the hub lists a terminal of the
   *  session (`sessionId ?? expectedSessionId`) whose state is in MAY_START; else, while a lost
   *  terminal of the session has a program that may still run (plan task 82: task 57's rule, for
   *  60 s after the loss), the guard's words `<short> is running (pid <p>[, pid <p>…])`, the
   *  terminal opened last first; else null. `resume` refuses with the same text, code 4. Never
   *  throws: a hub that cannot be read gives `the window's terminals could not be read (<kind>)`. */
  refusal(sessionId: string): string | null;
  /** C8: null while a terminal of the session may still run; else why it cannot start any more —
   *  `not started: <reason>` (an exit with notStarted), `its terminal's keeper ended` (lost, once
   *  the program its keeper reported is gone by design 5.5: null while it may live),
   *  `claude ended before the session started (status <n>)` / `(signal <n>)`, `its terminal was
   *  closed` (none listed). Never throws: null when the hub cannot be read. */
  gone(sessionId: string): string | null;
  /** The terminal restore opens with (size read once, when built): its open(spec) closes the
   *  spec's session's terminals that are over, then opens; a throw is a timeout, as for resume. A
   *  factory that throws: its open fails with `timedOut: false` (nothing was spawned). A spec that
   *  is not a resume: `restore starts only resumes`, `timedOut: false`, nothing closed or opened. */
  restoreTerminal(size: Size): Terminal;
}

/** S2 11.1, ruled by the plan owner (review 2 of stage A's task 32). */
const ALREADY_OPEN = 'this session is already open in the window';
/** C2: the window's own refusal has the guard's exit code (ResumeRefusedError, design 7.6). */
const REFUSED_CODE = 4;
/** C8's reasons. */
const KEEPER_ENDED = "its terminal's keeper ended";
const CLOSED = 'its terminal was closed';
const ENDED = 'claude ended before the session started';
/** restoreTerminal's answer to a spec that is not a resume: nothing was started (ruled, review 2). */
const NOT_A_RESUME: OpenResult = {
  ok: false,
  error: 'restore starts only resumes',
  timedOut: false,
};

/** Where a log line comes from: the launch it was part of. */
type Part = 'resume' | 'new' | 'restore';

/** A refusal: its message line by line as failureText prints it, no prefix (C2), sanitised. */
function refusedBy(error: SkydeckError): Launched {
  const lines = error.message.replace(/\n$/, '').split('\n').map(sanitize);
  return { code: error.exitCode, lines, refused: true, sessionId: null };
}

/** A launch's outcome: its code and lines (launchPrepared sanitises every foreign string in them);
 *  the session only when it started (plan A25). */
function launched(prepared: PreparedLaunch, outcome: LaunchOutcome): Launched {
  const { code, lines } = outcome;
  return { code, lines, refused: false, sessionId: code === 0 ? prepared.sessionId : null };
}

/** C8: why a terminal that is over can no longer start its session. */
function overReason(terminal: TerminalInfo): string {
  const { exit } = terminal;
  if (terminal.state === 'lost') return KEEPER_ENDED;
  if (terminal.state === 'not-started') {
    return exit === null || exit.notStarted === null
      ? 'not started'
      : `not started: ${sanitize(exit.notStarted)}`;
  }
  if (exit !== null && exit.code !== null) return `${ENDED} (status ${exit.code})`;
  if (exit !== null && exit.signal !== null) return `${ENDED} (signal ${exit.signal})`;
  return ENDED;
}

/**
 * Throws only what is not a refusal: a busy store (isBusy) and unexpected errors; callers map them
 * (the actions to stage A's texts, the server to C2's). `resume`: the window's refusal (code 4,
 * before anything is built or taken), then the terminal built, `prepareResumeById` (a SkydeckError
 * is the refusal: its exit code and message lines), the session's terminals that are over closed,
 * `launchPrepared`; a throw after the lock and before `open()` gives that lock back. `newSession`:
 * the terminal built, `prepareNew` with the request as it is (a blank label is refused, as `skydeck
 * new --label ' '` refuses it), `launchPrepared`. Up to the terminal's `open()` both run without an
 * await, so that two starts of one session meet at the lock.
 */
export function createLaunches(deps: LaunchesDeps): Launches {
  const { deck, hub, log } = deps;

  /** The window's terminals of the session: the session each shows, or while it shows none the one
   *  it was opened for — what the terminal itself carries, as the view model places it. */
  function terminalsOf(sessionId: string): TerminalInfo[] {
    return hub
      .list()
      .filter((terminal) => (terminal.sessionId ?? terminal.expectedSessionId) === sessionId);
  }

  /**
   * Why the window refuses a start of the session, before the guard; null when it does not. A
   * terminal of the session whose state is in MAY_START: "already open" (S2 11.1). Else, a lost
   * terminal of the session whose program may still run — task 57's rule (`lostProgramMayRun`: the
   * program its keeper reported, alive by design 5.5 or not readable, the loss less than 60 s old by
   * the server's clock) — in the guard's own words, which the guard cannot say itself: a program
   * that has not reported its session start is no holder (plan task 82). Every such program's pid,
   * the terminal opened last first (checkResumable lists its holders latest first).
   */
  function windowRefusal(sessionId: string): string | null {
    const terminals = terminalsOf(sessionId);
    if (terminals.some((terminal) => MAY_START.has(terminal.state))) return ALREADY_OPEN;
    const { proc, clock } = deck.platform;
    const nowNs = clock.nowNs();
    const pids = terminals
      .filter((terminal) => lostProgramMayRun(terminal, proc, nowNs))
      .sort((a, b) => (a.openedNs === b.openedNs ? 0 : a.openedNs > b.openedNs ? -1 : 1))
      .map((terminal) => `pid ${terminal.program?.pid}`);
    return pids.length === 0
      ? null
      : `${sessionId.slice(0, SHORT_ID_LENGTH)} is running (${pids.join(', ')})`;
  }

  /**
   * `terminal` with a rejection (or a throw) of its `open()` turned into the result of an open that
   * timed out (ruled, review 1 of stage A's task 32; S2 11.3): the window terminal may already have
   * a keeper then, so launchPrepared must print no command to run by hand (a hand-run claude could
   * resume the session twice) and keeps the lock and the label, as after a timeout. Logged once by
   * kind; the error's message goes nowhere.
   */
  function guarded(terminal: Terminal, part: Part, onOpen = (): void => {}): Terminal {
    return {
      name: terminal.name,
      opensTabs: terminal.opensTabs,
      async open(spec) {
        onOpen();
        try {
          return await terminal.open(spec);
        } catch (error) {
          const failure = failureKind(error);
          log(`${part}: the terminal failed (${failure})`);
          return {
            ok: false,
            error: `the terminal failed unexpectedly (${failure})`,
            timedOut: true,
          };
        }
      },
    };
  }

  /**
   * After a throw before the terminal's `open()` was called (ruled, review 2 of stage A's task 32):
   * nothing can have been started, so the lock this resume took (`ours`) is given back, and the next
   * resume is not refused for a minute — that lock and no other (releaseLock keeps one taken over
   * since).
   */
  function giveBackLock(sessionId: string, ours: string): void {
    try {
      releaseLock(deck, sessionId, ours);
    } catch (error) {
      log(`resume: the lock was not given back (${failureKind(error)})`);
    }
  }

  /** S2 7.8: the session's terminals that are over go when it runs again. Best effort: a terminal
   *  left behind costs a slot and a row's place, never the launch itself. */
  function closeEnded(sessionId: string, part: Part): void {
    try {
      const ended = terminalsOf(sessionId).filter((terminal) => !MAY_START.has(terminal.state));
      for (const terminal of ended) hub.close(terminal.id);
    } catch (error) {
      log(`${part}: an ended terminal was not closed (${failureKind(error)})`);
    }
  }

  /**
   * Task 71's review: gone gives restore's lock back on the server's word, so a lost terminal (its
   * keeper died; its program got SIGHUP, which a program can survive) is gone only once its program
   * is: by design 5.5, `/proc/<pid>/stat` with the start the keeper reported. Unknown is not dead
   * (a read that fails, a line without a start). A keeper lost before T reported no program: none
   * was started as far as anyone can tell (S2 7.8 settles it so). Task 57's `lives`, without its
   * 60 s bound: restore's own time limit ends the wait (plan task 82 shares the rule, no copy).
   */
  function programMayLive(terminal: TerminalInfo): boolean {
    return terminal.program !== null && lives(terminal.program, deck.platform.proc);
  }

  return {
    async resume(sessionId, size) {
      // Ruled (review 2 of stage A's task 32): a terminal of the window opened for the session
      // whose program may still run refuses a second resume, whatever the lock says — claude can
      // wait at a dialog before its SessionStart for longer than the lock holds. Task 82: so does
      // a lost terminal's program while it may still run.
      const refused = windowRefusal(sessionId);
      if (refused !== null) {
        return { code: REFUSED_CODE, lines: [refused], refused: true, sessionId: null };
      }
      // The terminal is made before anything is taken, so that a factory that throws leaves no
      // lock behind.
      let opened = false;
      const terminal = guarded(deps.terminalFor(size), 'resume', () => {
        opened = true;
      });
      let prepared: PreparedLaunch;
      try {
        prepared = prepareResumeById(deck, sessionId);
      } catch (error) {
        if (error instanceof SkydeckError) return refusedBy(error);
        throw error;
      }
      let ours: string | null = null;
      try {
        ours = readLock(deck, prepared.sessionId); // the lock prepareResumeById has just taken
        closeEnded(prepared.sessionId, 'resume');
        return launched(prepared, await launchPrepared(deck, prepared, terminal));
      } catch (error) {
        if (!opened && ours !== null) giveBackLock(prepared.sessionId, ours);
        throw error;
      }
    },

    async newSession(request, size) {
      // Made first for the same reason: a factory that throws leaves no label stored.
      const terminal = guarded(deps.terminalFor(size), 'new');
      let prepared: PreparedLaunch;
      try {
        prepared = prepareNew(deck, {
          dir: request.dir,
          label: request.label,
          group: request.group,
          extra: request.flags,
        });
      } catch (error) {
        if (error instanceof SkydeckError) return refusedBy(error);
        throw error;
      }
      return launched(prepared, await launchPrepared(deck, prepared, terminal));
    },

    refusal(sessionId) {
      try {
        return windowRefusal(sessionId);
      } catch (error) {
        // Nothing is started on what could not be checked.
        const failure = failureKind(error);
        log(`restore: the window's terminals could not be read (${failure})`);
        return `the window's terminals could not be read (${failure})`;
      }
    },

    gone(sessionId) {
      try {
        const terminals = terminalsOf(sessionId);
        if (terminals.length === 0) return CLOSED;
        if (terminals.some((terminal) => MAY_START.has(terminal.state))) return null;
        const latest = terminals.reduce((last, terminal) =>
          terminal.openedNs >= last.openedNs ? terminal : last,
        );
        if (latest.state === 'lost' && programMayLive(latest)) return null;
        return overReason(latest);
      } catch (error) {
        // Waiting on is what restore does without the hook: its own time limit ends the wait.
        log(`restore: the window's terminals could not be read (${failureKind(error)})`);
        return null;
      }
    },

    restoreTerminal(size) {
      let terminal: Terminal;
      try {
        terminal = guarded(deps.terminalFor(size), 'restore');
      } catch (error) {
        // The factory only builds: nothing was spawned, so the open fails for certain and restore
        // gives the lock back (its rule for an open that did not time out).
        const failure = failureKind(error);
        log(`restore: the terminal could not be made (${failure})`);
        return {
          name: 'window',
          opensTabs: true,
          async open() {
            return {
              ok: false,
              error: `the terminal failed unexpectedly (${failure})`,
              timedOut: false,
            };
          },
        };
      }
      return {
        name: terminal.name,
        opensTabs: terminal.opensTabs,
        async open(spec) {
          // Ruled on review 2: restore never starts a new session (a `new` spec would start with
          // any argv); a resume spec is runRestore's, which ran the guard and took the lock.
          if (spec.kind !== 'resume') return NOT_A_RESUME;
          closeEnded(spec.sessionId, 'restore');
          return terminal.open(spec);
        },
      };
    },
  };
}
