/**
 * Follow-up F30: "End session and mark done", the page's dialog for a session that runs in a
 * terminal of the window (S2 12.5's Done; design principle 6 as reworded: skydeck ends a session's
 * program only when the user asks for it there, each time). The one place the server ends a
 * program, and only through the registry's `end` (the keeper's `E`: SIGHUP and SIGCONT to the
 * program it started, as a terminal's closed window would).
 *
 * A request names the terminal and the session. It is refused, with nothing done, unless that
 * terminal of the window shows the session, its program runs and its keeper can be ended now
 * (`TerminalInfo.endable`), the store knows the session and it is not marked done, it runs, and a
 * holder of it belongs to that terminal (S2 7.5); and while a request for the same terminal waits,
 * a second one is refused (no second signal). Then the session is marked done (as `act done`),
 * the lists are told, and the keeper is told to hang the program up.
 *
 * The dialog "Park" (S2 12.15) asks for the same end with the mark `park`: the same checks in the
 * same order and words, except that a session parked already is refused (`it was parked
 * meanwhile`) where Done's refuses one marked done, and one marked done is not refused (parking
 * ends its done mark, as `act park` does); then the session is parked (as `act park`: its number
 * is freed by the lists' next sync, parked-slots.ts) in place of marked done, and the rest is
 * Done's — the hang-up, the wait, the following on, the record and the close. The answer comes when the
 * program has ended — its keeper's exit, `ended` true —, or after END_WAIT_MS — `ended` false: the
 * session stays marked done and running. The end is followed on after that answer until the
 * program exits (ruled at review): a later end is recorded and closed as one within the wait; a
 * terminal lost or forgotten meanwhile is followed no more. What is followed is held in memory
 * only: a server restarted while a program ends does not know that the user ended it (a known
 * limit, S2 12.10).
 *
 * Once the program has ended the server records, for each holder of the session the request found
 * in the terminal, an `end` event of detail `exit` and raw detail ENDED_IN_WINDOW (no spool file;
 * stamped not below the holder's process's stamps, with the machine's uptime: #207, design 5.3
 * "Order"), so that the session reads as an ordinary ended one (design 6.1: never
 * `ended-unexpectedly`, so no `was-working` and no restore offer) whatever end Claude Code's own
 * hook sends after its hang-up, before or after this one; then it closes the terminal (what
 * `close-terminal` does for an ended terminal: its slot is free, and its row, done, is hidden;
 * parked, it is listed under Parked, not running).
 *
 * Issue #166: a restart (restart.ts) ends the program by the same means — `check`, the same
 * refusals in the same words but for a session marked done, and `hangUp`, the same hang-up, wait,
 * following on and record — without marking it done and without closing the terminal: the
 * restart resumes the session, or leaves the ended terminal for the user. While a restart holds a
 * terminal (`TerminalInfo.restarting`) an end of it is refused (`skydeck is restarting this
 * session`).
 */
import { isBusy } from './busy.ts';
import { failureKind } from './auth.ts';
import type { Deck } from '../sessions/deck.ts';
import { loadRows } from '../sessions/load.ts';
import { markDone, markParked } from '../sessions/meta.ts';
import type { ListRow } from '../sessions/list.ts';
import type { Holder } from '../sessions/types.ts';
import { ENDED_IN_WINDOW } from '../store/types.ts';
import type { TerminalHub, TerminalInfo } from './hub.ts';
import { holderPlace } from './mapping.ts';

export interface EndingDeps {
  /** The server's deck: the store, and the platform's clock, proc and env. */
  deck: Deck;
  hub: Pick<TerminalHub, 'list' | 'onChange' | 'close' | 'end'>;
  log: (line: string) => void;
  /** The store was written (done, the end, the close): the rows again and the lists now (D7). */
  changed(): void;
}

/** The mark an end writes before its hang-up: Done's dialog's, or the dialog "Park"'s. */
export type EndMark = 'done' | 'park';

/** A refusal (nothing was done), or the session marked (done or parked) and whether its program
 *  ended. */
export type EndOutcome = { ok: false; error: string } | { ok: true; ended: boolean };

/** Issue #166: what `check` found — a refusal, or the terminal, the session's row and its holders
 *  that belong to that terminal. */
export type EndCheck =
  { ok: false; error: string } | { ok: true; term: TerminalInfo; row: ListRow; holders: Holder[] };

