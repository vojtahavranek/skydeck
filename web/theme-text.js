// The window's theme (follow-up F13; S2 12.1), chosen in the settings screen's Appearance (F39,
// S2 12.13): its three modes, the stored value each stands for, and their words. Pure: no DOM, so
// that node:test and the root type check load it (test/web/theme.test.ts). web/theme.js applies
// them; web/theme-early.js, a classic script, reads the stored value before the first paint by the
// same rule (the unit test holds the two readings equal).

/** `system` follows the system's light or dark (today's behaviour); `light` and `dark` force one.
 *  @typedef {'system' | 'light' | 'dark'} Theme */

/** The one key of the page's localStorage: `light` or `dark`; absent while the page follows the
 *  system. */
export const THEME_KEY = 'skydeck-theme';

/**
 * The state a stored value stands for: `light` and `dark` as they are, anything else (none,
 * another word, another case, white space) the system's.
 * @param {unknown} value
 * @returns {Theme}
 */
export function themeOf(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The modes in the order the screen offers them. @type {readonly Theme[]} */
export const MODES = ['system', 'light', 'dark'];

/** @type {Readonly<Record<Theme, string>>} */
const WORDS = { system: 'Auto', light: 'Light', dark: 'Dark' };

/**
 * The mode's word.
 * @param {Theme} theme
 * @returns {string}
 */
export function themeWord(theme) {
  return WORDS[theme];
}

// The colour themes (S2 12.1): each scheme keeps its own choice, as Windows Terminal's light and
// dark colour schemes do, and the screen shows and changes the one of the scheme the page shows
// now. `default` is skydeck's own colours; every other theme is a rule
// of style.css and terminal-view.css on <html data-palette-light> or <html data-palette-dark>.

/** The page's scheme: forced by the mode, else the system's.
 *  @typedef {'light' | 'dark'} Scheme */

/** @typedef {'default' | 'iris' | 'pleiades'} Palette */

/** Each scheme's themes, in the order the screen offers them, the default first.
 *  @type {Readonly<Record<Scheme, readonly Palette[]>>} */
export const PALETTES = { light: ['default', 'iris'], dark: ['default', 'iris', 'pleiades'] };

/** The key of each scheme's choice in the page's localStorage: the theme's name; absent for the
 *  default.
 *  @type {Readonly<Record<Scheme, string>>} */
export const PALETTE_KEYS = { light: 'skydeck-palette-light', dark: 'skydeck-palette-dark' };

/**
 * The theme a stored value stands for in `scheme`: one of its themes but the default as it is,
 * anything else (none, another word, another case, a theme of the other scheme only) the default.
 * @param {Scheme} scheme
 * @param {unknown} value
 * @returns {Palette}
 */
export function paletteOf(scheme, value) {
  return (
    PALETTES[scheme].find((palette) => palette !== 'default' && palette === value) ?? 'default'
  );
}

/** @type {Readonly<Record<Palette, string>>} */
const PALETTE_WORDS = { default: 'Default', iris: 'Iris', pleiades: 'Pleiades' };

/**
 * The theme's name.
 * @param {Palette} palette
 * @returns {string}
 */
export function paletteWord(palette) {
  return PALETTE_WORDS[palette];
}
