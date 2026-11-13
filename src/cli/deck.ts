// How a command gets at the deck (plan 2.9.3): open it, bring it up to date, close it again.
import { SkydeckError } from '../platform/errors.ts';
import { openDeck } from '../sessions/deck.ts';
import type { Deck } from '../sessions/deck.ts';
import { refresh } from '../sessions/refresh.ts';
import type { RefreshResult } from '../sessions/refresh.ts';
import { isDatabaseFailure } from '../store/store.ts';
import type { Context } from './context.ts';

/**
 * openDeck(ctx.platform); refreshWithProgress when options.refresh; await fn(deck); and the store
 * is closed whichever way that ends. A failure of the database as a whole (locked, read-only, I/O,
 * corrupt, full) that comes out of the refresh or of `fn` is rethrown as one SkydeckError that
 * names the database (exit 1), not as an internal error; every other error passes through as it is.
 */
export async function withDeck<T>(
  ctx: Context,
  options: { refresh: boolean },
  fn: (deck: Deck) => Promise<T>,
): Promise<T> {
  const deck = openDeck(ctx.platform);
  try {
    if (options.refresh) {
      refreshWithProgress(ctx, deck);
    }
    return await fn(deck);
  } catch (error) {
    throw isDatabaseFailure(error) ? databaseFailure(deck, error) : error;
  } finally {
    try {
      deck.store.close();
    } catch {
      // Everything is committed already (each write is its own transaction, synchronous=FULL), and
      // an error from here would replace the one that ended the command.
    }
  }
}

function databaseFailure(deck: Deck, error: unknown): SkydeckError {
  const reason = error instanceof Error ? error.message : String(error);
  const failure = new SkydeckError(`the database ${deck.store.path} failed: ${reason}`);
  failure.cause = error; // SkydeckError takes no options; the stack of the SQLite error stays
  return failure;
}

/**
 * refresh(deck). When io.isTTY.stderr and kv first_scan_done is absent, shows
 * "\rskydeck: reading transcripts <done>/<total>" on stderr while scanning and clears it with
 * "\r\x1b[K" at the end (design 5.6), also when the scan fails. Nothing is written when there is
 * no file to read.
 */
export function refreshWithProgress(ctx: Context, deck: Deck): RefreshResult {
  if (!ctx.io.isTTY.stderr || deck.store.getKv('first_scan_done') === '1') {
    return refresh(deck);
  }
  let shown = false;
  try {
    return refresh(deck, (done, total) => {
      shown = true;
      ctx.io.stderr(`\rskydeck: reading transcripts ${done}/${total}`);
    });
  } finally {
    if (shown) {
      ctx.io.stderr('\r\x1b[K');
    }
  }
}
