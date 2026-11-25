// Follow-up F38 (S2 16.5, 12.1): the dialog the title bar's `Update available` opens, shown over the
// page in the manner of stage D's dialogs (web/edit.js, edit.css; modal: app.js makes the page
// inert under it, D2). It asks the server to look again without the network (`act update-look`),
// so that what it says is true now, and draws the answer (web/update-text.js's dialogModel): the
// notes of what is new the update brings, the fold of its other changes (a button: a click, Enter
// or Space opens and closes the list under it; folded at every open, open from the start when the
// update brings no note), the database note, why it cannot be applied as the checkout is, and
// small at the bottom the commits and the command for a terminal; or why skydeck cannot tell. The
// body scrolls inside the dialog, its heading and buttons stay in view. `Close` has the keyboard
// from the start; for an update that can be applied as it is, `Update now` stands before it
// (milestone 2) and sends `act update-apply` with the commit the dialog drew; a refusal is drawn
// under the answer. While it is shown an `update` message draws the answer again (the fold as the
// user left it).
//
// Milestone 2's running form (`running`): while an update runs, every connected page shows the
// dialog with one line and no button; Esc does not close it. app.js lifts it when the connection
// is lost or ends fatal and at every welcome.
//
// It decides nothing (S2 4.3): what is known, the notes and their code runs are the server's. Keys
// come from app.js's capture phase (`key`): Esc closes; Tab and Shift+Tab go round the fold line
// and the buttons. Every text reaches the DOM as text.

/** @import { ResultMessage, TextRun, UpdatePayload } from '../src/window/protocol.ts' */
/** @import { DialogBlock, DialogModel } from './update-text.js' */
import {
  dialogModel,
  lineModel,
  offersUpdateNow,
  runningRuns,
  UPDATE_TEXTS,
} from './update-text.js';

/**
 * @typedef {object} UpdateDialogDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(update: UpdatePayload) => void} answered the look's state, for the rest of the page
 * @property {() => void} closed called once whenever the dialog closes
 */

/** How far ↑ and ↓ scroll the dialog's body, in pixels. */
const LINE_PX = 40;

/**
 * The keys that scroll the dialog's body: how far, from the body's page height and its whole height.
 * @type {Record<string, (page: number, whole: number) => number>}
 */
