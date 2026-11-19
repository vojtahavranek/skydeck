/**
 * The server's tick (S2 10.1; plan task 23): what the server does on its own, once a second.
 *
 * - Every second: attention's look at the live-session files (S2 10.3; plan B 2.7), then the
 *   keep-alive (S2 6.1, 6.2).
 * - Every second tick: the refresh every command runs (design 5.3), the settling of the terminals
 *   that ended since (S2 7.8), the rows loaded again by step 1's rule of the interactive list
 *   (A24), the mapping of the window's terminals to sessions (S2 7.5, 7.9) with the ended terminals
 *   whose session runs again dropped, attention's judgement of the window ends (B10), the automatic
 *   pull-request refresh for the sessions the pages list (design 7.3), the automatic round of their
 *   tickets' statuses (follow-up F19), and the pages' lists.
 * - Every 30 seconds: the interop link (S2 6.4).
 * - Once a minute: keepers.log rotated (the keepers only append to it; S2 4.2).
 *
 * A refresh that fails is logged by kind (never its message, S2 5.2) and shown once to the pages
 * (`notice tick-failed`, A7) until a refresh has worked again; the next one tries again. A store
 * that a newer skydeck migrated (StoreNewerError, S2 10.1) stops the server: the tick tells
 * `storeNewer` once and does nothing more.
 */
