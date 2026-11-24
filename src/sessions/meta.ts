// What the user attaches to a session (design 7.1) and the pull requests they attach by hand (7.3).
// Nothing here stops a process, and nothing moves a note from one session to another (principle 6)
// but the window's carry over after `/clear` (follow-up F40, `carryFields`), on the user's word:
// it copies, and the old session keeps its own.
import { join } from 'node:path';

import { prKey } from '../github.ts';
import type { PrKey } from '../github.ts';
import { SkydeckError, UsageError } from '../platform/errors.ts';
import type { Ns } from '../platform/types.ts';
import { sanitize } from '../text/sanitize.ts';
import type { MetaPatch } from '../store/types.ts';
import type { Deck } from './deck.ts';
import { ACTIVITY_STARTS } from './derive.ts';
import type { ListRow } from './list.ts';
import { readTicket } from './ticket.ts';

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

/**
 * F18's K1 for a command and the window: the address `text` sets (readTicket with the
 * configuration's `ticketUrl`), null when it removes the ticket; a UsageError with readTicket's
 * words when it is refused.
 */
export function requireTicket(text: string, ticketUrl: string | null): string | null {
  const read = readTicket(text, ticketUrl);
  if (!read.ok) {
    throw new UsageError(read.error);
  }
  return read.address;
}

/** Sets the ticket's address (F18), replacing the one before; null removes it. The caller has
 *  read the text with `requireTicket`. */
export function setTicket(deck: Deck, sessionId: string, address: string | null): void {
  deck.store.updateMeta(sessionId, { ticket: address }, deck.platform.clock.nowNs());
}

/** Follow-up F40: the fields a carry over copies, cleaned by the caller; absent is not copied. */
export interface CarriedFields {
  label?: string;
  group?: string;
  /** The ticket's address. */
  ticket?: string;
  note?: string;
  /** The urls of the pull requests to attach. */
  prs?: readonly string[];
}

/**
 * Follow-up F40 (design 7.1): copies the given fields to the session — one `updateMeta` with the
 * label, group, ticket and note given (none given: none), then each pull request attached with
 * origin `manual` (which also clears an earlier detach). It opens no transaction (the caller's
 * holds it) and cleans nothing (the caller cleaned, as for `setLabel`).
 */
export function carryFields(deck: Deck, sessionId: string, fields: CarriedFields): void {
  const now = deck.platform.clock.nowNs();
  const patch: MetaPatch = {};
  if (fields.label !== undefined) patch.label = fields.label;
  if (fields.group !== undefined) patch.group = fields.group;
  if (fields.ticket !== undefined) patch.ticket = fields.ticket;
  if (fields.note !== undefined) patch.note = fields.note;
  if (Object.keys(patch).length > 0) deck.store.updateMeta(sessionId, patch, now);
  for (const url of fields.prs ?? []) {
    deck.store.attachPr(sessionId, url, 'manual', now);
  }
}

/** The file `skydeck note`'s editor works on, and keeps when it fails: `<stateDir>/note-<id>.md`. */
export function keptNotePath(deck: Deck, sessionId: string): string {
  return join(deck.places.stateDir, `note-${sessionId}.md`);
}

/**
 * Removes the note file a failed edit of this session kept: the user has now set the note
 * another way (`note --set`, the window), so that unsaved text is not wanted any more. Failing to
 * is not worth ending anything for: the next edit of the same note opens what is left.
 */
export function discardKeptNote(deck: Deck, sessionId: string): void {
  try {
    deck.platform.files.remove(keptNotePath(deck, sessionId));
  } catch {
    // a leftover file is replaced by the next edit of the same note
  }
}

/**
 * Hides the session from now on (7.1), and ends its parking in the same statement (follow-up F44:
 * Open, Parked and Done exclude one another, so every caller of this ends a parking). The session
 * itself is not touched. The done time is the clock now, but never below what would make the
 * session active again (a start, a transcript's input): the wall clock can be behind such a stamp
 * after it stepped back, and the session would then never be hidden (#207; a parking has the same
 * rule for its input, `parkTime`). A stamp from a clock that was far ahead keeps it hidden until
 * the clock passes it.
 */
export function markDone(deck: Deck, sessionId: string): void {
  const now = deck.platform.clock.nowNs();
  const latest = deck.store.latestActivityNs(sessionId, ACTIVITY_STARTS);
  deck.store.updateMeta(
    sessionId,
    { doneAtNs: latest !== null && latest > now ? latest : now, parkedAtNs: null },
    now,
  );
}

/**
 * Shows a hidden session again. A parking it leaves alone: a done session has none (markDone
 * cleared it), and on a parked session that is not done this changes nothing (F44).
 */
export function markUndone(deck: Deck, sessionId: string): void {
  deck.store.updateMeta(sessionId, { doneAtNs: null }, deck.platform.clock.nowNs());
}

/**
 * Follow-up F44 (design 7.1): the time a parking is stored with, the later of `nowNs` and one
 * nanosecond after `lastUserNs` (the user's last input known at the parking; null for none). The
 * transcript's clock is Claude Code's and the wall clock of WSL steps back (design 7.6), so a
 * parking right after a prompt could otherwise be dated before it and read as ended at once: input
 * known at the parking is by definition not later than the parking.
 */
export function parkTime(nowNs: Ns, lastUserNs: Ns | null): Ns {
  return lastUserNs !== null && lastUserNs + 1n > nowNs ? lastUserNs + 1n : nowNs;
}

/** What `markParked` reads of a row: its id, whether it is parked now, its transcript. */
export type ParkTarget = Pick<ListRow, 'id' | 'parked' | 'session'>;

/**
 * Follow-up F44 (design 7.1): parks the session, and ends its done mark in the same statement.
 * A row that is parked already is not written (the time it was parked is kept) and the answer is
 * false; otherwise true. It never stops or moves anything.
 */
export function markParked(deck: Deck, row: ParkTarget): boolean {
  if (row.parked) {
    return false;
  }
  const now = deck.platform.clock.nowNs();
  const at = parkTime(now, row.session.transcript?.lastUserNs ?? null);
  deck.store.updateMeta(row.id, { parkedAtNs: at, doneAtNs: null }, now);
  return true;
}

/** Follow-up F44: ends the session's parking; the session is listed under Open or as before. */
export function markUnparked(deck: Deck, sessionId: string): void {
  deck.store.updateMeta(sessionId, { parkedAtNs: null }, deck.platform.clock.nowNs());
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