/** Issue #166: how a hang-up for a restart ended: the program ended, or why it did not (a
 *  sentence: not within the wait, the keeper lost, the terminal gone, the hang-up not sent). */
export type HangUpOutcome = { ended: true } | { ended: false; why: string };

export interface Endings {
  /** Throws (before anything is sent) only what marking throws: a busy store, an error. */
  end(termId: string, sessionId: string, mark?: EndMark): Promise<EndOutcome>;
  /**
   * Issue #166: `end`'s refusals in its order and words, with `done` the words for a session
   * marked done; nothing is done. Ok: the terminal, the row and the holders `hangUp` is given.
   */
  check(termId: string, sessionId: string, done: string): EndCheck;
  /**
   * Issue #166: `end`'s hang-up for a restart, after its `check`: no done mark, and the terminal
   * is not closed. Resolves once the program ended (its end recorded, as `end` records it) or why
   * not; after the wait the end is followed on and recorded when it comes, nothing closed — but
   * only for 60 seconds from the hang-up: an end after that is an ordinary one (ruled), which
   * reads as Claude Code's hook reports it, with its attention and notification.
   */
  hangUp(termId: string, sessionId: string, holders: readonly Holder[]): Promise<HangUpOutcome>;
}

/** How long the answer waits for the program to end after its hang-up. */
const END_WAIT_MS = 10_000;
/** Issue #166: how long after its hang-up a restart's end is still followed and recorded as the
 *  user's (a restart given up): a later end is an ordinary one, with its attention. */
const RESTART_FOLLOW_MS = 60_000;
/** A record of the end that met a busy store is tried again this often, at most RECORD_TRIES times. */
const RECORD_RETRY_MS = 1000;
const RECORD_TRIES = 10;

const NO_TERMINAL = 'this terminal is no longer there';
const OTHER_SESSION = 'that terminal shows another session now';
const NOT_RUNNING = 'its program is not running';
const CANNOT_END = 'skydeck cannot end this one: end it in its terminal';
const UNKNOWN = 'skydeck does not know this session';
const ALREADY_DONE = 'it was marked done meanwhile';
const ALREADY_PARKED = 'it was parked meanwhile';
const NOT_HERE = 'it does not run in that terminal';
const ENDING = 'skydeck is ending this session already';
const NOT_AN_ACTION = 'skydeck cannot do that action';
/** Issue #166: a restart holds the terminal: what is refused meanwhile. */
export const RESTARTING = 'skydeck is restarting this session';
/** Issue #166: why a restart's hang-up did not end the program. */
const NOT_ENDED = 'it has not ended within 10 seconds; if it ends later, resume it from its bar';
const KEEPER_LOST = "its terminal's keeper ended unexpectedly";
const NOT_SENT = 'skydeck could not ask it to end';

/** A test setting (A31): a whole number of at least 1 from `SKYDECK_TEST_<name>`, else `fallback`. */
function testNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const text = env[`SKYDECK_TEST_${name}`];
  return text !== undefined && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : fallback;
}

/**
 * One request's terminal, from the hang-up until its program's exit (ruled at review: also after
 * the answer, so that an end that comes later is recorded and closed as one inside the wait).
 */
interface Ending {
  sessionId: string;
  holders: readonly Holder[];
  /** Answers the request: null once the program ended, else why not; null once answered. */
  answer: ((why: string | null) => void) | null;
  /** Stops the wait's timer. */
  cancel(): void;
  /** Its terminal is closed once its program ended (`end`); a restart's is not (#166). */
  close: boolean;
}

