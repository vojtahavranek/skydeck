// What the user attaches to a session (design 7.1) and the pull requests they attach by hand (7.3).
// Nothing here stops a process, and nothing moves a note from one session to another (principle 6).
import { prKey } from '../github.ts';
import type { PrKey } from '../github.ts';
import { SkydeckError, UsageError } from '../platform/errors.ts';
import { sanitize } from '../text/sanitize.ts';
import type { Deck } from './deck.ts';

/** Sets the label; null clears it. The caller has cleaned the text with `cleanLabel`. */
export function setLabel(deck: Deck, sessionId: string, label: string | null): void {
  deck.store.updateMeta(sessionId, { label }, deck.platform.clock.nowNs());
}

/** Sets the group; null clears it. The caller has cleaned the text with `cleanGroup`. */
export function setGroup(deck: Deck, sessionId: string, group: string | null): void {
  deck.store.updateMeta(sessionId, { group }, deck.platform.clock.nowNs());
}

/**
 * Sets the note exactly as given: free text, several lines, not trimmed. A note that is null,
 * empty or only whitespace clears it.
 */
export function setNote(deck: Deck, sessionId: string, note: string | null): void {
  const stored = note === null || note.trim() === '' ? null : note;
  deck.store.updateMeta(sessionId, { note: stored }, deck.platform.clock.nowNs());
}

/** Hides the session from now on (7.1). The session itself is not touched. */
export function markDone(deck: Deck, sessionId: string): void {
  const now = deck.platform.clock.nowNs();
  deck.store.updateMeta(sessionId, { doneAtNs: now }, now);
}

/** Shows a hidden session again. */
export function markUndone(deck: Deck, sessionId: string): void {
  deck.store.updateMeta(sessionId, { doneAtNs: null }, deck.platform.clock.nowNs());
}

/**
 * The key of a pull-request URL (design 7.3). UsageError "not a GitHub pull-request URL: <text>"
 * when `url` is none; the text is sanitised, because the message is shown on a terminal. Also
 * exported for a command that must check its arguments before it opens the database.
 */
export function requirePrKey(url: string): PrKey {
  const key = prKey(url);
  if (key === null) {
    throw new UsageError(`not a GitHub pull-request URL: ${sanitize(url)}`);
  }
  return key;
}

/**
 * Attaches the pull request to the session with origin `manual`, which also clears an earlier
 * detach (7.3). The pull request is not fetched here. UsageError when `url` is not a pull request.
 */
export function attachManualPr(deck: Deck, sessionId: string, url: string): PrKey {
  const key = requirePrKey(url);
  deck.store.transaction(() => {
    deck.store.ensurePr(key);
    deck.store.attachPr(sessionId, key.url, 'manual', deck.platform.clock.nowNs());
  });
  return key;
}

/**
 * Detaches the pull request from the session; a later `pr-link` record does not attach it again.
 * UsageError when `url` is not a pull request; SkydeckError (exit 1) when it was not attached.
 */
export function detachSessionPr(deck: Deck, sessionId: string, url: string): PrKey {
  const key = requirePrKey(url);
  if (!deck.store.detachPr(sessionId, key.url, deck.platform.clock.nowNs())) {
    throw new SkydeckError(`${key.url} is not attached to ${sessionId.slice(0, 8)}`);
  }
  return key;
}
