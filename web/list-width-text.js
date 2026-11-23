// The list's width (issue #192; S2 12.1): the bounds a width keeps, the one key of the page's
// localStorage, the rule of a stored value, and the words of the handle between the list and the
// right side. Pure: no DOM, so that node:test and the root type check load it
// (test/web/list-width.test.ts). web/list-width.js applies them; web/list-width-early.js, a
// classic script, reads the stored value before the first paint by the same rule (the unit test
// holds the two readings equal), and style.css's `.main` holds the shown width to the window with
// the same numbers (the unit test holds them equal too).

/** The list's width while none is stored: today's layout, whatever the window's width. */
export const DEFAULT_WIDTH = 400;
/** The narrowest and the widest width, in px. */
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 800;
/** While a width is stored, the right side keeps at least this many px of the window. */
export const RIGHT_ROOM = 320;

/** The one key of the page's localStorage: the width in px, a decimal whole number; absent while
 *  the list has its default width. */
export const LIST_WIDTH_KEY = 'skydeck-list-width';

/**
 * The width a stored value stands for: a whole number (an optional `-` and decimal digits, nothing
 * else) held to MIN_WIDTH … MAX_WIDTH; anything else (none, a fraction, a word, white space, an
 * exponent) null, as if nothing were stored.
 * @param {unknown} value
 * @returns {number | null}
 */
export function widthOf(value) {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) {
    return null;
  }
  return held(Number(value));
}

/**
 * `width` rounded to a whole px and held to MIN_WIDTH … MAX_WIDTH.
 * @param {number} width
 * @returns {number}
 */
export function held(width) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/**
 * The width shown for `width` in a window `windowWidth` px wide: at most the window less
 * RIGHT_ROOM, never under MIN_WIDTH (what style.css's `.main` computes).
 * @param {number} width
 * @param {number} windowWidth
 * @returns {number}
 */
export function shownWidth(width, windowWidth) {
  return Math.max(MIN_WIDTH, Math.min(width, windowWidth - RIGHT_ROOM));
}

/** The handle's tooltip. */
export const HANDLE_TITLE = `Drag to change the width of the list. Double-click: back to ${DEFAULT_WIDTH} px.`;
