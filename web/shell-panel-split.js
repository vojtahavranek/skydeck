// A session's shell (issue #199; S2 12.6): the rules of the split between the session's terminal
// and its shell's panel, pure (no DOM), so that node:test and the root type check load them
// (test/web/shell-panel-split.test.ts). web/shell-panel.js measures the terminal area and applies
// them; the numbers have this one place.
//
// The terminal area is the right zone's box less the cards (`area` px high). Each of the two keeps
// room for at least MIN_ROWS rows (`least`, the shells' view's `heightFor(MIN_ROWS)`); the bar
// between them is BAR_PX high. In an area too low for both and the bar the shell takes the whole
// area; else the shell is the stored height (a third of the area while none is stored), held to
// its bounds, and the session's terminal the rest.

export { atPress, dragBegun } from './list-width-text.js';

/** Each of the two keeps room for at least this many rows. */
export const MIN_ROWS = 4;
/** The bar's height, in CSS px (web/shell-panel.css has the same number). */
export const BAR_PX = 6;
/** The px of MIN_ROWS rows while no cell can be measured: 4 rows of 17 px and 16 px of room. */
export const LEAST_FALLBACK = 84;
/** The largest stored height that counts, in px. */
export const MAX_STORED = 100_000;

/** The one key of the page's localStorage: the shell's height in px, a decimal whole number;
 *  absent while the shell has its default third. */
export const SHELL_HEIGHT_KEY = 'skydeck-shell-height';

/** The bar's tooltip. */
export const BAR_TITLE = 'Drag to change the height of the shell. Double-click: back to a third.';

/**
 * The height a stored value stands for: a whole number of 1 to MAX_STORED as decimal digits
 * (nothing else: no sign, no fraction, no white space, no exponent), else null, as if nothing
 * were stored.
 * @param {unknown} value
 * @returns {number | null}
 */
export function heightOf(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return null;
  }
  const height = Number(value);
  return height >= 1 && height <= MAX_STORED ? height : null;
}

/**
 * The split of a terminal area `area` px high, with the stored height `stored` (null: none) and
 * `least` px for MIN_ROWS rows: `full` (the shell over the whole area, no bar, no session's
 * terminal) when the area is lower than twice `least` and the bar, else `split` with the shell's
 * height in px — the stored one, or a third of the area rounded, held to `least` … `area` less the
 * bar and `least`.
 * @param {number} area
 * @param {number | null} stored
 * @param {number} least
 * @returns {{ mode: 'full' } | { mode: 'split', shell: number }}
 */
export function layoutOf(area, stored, least) {
  if (!(area >= 2 * least + BAR_PX)) {
    return { mode: 'full' };
  }
  const wanted = stored ?? Math.round(area / 3);
  return { mode: 'split', shell: Math.max(least, Math.min(area - BAR_PX - least, wanted)) };
}

/**
 * The shell's height while the bar is dragged: the height at the press, `pressHeight`, and as much
 * more as the pointer went up from the press's y (`pressY`) to `y` (the bounds are layoutOf's).
 * @param {number} pressHeight
 * @param {number} pressY
 * @param {number} y
 * @returns {number}
 */
export function draggedHeight(pressHeight, pressY, y) {
  return pressHeight + (pressY - y);
}
