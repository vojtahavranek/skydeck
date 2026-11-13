// The page's key policy (S2 9.1, S2 12.9, A11): which keys are the window's, what the terminal's
// key handler does with the keys it maps, the list keys, and which keys the page cancels.
// Pure: functions of a KeyboardEvent-like object, no DOM, no state. Tested by
// test/web/keys.test.ts on a US and a Czech layout.
//
// Matching (S2 12.9): a letter is matched by the character the key types (`key`), never by the
// physical key, as Claude Code does. A digit is matched by the character typed when that is a
// digit (Shift on a Czech number row types the digits) and otherwise by the physical key
// `Digit1` … `Digit9` (on a US layout Shift+1 types `!`). AltGr arrives as Ctrl+Alt, so no chord
// and no list key has Alt: AltGr characters and dead keys reach xterm.js unchanged.
//
// Some keys are classified by two functions — Ctrl+Shift+V (windowChord `paste-raw`, terminalKey
// `{ send: '\x16' }`), Ctrl+Shift+R and BrowserRefresh (windowChord and listKey `reload`): the
// page acts on such a key once.

/** @typedef {{ key: string, code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }} KeyLike */
/** @typedef {'list' | 'terminal'} Zone */
/**
 * @typedef {{ kind: 'slot', slot: number } | { kind: 'previous' } | { kind: 'toggle-zone' }
 *   | { kind: 'new' } | { kind: 'find' } | { kind: 'copy' } | { kind: 'paste-raw' }
 *   | { kind: 'help' } | { kind: 'reload' } | { kind: 'later', stage: 'B' | 'E' }} WindowChord
 */
/** @typedef {{ send: string } | 'browser' | null} TerminalMapping */
/**
 * @typedef {{ kind: 'move', by: 1 | -1 | 'home' | 'end' | 'page-up' | 'page-down' }
 *   | { kind: 'fold' } | { kind: 'unfold' } | { kind: 'enter' } | { kind: 'filter' }
 *   | { kind: 'show-done' } | { kind: 'escape' } | { kind: 'reload' }
 *   | { kind: 'later', stage: 'D' }} ListAction
 */

/**
 * The window's own chord (S2 12.9, stage A): Ctrl+Shift with a letter or a digit of the table,
 * and Ctrl+Tab. The keys of later stages are the window's from stage A on (A11): Ctrl+Shift+J
 * (B) and Ctrl+Shift+P (E) give `later`. Every chord is the window's in both zones, so the
 * result does not depend on `zone`. Ctrl+Shift+R and the BrowserRefresh key (alone, with Shift,
 * with Ctrl; xterm.js sends nothing for it) are the page's reload in both (S2 12.9, 15.3).
 * @param {KeyLike} e
 * @param {Zone} zone
 * @returns {WindowChord | null}
 */
export function windowChord(e, zone) {
  if (e.key === 'Tab' && hasOnly(e, 'ctrl')) {
    return { kind: 'previous' };
  }
  if (isBrowserRefresh(e)) {
    return { kind: 'reload' };
  }
  if (!hasOnly(e, 'ctrl', 'shift')) {
    return null;
  }
  const typed = lowerKey(e);
  if (typed === '') {
    return null;
  }
  switch (typed) {
    case 'p':
      return { kind: 'later', stage: 'E' };
    case 'j':
      return { kind: 'later', stage: 'B' };
    case 'o':
      return { kind: 'previous' };
    case 'l':
      return { kind: 'toggle-zone' };
    case 'n':
      return { kind: 'new' };
    case 'f':
      return { kind: 'find' };
    case 'c':
      return { kind: 'copy' };
    case 'v':
      return { kind: 'paste-raw' };
    case 'h':
      return { kind: 'help' };
    case 'r':
      return { kind: 'reload' };
  }
  const slot = slotOf(e);
  return slot === null ? null : { kind: 'slot', slot };
}

/**
 * The terminal's mapping (S2 9.1) for its custom key handler: `{ send }` — the page sends these
 * bytes and cancels the key (Shift+Enter → `\n`, Ctrl+Shift+V → `\x16`); `'browser'` — neither
 * send nor cancel (Ctrl+V, which the browser pastes; Alt+F4, which closes the window); null —
 * xterm.js handles the key as it is.
 * @param {KeyLike} e
 * @returns {TerminalMapping}
 */
export function terminalKey(e) {
  if (isAltF4(e)) {
    return 'browser';
  }
  if (e.key === 'Enter' && hasOnly(e, 'shift')) {
    return { send: '\n' };
  }
  if (lowerKey(e) === 'v') {
    if (hasOnly(e, 'ctrl')) {
      return 'browser';
    }
    if (hasOnly(e, 'ctrl', 'shift')) {
      return { send: '\x16' };
    }
  }
  return null;
}

/**
 * The list zone's keys (S2 12.9). A character key (`j`, `k`, `/`, `a`, `l`, …) takes no Ctrl,
 * Alt or Meta; Shift may be held, since it chose the character (`/` is Shift+ú on a Czech
 * layout), and an upper-case letter is another key. A named key (arrows, Home, Enter, Esc, F2 …)
 * takes no modifier. The reload keys are F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R and the
 * BrowserRefresh key alone, with Shift or with Ctrl (S2 12.9, 15.3). The keys of stage D — `l`, `g`, `n`, `p`, `d` and F2 — give `later` (A11).
 * @param {KeyLike} e
 * @returns {ListAction | null}
 */
