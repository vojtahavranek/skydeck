/**
 * Issue #166, with part 2 of #188: "Restart", the page's dialog for a session that runs in a
 * terminal of the window — one action that ends its program and resumes the same conversation in
 * its place, with the flags a plain resume passes on or with other flags (S2 12.10, design 7.6).
 *
 * Every refusal is decided before anything is ended (a refused restart ends nothing): the flags as
 * `act resume` checks them (`refuseResumeFlags`, in its words; the page's text is split by
 * `splitFlags` before it comes here), the terminal and the session as "End session and mark done"
 * checks them (`endings.check`, in its words), a session marked done (its ended terminal would be
 * hidden), a session that also runs outside the terminal (the resume would be refused), what the
 * resume itself would refuse that can be known now (`checkResumable` on the row as if its program
 * had ended: the boot id, the transcript, the directory) and a lock another skydeck holds. Then the
 * restart holds the terminal's number (`hub.holdSlot`), and the program is hung up by the same
 * means and with the same wait as an end (`endings.hangUp`: the keeper's `E`, 10 seconds, the end
 * recorded as one the user asked for), without the done mark and without the close.
 *
 * Once the program has ended, the session is resumed through the window's one way to start it
 * (`launches.resume`: the guard on refreshed rows, the lock, the command builder; `flags` given:
 * in place of the recorded ones), in a terminal of the old one's size that takes the held number at
 * its spawn. The hold is let go when the resume has answered; the old terminal is closed then when
 * the session has another terminal (the new one, also one whose program did not start: it shows
 * why), and stays as an ordinary ended terminal when it has none (the resume was refused or no
 * terminal could be made): its bar offers Resume, Other flags… and Close. A program that has not
 * ended within the wait is not resumed, then or later: its end is followed on and recorded when it
 * comes (endings), and the session is an ended one like any other. What a restart holds is in
 * memory only: a server that stops meanwhile leaves nothing to finish at its next start.
 *
 * Logs carry kinds only.
 */
import { SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { checkResumable, isLockHeld, refuseResumeFlags } from '../sessions/resume.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import type { Endings } from './end-session.ts';
import { RESTARTING } from './end-session.ts';
import type { TerminalHub } from './hub.ts';
import type { Launched, Launches } from './launches.ts';

export interface RestartDeps {
  deck: Deck;
  hub: Pick<TerminalHub, 'list' | 'close' | 'holdSlot'>;
  endings: Pick<Endings, 'check' | 'hangUp'>;
  launches: Pick<Launches, 'resume'>;
  log: (line: string) => void;
}

/**
 * How a restart went: refused before anything was ended; given up (the program did not end:
 * nothing resumed); or ended, and then the resume's own outcome — or why it could not be asked
 * (a busy store, an unexpected error: the ended terminal stays).
 */
export type RestartOutcome =
  | { kind: 'refused'; error: string }
  | { kind: 'not-ended'; error: string }
  | { kind: 'resumed'; launched: Launched }
  | { kind: 'not-resumed'; error: string };

export interface Restarts {
  /** `flags`: this resume's flags in place of the recorded ones; null: a plain resume. Throws
   *  only before anything is ended (a busy store while checking). */
  restart(
    termId: string,
    sessionId: string,
    flags: readonly string[] | null,
  ): Promise<RestartOutcome>;
}

const NOT_AN_ACTION = 'skydeck cannot do that action';
const DONE = 'it is marked done: mark it undone first';
const ALSO_ELSEWHERE = 'it also runs outside this terminal, so it cannot be resumed';
const BUSY = "skydeck's database is busy; try again";

/** A SkydeckError's message as one line (a refusal of step 1 can span lines). */
function oneLine(error: SkydeckError): string {
  return error.message.replace(/\n$/, '').split('\n').join(' ');
}

export function createRestarts(deps: RestartDeps): Restarts {
  const { deck, hub, endings, launches, log } = deps;

  const refused = (error: string): RestartOutcome => ({ kind: 'refused', error });

  /** Why the restart cannot be made, before anything is ended; null when it can. */
  function refusalOf(
    termId: string,
    sessionId: string,
    flags: readonly string[] | null,
  ): { error: string } | { ok: Extract<ReturnType<Endings['check']>, { ok: true }> } {
    if (flags !== null) {
      try {
        refuseResumeFlags(flags);
      } catch (error) {
        if (error instanceof SkydeckError) return { error: oneLine(error) };
        throw error;
      }
    }
    const checked = endings.check(termId, sessionId, DONE);
    if (!checked.ok) return { error: checked.error };
    const { row, holders } = checked;
    if (holders.length !== row.session.holders.length) return { error: ALSO_ELSEWHERE };
    try {
      // What the resume would refuse once the program is gone, as far as it is known now.
      checkResumable({ ...row, session: { ...row.session, holders: [] } }, deck.platform.files);
    } catch (error) {
      if (error instanceof SkydeckError) return { error: oneLine(error) };
      throw error;
    }
    if (isLockHeld(deck, sessionId)) {
      return { error: `${row.shortId} is being resumed; try again in a minute` };
    }
    return { ok: checked };
  }

  /** Once the hold is let go: the old terminal goes when the session has another one. */
  function tidy(termId: string, sessionId: string): void {
    try {
      const another = hub
        .list()
        .some(
          (term) => term.id !== termId && (term.sessionId ?? term.expectedSessionId) === sessionId,
        );
      if (another) hub.close(termId);
    } catch (error) {
      log(`terminal ${termId}: the restarted terminal was not closed (${failureKind(error)})`);
    }
  }

  return {
    async restart(termId, sessionId, flags) {
      if (hub.holdSlot === undefined) return refused(NOT_AN_ACTION);
      const refusal = refusalOf(termId, sessionId, flags);
      if ('error' in refusal) return refused(refusal.error);
      const { term, holders } = refusal.ok;
      const hold = hub.holdSlot(termId);
      if (hold === null) return refused(RESTARTING);
      log(`terminal ${termId}: restarting its session`);
      try {
        const hungUp = await endings.hangUp(termId, sessionId, holders);
        if (!hungUp.ended) {
          log(`terminal ${termId}: the restart was given up`);
          return { kind: 'not-ended', error: hungUp.why };
        }
        try {
          const size = { cols: term.cols, rows: term.rows };
          const launched = await launches.resume(sessionId, size, flags, { term: termId, hold });
          return { kind: 'resumed', launched };
        } catch (error) {
          const kind = failureKind(error);
          log(`terminal ${termId}: the session was not resumed (${kind})`);
          return {
            kind: 'not-resumed',
            error: isBusy(error) ? BUSY : `the resume failed unexpectedly (${kind})`,
          };
        }
      } finally {
        hold.release();
        tidy(termId, sessionId);
      }
    },
  };
}
