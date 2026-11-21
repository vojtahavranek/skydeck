// Follow-up F38 (S2 16.5, 12.1): the dialog the title bar's `Update available` opens, shown over the
// page in the manner of stage D's dialogs (web/edit.js, edit.css; modal: app.js makes the page
// inert under it, D2). It asks the server to look again without the network (`act update-look`),
// so that what it says is true now, and draws the answer: `skydeck update --check`'s lines, one per
// line, and the command to run in a terminal (web/update-text.js), or why the update cannot be
// applied as the checkout is, or why skydeck cannot tell. No button but `Close`, which has the
// keyboard from the start. While it is shown an `update` message draws the answer again.
//
// It decides nothing (S2 4.3): what is known is the server's. Keys come from app.js's capture
// phase (`key`): Esc closes; Tab and Shift+Tab stay on `Close`. Every text reaches the DOM as text.

/** @import { ResultMessage, UpdatePayload } from '../src/window/protocol.ts' */
import { dialogLines, UPDATE_TEXTS } from './update-text.js';

/**
 * @typedef {object} UpdateDialogDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(update: UpdatePayload) => void} answered the look's state, for the rest of the page
 * @property {() => void} closed called once whenever the dialog closes
 */

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

/**
 * @param {HTMLElement} root  #update-dialog
 * @param {UpdateDialogDeps} deps
 */
export function createUpdateDialog(root, deps) {
  const scrim = element('div', 'edit-scrim');
  const box = element('div', 'edit-dialog update-dialog');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'update-dialog-heading');
  box.setAttribute('aria-describedby', 'update-dialog-lines');
  const heading = element('div', 'edit-heading update-heading', UPDATE_TEXTS.heading);
  heading.id = 'update-dialog-heading';
  const lines = element('div', 'update-lines');
  lines.id = 'update-dialog-lines';
  lines.setAttribute('aria-live', 'polite');
  const close = /** @type {HTMLButtonElement} */ (
    element('button', 'update-close', UPDATE_TEXTS.close)
  );
  close.type = 'button';
  const actions = element('div', 'edit-actions update-actions');
  actions.append(close);
  box.append(heading, lines, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  let shown = false;
  /** Opens counted, so that the answer of an earlier open draws nothing after a close. */
  let opens = 0;
  /** Whether the look of this open has answered (until then an `update` message draws nothing). */
  let answered = false;

  /** @param {string[]} texts */
  const draw = (texts) => {
    lines.replaceChildren(
      ...texts.map((text) => {
        const line = element('div', 'update-line');
        line.textContent = text;
        return line;
      }),
    );
  };

  const hide = () => {
    if (!shown) {
      return;
    }
    shown = false;
    opens++;
    // The keyboard leaves the dialog before it is hidden: app.js gives it back.
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    root.hidden = true;
    deps.closed();
  };

  close.addEventListener('click', hide);
  // A click acts without moving the keyboard off `Close` (D17).
  close.addEventListener('mousedown', (event) => event.preventDefault());
  scrim.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    /** Shows the dialog and asks the server to look again; the keyboard on `Close`. */
    open() {
      if (shown) {
        return;
      }
      shown = true;
      answered = false;
      opens++;
      const open = opens;
      draw([UPDATE_TEXTS.looking]);
      root.hidden = false;
      close.focus();
      void deps.act({ kind: 'update-look' }).then((result) => {
        if (!shown || open !== opens) {
          return;
        }
        if (result.update === undefined) {
          draw([result.error ?? 'skydeck could not look for an update']);
          return;
        }
        answered = true;
        draw(dialogLines(result.update.check));
        deps.answered(result.update);
      });
    },
    /**
     * Every `update` message while it is shown and its look has answered: drawn again.
     * @param {UpdatePayload} update
     */
    update(update) {
      if (shown && answered) {
        draw(dialogLines(update.check));
      }
    },
    /**
     * A keydown while shown, from app.js's capture phase: true when the dialog took it — Esc
     * closes, Tab and Shift+Tab keep the keyboard on `Close`.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    key(event) {
      if (!shown || event.ctrlKey || event.altKey || event.metaKey) {
        return false;
      }
      if (event.isComposing || event.keyCode === 229) {
        return false; // a key of an IME composition is the IME's
      }
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          hide();
        }
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        close.focus();
        return true;
      }
      return false;
    },
    /** @returns {boolean} */
    shown: () => shown,
  };
}
