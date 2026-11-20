/**
 * Follow-up F30: "End session and mark done", the page's dialog for a session that runs in a
 * terminal of the window (S2 12.5's Done; design principle 6 as reworded: skydeck ends a session's
 * program only when the user asks for it there, each time). The one place the server ends a
 * program, and only through the registry's `end` (the keeper's `E`: SIGHUP to the program it
 * started, as a terminal's closed window would).
 *
 * A request names the terminal and the session. It is refused, with nothing done, unless that
 * terminal of the window shows the session, its program runs and its keeper can be ended now
 * (`TerminalInfo.endable`), the store knows the session and it is not marked done, it runs, and a
 * holder of it belongs to that terminal (S2 7.5); and while a request for the same terminal waits,
 * a second one is refused (no second signal). Then the session is marked done (as `act done`),
 * the lists are told, and the keeper is told to hang the program up. The answer comes when the
 * program has ended — its keeper's exit, `ended` true —, or after END_WAIT_MS — `ended` false: the
 * session stays marked done and running, as after `Keep it running`.
 *
 * Once the program has ended the server records, for each holder of the session the request found
 * in the terminal, an `end` event of detail `exit` and raw detail ENDED_IN_WINDOW (no spool file;
 * no schema change), so that the session reads as an ordinary ended one (design 6.1: never
 * `ended-unexpectedly`, so no `was-working` and no restore offer) whatever end Claude Code's own
 * hook sends after its hang-up, before or after this one; then it closes the terminal (what
 * `close-terminal` does for an ended terminal: its slot is free, and its row, done, is hidden).
 */
import { isBusy } from './busy.ts';
import { failureKind } from './auth.ts';
import type { Deck } from '../sessions/deck.ts';
import { loadRows } from '../sessions/load.ts';
import { markDone } from '../sessions/meta.ts';
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

/** A refusal (nothing was done), or the session marked done and whether its program ended. */
export type EndOutcome = { ok: false; error: string } | { ok: true; ended: boolean };

export interface Endings {
  /** Throws (before anything is sent) only what marking done throws: a busy store, an error. */
  end(termId: string, sessionId: string): Promise<EndOutcome>;
}

/** How long the answer waits for the program to end after its hang-up. */
const END_WAIT_MS = 10_000;
/** A record of the end that met a busy store is tried again this often, at most RECORD_TRIES times. */
const RECORD_RETRY_MS = 1000;
const RECORD_TRIES = 10;

const NO_TERMINAL = 'this terminal is no longer there';
const OTHER_SESSION = 'that terminal shows another session now';
const NOT_RUNNING = 'its program is not running';
const CANNOT_END = 'skydeck cannot end this one: end it in its terminal';
const UNKNOWN = 'skydeck does not know this session';
const ALREADY_DONE = 'it was marked done meanwhile';
const NOT_HERE = 'it does not run in that terminal';
const ENDING = 'skydeck is ending this session already';
const NOT_AN_ACTION = 'skydeck cannot do that action';

/** A test setting (A31): a whole number of at least 1 from `SKYDECK_TEST_<name>`, else `fallback`. */
function testNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const text = env[`SKYDECK_TEST_${name}`];
  return text !== undefined && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : fallback;
}

interface Ending {
  sessionId: string;
  holders: Holder[];
  /** Answers the request (once) and logs `why`. */
  settle(ended: boolean, why: string): void;
}

export function createEndings(deps: EndingDeps): Endings {
  const { deck, hub, log } = deps;
  const { clock, proc } = deck.platform;
  const waitMs = testNumber(deck.platform.env, 'END_WAIT_MS', END_WAIT_MS);
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
      const atNs = clock.nowNs();
      deck.store.transaction(() => {
        for (const holder of entry.holders) {
          deck.store.insertEvent({
            spoolName: null,
            timeNs: atNs,
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
   * At every change of the terminals while a request waits (subscribed with the first, dropped
   * with the last): a program that ended is recorded and its terminal closed.
   */
  let unwatch: (() => void) | null = null;
  const watch = (): void => {
    unwatch ??= hub.onChange(changedTerminals);
  };
  function changedTerminals(): void {
    if (ending.size === 0) return;
    const terminals = new Map(hub.list().map((term) => [term.id, term]));
    for (const [termId, entry] of [...ending]) {
      const term = terminals.get(termId);
      if (term === undefined) {
        entry.settle(false, 'the terminal was forgotten'); // nothing known of its end
      } else if (term.state === 'ended' && term.exit !== null && term.exit.notStarted === null) {
        // The keeper reaped the program and sent its exit (a lost keeper's is made up: not this).
        record(termId, entry);
        entry.settle(true, 'its program ended as the user asked');
        // After the registry's own steps for the exit (its A to the keeper, the exited event),
        // which come after this announcement.
        queueMicrotask(() => {
          if (hub.close(termId) === 'ok') tell();
        });
      }
    }
  }

  function refuse(error: string): Promise<EndOutcome> {
    return Promise.resolve({ ok: false, error });
  }

  return {
    end(termId, sessionId) {
      if (ending.has(termId)) return refuse(ENDING);
      if (hub.end === undefined) return refuse(NOT_AN_ACTION);
      const term = hub.list().find((candidate) => candidate.id === termId);
      if (term === undefined) return refuse(NO_TERMINAL);
      if (term.sessionId !== sessionId) return refuse(OTHER_SESSION);
      if (term.state !== 'running' || term.exit !== null || term.program === null) {
        return refuse(NOT_RUNNING);
      }
      if (term.endable !== true) return refuse(CANNOT_END);
      const row = loadRows(deck).find((candidate) => candidate.id === sessionId);
      if (row === undefined) return refuse(UNKNOWN);
      if (row.done) return refuse(ALREADY_DONE);
      if (row.state === 'not-running') return refuse(NOT_RUNNING);
      const holders = holdersIn(term, row.session.holders);
      if (holders.length === 0) return refuse(NOT_HERE);
      // Done first (a busy store throws here, before anything is sent), then the hang-up.
      markDone(deck, sessionId);
      tell();
      return new Promise<EndOutcome>((resolve) => {
        let cancel = (): void => {};
        const entry: Ending = {
          sessionId,
          holders,
          settle(ended, why) {
            if (ending.get(termId) !== entry) return;
            ending.delete(termId);
            cancel();
            if (ending.size === 0) {
              unwatch?.();
              unwatch = null;
            }
            log(`terminal ${termId}: ${why}`);
            resolve({ ok: true, ended });
          },
        };
        ending.set(termId, entry);
        watch();
        cancel = clock.after(waitMs, () => entry.settle(false, 'its program did not end in time'));
        if (hub.end?.(termId) !== 'ok') entry.settle(false, 'the hang-up could not be sent');
      });
    },
  };
}