export function listKey(e) {
  if (isReload(e)) {
    return { kind: 'reload' };
  }
  if (e.ctrlKey || e.altKey || e.metaKey) {
    return null;
  }
  switch (e.key) {
    case 'j':
      return { kind: 'move', by: 1 };
    case 'k':
      return { kind: 'move', by: -1 };
    case '/':
      return { kind: 'filter' };
    case 'a':
      return { kind: 'show-done' };
    case 'l':
    case 'g':
    case 'n':
    case 'p':
    case 'd':
      return { kind: 'later', stage: 'D' };
  }
  if (e.shiftKey) {
    return null;
  }
  switch (e.key) {
    case 'ArrowDown':
      return { kind: 'move', by: 1 };
    case 'ArrowUp':
      return { kind: 'move', by: -1 };
    case 'Home':
      return { kind: 'move', by: 'home' };
    case 'End':
      return { kind: 'move', by: 'end' };
    case 'PageUp':
      return { kind: 'move', by: 'page-up' };
    case 'PageDown':
      return { kind: 'move', by: 'page-down' };
    case 'ArrowLeft':
      return { kind: 'fold' };
    case 'ArrowRight':
      return { kind: 'unfold' };
    case 'Enter':
      return { kind: 'enter' };
    case 'Escape':
      return { kind: 'escape' };
    case 'F2':
      return { kind: 'later', stage: 'D' };
  }
  return null;
}

/**
 * Whether the page cancels the key (preventDefault) — S2 12.9: exactly the keys it handles, and
 * Alt+F4 never.
 * - Never: Alt+F4, in either zone; Ctrl+V in the terminal zone (the browser pastes).
 * - Always, whatever `handled` says: every window chord (`later` ones included, A11) in both
 *   zones; the reload keys in the list zone (so that Edge never reloads the page by itself,
 *   15.3); in the terminal zone the keys the page sends itself (`terminalKey` gives `{ send }`).
 * - Every other key: exactly when `handled` — the page acted on it. That covers the list keys
 *   the page applied (and the `later` list keys, whose message it shows), and keys it used
 *   outside the table (Enter in the find bar). While a text field of the page has the keyboard
 *   (the filter, the new form) the caller passes false for the keys it leaves to the field, so
 *   that `j` or `/` type there. A key xterm.js sends is cancelled by xterm.js, not by the page.
 * - In the terminal zone F5, Shift+F5, Ctrl+F5 and Ctrl+R go to the program only while xterm.js
 *   has the keyboard; while something of the page has it (the find bar, the New form, a card, the
 *   ended bar) the caller takes them as the page's reload (`listKey` gives `reload` in any zone)
 *   and passes `handled = true`.
 * @param {KeyLike} e
 * @param {Zone} zone
 * @param {boolean} handled whether the page acted on the key
 * @returns {boolean}
 */
export function cancels(e, zone, handled) {
  if (isAltF4(e)) {
    return false;
  }
  if (windowChord(e, zone) !== null) {
    return true;
  }
  if (zone === 'list') {
    return isReload(e) || handled;
  }
  const mapped = terminalKey(e);
  if (mapped === 'browser') {
    return false;
  }
  return mapped !== null || handled;
}

/** @typedef {'ctrl' | 'shift' | 'alt' | 'meta'} Modifier */

/**
 * Whether exactly these modifiers are held, and no other.
 * @param {KeyLike} e
 * @param {...Modifier} modifiers
 * @returns {boolean}
 */
function hasOnly(e, ...modifiers) {
  return (
    e.ctrlKey === modifiers.includes('ctrl') &&
    e.shiftKey === modifiers.includes('shift') &&
    e.altKey === modifiers.includes('alt') &&
    e.metaKey === modifiers.includes('meta')
  );
}

/**
 * The character typed, lower-cased; '' for an event without a `key` (Chromium dispatches a
 * keydown without one when an autofill suggestion is picked), which is then no key of any table.
 * @param {KeyLike} e
 * @returns {string}
 */
function lowerKey(e) {
  return typeof e.key === 'string' ? e.key.toLowerCase() : '';
}

/**
 * Alt+F4 closes a window on Windows with or without Shift; Ctrl+Alt+F4 does not.
 * @param {KeyLike} e
 * @returns {boolean}
 */
function isAltF4(e) {
  return e.key === 'F4' && e.altKey && !e.ctrlKey;
}

/**
 * The reload keys of the list zone (S2 12.9, 15.3): every key on which Chromium reloads the page
 * — F5, Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R, and the BrowserRefresh key alone, with Shift or
 * with Ctrl.
 * @param {KeyLike} e
 * @returns {boolean}
 */
function isReload(e) {
  if (e.key === 'F5') {
    return hasOnly(e) || hasOnly(e, 'shift') || hasOnly(e, 'ctrl');
  }
  if (lowerKey(e) === 'r') {
    return hasOnly(e, 'ctrl') || hasOnly(e, 'ctrl', 'shift');
  }
  return isBrowserRefresh(e);
}

/**
 * The keyboard's BrowserRefresh key, alone, with Shift or with Ctrl.
 * @param {KeyLike} e
 * @returns {boolean}
 */
function isBrowserRefresh(e) {
  return e.key === 'BrowserRefresh' && (hasOnly(e) || hasOnly(e, 'shift') || hasOnly(e, 'ctrl'));
}

/**
 * The slot of a Ctrl+Shift+digit chord: the digit typed when the key types one, else the
 * physical key `Digit1` … `Digit9`.
 * @param {KeyLike} e
 * @returns {number | null}
 */
function slotOf(e) {
  if (/^[0-9]$/.test(e.key)) {
    return e.key === '0' ? null : Number(e.key);
  }
  const physical = /^Digit([1-9])$/.exec(e.code);
  return physical === null ? null : Number(physical[1]);
}
