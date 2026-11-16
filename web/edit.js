// The dialogs of stage D (S2 12.5, 12.9; plan D1–D3, D2, D17; plan D's contract 2.4): the label,
// the group, the note and the pull requests of one session, edited in a dialog that lies over the
// page, as the mockup shows — a heading that names the session, the field (a text box for the
// note), a line of help, Cancel and Save (Close and Attach in the pull-request dialog, ruled). The
// pull-request dialog lists every attached pull request above its field (plan D task 38, D13): each
// on its line, in the dialog's words (web/header-text.js) — a click on a line that selected no text
// opens it (`act open-link`), × detaches it with an Undo toast —, the merged and closed ones folded
// into `30 merged, 2 closed ▸`, and ↻ (`pr-refresh`). The list follows every `list` while the dialog
// is shown (`update`), never its field; its ages count from `deps.now()` and are drawn again on the
// dialog's own 1 s tick (A18).
//
// The dialog decides no rule (S2 4.3): it sends the `act` through app.js's `deps.act` and shows
// the answer — `ok` closes it (Attach's `ok` empties the field and keeps the pull-request dialog
// open, ruled), a refusal stays under the field with the text and the keyboard (plan D 2.5).
// Save is disabled, and the field read-only, while the act waits, so that the text sent is the
// text shown. Enter saves (Ctrl+Enter in the note, where Enter is a line break); a held Enter
// saves once. Esc comes from app.js (`escape()`, in the capture phase, D2): it closes, but a note
// whose text was changed needs a second Esc. Every close, whatever closed it, calls
// `deps.closed()` once, and app.js gives the keyboard back (D2).
//
// Keyboard and selection (D17): only the buttons cancel their mousedown, so that a click on one
// leaves the keyboard in the field; the heading and the help can be selected and copied, and a
// click there that selected nothing gives the keyboard back to the field. The scrim takes clicks
// without acting. Every text a user or a program wrote reaches the DOM as text.

/** @import { ListMessage, PrPayload, ResultMessage, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */
/** @import { EditWhat } from './keys.js' */
import { foldText, prLineParts, prLineTip, prName, splitPrs } from './header-text.js';
import { sessionRow } from './pane.js';

/**
 * @typedef {object} EditorDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {(text: string, undo: (() => void) | null) => void} toast
 * @property {() => void} closed called once whenever a dialog closes, whatever closed it (D2)
 * @property {() => string} now the server's now (serverNow); task 38's ages repaint through it
 */

/** The heading's first word, by dialog. */
const HEADINGS = { label: 'Label', group: 'Group', note: 'Note', pr: 'Pull requests' };
/** The mockup's line of help, by dialog. */
const HELP = {
  label:
    'Shown as the title, and passed to Claude Code as the session name on the next start or resume. Empty clears it.',
  group: 'Empty: the ticket key at the start of the title is used.',
  note: 'Ctrl+Enter saves. Plain text, kept on this machine.',
  pr: 'Pull requests a session touched are attached by themselves.',
};
const ESC_AGAIN = 'Esc again discards your text';
/** How often the pull-request dialog's ages are drawn again (A18, as the list's). */
const AGE_TICK_MS = 1000;

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
 * A refusal's words.
 * @param {ResultMessage} result
 * @returns {string}
 */
function errorOf(result) {
  return result.error ?? (result.lines.join(' ') || 'skydeck could not do that');
}

/**
 * Sets `text` only when it differs, so that a selection in an unchanged text survives.
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

/**
 * Whether the page holds selected text: a click that ends a drag over a line opens nothing (D17).
 */
function textSelected() {
  const selection = getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== '';
}

/**
 * A button that takes no keyboard on a click (D17).
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function button(className, text) {
  const made = /** @type {HTMLButtonElement} */ (element('button', className, text));
  made.type = 'button';
  made.addEventListener('mousedown', (event) => event.preventDefault());
  return made;
}

/**
 * @param {HTMLElement} root  #editor
 * @param {EditorDeps} deps
 */
