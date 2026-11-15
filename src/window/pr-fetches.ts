/**
 * The pull-request fetches the window asks for (plan D8): design 7.3's fetch of a pull request
 * attached in the window (`pr-add`: at once, `gh`'s 10-second timeout) and the explicit refresh of a
 * session's pull requests (`pr-refresh`: refreshPrs with force), in the background on the server, so
 * that no action waits for `gh`. One such fetch runs at a time per server: a request whose pull
 * requests the running one already asks about joins it; any other waits, and every request that
 * waited runs together when it ends. The server's stop aborts the running one and starts no other.
 * The tick's automatic refresh (tick.ts) runs beside these, one at a time of its own, as the
 * interactive list's does beside `pr refresh`.
 */
import { fetchPrs, refreshPrs } from '../github.ts';
import type { Deck } from '../sessions/deck.ts';
import { failureKind } from './auth.ts';

export interface PrFetches {
  /** design 7.3's fetch of these pull requests, in the background; never rejects. */
  fetch(urls: readonly string[]): void;
  /** An explicit refresh of the session's pull requests (refreshPrs with force), likewise. */
  refresh(sessionId: string): void;
  /** Resolves when no fetch runs or waits (the server's stop waits for it after aborting). */
  idle(): Promise<void>;
}

/** What one run asks about: pull requests by their key URL, and sessions refreshed whole. */
interface Batch {
  urls: Set<string>;
  sessions: Set<string>;
}

/**
 * The fetches of one server. A run calls refreshPrs for the sessions it holds, then fetchPrs for
 * the pull requests (with the platform's runner, clock and environment and the deck's store, and
 * `signal`); `changed()` once after a run that saved something (fetched or failed), a failure that
 * was saved logged by its count, a thrown one by its kind (failureKind) — never a message, which can
 * name an address. A run the signal ended saves nothing (fetchPrs), so it logs and tells nothing.
 */
export function createPrFetches(deps: {
  deck: Deck;
  /** The server's stop: aborts a running fetch, starts no other. */
  signal: AbortSignal;
  /** Called when a fetch saved something (fetched + failed > 0). */
  changed(): void;
  log: (line: string) => void;
}): PrFetches {
  const { deck, signal, log } = deps;
  const { runner, clock, env } = deck.platform;
  const gh = { runner, clock, env, store: deck.store };

  let running: Batch | null = null;
  let waiting: Batch | null = null;
  /** The running run, until it and everything that waited for it have ended. */
  let current: Promise<void> | null = null;

  const covers = (batch: Batch, urls: readonly string[], sessions: readonly string[]): boolean =>
    urls.every((url) => batch.urls.has(url)) && sessions.every((id) => batch.sessions.has(id));

  const run = async (batch: Batch): Promise<void> => {
    let fetched = 0;
    let failed = 0;
    try {
      if (batch.sessions.size > 0) {
        const counts = await refreshPrs(gh, {
          force: true,
          refreshMinutes: deck.config.prRefreshMinutes,
          sessionIds: [...batch.sessions],
          signal,
        });
        fetched += counts.fetched;
        failed += counts.failed;
      }
      if (batch.urls.size > 0) {
        const counts = await fetchPrs(gh, [...batch.urls], { signal });
        fetched += counts.fetched;
        failed += counts.failed;
      }
    } catch (error) {
      log(`prs: the fetch failed (${failureKind(error)})`);
    }
    if (failed > 0) log(`prs: ${failed} of ${fetched + failed} pull requests could not be read`);
    if (fetched + failed === 0) return;
    try {
      deps.changed();
    } catch (error) {
      log(`prs: the lists were not told (${failureKind(error)})`);
    }
  };

  const start = (): void => {
    const batch = waiting;
    waiting = null;
    if (batch === null || signal.aborted) return;
    running = batch;
    current = run(batch).finally(() => {
      running = null;
      current = null;
      start();
    });
  };

  const ask = (urls: readonly string[], sessions: readonly string[]): void => {
    if (running !== null && covers(running, urls, sessions)) return; // it joins the running one
    waiting ??= { urls: new Set(), sessions: new Set() };
    for (const url of urls) waiting.urls.add(url);
    for (const id of sessions) waiting.sessions.add(id);
    if (running === null) start();
  };

  return {
    fetch(urls) {
      ask(urls, []);
    },
    refresh(sessionId) {
      ask([], [sessionId]);
    },
    async idle() {
      while (current !== null) await current;
    },
  };
}
