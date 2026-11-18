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

/** @import { Theme } from './theme-text.js' */
import { nextTheme, THEME_KEY, themeOf, themeTitle, themeWord } from './theme-text.js';

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
