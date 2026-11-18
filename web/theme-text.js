// The title bar's theme switch (follow-up F13; S2 12.1): its three states, the stored value each
// stands for, the order a click walks them in, and what the button says. Pure: no DOM, so that
// node:test and the root type check load it (test/web/theme.test.ts). web/theme.js applies the
// states; web/theme-early.js, a classic script, reads the stored value before the first paint by
// the same rule (the unit test holds the two readings equal).

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

/**
 * The state a click goes to: Auto → Light → Dark → Auto.
 * @param {Theme} theme
 * @returns {Theme}
 */
export function nextTheme(theme) {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

/** @type {Readonly<Record<Theme, string>>} */
const WORDS = { system: 'Auto', light: 'Light', dark: 'Dark' };

/** @type {Readonly<Record<Theme, string>>} */
const TITLES = {
  system: 'Theme: follows the system. Click for light.',
  light: 'Theme: light. Click for dark.',
  dark: 'Theme: dark. Click to follow the system.',
};

/**
 * The button's word.
 * @param {Theme} theme
 * @returns {string}
 */
export function themeWord(theme) {
  return WORDS[theme];
}

/**
 * The button's hover title: the state, and what a click does.
 * @param {Theme} theme
 * @returns {string}
 */
export function themeTitle(theme) {
  return TITLES[theme];
}
