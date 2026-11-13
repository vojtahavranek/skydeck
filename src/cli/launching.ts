// Starting a prepared `claude` command (design 7.6 "Where"): here through the launcher's handoff,
// or in a new tab through the configured terminal adapter; when that fails, the command is printed
// for the user to run instead — unless printing it could do harm.
import type { Deck } from '../sessions/deck.ts';
import { flagWarnings, openSafely, readLock, settleFailedLaunch } from '../sessions/resume.ts';
import type { PreparedLaunch } from '../sessions/resume.ts';
import { terminalFor } from '../terminals/index.ts';
import type { OpenResult, Terminal } from '../terminals/index.ts';
import { sanitize } from '../text/sanitize.ts';
import { EXIT } from './exit.ts';

/** What launchPrepared did: the exit code, and the lines to show the user, in order. */
export interface LaunchOutcome {
  code: number;
  /** Each line as it is printed (without its newline); every foreign string in it sanitised. */
  lines: string[];
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

/** The terminal for `where`, or null when a tab was asked for and no adapter opens tabs (D24). */
function chooseTerminal(deck: Deck, where: 'here' | 'tab' | null): Terminal | null {
  if (where === 'here') {
    return terminalFor('here', deck.platform, deck.config);
  }
  const configured = terminalFor(deck.config.terminal, deck.platform, deck.config);
  return where === 'tab' && !configured.opensTabs ? null : configured;
}

/**
 * Opens a prepared command. where 'here' → hereTerminal; 'tab' → the configured adapter if it
 * opens tabs; null → config.terminal. It prints nothing: it returns the exit code and the lines for
 * the caller to show (the commands print them on stderr; the interactive list shows them in its
 * message line). The lines are, in order: "skydeck: original flags unknown; resuming with
 * defaults" when !prepared.flagsKnown; "skydeck: started with flags skydeck does not know, not
 * passed on resume: <names>" (sanitised, joined by one space) when prepared.unknownFlags is not
 * empty; and, when the launch failed, the reason and what to do instead.
 *
 * On success the code is EXIT.ok (for 'here', the caller must return at once so the launcher can
 * exec). On failure, or 'tab' without a tab adapter (D24), it is EXIT.failure and the lines end
 * with "skydeck: to start it yourself, run:" and the command ("cd -- <q dir> && <shellJoin argv>"),
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
  where: 'here' | 'tab' | null,
): Promise<LaunchOutcome> {
  const lines = flagWarnings(prepared).map((line) => `skydeck: ${line}`);
  const terminal = chooseTerminal(deck, where);
  const lock = prepared.kind === 'resume' ? readLock(deck, prepared.sessionId) : null;
  let result: OpenResult;
  if (terminal === null) {
    const error = `no terminal adapter that opens tabs is configured (set "terminal" in ${deck.places.configPath})`;
    result = { ok: false, error, timedOut: false };
  } else {
    result = await openSafely(terminal, { cwd: prepared.cwd, argv: prepared.argv });
  }
  if (result.ok) {
    return { code: EXIT.ok, lines };
  }
  // Releases the lock (and removes what `new` stored) when nothing started and nothing is printed.
  const command = settleFailedLaunch(deck, prepared, lock, result.timedOut);
  return {
    code: EXIT.failure,
    lines: [...lines, ...failure(prepared, result.error, result.timedOut, command)],
  };
}