const SCROLL_KEYS = {
  ArrowUp: () => -LINE_PX,
  ArrowDown: () => LINE_PX,
  PageUp: (page) => -page,
  PageDown: (page) => page,
  Home: (_, whole) => -whole,
  End: (_, whole) => whole,
};

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
  const lines = element('div', 'update-body');
  lines.id = 'update-dialog-lines';
  lines.setAttribute('aria-live', 'polite');
  const before = element('div', 'update-before');
  const fold = /** @type {HTMLButtonElement} */ (element('button', 'update-fold'));
  fold.type = 'button';
  fold.hidden = true;
  const others = element('ul', 'update-others');
  others.id = 'update-dialog-others';
  others.hidden = true;
  fold.setAttribute('aria-controls', others.id);
  const after = element('div', 'update-after');
  lines.append(before, fold, others, after);
  const close = /** @type {HTMLButtonElement} */ (
    element('button', 'update-close', UPDATE_TEXTS.close)
  );
  close.type = 'button';
  const updateNow = /** @type {HTMLButtonElement} */ (
    element('button', 'edit-save update-now', UPDATE_TEXTS.updateNow)
  );
  updateNow.type = 'button';
  updateNow.hidden = true;
  const actions = element('div', 'edit-actions update-actions');
  actions.append(updateNow, close);
  box.append(heading, lines, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  let shown = false;
  /** Opens counted, so that the answer of an earlier open draws nothing after a close. */
  let opens = 0;
  /** Whether the look of this open has answered (until then an `update` message draws nothing). */
  let answered = false;
  /** Milestone 2: the commit `Update now` applies (the one the dialog drew); null: not offered. */
  let offered = /** @type {string | null} */ (null);
  /** Milestone 2: the running form is shown. */
  let runningForm = false;
  /** The body drawn last (the fold is drawn again from it). */
  let model = /** @type {DialogModel} */ (lineModel(''));
  /** The fold as the user set it in this open; null: as the body says (folded, or open with no note). */
  let foldOpen = /** @type {boolean | null} */ (null);

  /**
   * Runs as nodes: a code run in the terminal's font, the rest as text.
   * @param {HTMLElement} into
   * @param {TextRun[]} runs
   */
  const fill = (into, runs) => {
    into.append(
      ...runs.map((run) =>
        run.code ? element('code', 'update-code', run.text) : document.createTextNode(run.text),
      ),
    );
    return into;
  };

  /**
   * @param {DialogBlock} block
   * @returns {HTMLElement}
   */
  const blockElement = (block) => {
    if (block.kind === 'note') {
      const note = element('div', 'update-note');
      note.append(
        fill(element('div', 'update-note-title'), block.title),
        ...block.paragraphs.map((runs) => fill(element('p', 'update-note-text'), runs)),
      );
      return note;
    }
    if (block.kind === 'database') {
      const marked = element('div', 'update-database');
      const mark = element('span', 'update-database-mark', '!');
      mark.setAttribute('aria-hidden', 'true');
      marked.append(mark, fill(element('span', 'update-database-text'), block.runs));
      return marked;
    }
    return fill(element('div', block.kind === 'meta' ? 'update-meta' : 'update-line'), block.runs);
  };

  /** The fold line and its list, as `model` and the user's choice say. */
  const drawFold = () => {
    const folding = model.fold;
    const had = document.activeElement === fold;
    fold.hidden = folding === null;
    if (folding === null) {
      others.hidden = true;
      others.replaceChildren();
      if (had) {
        close.focus();
      }
      return;
    }
    const open = foldOpen ?? folding.openAtStart;
    const mark = element('span', 'update-fold-mark', open ? '▾' : '▸');
    mark.setAttribute('aria-hidden', 'true');
    fold.replaceChildren(mark, document.createTextNode(` ${folding.label}`));
    fold.setAttribute('aria-expanded', String(open));
    others.hidden = !open;
    others.replaceChildren(...folding.items.map((item) => element('li', 'update-other', item)));
  };

  /** @param {DialogModel} next */
  const draw = (next) => {
    model = next;
    before.replaceChildren(...next.before.map(blockElement));
    after.replaceChildren(...next.after.map(blockElement));
    drawFold();
  };

  /**
   * The look's answer drawn, `Update now` offered for an update that can be applied as it is.
   * @param {UpdatePayload} update
   * @param {string | null} [refusal] under the answer: why `Update now` was refused
   */
  const drawAnswer = (update, refusal = null) => {
    draw(dialogModel(update.check, refusal));
    const check = update.check;
    offered =
      check !== null && check.state === 'available' && offersUpdateNow(check) ? check.to : null;
    const had = document.activeElement === updateNow;
    updateNow.hidden = offered === null;
    if (had && updateNow.hidden) {
      close.focus();
    }
  };

  // The fold: a click (or Enter or Space on it, a button's own) opens or closes the list.
  fold.addEventListener('click', () => {
    if (!shown || runningForm || model.fold === null) {
      return;
    }
    foldOpen = !(foldOpen ?? model.fold.openAtStart);
    drawFold();
  });

  const hide = () => {
    if (!shown) {
      return;
    }
    shown = false;
    runningForm = false;
    offered = null;
    updateNow.hidden = true;
    close.hidden = false;
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
  fold.addEventListener('mousedown', (event) => event.preventDefault());
  updateNow.addEventListener('mousedown', (event) => event.preventDefault());
  // Milestone 2: the second click. The server looks again and refuses what it does not list; its
  // `applying` brings the running form (app.js), a refusal is drawn under the answer.
  updateNow.addEventListener('click', () => {
    const to = offered;
    if (!shown || runningForm || to === null) {
      return;
    }
    const open = opens;
    updateNow.disabled = true;
    void deps.act({ kind: 'update-apply', to }).then((result) => {
      updateNow.disabled = false;
      if (result.update !== undefined) {
        deps.answered(result.update);
      }
      if (!shown || runningForm || open !== opens || result.ok) {
        return;
      }
      const why = result.error ?? 'skydeck could not start the update';
      if (result.update === undefined) {
        draw(lineModel(why));
        offered = null;
        updateNow.hidden = true;
        close.focus();
        return;
      }
      drawAnswer(result.update, why);
    });
  });
  scrim.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    /** Shows the dialog and asks the server to look again; the keyboard on `Close`. */
    open() {
      if (shown) {
        return;
      }
      shown = true;
      answered = false;
      foldOpen = null; // folded at every open
      opens++;
      const open = opens;
      draw(lineModel(UPDATE_TEXTS.looking));
      root.hidden = false;
      close.focus();
      void deps.act({ kind: 'update-look' }).then((result) => {
        if (!shown || open !== opens) {
          return;
        }
        if (result.update === undefined) {
          draw(lineModel(result.error ?? 'skydeck could not look for an update'));
          return;
        }
        answered = true;
        drawAnswer(result.update);
        deps.answered(result.update);
      });
    },
    /**
     * Every `update` message while it is shown and its look has answered: drawn again.
     * @param {UpdatePayload} update
     */
    update(update) {
      if (shown && answered && !runningForm) {
        drawAnswer(update);
      }
    },
    /**
     * Milestone 2: the running form while `applying` is set — shown (opened when it was not), one
     * line, no button, the keyboard on the dialog itself; null lifts it (the dialog closes).
     * @param {{ name: string } | null} applying
     */
    running(applying) {
      if (applying === null) {
        if (runningForm) {
          hide();
        }
        return;
      }
      if (!shown) {
        shown = true;
        opens++;
        root.hidden = false;
      }
      runningForm = true;
      answered = false;
      offered = null;
      draw(lineModel(runningRuns(applying.name)));
      updateNow.hidden = true;
      close.hidden = true;
      box.focus();
    },
    /** @returns {boolean} whether the running form is shown */
    runningShown: () => shown && runningForm,
    /**
     * A keydown while shown, from app.js's capture phase: true when the dialog took it — Esc
     * closes, Tab and Shift+Tab go round the fold line, `Update now` and `Close` (those shown), and
     * ↑ ↓ PageUp PageDown Home End scroll the body, whichever control has the keyboard (Enter and
     * Space still press it).
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
        if (!event.repeat && !runningForm) {
          hide();
        }
        return true;
      }
      const scroll = Object.hasOwn(SCROLL_KEYS, event.key) ? SCROLL_KEYS[event.key] : undefined;
      if (scroll !== undefined && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!runningForm) {
          const page = Math.max(lines.clientHeight - LINE_PX, LINE_PX);
          lines.scrollBy({ top: scroll(page, lines.scrollHeight) });
        }
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const round = [fold, updateNow, close].filter((button) => !button.hidden);
        if (runningForm || round.length === 0) {
          box.focus();
          return true;
        }
        const at = round.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        const step = event.shiftKey ? -1 : 1;
        const next = at === -1 ? round.length - 1 : (at + step + round.length) % round.length;
        round[next]?.focus();
        return true;
      }
      return false;
    },
    /** @returns {boolean} */
    shown: () => shown,
  };
}
