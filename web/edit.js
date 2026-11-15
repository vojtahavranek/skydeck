// The dialogs of stage D (S2 12.5, 12.9; plan D1–D3, D2, D17; plan D's contract 2.4): the label,
// the group, the note and the pull requests of one session, edited in a dialog that lies over the
// page, as the mockup shows — a heading that names the session, the field (a text box for the
// note), a line of help, Cancel and Save (Close and Attach in the pull-request dialog, ruled). Task 38 adds the
// pull-request dialog's list above its field.
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

/** @import { ListMessage, ResultMessage, RowPayload, SelectedPayload } from '../src/window/protocol.ts' */
/** @import { EditWhat } from './keys.js' */

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
  box.append(heading, place, help, message, actions);
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
    place.replaceChildren();
    root.hidden = true;
    deps.closed();
  };

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
      // Ruled: Attach's `ok` empties the field and keeps the dialog open, whose list (task 38)
      // shows the new pull request.
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
      // The dialog's session's row, for what it lists (task 38) — never a field's text or the
      // note's base (D3).
      const row = list.sections
        .flatMap((section) => section.rows)
        .find((candidate) => candidate.id === shown.row.id);
      if (row !== undefined) {
        shown.row = row;
      }
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
