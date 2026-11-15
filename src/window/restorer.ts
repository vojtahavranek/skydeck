// The one coordinator of restores in the window's server (S2 11.3, 11.4, 12.7; plan C 2.3, task
// 73): it runs step 1's `runRestore` with the window terminal and the server's hooks, one run at a
// time whoever asked (a page or a command), reports every line to every page, and decides the
// restore banner of the view model. The window terminal, the "already open" refusal and `gone` are
// the server's (task 72's `Launches`), injected, so that this module is tested without a server.
//
// What a restore can cost the user, and what bounds it (design 7.8, S2 11.3): at most
// `restoreBatch` sessions start at once, a batch only while `restoreMinFreeMb` is free, each
// through the guard and its lock; a session that does not start within
// `restoreStartTimeoutSeconds` is reported `timed out` and keeps its lock, renewed last (its
// terminal may still start it; no other resume does while the lock holds, 60 s from that renewal,
// and none from the window while its terminal may still run, `refuse`); one whose terminal ended
// is `failed` at once and its lock given back; a batch in which none started stops the run while
// entries are left (C23); the server's stop or the asking command's going stops it at its next
// step (C22). Whatever ends a run, the sessions it opened go on starting and the rest are said to
// be not started.
import { SkydeckError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { SHORT_ID_LENGTH } from '../sessions/list.ts';
import type { ListRow } from '../sessions/list.ts';
import { refresh } from '../sessions/refresh.ts';
import { restorePlan, runRestore } from '../sessions/restore.ts';
import type { ReportOutcome, RestoreEntry, RestorePlan } from '../sessions/restore.ts';
import type { Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import type {
  BannerPayload,
  RestoreOutcomeLine,
  RestoreRequest,
  RestoreStreamLine,
} from './protocol.ts';
import { bannerPayload } from './view/banner.ts';

type Size = { cols: number; rows: number };

export interface RestorerDeps {
  deck: Deck;
  /** Launches.restoreTerminal, .refusal, .gone (task 72; task 74 passes them). */
  terminalFor(size: Size): Terminal;
  refuse(sessionId: string): string | null;
  gone(sessionId: string): string | null;
  /** C7: the first size of a terminal it opens, read when it opens it. */
  size(): Size;
  /** One report line to every page (notice restore-progress). */
  progress(text: string): void;
  /** The banner may have changed (a run began or ended, a dismissal): the lists again. */
  changed(): void;
  log: (line: string) => void;
  /** C17: default 10_000. */
  heartbeatMs?: number;
}

export interface Restorer {
  /**
   * C6, C7: refuses while one runs (or after stop()); otherwise refresh, restorePlan(all), the ids
   * filtered, runRestore with the hooks (stopAfterEmptyBatch on) and its signal — and returns at
   * once. `write` gets every line, the heartbeats, and the outcome last; `done` resolves when the
   * run is over. `asker` (C22, a command's connection): when it fires before the outcome, the run
   * stops with the reason `the command that asked for it stopped`; after it, it changes nothing.
   * Every run, also one that cannot begin or is stopped, ends with exactly one `restore finished:
   * …` line to `progress` (C6). A refused request is no run (ruled): its asker alone gets its line
   * and the outcome, nothing goes to `progress`.
   */
  start(
    request: RestoreRequest,
    write?: (line: RestoreStreamLine) => void,
    asker?: AbortSignal,
  ): { ok: true; done: Promise<void> } | { ok: false; error: string };
  /** C9. */
  dismiss(bootId: string): { ok: true } | { ok: false; error: string };
  /** The view model's banner for the tick's rows (cached, C9). A store that fails while it is made
   *  keeps the previous one (one log line by kind) with the live `running` (ruled, task 74): while
   *  a run goes on, that one with `running: true`, or with none made the payload of a run that
   *  offers nothing; else that one with `running: false`, or null when it offered nothing (none
   *  made, or a run's whose `bootId` is null). */
  banner(rows: readonly ListRow[]): BannerPayload | null;
  /** Aborts a running restore with the reason `the window's server is stopping`, resolves once it
   *  is over; nothing starts afterwards. */
  stop(): Promise<void>;
}

const ALREADY_RUNNING = 'a restore is already running; wait until it has finished';
const STOPPING = "the window's server is stopping";
const ASKER_GONE = 'the command that asked for it stopped';
const NOT_OFFERED = 'no longer offered for restore';
const NO_LONGER_SHOWN = 'this offer to restore is no longer shown';
const BUSY = "skydeck's database is busy; try again";
const BUSY_STOP =
  "stopped: skydeck's database is busy; press Restore again (or run skydeck restore) for the rest";
const HEARTBEAT_MS = 10_000;
/** The longest a timer of the clock waits (Clock.after). */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Counts {
  started: number;
  timedOut: number;
  failed: number;
  notStarted: number;
}
const NONE: Readonly<Counts> = { started: 0, timedOut: 0, failed: 0, notStarted: 0 };

/** C6: `restore finished: <n> started, <n> timed out, <n> failed, <n> not started`, the parts that
 *  are 0 left out. */
function finishedLine(counts: Counts): string {
  const parts = (
    [
      [counts.started, 'started'],
      [counts.timedOut, 'timed out'],
      [counts.failed, 'failed'],
      [counts.notStarted, 'not started'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, what]) => `${count} ${what}`);
  return `restore finished: ${parts.length === 0 ? 'nothing was started' : parts.join(', ')}`;
}

/** What a session's report line records, counted. */
function count(counts: Counts, ended: ReportOutcome): void {
  switch (ended.kind) {
    case 'started':
      counts.started += 1;
      break;
    case 'timed-out':
      counts.timedOut += 1;
      break;
    case 'failed':
      counts.failed += 1;
      break;
    case 'not-started':
      counts.notStarted += 1;
      break;
    // `handed-off` and `printed` come only from a terminal that opens no tabs; the window's does.
  }
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/** The banner last made, with what it was made from. */
interface Made {
  rows: readonly ListRow[];
  dismissals: number;
  running: boolean;
  payload: BannerPayload | null;
}

export function createRestorer(deps: RestorerDeps): Restorer {
  const { deck, log } = deps;
  const { clock } = deck.platform;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  // A heartbeat of 0 would re-arm itself at once, for ever: refused here, not in a run.
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > MAX_TIMER_MS) {
    throw new RangeError(`not a heartbeat a timer can wait: ${heartbeatMs} ms`);
  }
  let current: Run | null = null;
  let stopping = false;
  let made: Made | null = null;
  /** How many dismissals this restorer stored: the stored one changes only through dismiss(). */
  let dismissals = 0;

  /** A callback of the server that throws must not end a run half way, nor leave it running. */
  const safely = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log(`restore: ${what} (${failureKind(error)})`);
    }
  };
  const changed = (): void => {
    safely('the lists were not told', () => deps.changed());
  };

  /** Where the lines of one request go: `progress` (every page) and the asker's `write`. */
  const sink = (write: ((line: RestoreStreamLine) => void) | undefined) => {
    const toAsker = (line: RestoreStreamLine): void => {
      if (write !== undefined) safely('a line was not written', () => write(line));
    };
    return {
      /** A report line, sanitised (S2 2: whatever a message quotes), to every page and the asker. */
      line(text: string): void {
        const shown = sanitize(text);
        safely('a report line was not sent', () => deps.progress(shown));
        toAsker({ line: shown });
      },
      /** A line for the asker alone: a heartbeat, a refusal of the request. */
      only(text: string): void {
        toAsker({ line: text });
      },
      outcome(outcome: RestoreOutcomeLine): void {
        toAsker({ outcome });
      },
    };
  };

  /** C7: each terminal is built with the size of the moment it is opened. */
  const terminal: Terminal = {
    name: 'window',
    opensTabs: true,
    open: async (spec) => deps.terminalFor(deps.size()).open(spec),
  };

  /** The line of a run that cannot begin, logged by kind but for the user's own refusals. */
  const cannotBegin = (error: unknown): string => {
    if (error instanceof SkydeckError) return error.message;
    const kind = failureKind(error);
    if (isBusy(error)) {
      log(`restore: could not begin: the database is busy (${kind})`);
      return BUSY;
    }
    log(`restore: could not begin (${kind})`);
    return `restore could not begin (${kind})`;
  };

  async function run(
    entries: readonly RestoreEntry[],
    notOffered: readonly string[],
    out: ReturnType<typeof sink>,
    write: ((line: RestoreStreamLine) => void) | undefined,
    asker: AbortSignal | undefined,
    controller: AbortController,
  ): Promise<void> {
    const counts: Counts = { ...NONE };
    /** The selected sessions that have their outcome. */
    const ended = new Set<string>();
    // C22. The asker may also go after its outcome was written, while its answer is still open:
    // the run has no step left then, and nothing looks at its signal again.
    const onAsker = (): void => {
      controller.abort(ASKER_GONE);
    };
    let cancelBeat = (): void => {};
    /** C17: a line at least every heartbeatMs to the asker, re-armed by every line. */
    const arm = (): void => {
      if (write === undefined) return;
      cancelBeat();
      cancelBeat = clock.after(heartbeatMs, () => {
        const waiting = entries.length - ended.size;
        out.only(`waiting for ${waiting} ${waiting === 1 ? 'session' : 'sessions'}`);
        arm();
      });
    };
    const line = (text: string): void => {
      out.line(text);
      arm();
    };
    try {
      if (asker?.aborted === true) onAsker();
      else asker?.addEventListener('abort', onAsker, { once: true });
      arm();
      await Promise.resolve(); // start() returns before the run does anything
      for (const sessionId of notOffered) {
        counts.failed += 1;
        line(`failed ${sessionId.slice(0, SHORT_ID_LENGTH)}: ${NOT_OFFERED}`);
      }
      let code: 0 | 1 | 5;
      try {
        const outcome = await runRestore(
          {
            deck,
            terminal,
            report: (text, about) => {
              if (about !== undefined) {
                ended.add(about.sessionId);
                count(counts, about);
              }
              line(text);
            },
            refuse: (sessionId) => deps.refuse(sessionId),
            gone: (sessionId) => deps.gone(sessionId),
            signal: controller.signal,
            stopAfterEmptyBatch: true,
          },
          entries,
        );
        code =
          outcome.stopped || outcome.stoppedForMemory
            ? 5
            : counts.failed + counts.timedOut > 0
              ? 1
              : 0;
      } catch (error) {
        const kind = failureKind(error);
        if (isBusy(error)) {
          log(`restore: the run stopped: the database is busy (${kind})`);
          line(BUSY_STOP);
        } else {
          log(`restore: the run failed (${kind})`);
          line(
            `stopped unexpectedly (${kind}); the sessions it opened go on starting: run skydeck to see which`,
          );
        }
        code = 1;
      }
      cancelBeat();
      out.line(finishedLine(counts));
      out.outcome({ code, ...counts });
    } finally {
      cancelBeat();
      asker?.removeEventListener('abort', onAsker);
      current = null;
      changed();
    }
  }

  return {
    start(request, write, asker) {
      if (current !== null || stopping) {
        const error = stopping ? STOPPING : ALREADY_RUNNING;
        const out = sink(write);
        out.only(error);
        out.outcome({ code: 1, ...NONE });
        return { ok: false, error };
      }
      const out = sink(write);
      let entries: RestoreEntry[];
      try {
        refresh(deck);
        entries = restorePlan(deck, request.all).entries;
      } catch (error) {
        const why = cannotBegin(error);
        out.line(why);
        out.line(finishedLine(NONE));
        out.outcome({ code: 1, ...NONE });
        return { ok: false, error: sanitize(why) };
      }
      const chosen = new Set(request.sessionIds);
      const offered = new Set(entries.map((entry) => entry.row.id));
      const controller = new AbortController();
      let finished = (): void => {};
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      current = { controller, done };
      changed();
      void run(
        entries.filter((entry) => chosen.has(entry.row.id)),
        request.sessionIds.filter((sessionId) => !offered.has(sessionId)),
        out,
        write,
        asker,
        controller,
      ).finally(finished);
      return { ok: true, done };
    },

    dismiss(bootId) {
      const offered = made?.payload?.bootId ?? null;
      if (offered === null || offered !== bootId) {
        return { ok: false, error: NO_LONGER_SHOWN };
      }
      deck.store.setKv('window_restore_dismissed', bootId);
      dismissals += 1;
      changed();
      return { ok: true };
    },

    banner(rows) {
      const running = current !== null;
      if (
        made !== null &&
        made.rows === rows &&
        made.dismissals === dismissals &&
        made.running === running
      ) {
        return made.payload;
      }
      try {
        const dismissedBootId = deck.store.getKv('window_restore_dismissed');
        let plan: RestorePlan | null;
        try {
          plan = restorePlan(deck, false, rows);
        } catch (error) {
          // The rows' boot id could not be read: nothing can be offered (a run says why).
          if (!(error instanceof SkydeckError)) throw error;
          plan = null;
        }
        const payload = bannerPayload({ plan, dismissedBootId, running });
        made = { rows, dismissals, running, payload };
        return payload;
      } catch (error) {
        log(`restore: the banner was not made (${failureKind(error)})`);
        // Ruled by the plan owner (task 74): `running` is the live one — the page ends a restore's
        // report at the first list whose banner does not say it runs. While a run goes on: the last
        // payload made with that flag, or, with none made, a run's that offers nothing. While none
        // runs: null when nothing was offered (no payload, or a run's that offered nothing, whose
        // boot id is null), else the last payload with the flag off. Not kept (made again at the
        // next call).
        const last = made?.payload ?? null;
        if (running) {
          if (last === null) {
            return { bootId: null, lastActivityNs: null, entries: [], shown: true, running: true };
          }
          return last.running ? last : { ...last, running: true };
        }
        if (last === null || last.bootId === null) return null;
        return last.running ? { ...last, running: false } : last;
      }
    },

    stop() {
      stopping = true;
      if (current === null) return Promise.resolve();
      current.controller.abort(STOPPING);
      return current.done;
    },
  };
}