export function createEndings(deps: EndingDeps): Endings {
  const { deck, hub, log } = deps;
  const { clock, proc } = deck.platform;
  const waitMs = testNumber(deck.platform.env, 'END_WAIT_MS', END_WAIT_MS);
  const restartFollowMs = testNumber(deck.platform.env, 'RESTART_FOLLOW_MS', RESTART_FOLLOW_MS);
  const ending = new Map<string, Ending>();

  const tell = (): void => {
    try {
      deps.changed();
    } catch (error) {
      log(`act end-session: the lists were not told (${failureKind(error)})`);
    }
  };

  /** The session's holders that belong to `term` (S2 7.5): of this boot, not a scripted run. */
  function holdersIn(term: TerminalInfo, holders: readonly Holder[]): Holder[] {
    const program = term.program;
    if (program === null) return [];
    let bootId: string | null;
    try {
      bootId = proc.bootId();
    } catch {
      bootId = null;
    }
    if (bootId === null) return [];
    const programs = new Map([[program.pid, { procStart: program.procStart, termId: term.id }]]);
    return holders.filter((holder) => {
      if (holder.scripted || holder.process.bootId !== bootId) return false;
      const place = holderPlace(holder, programs, proc);
      return typeof place === 'object' && place.termId === term.id;
    });
  }

  /** The end of each holder, as an `end` event of the window's own (tried again on a busy store). */
  function record(termId: string, entry: Ending, tries = 1): void {
    try {
      const clockNs = clock.nowNs();
      const uptimeCs = deck.platform.proc.uptimeCs();
      deck.store.transaction(() => {
        for (const holder of entry.holders) {
          const { bootId, pid, procStart } = holder.process;
          // Never below a stamp stored for the process, and with the machine's uptime, which orders
          // the process's events (#207): the wall clock may have stepped back since its start.
          const latestNs = deck.store.latestStampOfProcess(bootId, pid, procStart);
          deck.store.insertEvent({
            spoolName: null,
            timeNs: latestNs !== null && latestNs >= clockNs ? latestNs + 1n : clockNs,
            ...(uptimeCs === null ? {} : { uptimeCs }),
            kind: 'end',
            detail: 'exit',
            rawDetail: ENDED_IN_WINDOW,
            sessionId: entry.sessionId,
            bootId: holder.process.bootId,
            pid: holder.process.pid,
            procStart: holder.process.procStart,
            cwd: null,
            argv: null,
            name: null,
            payload: null,
          });
        }
      });
      tell();
    } catch (error) {
      if (isBusy(error) && tries < RECORD_TRIES) {
        clock.after(RECORD_RETRY_MS, () => record(termId, entry, tries + 1));
        return;
      }
      log(`terminal ${termId}: the end was not recorded (${failureKind(error)})`);
    }
  }

  /**
   * At every change of the terminals while an end is followed (subscribed with the first, dropped
   * with the last): a program that ended is recorded and its terminal closed, inside the wait or
   * after it; a terminal lost or forgotten meanwhile is followed no more, nothing recorded.
   */
  let unwatch: (() => void) | null = null;
  const watch = (): void => {
    unwatch ??= hub.onChange(changedTerminals);
  };

  /** Follows the terminal no more; answers when it has not been answered yet: `ended`, else why
   *  not (`reason`, the user's words). */
  function finish(
    termId: string,
    entry: Ending,
    ended: boolean,
    why: string,
    reason = NOT_ENDED,
  ): void {
    if (ending.get(termId) !== entry) return;
    ending.delete(termId);
    entry.cancel();
    if (ending.size === 0) {
      unwatch?.();
      unwatch = null;
    }
    log(`terminal ${termId}: ${why}`);
    const answer = entry.answer;
    entry.answer = null;
    answer?.(ended ? null : reason);
  }

  function changedTerminals(): void {
    if (ending.size === 0) return;
    const terminals = new Map(hub.list().map((term) => [term.id, term]));
    for (const [termId, entry] of [...ending]) {
      const term = terminals.get(termId);
      if (term === undefined) {
        finish(termId, entry, false, 'the terminal was forgotten', NO_TERMINAL); // nothing known of its end
      } else if (term.state === 'lost') {
        finish(termId, entry, false, 'its keeper was lost', KEEPER_LOST); // its exit is made up, not the end
      } else if (term.state === 'ended' && term.exit !== null && term.exit.notStarted === null) {
        // The keeper reaped the program and sent its exit.
        const late = entry.answer === null;
        record(termId, entry);
        finish(
          termId,
          entry,
          true,
          `its program ended as the user asked${late ? ', after the wait' : ''}`,
        );
        // After the registry's own steps for the exit (its A to the keeper, the exited event),
        // which come after this announcement. Not for a restart (#166): it resumes the session.
        if (entry.close) {
          queueMicrotask(() => {
            if (hub.close(termId) === 'ok') tell();
          });
        }
      }
    }
  }

  function refuse(error: string): Promise<EndOutcome> {
    return Promise.resolve({ ok: false, error });
  }

  /**
   * The checks of a request, in their order (F30), nothing done: a terminal a restart holds
   * (#166), a request for the terminal that waits, a hub that cannot end, the terminal, the
   * session it shows, its program, the store's row (`done`: the words for one marked done) and
   * the holders that belong to it. `refused` (with `check`: a session marked done, in `done`'s
   * words) is the mark's own refusal of the row.
   */
  function checkFor(
    termId: string,
    sessionId: string,
    refused: (row: ListRow) => string | null,
  ): EndCheck {
    const term = hub.list().find((candidate) => candidate.id === termId);
    if (term?.restarting === true) return { ok: false, error: RESTARTING };
    // While a request waits for its answer, no second one (no second signal); once answered, a
    // new request (the session undone and asked again) replaces the end that is followed.
    if (ending.get(termId)?.answer != null) return { ok: false, error: ENDING };
    if (hub.end === undefined) return { ok: false, error: NOT_AN_ACTION };
    if (term === undefined) return { ok: false, error: NO_TERMINAL };
    if (term.sessionId !== sessionId) return { ok: false, error: OTHER_SESSION };
    if (term.state !== 'running' || term.exit !== null || term.program === null) {
      return { ok: false, error: NOT_RUNNING };
    }
    if (term.endable !== true) return { ok: false, error: CANNOT_END };
    const row = loadRows(deck).find((candidate) => candidate.id === sessionId);
    if (row === undefined) return { ok: false, error: UNKNOWN };
    const mark = refused(row);
    if (mark !== null) return { ok: false, error: mark };
    if (row.state === 'not-running') return { ok: false, error: NOT_RUNNING };
    const holders = holdersIn(term, row.session.holders);
    if (holders.length === 0) return { ok: false, error: NOT_HERE };
    return { ok: true, term, row, holders };
  }

  function check(termId: string, sessionId: string, done: string): EndCheck {
    return checkFor(termId, sessionId, (row) => (row.done ? done : null));
  }

  /**
   * The hang-up of a checked request, and its wait: `answer` gets null once the program ended,
   * else why not. An end still followed for the terminal (answered, its program not ended) is
   * replaced. The end is followed on after the wait until the program exits.
   */
  function follow(
    termId: string,
    sessionId: string,
    holders: readonly Holder[],
    close: boolean,
    answer: (why: string | null) => void,
    followMs: number | null = null,
  ): void {
    const before = ending.get(termId);
    if (before !== undefined) finish(termId, before, false, 'asked again');
    const entry: Ending = { sessionId, holders, answer, cancel: () => {}, close };
    ending.set(termId, entry);
    watch();
    // The answer after the wait; the end is followed on until the program exits — for a restart
    // (#166) only until `followMs` after the hang-up: a later end is no longer the user's.
    const stopWait = clock.after(waitMs, () => {
      const answered = entry.answer;
      entry.answer = null;
      if (answered !== null && ending.get(termId) === entry) {
        log(`terminal ${termId}: its program has not ended within the wait`);
        answered(NOT_ENDED);
      }
    });
    const stopFollow =
      followMs === null
        ? () => {}
        : clock.after(followMs, () => {
            finish(termId, entry, false, "the restart's end is followed no more");
          });
    entry.cancel = () => {
      stopWait();
      stopFollow();
    };
    if (hub.end?.(termId) !== 'ok') {
      finish(termId, entry, false, 'the hang-up could not be sent', NOT_SENT);
    }
  }

  return {
    end(termId, sessionId, mark = 'done') {
      const checked =
        mark === 'park'
          ? checkFor(termId, sessionId, (row) => (row.parked ? ALREADY_PARKED : null))
          : check(termId, sessionId, ALREADY_DONE);
      if (!checked.ok) return refuse(checked.error);
      // The mark first (a busy store throws here, before anything is sent), then the hang-up.
      if (mark === 'park') {
        markParked(deck, checked.row);
      } else {
        markDone(deck, sessionId);
      }
      tell();
      return new Promise<EndOutcome>((resolve) => {
        follow(termId, sessionId, checked.holders, true, (why) => {
          resolve({ ok: true, ended: why === null });
        });
      });
    },
    check,
    hangUp(termId, sessionId, holders) {
      return new Promise<HangUpOutcome>((resolve) => {
        follow(
          termId,
          sessionId,
          holders,
          false,
          (why) => {
            resolve(why === null ? { ended: true } : { ended: false, why });
          },
          restartFollowMs,
        );
      });
    },
  };
}
