// The title bar's theme switch (follow-up F13; S2 12.1): `◐ Auto`, `◐ Light` or `◐ Dark`; a click
// goes to the next state (web/theme-text.js), puts it on <html data-theme> — which the style
// sheets read (style.css says how) — and keeps it in the page's localStorage, one key, which
// web/theme-early.js reads before the next load's first paint. Another window of the profile
// follows a change at once (the `storage` event). Storage that throws or is missing changes
// nothing but the memory: the switch works for the life of the page. Nothing of it goes to the
// server but the colours (`changed`, app.js).
//
// The button takes no keyboard on a click (the title bar's mousedown is cancelled, app.js), so the
// keyboard stays where it was, as after `Switch…`.

/** @import { Palette, Scheme, Theme } from './theme-text.js' */
import {
  nextPalette,
  nextTheme,
  PALETTE_KEYS,
  paletteOf,
  PALETTES,
  paletteTitle,
  paletteWord,
  THEME_KEY,
  themeOf,
  themeTitle,
  themeWord,
} from './theme-text.js';

/** @type {readonly Theme[]} */
const THEMES = ['system', 'light', 'dark'];

/** The stored state; the system's when storage throws or is missing. @returns {Theme} */
function readStored() {
  try {
    return themeOf(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Keeps `theme`: its value, or no key for the system's. Storage that refuses keeps nothing. @param {Theme} theme */
function store(theme) {
  try {
    if (theme === 'system') {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, theme);
    }
  } catch {
    // The choice holds for the life of the page.
  }
}

/**
 * @param {HTMLButtonElement} button  #theme-button (index.html's title bar), with its `.theme-word`
 * @param {{ changed(): void }} deps  `changed` once the page's colours may have changed: after a
 *   click, after another window's change, and after a change of the system's scheme while the page
 *   follows it
 */
export function createThemeSwitch(button, deps) {
  const root = document.documentElement;
  const word = /** @type {HTMLElement} */ (button.querySelector('.theme-word'));
  // The widest of the three words is the word's room, so that a click moves nothing in the title
  // bar (measured once, in the page's own font).
  let widest = 0;
  for (const theme of THEMES) {
    word.textContent = themeWord(theme);
    widest = Math.max(widest, word.getBoundingClientRect().width);
  }
  word.style.minWidth = `${Math.ceil(widest)}px`;

  /** @type {Theme} */
  let current = 'system';
  /** @param {Theme} theme */
  const apply = (theme) => {
    current = theme;
    if (theme === 'system') {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = theme;
    }
    word.textContent = themeWord(theme);
    button.title = themeTitle(theme);
  };
  // web/theme-early.js applied the stored choice before the first paint; read again, so that a
  // change another window made since is not missed.
  apply(readStored());

  // A held key acts once, as everywhere in the page (S2 12.9): the repeats of a held Enter, which
  // would each press the button, do nothing (a held Space presses it once, at its release); a held
  // Tab walks on, as it does over the banner's controls.
  button.addEventListener('keydown', (event) => {
    if (event.repeat && event.key === 'Enter') {
      event.preventDefault();
    }
  });
  button.addEventListener('click', () => {
    const next = nextTheme(current);
    apply(next);
    store(next);
    deps.changed();
  });
  addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== THEME_KEY) {
      return;
    }
    const stored = readStored();
    if (stored !== current) {
      apply(stored);
      deps.changed();
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current === 'system') {
      deps.changed();
    }
  });
}

// The title bar's second switch, the colour themes (S2 12.1): `✦ Default`, `✦ Iris`, …; it shows
// and a click changes the theme of the scheme the page shows now (web/theme-text.js PALETTES),
// so that light and dark each keep their own, as Windows Terminal's colour schemes do. Each is put
// on <html data-palette-light> or <html data-palette-dark> (none for the default), which the style
// sheets read, and kept in the page's localStorage under its scheme's key (PALETTE_KEYS), which
// web/theme-early.js reads before the next load's first paint. Another window of the profile
// follows a change at once; storage that throws or is missing keeps the choice for the life of the
// page, as the theme switch does.

