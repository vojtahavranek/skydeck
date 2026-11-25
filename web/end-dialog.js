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
//
// Follow-up F44 (S2 12.15): the same dialog asks for `w` and the header's `Park` (`open` with the
// mark `park`), with the words of a parking (web/end-text.js `PARK_TEXTS`: `Park: <title>`, `End
// session and park`, `Park, keep it running`, `Cancel`) and the same rules, but two. The keyboard
// starts on `End session and park` only when skydeck knows the session is idle (`parkPhase`), else
// on `Park, keep it running`, and the warning line says why (working, asking, cannot tell); a change
// away from idle while it is shown moves a keyboard on End to Keep, nothing moves it towards End
// (the owner's choice, ruled on review 1). And a typed character (ruled on review 1, in the manner
// of the restart dialog): on the button where the dialog itself put the keyboard (End or Keep) only
// a fresh Enter presses it, Space there counts as typed; an auto-repeat is never typed (a held `w`
// does nothing); once a key that types a character came while it asks, the keyboard is on
// `Cancel` until it closes (Tab and the arrows move nothing, Enter and Space cancel, a click still
// presses); after the user's own Tab or arrow, with nothing typed, Enter and Space press as for
// Done. So a word typed into the list by mistake never ends a session: only `w` directly followed
// by Enter does. It follows its session as for Done, and also closes when the session is parked
// elsewhere.

/** @import { ListMessage, RowPayload } from '../src/window/protocol.ts' */
import { cutTitle, dialogFollows, END_TEXTS, parkPhase, parkWarning, textsOf } from './end-text.js';
import { typesCharacter } from './keys.js';
import { sessionRow } from './pane.js';

/**
 * @typedef {'end' | 'keep' | 'cancel'} EndChoice
 * @typedef {import('./end-text.js').DialogMark} DialogMark
 * @typedef {object} EndDialogDeps
 * @property {(choice: 'end' | 'keep', session: { sessionId: string, term: string, fromList: boolean, mark: DialogMark }) => void} chose
 *   a press of the End or the Keep button, after the dialog closed; `mark` says which dialog
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
   * The dialog shown: the session and the terminal it was opened for, whether `d` (or `w`) in the
   * list opened it, its mark, whether the session works now and whether it is marked done now;
   * for the dialog "Park" its phase (`parkPhase`), whether a key that types a character came
   * (`typed`) and whether the user moved the keyboard with Tab or an arrow (`moved`).
   * @type {{ sessionId: string, term: string, fromList: boolean, mark: DialogMark, working: boolean, done: boolean, phase: import('./end-text.js').ParkPhase, typed: boolean, moved: boolean } | null}
   */
  let current = null;

  /**
   * The session's state at a list: the warning line, and a keyboard on End moved to the second
   * button when the session turned working (Done's), or for Park left idle or changed to another
   * phase that is not idle. Never by itself towards the End button: only away from it.
   * @param {RowPayload} row
   */
  const setState = (row) => {
    if (current === null) {
      return;
    }
    const working = row.state === 'working';
    let away = working && !current.working;
    current.working = working;
    box.dataset['working'] = working ? 'true' : 'false';
    if (current.mark === 'park') {
      const phase = parkPhase(row);
      away = phase !== 'idle' && phase !== current.phase;
      current.phase = phase;
      box.dataset['phase'] = phase;
      const words = parkWarning(phase);
      warning.hidden = words === null;
      if (words !== null && warning.textContent !== words) {
        warning.textContent = words;
      }
    } else {
      warning.hidden = !working;
    }
    if (away && document.activeElement === endButton && !current.typed) {
      keepButton.focus();
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
        mark: shown.mark,
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
     * Opens the dialog of `mark` (Done's by default) for `row`, which runs in its terminal
     * (`row.terminal`); `fromList`: `d` (or `w`) in the list opened it (app.js's selection rule).
     * @param {RowPayload} row
     * @param {boolean} fromList
     * @param {DialogMark} [mark]
     */
    open(row, fromList, mark = 'done') {
      if (current !== null || typeof row.terminal !== 'string') {
        return;
      }
      const phase = parkPhase(row);
      current = {
        sessionId: row.id,
        term: row.terminal,
        fromList,
        mark,
        working: row.state === 'working',
        done: row.done,
        phase,
        typed: false,
        moved: false,
      };
      const texts = textsOf(mark);
      prefix.textContent = texts.heading;
      line.textContent = texts.running;
      warning.textContent = texts.working;
      endButton.textContent = texts.end;
      keepButton.textContent = texts.keep;
      cancelButton.textContent = texts.cancel;
      box.dataset['mark'] = mark;
      box.dataset['session'] = row.id;
      // Its first state as any later one; `phase` already set, so that nothing counts as a change.
      setState(row);
      setTitle(row);
      root.hidden = false;
      // Done's: never on End by itself (ruled). Park's: on End only when known idle (ruled).
      (mark === 'park' && phase === 'idle' ? endButton : keepButton).focus();
    },
    /**
     * Every list while it is shown: closes it when its session stopped, was marked done (or, the
     * dialog "Park", parked) or left the list (`deps.gone` with the toast's words); else follows the title and the working state.
     * @param {ListMessage} list
     */
    update(list) {
      if (current === null) {
        return;
      }
      const follows = dialogFollows(
        list,
        current.sessionId,
        current.term,
        sessionRow,
        current.mark,
        current.done,
      );
      if ('close' in follows) {
        close('gone');
        deps.gone(follows.close);
        return;
      }
      current.done = follows.stay.done;
      setTitle(follows.stay);
      setState(follows.stay);
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
      let isPress = PRESS_KEYS.has(event.key) && !event.shiftKey;
      // The dialog "Park" (ruled on review 1): a key that types a character is text typed into the
      // list by mistake — Space too while the keyboard is where the dialog itself put it (End when
      // idle, Keep otherwise: the user has not moved it), where only a fresh Enter presses —; the
      // dialog takes it, so that the rest of a word reaches no list key, and from then on the
      // keyboard stays on Cancel. An auto-repeat is no typed character (ruled): the `w` that
      // opened the dialog, or a key held since before it opened, held on, does nothing.
      let isTyped = false;
      if (current.mark === 'park') {
        if (event.key === ' ' && !current.moved) {
          isPress = false;
        }
        isTyped = !isPress && typesCharacter(event);
      }
      if (!isEscape && !isTab && !isArrow && !isPress && !isTyped) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      // Enter or Space after a typed character cancel; the Space that is itself the first typed
      // character presses nothing.
      const cancels = isEscape || (current.typed && PRESS_KEYS.has(event.key) && !event.shiftKey);
      if (isTyped && !event.repeat) {
        current.typed = true;
      }
      if (current.typed) {
        cancelButton.focus(); // Tab and the arrows move nothing, Enter and Space cancel
        if (!event.repeat && cancels) {
          press('cancel');
        }
        return true;
      }
      if (isTyped) {
        return true; // a held key's auto-repeat: nothing
      }
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
        current.moved = true; // the user's own move: Enter and Space press where it lands
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
    /** F38: closes the dialog as Cancel does (an update from the window began). */
    cancel: () => press('cancel'),
    /** @returns {boolean} */
    shown: () => current !== null,
  };
}
