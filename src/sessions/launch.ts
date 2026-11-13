// Starting a prepared `claude` command in a terminal (design 7.6 "Where", S2 11.1): the command line
// and the window's server both start sessions here, each with the terminal it chose; when that
// fails, the command is given for the user to run instead — unless running it could do harm.
import type { Ns } from '../platform/types.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import type { Deck } from './deck.ts';
import {
  LOCK_START_TOLERANCE_NS,
  LOCK_TTL_NS,
  flagWarnings,
  lockTakenNs,
  openSafely,
  readLock,
  settleFailedLaunch,
} from './resume.ts';
import type { PreparedLaunch } from './resume.ts';

/** The exit codes of an outcome: EXIT.ok and EXIT.failure of src/cli/exit.ts. */
const OK = 0;
const FAILURE = 1;

/**
 * How long after its lock was taken a launch may still start its program (S2 7.1): no later than
 * the lock holds, less the tolerance by which a start may be dated before the lock (design 7.6).
 */
const START_WINDOW_NS: Ns = LOCK_TTL_NS - LOCK_START_TOLERANCE_NS;

/** What launchPrepared did: the exit code, and the lines to show the user, in order. */
export interface LaunchOutcome {
  code: number;
  /** Each line as it is printed (without its newline); every foreign string in it sanitised. */
  lines: string[];
}

/**
 * A20: lock time + LOCK_TTL_NS − LOCK_START_TOLERANCE_NS for a resume (the time read from `lock`);
 * preparedAtNs + the same for `new`, and for a resume whose `lock` is null or not a lock skydeck
 * writes (it has no time to read). Such a resume is protected by no lock of its own: a terminal
 * that starts the program itself against the deadline (the window's) must not start it; `here` and
 * `wezterm` ignore the deadline and the lock, as in step 1.
 */
export function startDeadline(prepared: PreparedLaunch, lock: string | null): Ns {
  const takenNs = prepared.kind === 'resume' && lock !== null ? lockTakenNs(lock) : null;
  return (takenNs ?? prepared.preparedAtNs) + START_WINDOW_NS;
}

/** The spec a terminal opens: the prepared command, the session, its kind, `lock` (null for `new`), the deadline and the label. */
export function launchSpec(prepared: PreparedLaunch, lock: string | null): LaunchSpec {
  return {
    cwd: prepared.cwd,
    argv: prepared.argv,
    sessionId: prepared.sessionId,
    kind: prepared.kind,
    lock: prepared.kind === 'resume' ? lock : null,
    startByNs: startDeadline(prepared, lock),
    label: prepared.label,
  };
}

/**
 * The reason a launch failed, then what the user can do about it: `command` (settleFailedLaunch) is
 * printed only when running it cannot start the session a second time and it holds nothing a
 * terminal would act on.
 */
function failure(
  prepared: PreparedLaunch,
  reason: string,
  timedOut: boolean,
  command: string | null,
): string[] {
  const lines = [`skydeck: ${sanitize(reason)}`];
  if (timedOut) {
    // The program may have started: a command run by hand now could resume the session twice. A
    // new session that did not start has nothing to resume, so its id is all there is to give.
    lines.push(
      prepared.kind === 'new'
        ? `skydeck: the new session's id is ${prepared.sessionId}; running skydeck shows whether it started`
        : `skydeck: run skydeck again to see whether session ${prepared.sessionId} is running`,
    );
  } else if (command === null) {
    // A word with a control character is safe inside the quotes of the handoff, which no terminal
    // shows, but not on the user's screen nor in a line that may be pasted into a shell.
    lines.push('skydeck: the command contains control characters and cannot be printed safely');
  } else {
    lines.push('skydeck: to start it yourself, run:', command);
  }
  return lines;
}

/**
 * Opens a prepared command in `terminal`, with launchSpec(prepared, the session's lock as read now)
 * (for a resume, the lock prepareResume has just taken). `terminal` null means there is no terminal
 * that opens tabs; the launch then fails with `noTerminal` as its reason (default: "no terminal
 * adapter that opens tabs is configured (set "terminal" in <config path>)").
 *
 * It prints nothing: it returns the exit code and the lines for the caller to show (the commands
 * print them on stderr; the interactive list shows them in its message line; the window shows
 * them on its card). The lines are, in order: "skydeck: original flags unknown; resuming with
 * defaults" when !prepared.flagsKnown; "skydeck: started with flags skydeck does not know, not
 * passed on resume: <names>" (sanitised, joined by one space) when prepared.unknownFlags is not
 * empty; and, when the launch failed, the reason and what to do instead.
 *
 * On success the code is 0 (EXIT.ok; for 'here', the caller must return at once so the launcher
 * can exec). On failure, or without a terminal, it is 1 (EXIT.failure) and the lines end with
 * "skydeck: to start it yourself, run:" and the command ("cd -- <q dir> && <shellJoin argv>"),
 * except in two cases: after an open() that timed out (the program may have started) they end with
 * "skydeck: run skydeck again to see whether session <id> is running" (kind 'new': "skydeck: the new
 * session's id is <id>; running skydeck shows whether it started"), and when the directory or a
 * word of the command holds anything sanitize() would change, with "skydeck: the command contains
 * control characters and cannot be printed safely". An open() that rejects is a failed open.
 *
 * After a failure settleFailedLaunch decides, by the rule restore uses too: the lock prepareResume
 * took, and the label and group `new` stored, stay — the program may have started (a timeout), or
 * the user may run the printed command now — except after a failure other than a timeout whose
 * command cannot be printed, when nothing was started and there is nothing to run by hand: then
 * both are given back.
 */
export async function launchPrepared(
  deck: Deck,
  prepared: PreparedLaunch,
  terminal: Terminal | null,
  noTerminal?: string,
): Promise<LaunchOutcome> {
  const lines = flagWarnings(prepared).map((line) => `skydeck: ${line}`);
  const lock = prepared.kind === 'resume' ? readLock(deck, prepared.sessionId) : null;
  let result: OpenResult;
  if (terminal === null) {
    const error =
      noTerminal ??
      `no terminal adapter that opens tabs is configured (set "terminal" in ${deck.places.configPath})`;
    result = { ok: false, error, timedOut: false };
  } else {
    result = await openSafely(terminal, launchSpec(prepared, lock));
  }
  if (result.ok) {
    return { code: OK, lines };
  }
  // Releases the lock (and removes what `new` stored) when nothing started and nothing is printed.
  const command = settleFailedLaunch(deck, prepared, lock, result.timedOut);
  return {
    code: FAILURE,
    lines: [...lines, ...failure(prepared, result.error, result.timedOut, command)],
  };
}
