/**
 * The one rule by which the window's filter and its quick switcher match a session (S2 12.8,
 * plan E2–E5), with its bounds (E3). Pure.
 *
 * A search text is foreign input, typed on every keystroke and matched on the server's one
 * thread: it is split by one literal pattern and compared with `includes` and `startsWith`, never
 * made into a pattern. The cost is linear: rows × words × units searched, the units of all a row's
 * fields — the title, the group, the note, the directory, three per pull request, two for the
 * ticket (F18), one for its status (F19) — each at most FIELD_UNITS; nothing bounds how many pull requests a row has.
 *
 * Imports (plan 2.1): values only from this directory and `text`'s `sanitize`; types from
 * `sessions` and `protocol.ts`.
 */
import type { ListRow } from '../../../sessions/list.ts';
import { sanitize } from '../../../text/sanitize.ts';
import type { SearchChip } from '../../protocol.ts';

/** E3. */
export const MAX_WORDS = 16;
/** E3: a word counts in its first MAX_WORD_UNITS UTF-16 units. */
export const MAX_WORD_UNITS = 64;
/** E3: each field is searched in its first FIELD_UNITS UTF-16 units. */
export const FIELD_UNITS = 16_384;
/** E2: a word matches the session id only as its start, and only with this many characters. */
export const ID_PREFIX_MIN = 4;
/** E9: the most ranges foundIn gives. */
export const MAX_FOUND = 32;

/** E4: the chips' values (the type is protocol.ts's), F35's `done` the fourth; the protocol's
 *  parser takes the same four (a case of the protocol's tests ties them). */
export const SEARCH_CHIPS: readonly SearchChip[] = Object.freeze([
  'running',
  'open-pr',
  'note',
  'done',
]);

/** The first `units` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function head(text: string, units: number): string {
  if (text.length <= units) {
    return text;
  }
  const last = text.charCodeAt(units - 1);
  const next = text.charCodeAt(units);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? units - 1 : units);
}

/** A field as it is searched: cut, lower-cased, and cut again (lower case can be longer). */
function field(text: string): string {
  return head(head(text, FIELD_UNITS).toLowerCase(), FIELD_UNITS);
}

/**
 * The note as `show` prints it (design 7.4): its raw text cut to FIELD_UNITS first, so that a long
 * note costs no more than a short one, then sanitised line by line (a line break, a lone carriage
 * return too, ends whatever escape sequence the line left open) and joined with `\n`.
 */
function noteField(note: string): string {
  const lines = head(note, FIELD_UNITS).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  return field(lines.map(sanitize).join('\n'));
}

/** E2, E3: the words of a search text — split at /\s+/u, empty parts dropped, toLowerCase, the
 *  first MAX_WORDS, each cut to its first MAX_WORD_UNITS units (never inside a surrogate pair),
 *  then each once in order. */
export function searchWords(text: string): string[] {
  const parts = text.split(/\s+/u).filter((part) => part !== '');
  const words = parts.slice(0, MAX_WORDS).map((part) => head(part.toLowerCase(), MAX_WORD_UNITS));
  return [...new Set(words)];
}

/** What a row is searched in (E2, E3): its fields lower-cased and cut to FIELD_UNITS, and its id.
 *  Made once per row object (a WeakMap); the same row gives the same object. */
export interface Searchable {
  readonly fields: readonly string[];
  readonly id: string;
}

/** Keyed by the row object: the tick replaces a row when it reloads, so a changed row is made anew. */
const SEARCHABLE = new WeakMap<ListRow, Searchable>();

