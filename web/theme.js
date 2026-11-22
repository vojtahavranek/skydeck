// The window's theme (follow-up F13; S2 12.1), chosen in the settings screen's Appearance (F39,
// S2 12.13): its mode — Auto, Light or Dark — and, for each scheme, its colour theme. A choice is
// put on <html> at once — `data-theme` (none for Auto), `data-palette-light`, `data-palette-dark`
// (none for the default) —, which the style sheets read (style.css says how), and kept in the
// page's localStorage under the keys of web/theme-text.js, which web/theme-early.js reads before
// the next load's first paint. Another window of the profile follows a change at once (the
// `storage` event), and while the mode is Auto the page follows the system's scheme. Storage that
// throws or is missing changes nothing but the memory: a choice holds for the life of the page.
// Nothing of it goes to the server but the colours (`changed`, app.js).
//
// The colour theme shown and changed is the one of the scheme the page shows now (`scheme()`),
// so that light and dark each keep their own, as Windows Terminal's colour schemes do.

/** @import { Palette, Scheme, Theme } from './theme-text.js' */
import { PALETTE_KEYS, paletteOf, PALETTES, THEME_KEY, themeOf } from './theme-text.js';

/** @type {readonly Scheme[]} */
const SCHEMES = ['light', 'dark'];

/** The dataset name of each scheme's attribute. @type {Readonly<Record<Scheme, string>>} */
const PALETTE_ATTRIBUTES = { light: 'paletteLight', dark: 'paletteDark' };

/** @param {string} key @returns {string | null} the stored value; null when storage throws */
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`, or no key for null. Storage that refuses keeps nothing.
 *  @param {string} key @param {string | null} value */
function write(key, value) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // The choice holds for the life of the page.
  }
}

/**
 * The theme: what the page shows and keeps, and what the settings screen changes.
 * @typedef {object} ThemeState
 * @property {() => Theme} mode
 * @property {(theme: Theme) => void} setMode
 * @property {() => Scheme} scheme  the scheme the page shows: the mode's forced one, else the system's
 * @property {() => Palette} palette  the colour theme of the shown scheme
 * @property {() => readonly Palette[]} palettes  the shown scheme's colour themes, the default first
 * @property {(palette: Palette) => void} setPalette  of the shown scheme
 * @property {(listener: () => void) => void} watch  `listener` runs after every change of what the
 *   four readers answer: a choice here, another window's, a change of the system's scheme
 */

/**
 * @param {{ changed(): void }} deps  `changed` once the page's colours may have changed: after a
 *   choice, after another window's change, and after a change of the system's scheme while the
 *   page follows it
 * @returns {ThemeState}
 */
export function createTheme(deps) {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const shown = () => {
    for (const listener of listeners) listener();
  };

  /** @type {Theme} */
  let mode = 'system';
  /** @type {Record<Scheme, Palette>} */
  const palettes = { light: 'default', dark: 'default' };

  /** @param {Theme} theme */
  const applyMode = (theme) => {
    mode = theme;
    if (theme === 'system') {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = theme;
    }
  };
  /** @param {Scheme} scheme @param {Palette} palette */
  const applyPalette = (scheme, palette) => {
    palettes[scheme] = palette;
    const name = PALETTE_ATTRIBUTES[scheme];
    if (palette === 'default') {
      delete root.dataset[name];
    } else {
      root.dataset[name] = palette;
    }
  };
  /** @returns {Scheme} */
  const scheme = () => (mode === 'system' ? (dark.matches ? 'dark' : 'light') : mode);

  // web/theme-early.js applied the stored choices before the first paint; read again, so that a
  // change another window made since is not missed.
  applyMode(themeOf(read(THEME_KEY)));
  for (const one of SCHEMES) {
    applyPalette(one, paletteOf(one, read(PALETTE_KEYS[one])));
  }

  addEventListener('storage', (event) => {
    const key = event.key;
    if (key !== null && key !== THEME_KEY && !SCHEMES.some((one) => PALETTE_KEYS[one] === key)) {
      return;
    }
    const before = { scheme: scheme(), palette: palettes[scheme()], mode };
    applyMode(themeOf(read(THEME_KEY)));
    for (const one of SCHEMES) {
      applyPalette(one, paletteOf(one, read(PALETTE_KEYS[one])));
    }
    // A change of the mode tells the server even when the scheme stays (Auto under a dark system
    // and Dark), as a choice here does; a change of the other scheme's colour theme does not.
    const now = scheme();
    if (now !== before.scheme || palettes[now] !== before.palette || mode !== before.mode) {
      deps.changed();
      shown();
    }
  });
  dark.addEventListener('change', () => {
    if (mode === 'system') {
      deps.changed();
      shown();
    }
  });

  return {
    mode: () => mode,
    setMode(theme) {
      applyMode(theme);
      write(THEME_KEY, theme === 'system' ? null : theme);
      deps.changed();
      shown();
    },
    scheme,
    palette: () => palettes[scheme()],
    palettes: () => PALETTES[scheme()],
    setPalette(palette) {
      const now = scheme();
      if (!PALETTES[now].includes(palette)) {
        return;
      }
      applyPalette(now, palette);
      write(PALETTE_KEYS[now], palette === 'default' ? null : palette);
      deps.changed();
      shown();
    },
    watch(listener) {
      listeners.add(listener);
    },
  };
}
