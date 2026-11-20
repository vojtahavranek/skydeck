// Follow-up F30: the dialog "Mark done" for a session that runs in a terminal of the window and
// can be ended there (web/end-text.js `asksFirst`), shown over the list and the terminal in the
// manner of stage D's dialogs (web/edit.js, edit.css): a scrim over the window, the dialog above it,
// modal (app.js makes the page inert under it, D2). Its heading names the session, cut with `…`,
// whole in its tooltip; a line says it still runs, and while it is working a warning says that
// ending it stops the turn. Three buttons: `End session and mark done` (the primary one), `Mark
// done, keep it running`, `Cancel`.
//
// It decides nothing about the session: a press tells app.js which (`deps.chose`), with the session
// and the terminal it was opened for — never the selection's, which may move behind it. Keys come
// from app.js's capture phase (`key`): Esc is Cancel; Tab and Shift+Tab, and Right and Left, walk
// the three buttons and stay inside; Enter or Space press the button that has the keyboard, at a
// fresh press only — an auto-repeated one presses nothing (and neither does a key held since before
// it opened). The keyboard always starts on `Mark done, keep it running` (ruled: a word typed into
// the list by mistake, a `d` and then Enter or Space, must never end a session); it comes to the End
// button only by the user's own Tab, Shift+Tab, arrow or click. When the session turns working while
// the dialog is shown, a keyboard on the End button moves back to the second button; nothing moves
// it by itself towards the End button. At every list
// (`update`) the dialog follows its own session: one that stopped, was marked done in another
// window or left the list closes it, nothing done, and `deps.gone` gets the toast's words. Every
// text reaches the DOM as text.

/** @import { ListMessage, RowPayload } from '../src/window/protocol.ts' */
import { cutTitle, dialogFollows, END_TEXTS } from './end-text.js';
import { sessionRow } from './pane.js';

/**
 * @typedef {'end' | 'keep' | 'cancel'} EndChoice
 * @typedef {object} EndDialogDeps
 * @property {(choice: 'end' | 'keep', session: { sessionId: string, term: string, fromList: boolean }) => void} chose
 *   a press of the End or the Keep button, after the dialog closed
 * @property {(text: string) => void} gone the dialog closed by itself; the toast's words
 * @property {(choice: EndChoice | 'gone') => void} closed called once whenever the dialog closes
 */

/**
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function button(className, text) {
  const made = document.createElement('button');
  made.type = 'button';
  made.className = className;
  made.textContent = text;
  // A click acts without moving the keyboard first (D17): the keyboard stays on its button.
  made.addEventListener('mousedown', (event) => event.preventDefault());
  return made;
}

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/** The keys that press a button. */
const PRESS_KEYS = new Set(['Enter', ' ']);

/**
 * @param {HTMLElement} root  #end-dialog
 * @param {EndDialogDeps} deps
 */