export function createEditor(root, deps) {
  const scrim = element('div', 'edit-scrim');
  const box = element('div', 'edit-dialog');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const heading = element('div', 'edit-heading');
  const place = element('div', 'edit-place');
  const help = element('div', 'edit-help');
  const message = element('div', 'edit-message');
  const cancel = button('edit-cancel', 'Cancel');
  const save = button('edit-save', 'Save');
  const actions = element('div', 'edit-actions');
  actions.append(cancel, save);
  // The pull-request dialog's list (D13): the open ones, the fold and ↻, the merged and closed ones.
  const prList = element('div', 'edit-prs');
  const prNone = element('div', 'edit-pr-none', 'no pull request attached');
  const openLines = element('div', 'edit-prs-open');
  const fold = button('edit-pr-fold', '');
  const refresh = button('edit-pr-refresh', '↻');
  refresh.title = 'read their status from GitHub now';
  const foot = element('div', 'edit-prs-foot');
  foot.append(fold, refresh);
  const finishedLines = element('div', 'edit-prs-finished');
  prList.append(prNone, openLines, foot, finishedLines);
  box.append(heading, prList, place, help, message, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  /**
   * The dialog shown: what it edits, for which session (its row as the last list had it, for
   * task 38's list), its field (null for a note too long to edit, D5), the note's `base` (the
   * listed string exactly, D3), the field's value when it opened (to tell a change), whether the
   * act waits, and whether a first Esc warned about a changed note.
   * @type {{ what: EditWhat, row: RowPayload, field: HTMLInputElement | HTMLTextAreaElement | null,
   *          base: string, start: string, waiting: boolean, warned: boolean } | null}
   */
  let current = null;
  /** The merged and closed pull requests are shown (the fold is open); folded at every open. */
  let unfolded = false;
  /**
   * The pull requests whose × was pressed (`<session id> <address>`), and whether its answer came:
   * its × stays disabled while the answer waits and, after an `ok`, until a list no longer holds
   * the line (review 2 of task 38: a slow second click must not send `pr-rm` again for it). One
   * whose answer came is forgotten when the dialog closes, and an `ok` that finds the dialog
   * closed is forgotten at once, so that a pull request attached again elsewhere has a × that acts
   * when the dialog is opened again.
   * @type {Map<string, 'waiting' | 'answered'>}
   */
  const removing = new Map();
  /** A mouse button is down on the list: no line's text is replaced meanwhile (D17, below). */
  let pressed = false;
  /**
   * The sessions whose ↻ waits for its answer.
   * @type {Set<string>}
   */
  const refreshing = new Set();

  /** @param {string} text */
  const say = (text) => {
    message.textContent = text;
  };

  /** Whether the field holds text the user typed and did not save. */
  const changed = () =>
    current !== null && current.field !== null && current.field.value !== current.start;

  const close = () => {
    if (current === null) {
      return;
    }
    // The keyboard leaves the dialog before it is hidden: app.js gives it back (D2).
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    current = null;
    for (const [key, state] of removing) {
      if (state === 'answered') {
        removing.delete(key);
      }
    }
    place.replaceChildren();
    for (const lines of [openLines, finishedLines]) {
      lines.replaceChildren();
      delete lines.dataset['urls']; // drawn again whole at the next open
    }
    root.hidden = true;
    deps.closed();
  };

  /** The attached pull requests of the pull-request dialog shown, [] for any other dialog. */
  const prsShown = () =>
    current !== null && current.what === 'pr' && Array.isArray(current.row.prs)
      ? current.row.prs
      : [];

  /**
   * Draws `prs` as the lines of `container`, one each, in their order: made again only when the
   * addresses change, so that a selection in a line whose text stays survives a list.
   * @param {HTMLElement} container
   * @param {PrPayload[]} prs
   */
  const drawLines = (container, prs) => {
    const key = prs.map((pr) => pr.url).join('\n');
    if (container.dataset['urls'] !== key) {
      container.dataset['urls'] = key;
      container.replaceChildren(
        ...prs.map((pr) => {
          const line = element('div', 'edit-pr');
          line.dataset['url'] = pr.url;
          const remove = button('edit-pr-remove', '×');
          remove.title = 'detach it';
          // F4: the state's words apart, so that they alone take the state's tint (style.css).
          const text = element('span', 'edit-pr-text');
          text.append(
            element('span', 'edit-pr-head'),
            element('span', 'edit-pr-state'),
            element('span', 'edit-pr-tail'),
          );
          line.append(text, remove);
          return line;
        }),
      );
    }
    const now = deps.now();
    const selection = getSelection();
    prs.forEach((pr, at) => {
      const line = container.children[at];
      const text = line?.querySelector('.edit-pr-text');
      const remove = line?.querySelector('.edit-pr-remove');
      if (text instanceof HTMLElement && remove instanceof HTMLButtonElement) {
        // D17: a line is drawn again only while no button is down on the list and no selection
        // touches it, so that an age counting seconds neither ends a drag's selection nor turns
        // the drag's click into an open (review 2 of task 38); it is drawn on the next tick.
        // A line made just now is filled whatever holds it.
        const held =
          text.textContent !== '' &&
          (pressed ||
            (selection !== null && !selection.isCollapsed && selection.containsNode(text, true)));
        const [head, state, tail] = text.children;
        if (
          !held &&
          head instanceof HTMLElement &&
          state instanceof HTMLElement &&
          tail instanceof HTMLElement
        ) {
          const parts = prLineParts(pr, now);
          setText(head, parts.head);
          setText(state, parts.state);
          setText(tail, parts.tail);
          if (state.dataset['level'] !== parts.level) {
            state.dataset['level'] = parts.level;
          }
        }
        if (text.title !== prLineTip(pr)) {
          text.title = prLineTip(pr);
        }
        remove.disabled = current !== null && removing.has(`${current.row.id} ${pr.url}`);
      }
    });
  };

  /** The pull-request dialog's list for its row as the last list had it (D13); hidden otherwise. */
  const drawPrs = () => {
    const isPr = current !== null && current.what === 'pr';
    prList.hidden = !isPr;
    if (!isPr) {
      return;
    }
    const prs = prsShown();
    const sessionId = current?.row.id;
    for (const key of removing.keys()) {
      // A × whose line a list no longer holds is done with (its answer may still come).
      if (key.startsWith(`${sessionId} `) && !prs.some((pr) => key === `${sessionId} ${pr.url}`)) {
        removing.delete(key);
      }
    }
    const { open, finished } = splitPrs(prs);
    const merged = finished.filter((pr) => pr.level === 'merged').length;
    prNone.hidden = prs.length !== 0;
    drawLines(openLines, open);
    drawLines(finishedLines, finished);
    finishedLines.hidden = !unfolded || finished.length === 0;
    setText(fold, foldText(merged, finished.length - merged, unfolded));
    fold.hidden = finished.length === 0;
    refresh.disabled = current !== null && refreshing.has(current.row.id);
    foot.hidden = prs.length === 0;
  };

  /**
   * A refusal of an act of the list (a line's link, ×, its Undo, ↻): under the field while that
   * session's pull-request dialog is shown, else the toast `not saved: <the error>` (as C4: it must
   * still be seen).
   * @param {string} sessionId
   * @param {ResultMessage} result
   */
  const refused = (sessionId, result) => {
    if (current !== null && current.what === 'pr' && current.row.id === sessionId) {
      say(errorOf(result));
    } else {
      deps.toast(`not saved: ${errorOf(result)}`, null);
    }
  };

  /**
   * Keeps the keyboard in the field when a control of the list that had it (pressed from the
   * keyboard) is about to be disabled or removed (as Save, review 2 of task 37).
   */
  const keepField = () => {
    const holder = document.activeElement;
    if (current !== null && current.field !== null && holder !== null && prList.contains(holder)) {
      current.field.focus();
    }
  };

  /**
   * ×: `pr-rm`, then the toast `Detached owner/repo #7` whose Undo sends `pr-add` with that
   * address (D13). The line goes with the list that no longer holds it: the server pushes one
   * after the write (D7) — usually before the answer, else within a second (the once-a-second
   * rule), or at its next refresh when the store was busy —, so nothing here waits for a list.
   * @param {string} url
   */
  const detach = async (url) => {
    const shown = current;
    const pr = prsShown().find((candidate) => candidate.url === url);
    if (shown === null || pr === undefined) {
      return;
    }
    const sessionId = shown.row.id;
    const key = `${sessionId} ${url}`;
    if (removing.has(key)) {
      return;
    }
    const name = prName(pr);
    keepField();
    removing.set(key, 'waiting');
    drawPrs();
    const result = await deps.act({ kind: 'pr-rm', sessionId, url });
    const shownNow = current !== null && current.what === 'pr' && current.row.id === sessionId;
    if (!result.ok || !shownNow) {
      removing.delete(key);
    } else if (removing.has(key)) {
      removing.set(key, 'answered');
    }
    drawPrs();
    if (!result.ok) {
      refused(sessionId, result);
      return;
    }
    deps.toast(`Detached ${name}`, () => {
      removing.delete(key); // attached again, its line comes back with its × to press
      void deps.act({ kind: 'pr-add', sessionId, url }).then((again) => {
        if (!again.ok) {
          refused(sessionId, again);
        }
      });
    });
  };

  /** ↻: `pr-refresh`, the server's explicit refresh in the background (D8); the lists follow. */
  const refreshPrs = async () => {
    const sessionId = current?.row.id;
    if (sessionId === undefined || refreshing.has(sessionId)) {
      return;
    }
    keepField();
    refreshing.add(sessionId);
    drawPrs();
    const result = await deps.act({ kind: 'pr-refresh', sessionId });
    refreshing.delete(sessionId);
    drawPrs();
    if (!result.ok) {
      refused(sessionId, result);
    }
  };

  prList.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const line = target?.closest('.edit-pr');
    const url = line instanceof HTMLElement ? line.dataset['url'] : undefined;
    if (target === null || url === undefined) {
      return;
    }
    if (target.closest('.edit-pr-remove') !== null) {
      // A double click is one press (review 2 of task 38: its second click would detach the line
      // that moved under the pointer, or this one again); a press from the keyboard has no detail.
      if (event.detail <= 1) {
        void detach(url);
      }
    } else if (target.closest('.edit-pr-text') !== null && !textSelected()) {
      // S2 9.6's `open-link` (the server checks the address again); a refusal as `refused` says.
      const sessionId = current?.row.id;
      if (sessionId === undefined) {
        return;
      }
      void deps.act({ kind: 'open-link', url }).then((result) => {
        if (!result.ok) {
          refused(sessionId, result);
        }
      });
    }
  });
  prList.addEventListener('mousedown', () => {
    pressed = true;
  });
  // The press ends with the button's release, a drag and drop's end (which has no `mouseup`), or
  // the window's own loss of focus — not an element's blur: a press on a line's text moves the
  // keyboard from the field to the dialog's box while the button is down (review 2 of task 38).
  for (const ended of ['mouseup', 'dragend']) {
    addEventListener(
      ended,
      () => {
        pressed = false;
      },
      true,
    );
  }
  addEventListener('blur', (event) => {
    if (event.target === window) {
      pressed = false;
    }
  });
  fold.addEventListener('click', () => {
    unfolded = !unfolded;
    drawPrs();
  });
  refresh.addEventListener('click', () => void refreshPrs());
  setInterval(() => {
    if (current !== null && current.what === 'pr') {
      drawPrs();
    }
  }, AGE_TICK_MS);

  /** The act of the dialog shown, from its field. */
  const actionOf = () => {
    if (current === null || current.field === null) {
      return null;
    }
    const sessionId = current.row.id;
    const value = current.field.value;
    switch (current.what) {
      case 'label':
      case 'group':
        return { kind: current.what, sessionId, text: value };
      case 'note':
        return { kind: 'note', sessionId, text: value, base: current.base };
      case 'pr':
        return { kind: 'pr-add', sessionId, url: value };
    }
  };

  const submit = async () => {
    const shown = current;
    const action = actionOf();
    if (shown === null || shown.field === null || action === null || shown.waiting) {
      return;
    }
    const field = shown.field;
    shown.waiting = true;
    shown.warned = false;
    if (document.activeElement === save) {
      field.focus(); // a disabled Save would drop the keyboard (review 2 of task 37)
    }
    save.disabled = true;
    field.readOnly = true;
    say('');
    const result = await deps.act(action);
    if (current !== shown) {
      // Closed meanwhile (Esc, Cancel): the answer has no dialog. A refusal must still be seen
      // (C4, ruled); an `ok` stays silent.
      if (!result.ok) {
        deps.toast(`not saved: ${errorOf(result)}`, null);
      }
      return;
    }
    shown.waiting = false;
    save.disabled = false;
    field.readOnly = false;
    if (!result.ok) {
      say(errorOf(result));
      return;
    }
    if (shown.what === 'pr') {
      // Ruled: Attach's `ok` empties the field and keeps the dialog open, whose list shows the
      // new pull request (`not fetched`, then its state) with the list that holds it: the server
      // pushes one after the write (D7) — usually before this answer, else within a second (the
      // once-a-second rule), or at its next refresh when the store was busy. An address attached
      // already changes nothing, so no list comes for it, and its line is there.
      field.value = '';
      shown.start = '';
      return;
    }
    close();
  };

  /** @param {KeyboardEvent} event */
  const onFieldKey = (event) => {
    if (event.isComposing || event.keyCode === 229) {
      return; // an Enter that ends an IME composition is the IME's (review 2 of task 37)
    }
    if (event.key !== 'Enter' || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    // Enter saves; in the note Enter is a line break and Ctrl+Enter saves.
    if (event.target instanceof HTMLTextAreaElement && !event.ctrlKey) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      void submit(); // a held Enter saves once
    }
  };

  /** @param {Event} event */
  const onInput = (event) => {
    if (current !== null && event.target === current.field && current.warned) {
      current.warned = false; // a first Esc warned about other text than this
      say('');
    }
  };

  cancel.addEventListener('click', () => close());
  save.addEventListener('click', () => void submit());
  // The scrim takes clicks without acting, and keeps the keyboard where it is.
  scrim.addEventListener('mousedown', (event) => event.preventDefault());
  // A click in the dialog that selected nothing gives the keyboard back to its field (D17).
  box.addEventListener('mouseup', () => {
    setTimeout(() => {
      const selection = getSelection();
      if (current === null || (selection !== null && !selection.isCollapsed)) {
        return;
      }
      const holder = document.activeElement;
      if (holder === null || holder === box || !box.contains(holder)) {
        (current.field ?? box).focus();
      }
    }, 0);
  });

  // D2: the field has the keyboard while a dialog is shown. When nothing has it — after a click on
  // the key help or on the toast over the dialog, or an Undo of the toast pressed from the keyboard
  // and gone —, the next key gives it back to the field before that key acts (this listener is in
  // place before app.js's own). Not while text is selected: a Ctrl+C may be about to copy it.
  addEventListener(
    'keydown',
    () => {
      if (current === null) {
        return;
      }
      const holder = document.activeElement;
      if (holder instanceof HTMLElement && holder !== document.body && holder.checkVisibility()) {
        return;
      }
      const selection = getSelection();
      if (selection !== null && !selection.isCollapsed) {
        return;
      }
      (current.field ?? box).focus();
    },
    true,
  );

  return {
    /**
     * @param {EditWhat} what
     * @param {RowPayload} row
     * @param {SelectedPayload | null} selected
     */
    open(what, row, selected) {
      if (current !== null) {
        return;
      }
      /** @type {HTMLInputElement | HTMLTextAreaElement | null} */
      let field = null;
      let base = '';
      let warning = '';
      if (what === 'note') {
        if (selected?.noteTooLong === true) {
          warning = `this note is longer than the window edits; use skydeck note ${row.shortId}`;
        } else {
          // D3: the base is the listed string exactly, never the text box's value (which
          // normalises line breaks); a later list never changes it.
          base = selected?.note ?? '';
          field = /** @type {HTMLTextAreaElement} */ (element('textarea', 'edit-field'));
          field.value = base;
        }
      } else {
        field = /** @type {HTMLInputElement} */ (element('input', 'edit-field'));
        field.type = 'text';
        field.autocomplete = 'off';
        if (what === 'label') {
          field.value = row.titleSource === 'label' ? row.title : '';
          field.placeholder = row.title;
        } else if (what === 'group') {
          field.value = row.groupSource === 'meta' ? (row.group ?? '') : '';
          field.placeholder =
            row.groupSource === 'title' && row.group !== null ? row.group : 'ticket key or topic';
        } else {
          field.placeholder = 'https://github.com/owner/repo/pull/123';
        }
      }
      if (field !== null) {
        field.spellcheck = false;
        // S2 12.9: the key that opened a dialog types nothing into it while it is held. The list's
        // keys are app.js's to swallow; a key held on a button of the header (Enter on Note) is
        // this: the field takes the auto-repeats only of a key whose first press it got.
        /** @type {Set<string>} */
        const pressedHere = new Set();
        field.addEventListener('keydown', (event) => {
          const key = /** @type {KeyboardEvent} */ (event);
          if (!key.repeat) {
            pressedHere.add(key.code);
          } else if (!pressedHere.has(key.code)) {
            key.preventDefault();
          }
        });
        field.addEventListener('keyup', (event) => {
          pressedHere.delete(/** @type {KeyboardEvent} */ (event).code);
        });
        field.addEventListener('keydown', (event) =>
          onFieldKey(/** @type {KeyboardEvent} */ (event)),
        );
        field.addEventListener('input', onInput);
      }
      current = {
        what,
        row,
        field,
        base,
        start: field?.value ?? '',
        waiting: false,
        warned: false,
      };
      box.dataset['what'] = what;
      unfolded = false;
      drawPrs();
      heading.textContent = `${HEADINGS[what]} — ${row.title}`;
      place.replaceChildren(...(field === null ? [] : [field]));
      help.textContent = HELP[what];
      help.hidden = field === null;
      say(warning);
      // Attach keeps the pull-request dialog open, so its other button closes it (ruled).
      cancel.textContent = what === 'pr' ? 'Close' : 'Cancel';
      save.textContent = what === 'pr' ? 'Attach' : 'Save';
      save.hidden = field === null;
      save.disabled = false;
      root.hidden = false;
      if (field === null) {
        box.focus();
      } else {
        field.focus();
        if (field instanceof HTMLInputElement) {
          field.select();
        } else {
          field.setSelectionRange(field.value.length, field.value.length);
        }
      }
    },
    /** @param {ListMessage} list */
    update(list) {
      const shown = current;
      if (shown === null) {
        return;
      }
      // The dialog's session's row, for what the pull-request dialog lists — never a field's text
      // or the note's base (D3); also while the list does not show it (E13: `sessionRow` takes its
      // `selectedRow`). A row the list no longer has at all keeps its last lines.
      const row = sessionRow(list, shown.row.id);
      if (row !== null) {
        shown.row = row;
      }
      drawPrs();
    },
    escape() {
      if (current === null) {
        return;
      }
      if (current.what === 'note' && changed() && !current.warned) {
        current.warned = true;
        say(ESC_AGAIN);
        return;
      }
      close();
    },
    close,
    /** @returns {boolean} */
    shown: () => current !== null,
    /** @returns {boolean} */
    changed,
  };
}
