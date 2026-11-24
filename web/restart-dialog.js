// Issue #166, with part 2 of #188: the dialog "Restart" for a session that runs in a terminal of
// the window and can be ended there (web/restart-text.js `offersRestart`), shown over the list and
// the terminal in the manner of F30's dialog "Mark done" (web/end-dialog.js, edit.css): a scrim
// over the window, the dialog above it, modal (app.js makes the page inert under it, D2). Its
// heading names the session, cut with `…`, whole in its tooltip; a line says what will happen, and
// while the session is working the end dialog's own warning says that the current turn stops.
// Three buttons: `Restart` (the primary one), `Other flags…`, `Cancel`.
//
// The keyboard always starts on `Cancel` (ruled: a word typed into the list by mistake — an `r` and
// then Enter or Space, or any letters before them — must never restart a session); Tab and
// Shift+Tab, and Right and Left, walk the three buttons and stay inside; Enter or Space press the
// one that has the keyboard, at a fresh press only. Esc is Cancel. `Other flags…` puts the shared
// flags line (cards.js `flagsControls`: `Flags for claude`, the field, the ★, the favourites)
// in place of the line and the buttons, filled with the flags a plain resume would pass on (the
// list's `selected.resumeFlags`); its button reads `Restart` (it ends a running program), Enter in
// the field presses it, Tab stays inside the dialog, and Esc goes back with nothing changed, the
// keyboard on `Other flags…`.
//
// A press sends `act restart` itself (with the field's text as `flags` from Other flags…) and the
// dialog stays, its line saying `Restarting…`, until the answer: a refusal (nothing was ended)
// shows on its line and the dialog stays, with the field's text and the keyboard; any other answer
// closes it and goes to `deps.finished` (app.js: the toast, the ended bar's line). Esc while the
// answer is awaited closes the dialog; the answer still goes to `deps.finished`, and a refusal then
// becomes a toast. Before a press the dialog follows its own session at every list (`update`): one
// that stopped, was marked done in another window or left the list closes it, nothing done, and
// `deps.gone` gets the toast's words. Every text reaches the DOM as text.

/** @import { ListMessage, ResultMessage, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */
import { flagsControls } from './flags-line.js';
import { cutTitle } from './end-text.js';
import { flagsText as flagsFieldText } from './favourite-text.js';
import { sessionRow } from './pane.js';
import { RESTART_TEXTS, restartFollows, restartOutcome } from './restart-text.js';

/**
 * @typedef {object} RestartDialogDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(listener: ((favourites: string[]) => void) | null) => void} watchFavourites the
 *   listener of the favourites every list brings, while the dialog's Other flags… is open
 * @property {(outcome: { toast: string, bar: string | null }, session: { sessionId: string, term: string }) => void} finished
 *   the answer of a press that ended the program, or of any press once the dialog was closed
 * @property {(text: string) => void} gone the dialog closed by itself; the toast's words
 * @property {(choice: 'cancel' | 'answered' | 'gone') => void} closed called once whenever the
 *   dialog closes
 */

/** What the flags field takes, in bytes of UTF-8 (S2 8.2.3's text limit, as the resume card's). */
const FLAGS_BYTES = 1024;
const UTF8 = new TextEncoder();
const CANNOT_SHOW =
  'the flags it was started with hold a character this field cannot show; Restart without Other flags… passes them on as they are';
const TOO_LONG = `the flags it was started with are longer than this field takes (at most ${FLAGS_BYTES.toLocaleString('en-US')} bytes of UTF-8): shorten them, or use Restart without Other flags…`;

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
 * @param {HTMLElement} root  #restart-dialog
 * @param {RestartDialogDeps} deps
 */
