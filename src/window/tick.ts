/**
 * The server's tick (S2 10.1; plan task 23): what the server does on its own, once a second.
 *
 * - Every second: the keep-alive (S2 6.1, 6.2).
 * - Every second tick: the refresh every command runs (design 5.3), the settling of the terminals
 *   that ended since (S2 7.8), the rows loaded again by step 1's rule of the interactive list
 *   (A24), the mapping of the window's terminals to sessions (S2 7.5, 7.9) with the ended terminals
 *   whose session runs again dropped, the automatic pull-request refresh for the sessions the pages
 *   list (design 7.3), and the pages' lists.
 * - Every 30 seconds: the interop link (S2 6.4).
 * - Once a minute: keepers.log rotated (the keepers only append to it; S2 4.2).
 *
 * A refresh that fails is logged by kind (never its message, S2 5.2) and shown once to the pages
 * (`notice tick-failed`, A7) until a refresh has worked again; the next one tries again. A store
 * that a newer skydeck migrated (StoreNewerError, S2 10.1) stops the server: the tick tells
 * `storeNewer` once and does nothing more.
 */
import { isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import { refreshPrs } from '../github.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import type { ListRow } from '../sessions/list.ts';
import { loadRows } from '../sessions/load.ts';
import { describeError } from '../sessions/problems.ts';
import { refresh } from '../sessions/refresh.ts';
import type { RefreshResult } from '../sessions/refresh.ts';
import { isDatabaseFailure, StoreNewerError } from '../store/store.ts';
import { sanitize } from '../text/sanitize.ts';
import { failureKind } from './auth.ts';
import type { KeeperHello } from './frames.ts';
import type { TerminalHub, TerminalInfo } from './hub.ts';
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
}

export interface Tick {
  /** The rows the lists show: those of the last reload ([] before the first tick). */
  rows(): readonly ListRow[];
  /** Running sessions none of whose holders is in a terminal of the window (the mapping's). */
  elsewhere(): ReadonlyMap<string, { pid: number; tty: string | null }>;
  /** A terminal ended (any exit): settled at the next refresh with this, its latest hello. */
  ended(hello: KeeperHello): void;
  /** Sessions a page lists: the next automatic pull-request refresh asks about theirs. */
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
  /** Settles the exits not settled yet, now (the server's stop); a failure is logged by kind. */
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
  /** The exits not settled yet, by terminal id, each with the terminal's latest hello. */
  const unsettled = new Map<string, KeeperHello>();
  /** The sessions the pages listed since the last pull-request refresh started. */
  let listed = new Set<string>();
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

  /**
   * S2 7.8: settleEndedTerminal for each exit not settled yet. A failure of the database keeps it
   * for the next refresh and fails this one; any other failure is logged and that exit is given up.
   */
  const settle = (): void => {
    for (const [id, hello] of [...unsettled]) {
      try {
        settleEndedTerminal(deck, hello);
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

  /** A24: the rows again when the refresh saved something, a change mark moved, or a minute passed. */
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
      nowNs - loadedAtNs >= FULL_RELOAD_NS;
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

  /** The refresh and what rests on it; a failure is told once, a migrated store stops the server. */
  const refreshStep = (): void => {
    try {
      const result = refresh(deck);
      settle();
      reloadIfDue(result);
      map();
      fetchPrs();
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
    await attempt('the keep-alive', () => deps.keepAlive.tick());
    if (now % 2 === 0 && !stopped) {
      refreshStep();
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
      unsettled.set(hello.id, hello);
    },
    listed(sessionIds) {
      for (const id of sessionIds) listed.add(id);
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