export function searchable(row: ListRow): Searchable {
  const known = SEARCHABLE.get(row);
  if (known !== undefined) {
    return known;
  }
  // Design 7.4's fields: the title, the group, the note, the directory, per pull request
  // "<owner>/<repo>", its number and "<owner>/<repo>#<number>", the ticket's name and address
  // (F18), and its status' text (F19). Every one but the note is sanitised already (buildRows; an
  // address is printable ASCII, linkToOpen's).
  const fields: string[] = [field(row.title)];
  if (row.group !== null) {
    fields.push(field(row.group));
  }
  if (row.note !== null) {
    fields.push(noteField(row.note));
  }
  if (row.dir !== null) {
    fields.push(field(row.dir));
  }
  for (const pr of row.prs) {
    fields.push(field(pr.repo), String(pr.number), field(`${pr.repo}#${pr.number}`));
  }
  if (row.ticket !== null) {
    fields.push(field(row.ticket.text), field(row.ticket.url));
  }
  if (row.ticketStatus?.status != null) {
    fields.push(field(row.ticketStatus.status));
  }
  const made: Searchable = Object.freeze({ fields: Object.freeze(fields), id: row.id });
  SEARCHABLE.set(row, made);
  return made;
}

/** Every word is in a field, or (ID_PREFIX_MIN characters or more) starts the id. [] matches.
 *  `words` are searchWords' (lower-cased). */
export function matchesWords(target: Searchable, words: readonly string[]): boolean {
  return words.every(
    (word) =>
      target.fields.some((text) => text.includes(word)) ||
      (word.length >= ID_PREFIX_MIN && target.id.startsWith(word)),
  );
}

/** S2 12.3's open pull requests: every level but merged and closed (open, draft, never fetched,
 *  can't read). */
function hasOpenPr(row: ListRow): boolean {
  return row.prs.some((pr) => pr.level !== 'merged' && pr.level !== 'closed');
}

/** E4: every chip set holds. `open`: the row is in Open (build.ts knows it: running, or
 *  starting in a terminal of the window). F35: `done`, the row is marked done (running or not).
 *  [] matches. */
export function matchesChips(row: ListRow, open: boolean, chips: readonly SearchChip[]): boolean {
  return chips.every((chip) => {
    switch (chip) {
      case 'running':
        return open;
      case 'open-pr':
        return hasOpenPr(row);
      case 'note':
        return row.hasNote;
      case 'done':
        return row.done;
    }
  });
}

/** E5: a word or a chip (F35: `done` too). Only a word makes the list flat (build.ts). */
export function isFiltering(words: readonly string[], chips: readonly SearchChip[]): boolean {
  return words.length > 0 || chips.length > 0;
}

/** E9: where the words are in `text` (a title as the row carries it): [start, end) in UTF-16
 *  units of text, every occurrence of each word, overlapping or touching ones merged, in order,
 *  the first MAX_FOUND; only in the first FIELD_UNITS units; [] when text.toLowerCase() has
 *  another length than text, or for no word. `words` are searchWords' (lower-cased). */
export function foundIn(text: string, words: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) {
    return [];
  }
  const searched = head(lower, FIELD_UNITS);
  // The occurrences of all words in the order of their start, merged as they come. A word's next
  // occurrence is looked for only where it could reach past the range being merged (one that
  // ends inside it changes nothing), and the walk stops at the MAX_FOUND-th range: a title full
  // of matches costs one pass per word.
  const cursors = words
    .filter((word) => word !== '')
    .map((word) => ({ word, at: searched.indexOf(word) }));
  const found: [number, number][] = [];
  let range: [number, number] | null = null;
  for (;;) {
    let first: { word: string; at: number } | null = null;
    for (const cursor of cursors) {
      if (cursor.at >= 0 && (first === null || cursor.at < first.at)) {
        first = cursor;
      }
    }
    if (first === null) {
      break;
    }
    const start = first.at;
    const end = start + first.word.length;
    if (range !== null && start <= range[1]) {
      range[1] = Math.max(range[1], end);
    } else {
      if (range !== null) {
        found.push(range);
        if (found.length === MAX_FOUND) {
          return found;
        }
      }
      range = [start, end];
    }
    first.at = searched.indexOf(first.word, Math.max(start + 1, range[1] - first.word.length + 1));
  }
  if (range !== null) {
    found.push(range);
  }
  return found;
}