import { isAlive, isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import { refreshPrs } from '../github.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Ns, Proc } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import type { ListRow } from '../sessions/list.ts';
import { loadRows } from '../sessions/load.ts';
import { describeError } from '../sessions/problems.ts';
import { refresh } from '../sessions/refresh.ts';
import type { RefreshResult } from '../sessions/refresh.ts';
import { isDatabaseFailure, StoreNewerError } from '../store/store.ts';
import { sanitize } from '../text/sanitize.ts';
import type { Attention } from './attention.ts';
import { failureKind } from './auth.ts';
import type { KeeperHello } from './frames.ts';
import type { TerminalHub, TerminalInfo } from './hub.ts';
import type { TicketFetches } from './ticket-fetches.ts';
import type { Interop } from './interop.ts';
import type { KeepAlive } from './keepalive.ts';
import { rotateLog } from './log.ts';
import { mapTerminals } from './mapping.ts';
import type { Mapping } from './mapping.ts';
import type { Pages } from './pages.ts';
import { settleEndedTerminal } from './starts.ts';
import type { Registry } from './terminals.ts';
import { MAY_START } from './view/sections.ts';

export interface TickDeps {
  deck: Deck;
  /** The registry: its terminals, the mapping's answers for them, and dropping an ended one. */
  hub: Pick<TerminalHub, 'list' | 'close'> & Pick<Registry, 'setSession'>;
  pages: Pick<Pages, 'pushList' | 'notice'>;
  keepAlive: Pick<KeepAlive, 'tick'>;
  interop: Pick<Interop, 'refresh'>;
  /** `<stateDir>/keepers.log`, rotated once a minute. */
  keepersLog: string;
  log: (line: string) => void;
  /** S2 10.1: the store was migrated under the server; told once, with the text of `bye`. */
  storeNewer: (reason: string) => void;
  /** Called after each refresh that worked (the server's postponed found-keeper decisions). */
  afterRefresh?: () => void;
  /** Every second, before the keep-alive: look(); every refresh that worked: refreshed(), after
   *  the mapping. When either says true the pages' lists are pushed (plan B 2.7). */
  attention?: Pick<Attention, 'look' | 'refreshed'>;
  /** F19: the server's reads of a ticket's status; every refresh offers it a round over the
   *  tickets of the sessions the pages listed. Absent: no status is read by the tick. */
  tickets?: Pick<TicketFetches, 'round'>;
}

export interface Tick {
  /** The rows the lists show: those of the last reload ([] before the first tick). */
  rows(): readonly ListRow[];
  /** Running sessions none of whose holders is in a terminal of the window (the mapping's). */
  elsewhere(): ReadonlyMap<string, { pid: number; tty: string | null }>;
  /** A terminal ended (any exit): settled at the next refresh with this, its latest hello, and the
   *  terminal as `hub.list()` gives it now — a lost keeper's exit whose program may still run is
   *  settled only once that program is gone or 60 s after the loss (plan task 82). */
  ended(hello: KeeperHello): void;
  /** Sessions a page lists: the next automatic pull-request refresh asks about theirs, and the
   *  next round of the tickets' statuses (F19) about their tickets. */
  listed(sessionIds: Iterable<string>): void;
  /** The next refresh loads the rows again, whatever the change marks say (the server wrote). */
  reload(): void;
  /**
   * Plan D7: loadRows now and pages.pushList(), so that an edit shows within a second; a failure
   * is logged by kind and the reload is left to the next refresh. Nothing after stop().
   */
  reloadNow(): void;
  /** One second of the tick; resolves when its work is done. start() calls it every second. */
  run(): Promise<void>;
  /** Runs the first tick (and waits for it), then one every second. */
  start(): Promise<void>;
  /** No tick from now on; resolves once a running tick and a pull-request fetch have ended. */
  stop(): Promise<void>;
  /** Settles the exits not settled yet, now (the server's stop); a failure is logged by kind. A lost
   *  keeper's exit whose program may still run stays unsettled: its lock expires by itself, and a
   *  new session's label and group stay for good (no session is derived from them alone). */
  settleAll(): void;
}

/** S2 10.1: the rows are loaded again at least this often (the interactive list's rule). */
const FULL_RELOAD_NS: Ns = 60n * NS_PER_SECOND;
/** S2 6.4: the interop link is pointed again this often. */
const INTEROP_SECONDS = 30;
/** keepers.log is looked at this often (S2 4.2: rotated at 1 MiB). */
const ROTATE_SECONDS = 60;

/**
 * What tells a reload is due although the refresh saved nothing (the interactive list's change
 * marks): the live-session files with whether each is trusted, and the database's data version
 * (what another skydeck committed).
 */
type ChangeMarks = { live: string; data: number };

function marksOf(deck: Deck): ChangeMarks {
  const { platform, places, store } = deck;
  const live = readLiveFiles(platform.files, places.claudeHome).map((file) =>
    JSON.stringify([file, isLiveFileTrusted(file, platform.proc)], (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    ),
  );
  return { live: live.join('\n'), data: store.dataVersion() };
}

/**
 * Ruled 2026-11-15 09:47Z (stage B, part b): whether a row's last holding was alive at the last load
 * and its process is gone now. A session's end event can be ingested before its process exits, and
 * the row's `ended-unexpectedly` needs that process gone (design 6.3); a program that removes its
 * live file at its end moves no change mark when it exits, so without this the row — and a lost
 * terminal's window end judged on it (B10) — would wait for the minute's reload. Unknown is not gone
 * (design 5.5): a /proc read that throws, or a boot id that cannot be read, counts as alive.
 */
function holderGone(rows: readonly ListRow[], proc: Proc): boolean {
  let bootId: string | null;
  try {
    bootId = proc.bootId();
  } catch {
    return false;
  }
  if (bootId === null) return false;
  return rows.some((row) => {
    const holding = row.session.lastHolding;
    if (holding?.alive !== true) return false;
    try {
      return !isAlive(holding.process, proc, bootId);
    } catch {
      return false;
    }
  });
}

/** Whether a refresh saved anything that a row shows (the interactive list's test). */
function savedSomething({ ingest, observed, scan }: RefreshResult): boolean {
  return ingest.ingested + observed + scan.read + scan.missing + scan.prsAttached > 0;
}

/**
 * The session a terminal shows after this pass: the mapping's; but a terminal whose own session the
 * mapping could not judge keeps it — another session's holder in it that could be judged must not
 * move it for one pass (review 2; ruled in task 21: the previous answer is kept for `unknown`).
 */
function shownBy(term: TerminalInfo, mapping: Mapping): string | null {
  if (term.sessionId !== null && mapping.unknown.has(term.sessionId)) return term.sessionId;
  return mapping.shown.get(term.id) ?? null;
}

/** The session a terminal stands for: the one it shows, or the one it was opened for. */
function sessionOf(term: TerminalInfo, mapping: Mapping): string {
  return shownBy(term, mapping) ?? term.sessionId ?? term.expectedSessionId;
}

export function createTick(deps: TickDeps): Tick {
  const { deck, hub, pages, log } = deps;
  const { platform } = deck;
  const { clock } = platform;

  let rows: readonly ListRow[] = [];
  let elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }> = new Map();
  let loadedAtNs: Ns | null = null;
  let marks: ChangeMarks | null = null;
  let reloadOwed = false;
  /** How many ticks ran: the second of the schedule. */
  let second = 0;
  /**
   * The exits not settled yet, by terminal id, each with the terminal's latest hello and the
   * terminal as the hub listed it when its exit came (null when it did not list it): what tells a
   * lost keeper's exit and its program (plan task 82), also once the terminal was closed.
   */
  const unsettled = new Map<string, { hello: KeeperHello; terminal: TerminalInfo | null }>();
  /** The sessions the pages listed since the last pull-request refresh started. */
  let listed = new Set<string>();
  /** F19: the sessions the pages listed since the last round of the tickets' statuses started. */
  let ticketsListed = new Set<string>();
  /** The failure kind logged for the refresh failing now; null while it works. */
  let failing: string | null = null;
  /** The pages were told that the refresh fails (once until it works again). */
  let told = false;
  let migrated = false;
  let stopped = false;
  let stopTimer = (): void => {};
  let running: Promise<void> | null = null;
  let fetching: Promise<void> | null = null;
  const stopFetches = new AbortController();

  /** Work that must not end the tick: logged by its kind, and the tick goes on. */
  const attempt = async (what: string, work: () => unknown): Promise<void> => {
    try {
      await work();
    } catch (error) {
      log(`tick: ${what} failed (${failureKind(error)})`);
    }
  };

  /** Plan B 2.7: attention's look; true when the facts changed. A throw (its contract has none) is
   *  logged by kind and the tick goes on. */
  const look = (): boolean => {
    try {
      return deps.attention?.look() ?? false;
    } catch (error) {
      log(`tick: the attention look failed (${failureKind(error)})`);
      return false;
    }
  };

  /** Plan B 2.7: B10's window ends after a refresh that worked (the refresh pushes the lists in any
   *  case). A throw is logged by kind: it is no failure of the refresh. */
  const judgeWindowEnds = (): void => {
    try {
      deps.attention?.refreshed();
    } catch (error) {
      log(`tick: the window ends were not judged (${failureKind(error)})`);
    }
  };

  /**
   * S2 7.8: settleEndedTerminal for each exit not settled yet. A failure of the database keeps it
   * for the next refresh and fails this one; any other failure is logged and that exit is given up.
   * A lost keeper's exit whose program may still run is kept for a later refresh, as settleEndedTerminal
   * answers (plan task 82): at most 60 s after the loss, then it is settled as any other.
   */
  const settle = (): void => {
    for (const [id, { hello, terminal }] of [...unsettled]) {
      try {
        if (!settleEndedTerminal(deck, hello, terminal)) continue;
        unsettled.delete(id);
        // It ingested the spool and may have written, on the server's own connection after the
        // refresh's result was made: the rows are loaded again (review 2).
        reloadOwed = true;
      } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        unsettled.delete(id);
        log(`tick: terminal ${id} could not be settled (${failureKind(error)})`);
      }
    }
  };

  /** A24: the rows again when the refresh saved something, a change mark moved, or a minute passed;
   *  stage B: also when a last holder that lived at the last load is gone (holderGone). */
  const reloadIfDue = (result: RefreshResult): void => {
    const now = marksOf(deck);
    const nowNs = clock.nowNs();
    const due =
      reloadOwed ||
      loadedAtNs === null ||
      savedSomething(result) ||
      marks === null ||
      now.live !== marks.live ||
      now.data !== marks.data ||
      nowNs - loadedAtNs >= FULL_RELOAD_NS ||
      holderGone(rows, platform.proc);
    marks = now;
    if (due) {
      rows = loadRows(deck);
      loadedAtNs = nowNs;
      reloadOwed = false;
    }
  };

  /**
   * S2 7.5, 7.9 for the terminals of now: each one's session (setSession), the sessions running
   * elsewhere, and an ended terminal dropped when its session runs again in another terminal or
   * outside the window (ruled, review of task 13). For a session the mapping could not judge
   * (`unknown`, ruled in task 21) the previous answer is kept and nothing is decided on it. A lost
   * terminal's own program, while it may still run and for less than 60 s after the loss (by
   * `nowNs`), is that terminal's in the mapping (plan task 57): its session is not "elsewhere" for
   * it, so the terminal is not dropped for it (S2 7.5, 7.8).
   */
  const map = (): void => {
    const terminals = hub.list();
    let bootId: string | null;
    try {
      bootId = platform.proc.bootId();
    } catch {
      bootId = null;
    }
    const mapping = mapTerminals({
      terminals,
      sessions: rows.map((row) => row.session),
      proc: platform.proc,
      bootId,
      nowNs: clock.nowNs(),
      startTimeoutNs: BigInt(deck.config.restoreStartTimeoutSeconds) * NS_PER_SECOND,
    });
    for (const term of terminals) {
      hub.setSession(term.id, shownBy(term, mapping), mapping.notReported.has(term.id));
    }
    const next = new Map(mapping.elsewhere);
    for (const sessionId of mapping.unknown) {
      const before = elsewhere.get(sessionId);
      if (before !== undefined) next.set(sessionId, before);
    }
    elsewhere = next;
    for (const term of terminals) {
      if (MAY_START.has(term.state)) continue;
      const sessionId = sessionOf(term, mapping);
      if (mapping.unknown.has(sessionId)) continue;
      const runsAgain =
        mapping.elsewhere.has(sessionId) ||
        terminals.some(
          (other) =>
            other.id !== term.id &&
            MAY_START.has(other.state) &&
            shownBy(other, mapping) === sessionId,
        );
      if (runsAgain) hub.close(term.id);
    }
  };

  /** Design 7.3, automatic: the due pull requests of the sessions the pages listed; one at a time. */
  const fetchPrs = (): void => {
    if (fetching !== null || listed.size === 0) return;
    const sessionIds = [...listed];
    listed = new Set();
    const { runner, env } = platform;
    fetching = refreshPrs(
      { runner, clock, env, store: deck.store },
      {
        force: false,
        refreshMinutes: deck.config.prRefreshMinutes,
        sessionIds,
        signal: stopFetches.signal,
      },
    )
      .then(
        ({ fetched, failed }) => {
          // The server's own connection saved them: the data version does not show it.
          if (fetched + failed > 0) reloadOwed = true;
        },
        (error: unknown) => {
          if (!stopFetches.signal.aborted) {
            log(`tick: the pull-request refresh failed (${failureKind(error)})`);
          }
        },
      )
      .finally(() => {
        fetching = null;
      });
  };

  /**
   * F19 (T4): a round of the tickets' statuses over the addresses of the sessions the pages listed
   * (each row's ticket status: there only when a provider takes its address), each once; the
   * round reads those that are due. While one runs or waits the listed sessions are kept for the next.
   */
  const fetchTickets = (): void => {
    const tickets = deps.tickets;
    if (tickets === undefined || ticketsListed.size === 0) return;
    const urls = new Set(
      rows.flatMap((row) =>
        ticketsListed.has(row.id) && row.ticketStatus !== null ? [row.ticketStatus.url] : [],
      ),
    );
    if (urls.size === 0 || tickets.round([...urls])) ticketsListed = new Set();
  };

  /** The refresh and what rests on it; a failure is told once, a migrated store stops the server. */
  const refreshStep = (): void => {
    try {
      const result = refresh(deck);
      settle();
      reloadIfDue(result);
      map();
      judgeWindowEnds();
      fetchPrs();
      fetchTickets();
      deps.afterRefresh?.();
      failing = null;
      told = false;
    } catch (error) {
      if (error instanceof StoreNewerError) {
        migrated = true;
        deps.storeNewer(error.message);
        return;
      }
      reloadOwed = true;
      const kind = failureKind(error);
      if (failing !== kind) {
        failing = kind;
        log(`tick: the refresh failed (${kind})`);
      }
      if (!told) {
        told = true;
        pages.notice(
          'tick-failed',
          `skydeck could not refresh the list: ${sanitize(describeError(error))}; it tries again`,
        );
      }
    }
    pages.pushList();
  };

  const run = async (): Promise<void> => {
    if (stopped || migrated) return;
    const now = second++;
    if (now > 0 && now % INTEROP_SECONDS === 0) {
      await attempt('the interop link', () => deps.interop.refresh());
    }
    const looked = look();
    await attempt('the keep-alive', () => deps.keepAlive.tick());
    if (now % 2 === 0 && !stopped) {
      refreshStep(); // its lists carry what the look changed
    } else if (looked && !stopped) {
      pages.pushList();
    }
    if (now > 0 && now % ROTATE_SECONDS === 0) {
      await attempt('keepers.log rotation', () => {
        rotateLog(platform.files, deps.keepersLog);
      });
    }
  };

  /** One tick at a time: a tick that comes while the last one still runs is left out. */
  const once = (): Promise<void> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    rows: () => rows,
    elsewhere: () => elsewhere,
    ended(hello) {
      // The registry calls this inside its exit event, where it lists the terminal with its exit:
      // `lost` and the program for a lost keeper. A hub that cannot be read gives no terminal, and
      // the exit is settled as before.
      let terminal: TerminalInfo | null;
      try {
        terminal = hub.list().find((candidate) => candidate.id === hello.id) ?? null;
      } catch {
        terminal = null;
      }
      unsettled.set(hello.id, { hello, terminal });
    },
    listed(sessionIds) {
      for (const id of sessionIds) {
        listed.add(id);
        ticketsListed.add(id);
      }
    },
    reload() {
      reloadOwed = true;
    },
    reloadNow() {
      if (stopped) return;
      try {
        rows = loadRows(deck);
      } catch (error) {
        reloadOwed = true;
        log(`tick: the rows were not loaded again (${failureKind(error)})`);
        return;
      }
      loadedAtNs = clock.nowNs();
      reloadOwed = false;
      pages.pushList();
    },
    run: once,
    async start() {
      await once();
      if (stopped) return;
      stopTimer = clock.every(1000, () => {
        void once();
      });
    },
    settleAll() {
      try {
        settle();
      } catch (error) {
        log(`tick: ended terminals were not settled (${failureKind(error)})`);
      }
    },
    async stop() {
      stopped = true;
      stopTimer();
      stopFetches.abort();
      await running;
      await fetching;
    },
  };
}