export function createEndDialog(root, deps) {
  const scrim = element('div', 'edit-scrim');
  const box = element('div', 'edit-dialog end-dialog');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'end-dialog-heading');
  box.setAttribute('aria-describedby', 'end-dialog-text');
  const heading = element('div', 'edit-heading end-heading');
  heading.id = 'end-dialog-heading';
  const prefix = element('span', 'end-prefix', END_TEXTS.heading);
  // The title isolated from the words around it, so that a right-to-left title keeps its order.
  const title = element('bdi', 'end-title');
  heading.append(prefix, title);
  const text = element('div', 'end-text');
  text.id = 'end-dialog-text';
  // The warning that comes while the dialog is shown (the session turned working) is announced.
  text.setAttribute('aria-live', 'polite');
  const line = element('div', 'end-line', END_TEXTS.running);
  const warning = element('div', 'end-warning', END_TEXTS.working);
  text.append(line, warning);
  const endButton = button('end-end', END_TEXTS.end);
  const keepButton = button('end-keep', END_TEXTS.keep);
  const cancelButton = button('end-cancel', END_TEXTS.cancel);
  const buttons = [endButton, keepButton, cancelButton];
  const actions = element('div', 'edit-actions end-actions');
  actions.append(...buttons);
  box.append(heading, text, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  /**
   * The dialog shown: the session and the terminal it was opened for, whether `d` in the list
   * opened it, and whether the session works now.
   * @type {{ sessionId: string, term: string, fromList: boolean, working: boolean } | null}
   */
  let current = null;

  /** @param {boolean} working */
  const setWorking = (working) => {
    if (current === null) {
      return;
    }
    const turned = working && !current.working;
    current.working = working;
    warning.hidden = !working;
    box.dataset['working'] = working ? 'true' : 'false';
    if (turned && document.activeElement === endButton) {
      keepButton.focus(); // never by itself towards the End button: only away from it
    }
  };

  /** @param {RowPayload} row */
  const setTitle = (row) => {
    const shown = cutTitle(row.title);
    if (title.textContent !== shown) {
      title.textContent = shown;
    }
    if (heading.title !== row.title) {
      heading.title = row.title;
    }
  };

  /** @param {EndChoice | 'gone'} choice */
  const close = (choice) => {
    const shown = current;
    if (shown === null) {
      return null;
    }
    current = null;
    // The keyboard leaves the dialog before it is hidden: app.js gives it back.
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    root.hidden = true;
    deps.closed(choice);
    return shown;
  };

  /** @param {EndChoice} choice */
  const press = (choice) => {
    const shown = close(choice);
    if (shown !== null && choice !== 'cancel') {
      deps.chose(choice, {
        sessionId: shown.sessionId,
        term: shown.term,
        fromList: shown.fromList,
      });
    }
  };

  endButton.addEventListener('click', () => press('end'));
  keepButton.addEventListener('click', () => press('keep'));
  cancelButton.addEventListener('click', () => press('cancel'));
  // The scrim and the dialog's text take clicks without moving the keyboard off its button.
  scrim.addEventListener('mousedown', (event) => event.preventDefault());
  box.addEventListener('mousedown', (event) => event.preventDefault());
  // The browser's own press of a focused button (Enter at keypress, Space at keyup) never acts:
  // `key` presses at a fresh keydown only.
  for (const type of ['keypress', 'keyup']) {
    root.addEventListener(type, (event) => {
      const key = /** @type {KeyboardEvent} */ (event);
      if (PRESS_KEYS.has(key.key)) {
        key.preventDefault();
      }
    });
  }

  return {
    /**
     * Opens the dialog for `row`, which runs in its terminal (`row.terminal`); `fromList`: `d` in
     * the list opened it (app.js's selection rule after `d`).
     * @param {RowPayload} row
     * @param {boolean} fromList
     */
    open(row, fromList) {
      if (current !== null || typeof row.terminal !== 'string') {
        return;
      }
      const working = row.state === 'working';
      current = { sessionId: row.id, term: row.terminal, fromList, working };
      box.dataset['session'] = row.id;
      box.dataset['working'] = working ? 'true' : 'false';
      setTitle(row);
      warning.hidden = !working;
      root.hidden = false;
      keepButton.focus(); // never on End by itself (ruled)
    },
    /**
     * Every list while it is shown: closes it when its session stopped, was marked done or left
     * the list (`deps.gone` with the toast's words); else follows the title and the working state.
     * @param {ListMessage} list
     */
    update(list) {
      if (current === null) {
        return;
      }
      const follows = dialogFollows(list, current.sessionId, current.term, sessionRow);
      if ('close' in follows) {
        close('gone');
        deps.gone(follows.close);
        return;
      }
      setTitle(follows.stay);
      setWorking(follows.working);
    },
    /**
     * A keydown while the dialog is shown, from app.js's capture phase: true when the dialog took
     * it (Esc, Tab, ← →, Enter, Space without Ctrl, Alt or Meta), and then nothing else acts on it.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    key(event) {
      if (current === null || event.ctrlKey || event.altKey || event.metaKey) {
        return false;
      }
      if (event.isComposing || event.keyCode === 229) {
        return false; // a key of an IME composition is the IME's
      }
      const isEscape = event.key === 'Escape' && !event.shiftKey;
      const isTab = event.key === 'Tab';
      const isArrow = (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey;
      const isPress = PRESS_KEYS.has(event.key) && !event.shiftKey;
      if (!isEscape && !isTab && !isArrow && !isPress) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      const at = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
      if (at === -1) {
        // Something outside took the keyboard (a click on the toast): it comes back to the safe
        // button, and this key does nothing more — never a press the user did not aim.
        keepButton.focus();
        if (!isEscape || event.repeat) {
          return true;
        }
      }
      if (event.repeat) {
        return true; // a held key presses nothing, and walks nothing
      }
      if (isEscape) {
        press('cancel');
      } else if (isTab || isArrow) {
        // ← and → walk as Shift+Tab and Tab do (ruled): End is one ← from where it starts.
        const back = isTab ? event.shiftKey : event.key === 'ArrowLeft';
        const step = back ? -1 : 1;
        const from = at === -1 ? buttons.indexOf(keepButton) : at;
        buttons[(from + step + buttons.length) % buttons.length]?.focus();
      } else {
        const pressed = buttons[at];
        if (pressed !== undefined) {
          press(pressed === endButton ? 'end' : pressed === keepButton ? 'keep' : 'cancel');
        }
      }
      return true;
    },
    /** @returns {boolean} */
    shown: () => current !== null,
  };
}
