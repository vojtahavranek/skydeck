/**
 * The new form's favourite flags (S2 12.6, 10.2; follow-up F15), which skydeck keeps for the
 * window: one `kv` entry, `window_favourites`, holding a JSON array of the favourites' texts in the
 * order they were added — no table, no migration (`kv` is free text), so every window and every
 * server after a restart see the same list, and an older skydeck leaves the entry alone (it reads
 * only the keys it knows). The server reads it into every page's `list` (`favourites`) and the
 * actions `favourite-add` and `favourite-remove` change it (actions.ts).
 *
 * A favourite is one text of flags as typed, trimmed. `favouriteRefusal` says why a text cannot be
 * one: empty; splitFlags refuses it; it holds a line break or another control character, or a
 * bidirectional control (ruled on review 2); longer than FAVOURITE_LENGTH characters; the same
 * words as a favourite; MAX_FAVOURITES already; then a flag that `skydeck new` refuses —
 * prepareNew's own rule and words (refuseSessionFlags), so that a favourite never holds what Start
 * would refuse.
 * web/favourite-text.js is the page's copy of every step but the last, held equal by
 * test/web/favourite-text.test.ts.
 */
import { SkydeckError } from '../platform/errors.ts';
import { refuseSessionFlags } from '../sessions/resume.ts';
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';
import { splitFlags } from './flags.ts';
import { MAX_FAVOURITES } from './protocol.ts';

export const FAVOURITES_KEY: KvKey = 'window_favourites';
/** A favourite holds at most this many characters (code points) once trimmed. */
export const FAVOURITE_LENGTH = 200;

/** The refusals' words; the page shows them (web/favourite-text.js has the same). */
export const FAVOURITE_REFUSALS = {
  empty: 'there are no flags to save',
  control: 'the flags contain a line break or another control character',
  tooLong: `a favourite is at most ${FAVOURITE_LENGTH} characters`,
  known: 'these flags are a favourite already',
  full: `there are ${MAX_FAVOURITES} favourites already; remove one first`,
} as const;

/** What a favourite never holds (ruled on review 2 of F15): a line break (U+2028 and U+2029
 *  too) or another control character (C0, DEL, C1) and the bidirectional controls — what design
 *  7.4's sanitiser takes away or changes —, so that a chip shows the favourite as it is (the
 *  page's CONTROL is the same). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** The words of a text, or null when splitFlags refuses it. */
function wordsOf(text: string): string[] | null {
  const split = splitFlags(text);
  return split.ok ? split.flags : null;
}

function sameWords(one: readonly string[], other: readonly string[] | null): boolean {
  return other !== null && one.length === other.length && one.every((word, i) => word === other[i]);
}

/**
 * Why `text` cannot be saved as one more favourite beside `favourites`, in this order and these
 * words: trimmed it is empty; splitFlags refuses it (its words); it holds a line break or another
 * control character, or a bidirectional control (CONTROL); it holds more than
 * FAVOURITE_LENGTH characters; it has the same words as one of `favourites`, however spaced or
 * quoted; `favourites` holds MAX_FAVOURITES; refuseSessionFlags refuses its words (prepareNew's
 * words). null when it can be one.
 */
export function favouriteRefusal(text: string, favourites: readonly string[]): string | null {
  const favourite = text.trim();
  if (favourite === '') return FAVOURITE_REFUSALS.empty;
  const split = splitFlags(favourite);
  if (!split.ok) return split.error;
  if (CONTROL.test(favourite)) return FAVOURITE_REFUSALS.control;
  if ([...favourite].length > FAVOURITE_LENGTH) return FAVOURITE_REFUSALS.tooLong;
  if (favourites.some((one) => sameWords(split.flags, wordsOf(one)))) {
    return FAVOURITE_REFUSALS.known;
  }
  if (favourites.length >= MAX_FAVOURITES) return FAVOURITE_REFUSALS.full;
  try {
    refuseSessionFlags(split.flags);
  } catch (error) {
    if (error instanceof SkydeckError) return error.message;
    throw error;
  }
  return null;
}

/**
 * The favourites the store holds, in their order. A value that is not a JSON array is none; of an
 * array, the entries the rule takes are read — strings, well formed, trimmed already, each one
 * that favouriteRefusal accepts beside those read before it (so at most MAX_FAVOURITES) — and the
 * others are left out.
 */
export function readFavourites(store: Pick<Store, 'getKv'>): string[] {
  const stored = store.getKv(FAVOURITES_KEY);
  if (stored === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const read: string[] = [];
  for (const entry of value as unknown[]) {
    if (
      typeof entry === 'string' &&
      entry.isWellFormed() &&
      entry === entry.trim() &&
      favouriteRefusal(entry, read) === null
    ) {
      read.push(entry);
    }
  }
  return read;
}

/** Writes the list; an empty one removes the entry, as it was before the first favourite. */
function writeFavourites(store: Store, favourites: readonly string[]): void {
  if (favourites.length === 0) store.deleteKv(FAVOURITES_KEY);
  else store.setKv(FAVOURITES_KEY, JSON.stringify(favourites));
}

/**
 * Adds `text`, trimmed, as a favourite in one transaction: last, or at place `at` when it is given
 * (Undo puts a removed one back where it was; a place past the end is the end). Its refusal
 * (favouriteRefusal against the stored list) when it cannot be one, nothing written; else null.
 */
export function addFavourite(store: Store, text: string, at?: number): string | null {
  const favourite = text.trim();
  return store.transaction(() => {
    const favourites = readFavourites(store);
    const refusal = favouriteRefusal(favourite, favourites);
    if (refusal !== null) return refusal;
    favourites.splice(Math.min(at ?? favourites.length, favourites.length), 0, favourite);
    writeFavourites(store, favourites);
    return null;
  });
}

/**
 * Removes the favourite whose text is exactly `text`, in one transaction: true when it was one;
 * false, nothing written, when none is (a removal sent twice, or from two windows).
 */
export function removeFavourite(store: Store, text: string): boolean {
  return store.transaction(() => {
    const favourites = readFavourites(store);
    const at = favourites.indexOf(text);
    if (at < 0) return false;
    favourites.splice(at, 1);
    writeFavourites(store, favourites);
    return true;
  });
}
