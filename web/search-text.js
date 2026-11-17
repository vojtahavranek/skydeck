// The page's texts of search (S2 12.2, 12.8; plan task 93, E3, E7, E9; F9): the cut of a search
// text after its 16th word, a closed block caption's ` · 1 needs you` and the pane's group card, a
// title's parts with the words found in it, the switcher's headings and its footer. web/list.js,
// web/cards.js and web/switcher.js draw them. Pure: no DOM, no clock, nothing logged, so that
// node:test and the root type check load it (test/web/search-text.test.ts).
//
// A search text and a title are foreign text: they are cut and split by one literal pattern and
// sliced, never made into a pattern, and handed on as text, never as markup (plan 2.1). Where this
// module cuts a search text it cuts as the server reads it (src/window/view/search/filter.ts,
// `searchWords`), so that the page and the server never disagree about the words; the test runs
// both over the same texts.

import { sanitize } from './list-text.js';

/** E3: the server searches the first 16 words of a search text (filter.ts's MAX_WORDS). */
export const MAX_WORDS = 16;

/**
 * E3: `text` up to the end of its MAX_WORDS-th word, split as the server splits (/\s+/u: a word
 * is a run of anything else, a zero-width space or a control character too); `cut` when a word
 * came after it. A text with no more words is kept as typed, white space at its end too. A word
 * is never cut: the server counts its first 64 units itself, after lower-casing. So
 * searchWords(cutWords(t).text) equals searchWords(t), and the result is a prefix of `text`
 * (within the byte limit that `text` was within).
 * @param {string} text
 * @returns {{ text: string, cut: boolean }}
 */
export function cutWords(text) {
  let count = 0;
  let end = 0;
  for (const word of text.matchAll(/\S+/gu)) {
    count += 1;
    if (count > MAX_WORDS) {
      return { text: text.slice(0, end), cut: true };
    }
    end = word.index + word[0].length;
  }
  return { text, cut: false };
}

/**
 * G5 (ruled 2026-11-16), F9: what a closed block's caption adds when sessions it hides need you —
 * ` · 1 needs you`, ` · 2 need you` (the server's `needYou` of the caption, taken from the same
 * fact as a row's own mark: every session of a closed block is hidden, its first too); '' for
 * none. Drawn in the needs-you colour.
 * @param {number} count the caption's `needYou`
 * @returns {string}
 */
export function captionNeedText(count) {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    return '';
  }
  return ` · ${count} ${count === 1 ? 'needs' : 'need'} you`;
}

/**
 * F9: the pane's small card while a closed block's caption is selected: the group's name
 * (sanitised, as list-text.js's `sanitize` shows foreign text), the number of its sessions, the
 * caption's ` · 1 needs you` part ('' for none), and what opens it.
 * @param {string} group
 * @param {number} size
 * @param {number} needYou
 * @returns {{ title: string, count: string, need: string, hint: string }}
 */
export function groupCardText(group, size, needYou) {
  const count = Number.isInteger(size) && size >= 0 ? size : 0;
  return {
    title: sanitize(group),
    count: `${count} ${count === 1 ? 'session' : 'sessions'}`,
    need: captionNeedText(needYou),
    hint: '→ or Enter opens the group',
  };
}

/**
 * @typedef {object} HighlightPart
 * @property {string} text a piece of the title, to be set as `textContent`
 * @property {boolean} found the piece is a word found (drawn in a `mark` element)
 */

/** @param {number} code */
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
/** @param {number} code */
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Whether `at` lies between the two halves of a surrogate pair of `text`.
 * @param {string} text
 * @param {number} at
 */
function insidePair(text, at) {
  return (
    at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))
  );
}

/**
 * Appends a piece, joined to the last part when that one is marked alike; an empty piece is none.
 * @param {HighlightPart[]} parts
 * @param {string} text
 * @param {boolean} found
 */
function append(parts, text, found) {
  if (text === '') {
    return;
  }
  const last = parts.at(-1);
  if (last !== undefined && last.found === found) {
    last.text += text;
  } else {
    parts.push({ text, found });
  }
}

/**
 * E9: the parts of `text` with `found`'s ranges ([start, end) in UTF-16 units, as the server's
 * `foundIn` gives them) marked, in order. A wrong range marks less, never more: the ranges are
 * taken in their order, each clamped to the text and to start where the last one ended, its ends
 * moved off the middle of a surrogate pair (inwards); one that is then empty, or that is not a
 * pair of whole numbers, is dropped. Neighbouring parts marked alike are one part and no part is
 * empty, so that the parts always join to `text` ([] for an empty text). `text` must be the string
 * the ranges were found in: the row's title as the server sent it (plan 2.2: `foundIn(row.title,
 * words)`), not list-text.js's `rowText` title (its ticket key taken off) nor a sanitised copy.
 * @param {string} text
 * @param {readonly (readonly [number, number])[]} found
 * @returns {HighlightPart[]}
 */
export function highlightParts(text, found) {
  /** @type {HighlightPart[]} */
  const parts = [];
  let at = 0;
  for (const range of Array.isArray(found) ? found : []) {
    if (!Array.isArray(range) || range.length !== 2) {
      continue;
    }
    const [from, to] = range;
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      continue;
    }
    let start = Math.max(from, at);
    let end = Math.min(to, text.length);
    if (insidePair(text, start)) {
      start += 1;
    }
    if (insidePair(text, end)) {
      end -= 1;
    }
    if (start >= end) {
      continue;
    }
    append(parts, text.slice(at, start), false);
    append(parts, text.slice(start, end), true);
    at = end;
  }
  append(parts, text.slice(at), false);
  return parts;
}

/** E9: the switcher's ranks in words. */
const RANK_HEADINGS = new Map([
  ['need', 'Needs you'],
  ['open', 'Open'],
  ['not-running', 'Not running'],
  ['done', 'Done'],
]);

/**
 * E9: the heading over a rank's items: `Needs you`, `Open`, `Not running`, `Done`. A rank it does
 * not know shows its own name, sanitised and trimmed (as list-text.js shows a section's); anything
 * that is not a string, nothing.
 * @param {string} rank `need`, `open`, `not-running` or `done`
 * @returns {string}
 */
export function rankHeading(rank) {
  if (typeof rank !== 'string') {
    return '';
  }
  return RANK_HEADINGS.get(rank) ?? sanitize(rank).trim();
}

/**
 * The switcher's footer: `↑ ↓ move · Enter switch · Esc close`, then ` · 3 more: type to narrow`
 * when items were left out.
 * @param {'switch' | 'resume here' | 'restore'} action what Enter does on the highlighted item
 * @param {number} more how many matching sessions were left out (`list.switcher.more`)
 * @returns {string}
 */
export function switcherFooter(action, more) {
  const keys = `↑ ↓ move · Enter ${action} · Esc close`;
  return more > 0 ? `${keys} · ${more} more: type to narrow` : keys;
}