export function createRestartDialog(root, deps) {
  const scrim = element('div', 'edit-scrim');
  const box = element('div', 'edit-dialog end-dialog restart-dialog');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'restart-dialog-heading');
  box.setAttribute('aria-describedby', 'restart-dialog-text');
  const heading = element('div', 'edit-heading end-heading');
  heading.id = 'restart-dialog-heading';
  const prefix = element('span', 'end-prefix', RESTART_TEXTS.heading);
  // The title isolated from the words around it, so that a right-to-left title keeps its order.
  const title = element('bdi', 'end-title');
  heading.append(prefix, title);
  const text = element('div', 'end-text');
  text.id = 'restart-dialog-text';
  // The warning that comes while the dialog is shown (the session turned working) is announced.
  text.setAttribute('aria-live', 'polite');
  const line = element('div', 'end-line', RESTART_TEXTS.line);
  const warning = element('div', 'end-warning', RESTART_TEXTS.working);
  text.append(line, warning);
  const restartButton = button('end-end restart-restart', RESTART_TEXTS.restart);
  const otherButton = button('restart-other', RESTART_TEXTS.other);
  const cancelButton = button('end-cancel', RESTART_TEXTS.cancel);
  const buttons = [restartButton, otherButton, cancelButton];
  const actions = element('div', 'edit-actions end-actions');
  actions.append(...buttons);
  // The dialog's own result line: `Restarting…`, a refusal.
  const said = element('div', 'card-lines restart-lines');
  said.setAttribute('aria-live', 'polite');
  const host = element('div', 'restart-flags-host');
  box.append(heading, text, host, actions, said);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  /**
   * The dialog shown: the session and the terminal it was opened for, whether the session works
   * now, the list's `selected` of it (what a plain resume passes on), and the press that waits for
   * its answer.
   * @type {{ sessionId: string, term: string, working: boolean, selected: SelectedPayload | null, pending: boolean } | null}
   */
  let current = null;
  /** The open Other flags…: its form, field and result line. */
  /** @type {{ form: HTMLFormElement, flags: HTMLInputElement, lines: HTMLElement } | null} */
  let editor = null;

  /** @param {boolean} working */
  const setWorking = (working) => {
    if (current === null) {
      return;
    }
    current.working = working;
    warning.hidden = !working;
    box.dataset['working'] = working ? 'true' : 'false';
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

  /** The line a refusal or `Restarting…` goes to: the open Other flags…'s, else the dialog's. */
  const lineNow = () => editor?.lines ?? said;

  /** Closes Other flags… (nothing sent); `back`: the keyboard to `Other flags…`. */
  const closeEditor = (/** @type {boolean} */ back) => {
    if (editor === null) {
      return;
    }
    editor = null;
    host.replaceChildren();
    line.hidden = false;
    actions.hidden = false;
    said.hidden = false;
    box.dataset['view'] = 'main';
    deps.watchFavourites(null);
    if (back) {
      otherButton.focus();
    }
  };

  /** @param {'cancel' | 'answered' | 'gone'} choice */
  const close = (choice) => {
    const shown = current;
    if (shown === null) {
      return null;
    }
    closeEditor(false);
    current = null;
    said.textContent = '';
    // The keyboard leaves the dialog before it is hidden: app.js gives it back.
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    root.hidden = true;
    deps.closed(choice);
    return shown;
  };

  /**
   * Sends `act restart` for the shown session, with `flags` from Other flags…; the dialog waits for
   * the answer, its line `Restarting…`.
   * @param {string | undefined} flags
   */
  const send = (flags) => {
    const shown = current;
    if (shown === null || shown.pending) {
      return;
    }
    shown.pending = true;
    box.dataset['pending'] = 'true';
    if (editor !== null) {
      editor.flags.readOnly = true;
    }
    lineNow().textContent = RESTART_TEXTS.pending;
    const session = { sessionId: shown.sessionId, term: shown.term };
    const action =
      flags === undefined
        ? { kind: 'restart', ...session }
        : { kind: 'restart', ...session, flags };
    void deps.act(action).then((result) => {
      const outcome = restartOutcome(result);
      const still = current === shown;
      if ('stay' in outcome) {
        if (still) {
          // Nothing was ended: the dialog stays, with the field's text and the keyboard.
          shown.pending = false;
          delete box.dataset['pending'];
          if (editor !== null) {
            editor.flags.readOnly = false;
          }
          lineNow().textContent = outcome.stay;
        } else {
          deps.finished({ toast: `Restart: ${outcome.stay}`, bar: null }, session);
        }
        return;
      }
      if (still) {
        close('answered');
      }
      deps.finished(outcome, session);
    });
  };

  /** Opens Other flags…, the keyboard in its field at the end. */
  const openEditor = () => {
    if (current === null || current.pending) {
      return;
    }
    const recorded = current.selected?.resumeFlags;
    if (current.selected === null || recorded === undefined) {
      // Before the list's payload of the session (what a plain resume passes on): never a field
      // that is empty for flags it would not know (as the resume card's, #188).
      said.textContent = RESTART_TEXTS.notYet;
      return;
    }
    const words = Array.isArray(recorded) ? recorded : null;
    const value = words === null ? '' : flagsFieldText(words);
    const note =
      words === null ? CANNOT_SHOW : UTF8.encode(value).length > FLAGS_BYTES ? TOO_LONG : '';
    const form = /** @type {HTMLFormElement} */ (element('form', 'card-flags-form restart-flags'));
    form.noValidate = true;
    form.autocomplete = 'off';
    const go = /** @type {HTMLButtonElement} */ (
      element('button', 'card-button primary restart-go', RESTART_TEXTS.restart)
    );
    go.type = 'submit';
    go.addEventListener('mousedown', (event) => event.preventDefault());
    const hint = element('span', 'card-hint', RESTART_TEXTS.hint);
    const bar = element('div', 'card-actions');
    bar.append(go, hint);
    const lines = element('div', 'card-lines');
    lines.setAttribute('aria-live', 'polite');
    const parts = flagsControls({
      form,
      hint,
      lines,
      act: deps.act,
      id: 'restart-flags-label',
      placeholder: 'none: it resumes without flags',
      value,
    });
    lines.textContent = note;
    form.append(parts.line, parts.favourites.line, bar, lines);
    form.addEventListener('keydown', (event) => {
      if (event.repeat && event.key === 'Enter') {
        event.preventDefault(); // a held Enter restarts nothing more
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      send(parts.flags.value);
    });
    editor = { form, flags: parts.flags, lines };
    host.replaceChildren(form);
    line.hidden = true;
    actions.hidden = true;
    said.hidden = true;
    said.textContent = '';
    box.dataset['view'] = 'flags';
    deps.watchFavourites(parts.favourites.update);
    parts.flags.focus();
    parts.flags.setSelectionRange(parts.flags.value.length, parts.flags.value.length);
  };

  /** @param {'restart' | 'other' | 'cancel'} choice */
  const press = (choice) => {
    if (current === null) {
      return;
    }
    if (choice === 'cancel') {
      close('cancel');
    } else if (!current.pending) {
      if (choice === 'restart') {
        send(undefined);
      } else {
        openEditor();
      }
    }
  };

  restartButton.addEventListener('click', () => press('restart'));
  otherButton.addEventListener('click', () => press('other'));
  cancelButton.addEventListener('click', () => press('cancel'));
  // The scrim and the dialog's text take clicks without moving the keyboard off its button.
  scrim.addEventListener('mousedown', (event) => event.preventDefault());
  box.addEventListener('mousedown', (event) => {
    if (!(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
    }
  });
  // The browser's own press of a focused button (Enter at keypress, Space at keyup) never acts:
  // `key` presses at a fresh keydown only. In Other flags… the form is the browser's.
  for (const type of ['keypress', 'keyup']) {
    root.addEventListener(type, (event) => {
      const key = /** @type {KeyboardEvent} */ (event);
      if (PRESS_KEYS.has(key.key) && editor === null) {
        key.preventDefault();
      }
    });
  }

  /** In Other flags…: Tab and Shift+Tab walk what takes the keyboard there, and stay inside. */
  const walkForm = (/** @type {boolean} */ back) => {
    const stops = /** @type {HTMLElement[]} */ (
      [...box.querySelectorAll('input, button, [tabindex="0"]')].filter(
        (one) =>
          one instanceof HTMLElement &&
          !(one instanceof HTMLButtonElement && one.disabled) &&
          one.checkVisibility(),
      )
    );
    if (stops.length === 0) {
      return;
    }
    const at = stops.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = at === -1 ? 0 : (at + (back ? -1 : 1) + stops.length) % stops.length;
    stops[next]?.focus();
  };

  return {
    /**
     * Opens the dialog for `row`, which runs in its terminal (`row.terminal`); `selected` is the
     * list's of that session, null while the list has not brought it.
     * @param {RowPayload} row
     * @param {SelectedPayload | null} selected
     */
    open(row, selected) {
      if (current !== null || typeof row.terminal !== 'string') {
        return;
      }
      const working = row.state === 'working';
      current = { sessionId: row.id, term: row.terminal, working, selected, pending: false };
      box.dataset['session'] = row.id;
      box.dataset['working'] = working ? 'true' : 'false';
      box.dataset['view'] = 'main';
      delete box.dataset['pending'];
      setTitle(row);
      warning.hidden = !working;
      said.textContent = '';
      root.hidden = false;
      cancelButton.focus(); // never on Restart by itself (ruled)
    },
    /**
     * Every list while it is shown: before a press, closes it when its session stopped, was marked
     * done or left the list (`deps.gone` with the toast's words); else follows the title, the
     * working state and what a plain resume passes on. While a press waits, the session's end is
     * the restart's own.
     * @param {ListMessage} list
     */
    update(list) {
      if (current === null) {
        return;
      }
      if (list.selected?.sessionId === current.sessionId) {
        current.selected = list.selected;
      }
      if (current.pending) {
        return;
      }
      const follows = restartFollows(list, current.sessionId, current.term, sessionRow);
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
     * it, and then nothing else acts on it. In Other flags… only Esc and Tab are the dialog's (the
     * field, the ★ and the favourites take the others).
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
      if (editor !== null) {
        if (!isEscape && !isTab) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) {
          return true;
        }
        if (isTab) {
          walkForm(event.shiftKey);
        } else if (current.pending) {
          close('cancel'); // the answer still comes, as a toast
        } else {
          closeEditor(true);
        }
        return true;
      }
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
        cancelButton.focus();
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
        const back = isTab ? event.shiftKey : event.key === 'ArrowLeft';
        const step = back ? -1 : 1;
        const from = at === -1 ? buttons.indexOf(cancelButton) : at;
        buttons[(from + step + buttons.length) % buttons.length]?.focus();
      } else {
        const pressed = buttons[at];
        if (pressed !== undefined) {
          press(
            pressed === restartButton ? 'restart' : pressed === otherButton ? 'other' : 'cancel',
          );
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