/** @type {readonly Scheme[]} */
const SCHEMES = ['light', 'dark'];

/** The dataset name of each scheme's attribute. @type {Readonly<Record<Scheme, string>>} */
const PALETTE_ATTRIBUTES = { light: 'paletteLight', dark: 'paletteDark' };

/** The scheme the page shows: the theme switch's forced one, else the system's. @returns {Scheme} */
function shownScheme() {
  const forced = document.documentElement.dataset['theme'];
  if (forced === 'light' || forced === 'dark') {
    return forced;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The stored theme of `scheme`; the default when storage throws or is missing.
 *  @param {Scheme} scheme
 *  @returns {Palette} */
function readPalette(scheme) {
  try {
    return paletteOf(scheme, localStorage.getItem(PALETTE_KEYS[scheme]));
  } catch {
    return 'default';
  }
}

/** Keeps `palette` for `scheme`: its name, or no key for the default. Storage that refuses keeps
 *  nothing.
 *  @param {Scheme} scheme
 *  @param {Palette} palette */
function storePalette(scheme, palette) {
  try {
    if (palette === 'default') {
      localStorage.removeItem(PALETTE_KEYS[scheme]);
    } else {
      localStorage.setItem(PALETTE_KEYS[scheme], palette);
    }
  } catch {
    // The choice holds for the life of the page.
  }
}

/**
 * @param {HTMLButtonElement} button  #palette-button (index.html's title bar), with its `.theme-word`
 * @param {{ changed(): void }} deps  `changed` once the page's colours may have changed: after a
 *   click, and after another window's change of the theme of the scheme the page shows
 */
export function createPaletteSwitch(button, deps) {
  const root = document.documentElement;
  const word = /** @type {HTMLElement} */ (button.querySelector('.theme-word'));
  // The widest of the words is the word's room, so that a click moves nothing in the title bar.
  let widest = 0;
  for (const palette of new Set(SCHEMES.flatMap((scheme) => PALETTES[scheme]))) {
    word.textContent = paletteWord(palette);
    widest = Math.max(widest, word.getBoundingClientRect().width);
  }
  word.style.minWidth = `${Math.ceil(widest)}px`;

  /** @type {Record<Scheme, Palette>} */
  const current = { light: 'default', dark: 'default' };
  /** @param {Scheme} scheme @param {Palette} palette */
  const apply = (scheme, palette) => {
    current[scheme] = palette;
    const name = PALETTE_ATTRIBUTES[scheme];
    if (palette === 'default') {
      delete root.dataset[name];
    } else {
      root.dataset[name] = palette;
    }
  };
  const show = () => {
    const scheme = shownScheme();
    word.textContent = paletteWord(current[scheme]);
    button.title = paletteTitle(scheme, current[scheme]);
  };
  // web/theme-early.js applied the stored choices before the first paint; read again, so that a
  // change another window made since is not missed.
  for (const scheme of SCHEMES) {
    apply(scheme, readPalette(scheme));
  }
  show();

  // A held Enter acts once, as on the theme switch.
  button.addEventListener('keydown', (event) => {
    if (event.repeat && event.key === 'Enter') {
      event.preventDefault();
    }
  });
  button.addEventListener('click', () => {
    const scheme = shownScheme();
    const next = nextPalette(scheme, current[scheme]);
    apply(scheme, next);
    storePalette(scheme, next);
    show();
    deps.changed();
  });
  addEventListener('storage', (event) => {
    if (event.key !== null && !SCHEMES.some((scheme) => PALETTE_KEYS[scheme] === event.key)) {
      return;
    }
    let shownChanged = false;
    for (const scheme of SCHEMES) {
      const stored = readPalette(scheme);
      if (stored !== current[scheme]) {
        apply(scheme, stored);
        shownChanged ||= scheme === shownScheme();
      }
    }
    show();
    if (shownChanged) {
      deps.changed();
    }
  });
  // The scheme shown changes with the theme switch and with the system's: the word follows it.
  new MutationObserver(show).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show);
}
