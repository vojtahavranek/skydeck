/**
 * Follow-up F19 (T4): the reads of a ticket's status the window's server runs, in the background,
 * so that no action waits for a program. ONE run at a time per server, whoever asked, so that at
 * most one status command runs at a time: the reads asked for at once — a ticket set or changed
 * (`act ticket`), the ticket dialog's ↻ (`act ticket-refresh`) — wait while a run runs and then run
 * together, whatever their age; the tick's automatic round (`round`) starts only while nothing runs
 * or waits, reads only what is due (statusesDue, from the store as it is when the round runs) and
 * starts at most COMMANDS_PER_ROUND commands. The server's stop aborts the running one and starts
 * no other.
 */
import type { Deck } from '../sessions/deck.ts';
import { COMMANDS_PER_ROUND, fetchTicketStatuses, statusesDue } from '../ticket-status.ts';
import type { StatusDeps } from '../ticket-status.ts';
import { failureKind } from './auth.ts';

export interface TicketFetches {
  /** Reads these addresses' statuses now, whatever their age, in the background; never rejects. */
  fetch(urls: readonly string[]): void;
  /**
   * The tick's round over the ticket addresses of the sessions the pages list: false, and nothing
   * started, while a run runs or waits; else true, and a run reads those of them that are due.
   */
  round(urls: readonly string[]): boolean;
  /** Resolves when no run runs or waits (the server's stop waits for it after aborting). */
  idle(): Promise<void>;
}

/**
 * The reads of one server, with the platform's runner, clock, environment and home and the deck's
 * store and configuration. `changed()` after each saved result (the lists show it within a
 * second), and once after a run that threw (a result may have been saved before); a failure that
 * was saved is logged by its count, a thrown one by its kind — never a message, which can name an
 * address. A run the signal ended saves nothing more.
 */
export function createTicketFetches(deps: {
  deck: Deck;
  /** The server's stop: aborts a running read, starts no other. */
  signal: AbortSignal;
  changed(): void;
  log: (line: string) => void;
}): TicketFetches {
  const { deck, signal, log } = deps;
  const { runner, clock, env, homeDir } = deck.platform;
  // Made for each run: F36's settings screen changes `ticketUrl` while the server runs (AT ONCE);
  // `ticketStatus` only at the server's start.
  const statusDeps = (): StatusDeps => ({
    runner,
    clock,
    env,
    store: deck.store,
    homeDir,
    rules: deck.config.ticketStatus,
    ticketUrl: deck.config.ticketUrl,
  });

  /** The addresses asked for at once that wait for the running run; null when none waits. */
  let waiting: Set<string> | null = null;
  /** The running run, until it and every run that waited for it have ended. */
  let current: Promise<void> | null = null;

  const tell = (): void => {
    try {
      deps.changed();
    } catch (error) {
      log(`tickets: the lists were not told (${failureKind(error)})`);
    }
  };

  /** One run: every address of `urls` (the tick's: only the due ones, at most 5 commands). */
  const run = async (urls: readonly string[], automatic: boolean): Promise<void> => {
    try {
      const chosen = automatic
        ? statusesDue(
            urls,
            new Map(deck.store.ticketStatuses().map((row) => [row.url, row])),
            clock.nowNs(),
            deck.config.ticketRefreshMinutes,
          )
        : urls;
      if (chosen.length === 0) return;
      const { fetched, failed } = await fetchTicketStatuses(statusDeps(), chosen, {
        signal,
        saved: tell,
        ...(automatic ? { maxCommands: COMMANDS_PER_ROUND } : {}),
      });
      if (failed > 0) {
        log(`tickets: ${failed} of ${fetched + failed} ticket statuses could not be read`);
      }
    } catch (error) {
      if (signal.aborted) return;
      log(`tickets: the read failed (${failureKind(error)})`);
      tell();
    }
  };

  /** Starts `first`, then whatever waits, one run after the other, until nothing waits. */
  const start = (first: () => Promise<void>): void => {
    current = (async () => {
      await first();
      while (waiting !== null && !signal.aborted) {
        const urls = [...waiting];
        waiting = null;
        await run(urls, false);
      }
    })().finally(() => {
      current = null;
      // Review 2 (C6): a read asked for after the loop's last look still runs.
      if (waiting !== null && !signal.aborted) start(async () => {});
    });
  };

  return {
    fetch(urls) {
      if (signal.aborted || urls.length === 0) return;
      waiting ??= new Set();
      for (const url of urls) waiting.add(url);
      if (current === null) {
        start(async () => {});
      }
    },
    round(urls) {
      if (signal.aborted || current !== null || waiting !== null) return false;
      start(() => run(urls, true));
      return true;
    },
    async idle() {
      while (current !== null) await current;
    },
  };
}
