// Follow-up F36 (S2 12.13): the settings screen, a dialog over the page in the manner of stage D's
// dialogs (web/edit.js, edit.css; modal: app.js makes the page inert under it, D2). It is opened by
// the title bar's `Settings` and by the quick switcher's command `> settings`.
//
// The file's path stands at the top, with where its copy is kept; then every setting in the
// server's order, under its group's heading: its name as in the file, its meaning, its value in a
// control that fits its type (a number field, a text field, a choice), the default and whether the
// file sets it, when a change applies, and — when the running server uses another value —
// "applies after the window restarts". A changeable one has `Save` and `Default`; a shown-only one
// shows its value as text and says what it names and that it is changed in the file only.
//
// It decides no rule (S2 4.3): the table, what may be changed and what a value may be are the
// server's (src/window/settings.ts). One setting is saved at a time: `Save` (or Enter in its field)
// sends `act setting-set` for that one, `Default` `act setting-default`; the answer's words stand
// beside the field — the refusal's, or that it was saved and when it applies —, and the answer's
// screen is drawn. A text longer than a request carries (4,096 bytes of UTF-8) is refused here,
// before sending, in words that name the limit and the file. Nothing is disabled while an answer
// waits (the field is read-only, its buttons say so), and a draw moves no element (each row and
// each group's heading is made once), so that the keyboard and the scroll stay where they are —
// also when another window's change draws the screen again. A `settings` message (a change from another window) draws the screen again; a
// field whose text the user changed and did not save keeps that text. Keys come from app.js's
// capture phase: Esc closes (`escape()`); Tab and Shift+Tab walk the dialog's controls and stay in
// it (`key()`); Enter in a field saves it. Every text reaches the DOM as text, a value only as a
// control's value or as text, each isolated for right-to-left text.

/** @import { ResultMessage, SettingPayload, SettingsPayload } from '../src/window/protocol.ts' */
import {
  appliesText,
  controlText,
  factsText,
  faithful,
  overLimit,
  pendingText,
  savedText,
  SETTINGS_TEXTS,
  shownOnlyText,
  valueToSend,
} from './settings-text.js';

/**
 * @typedef {object} SettingsDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {() => void} closed called once whenever the dialog closes, whatever closed it
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
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function button(className, text) {
  const made = /** @type {HTMLButtonElement} */ (element('button', className, text));
  made.type = 'button';
  return made;
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
 * One setting's elements, made once per key and kept across screens.
 * @typedef {object} Row
 * @property {HTMLElement} root
 * @property {HTMLElement} value  a shown-only setting's value, or a changeable one's that its
 *   control cannot hold faithfully (`faithful`)
 * @property {HTMLElement} note  then: that it is changed in the file
 * @property {HTMLInputElement | HTMLSelectElement | null} control  a changeable one's
 * @property {HTMLElement} facts
 * @property {HTMLElement} applies
 * @property {HTMLElement} pending
 * @property {HTMLElement} message
 * @property {HTMLButtonElement | null} save
 * @property {HTMLButtonElement | null} reset
 * @property {string} drawn  the control's text as last drawn (another text: the user changed it)
 * @property {boolean} waiting
 */

/**
 * @param {HTMLElement} root  #settings
 * @param {SettingsDeps} deps
 */
export function createSettingsDialog(root, deps) {
  const scrim = element('div', 'edit-scrim');
  const box = element('div', 'edit-dialog settings-dialog');
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'settings-heading');
  const heading = element('div', 'edit-heading settings-heading', SETTINGS_TEXTS.heading);
  heading.id = 'settings-heading';
  const fileLine = element('div', 'settings-file');
  const filePath = element('bdi', 'settings-path');
  fileLine.append(SETTINGS_TEXTS.file, filePath);
  const copyLine = element('div', 'settings-copy');
  const copyPath = element('bdi', 'settings-path');
  copyLine.append(SETTINGS_TEXTS.copy, copyPath, '.');
  const noFile = element('div', 'settings-copy settings-no-file', SETTINGS_TEXTS.noFile);
  const problem = element('div', 'settings-problem');
  problem.setAttribute('role', 'alert');
  const problemText = element('div', 'settings-problem-text');
  problem.append(problemText, element('div', 'settings-problem-mend', SETTINGS_TEXTS.mend));
  const help = element('div', 'settings-help', SETTINGS_TEXTS.help);
  const status = element('div', 'settings-status');
  const list = element('div', 'settings-list');
  const close = button('settings-close', SETTINGS_TEXTS.close);
  const actions = element('div', 'edit-actions settings-actions');
  actions.append(close);
  box.append(heading, fileLine, copyLine, noFile, problem, help, status, list, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  let shown = false;
  /** Opens counted, so that the answer of an earlier open draws nothing after a close. */
  let opens = 0;
  /** @type {SettingsPayload | null} */
  let screen = null;
  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {Map<string, SettingPayload>} */
  const settings = new Map();
  /** Each group's heading, made once and kept across screens as the rows are. */
  /** @type {Map<string, HTMLElement>} */
  const headings = new Map();

  /** Whether, while the screen is shown, the user changed a field's text and did not save it. */
  const changed = () =>
    shown &&
    [...rows.values()].some((row) => row.control !== null && row.control.value !== row.drawn);

  /** @param {SettingPayload} setting */
  const makeRow = (setting) => {
    const rowRoot = element('div', 'setting');
    rowRoot.dataset['key'] = setting.key;
    rowRoot.dataset['kind'] = setting.kind;
    const name = element('code', 'setting-key', setting.key);
    const meaning = element('div', 'setting-meaning');
    meaning.textContent = setting.meaning;
    const id = `setting-${setting.key.replace(/[^A-Za-z0-9]/g, '-')}`;
    name.id = `${id}-name`;
    const value = element('bdi', 'setting-value');
    value.dir = 'auto';
    const facts = element('div', 'setting-facts');
    const applies = element('div', 'setting-applies');
    const pending = element('div', 'setting-pending');
    const note = element('div', 'setting-note', SETTINGS_TEXTS.unshowable);
    note.hidden = true;
    const message = element('div', 'setting-message');
    message.setAttribute('aria-live', 'polite');
    /** @type {HTMLInputElement | HTMLSelectElement | null} */
    let control = null;
    /** @type {HTMLButtonElement | null} */
    let save = null;
    /** @type {HTMLButtonElement | null} */
    let reset = null;
    const line = element('div', 'setting-line');
    if (setting.kind === 'change') {
      if (setting.control === 'choice') {
        const select = document.createElement('select');
        for (const choice of setting.choices) {
          const option = document.createElement('option');
          option.value = choice;
          option.textContent = choice;
          select.append(option);
        }
        control = select;
      } else {
        const input = document.createElement('input');
        input.type = setting.control === 'number' ? 'number' : 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.dir = 'auto';
        control = input;
      }
      control.className = 'edit-field setting-control';
      control.id = id;
      control.setAttribute('aria-labelledby', `${id}-name`);
      save = button('setting-save', SETTINGS_TEXTS.save);
      reset = button('setting-reset', SETTINGS_TEXTS.reset);
      value.hidden = true;
      line.append(control, save, reset, value);
      // The line under the field is about what was sent: it goes once the field's text or choice
      // changes again (`input`, at each change; never at a blur, whose `change` would move the
      // rows under a pointer that is pressing a button below).
      control.addEventListener('input', () => {
        if (!row.waiting) {
          setText(message, '');
          delete message.dataset['outcome'];
        }
      });
    } else {
      line.append(value);
    }
    rowRoot.append(name, meaning, line, note, facts, applies, pending, message);
    /** @type {Row} */
    const row = {
      root: rowRoot,
      value,
      note,
      control,
      facts,
      applies,
      pending,
      message,
      save,
      reset,
      drawn: '',
      waiting: false,
    };
    save?.addEventListener('click', () => void send(setting.key, false));
    reset?.addEventListener('click', () => void send(setting.key, true));
    return row;
  };

  /**
   * Draws `payload`: every row's texts, and each control's value unless the user changed its text
   * since it was drawn (`redraw`: the keys whose field is drawn whatever it holds). Only what is
   * out of place moves: an unchanged screen moves no element.
   * @param {SettingsPayload} payload
   * @param {ReadonlySet<string>} [redraw]
   */
  const draw = (payload, redraw = new Set()) => {
    screen = payload;
    setText(filePath, payload.path);
    setText(copyPath, payload.backup);
    noFile.hidden = payload.exists;
    problem.hidden = payload.problem === null;
    setText(problemText, payload.problem ?? '');
    status.hidden = true;
    /** @type {HTMLElement[]} */
    const children = [];
    let group = '';
    for (const setting of payload.settings) {
      settings.set(setting.key, setting);
      if (setting.group !== group) {
        group = setting.group;
        let heading = headings.get(group);
        if (heading === undefined) {
          heading = element('div', 'settings-group', group);
          headings.set(group, heading);
        }
        children.push(heading);
      }
      let row = rows.get(setting.key);
      let made = false;
      if (row === undefined) {
        row = makeRow(setting);
        rows.set(setting.key, row);
        made = true;
      }
      const text = controlText(setting);
      // A value its control cannot hold as it is (a line break) is shown as text, without Save.
      const asText = row.control !== null && !faithful(setting);
      for (const one of [row.control, row.save, row.reset]) {
        if (one !== null && one.hidden !== asText) one.hidden = asText;
      }
      if (row.control !== null) {
        row.value.hidden = !asText;
        row.note.hidden = !asText;
        if (asText) setText(row.value, setting.valueText);
      }
      if (row.control !== null && !asText) {
        if (made || redraw.has(setting.key) || row.control.value === row.drawn) {
          row.control.value = text;
          // A value that no option or number field shows (a hand edit) keeps the drawn text, so that
          // the field reads as unchanged.
          row.drawn = row.control.value;
        }
      } else if (row.control === null) {
        setText(row.value, setting.kind === 'show' ? setting.valueText : text);
      }
      setText(row.facts, factsText(setting, payload.problem === null));
      const shownOnly = shownOnlyText(setting);
      setText(row.applies, shownOnly ?? appliesText(setting.applies));
      const pendingLine = pendingText(setting);
      row.pending.hidden = pendingLine === null;
      setText(row.pending, pendingLine ?? '');
      children.push(row.root);
    }
    children.forEach((child, index) => {
      if (list.children[index] !== child) {
        list.insertBefore(child, list.children[index] ?? null);
      }
    });
    while (list.children.length > children.length) {
      list.lastElementChild?.remove();
    }
  };

  /**
   * One setting saved (`reset`: put back to its default): its field and buttons wait for the
   * answer, whose words stand beside it.
   * @param {string} key
   * @param {boolean} reset
   */
  const send = async (key, reset) => {
    const row = rows.get(key);
    const setting = settings.get(key);
    if (row === undefined || setting === undefined || row.control === null || row.waiting) {
      return;
    }
    if (!reset && row.control.value === row.drawn) {
      // Nothing typed or picked since the field was drawn: nothing to send, nothing written.
      row.message.dataset['outcome'] = 'saved';
      setText(row.message, SETTINGS_TEXTS.unchanged);
      return;
    }
    const value = valueToSend(setting, row.control.value);
    if (!reset && typeof value === 'string' && overLimit(value)) {
      row.message.dataset['outcome'] = 'refused';
      setText(row.message, SETTINGS_TEXTS.tooLong);
      return;
    }
    const open = opens;
    // While the answer waits the field is read-only and its buttons say they wait; nothing is
    // disabled, which would take the keyboard away from it.
    const waiting = (/** @type {boolean} */ on) => {
      row.waiting = on;
      if (on) row.root.dataset['waiting'] = 'true';
      else delete row.root.dataset['waiting'];
      for (const one of [row.save, row.reset, row.control]) {
        if (one === null) continue;
        if (on) one.setAttribute('aria-disabled', 'true');
        else one.removeAttribute('aria-disabled');
      }
      if (row.control instanceof HTMLInputElement) row.control.readOnly = on;
    };
    waiting(true);
    setText(row.message, SETTINGS_TEXTS.saving);
    delete row.message.dataset['outcome'];
    const result = await deps.act(
      reset ? { kind: 'setting-default', key } : { kind: 'setting-set', key, value },
    );
    waiting(false);
    if (!shown || open !== opens) {
      return;
    }
    if (result.settings !== undefined) {
      draw(result.settings, result.ok ? new Set([key]) : new Set());
    }
    row.message.dataset['outcome'] = result.ok ? 'saved' : 'refused';
    setText(
      row.message,
      result.ok
        ? savedText(setting.applies, reset)
        : (result.error ?? (result.lines.join(' ') || 'skydeck could not do that')),
    );
  };

  /** The controls the keyboard walks, in order. */
  const focusable = () =>
    /** @type {HTMLElement[]} */ ([...box.querySelectorAll('input, select, button')]).filter(
      (one) => !(/** @type {HTMLInputElement} */ (one).disabled) && one.checkVisibility(),
    );

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
  scrim.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    /** Shows the dialog and asks the server for the screen; the keyboard on the dialog. */
    open() {
      if (shown) {
        return;
      }
      shown = true;
      opens++;
      const open = opens;
      for (const row of rows.values()) {
        setText(row.message, '');
        delete row.message.dataset['outcome'];
        row.drawn = row.control?.value ?? '';
      }
      // Every field is drawn from the server's answer: nothing typed before stays.
      const fresh = new Set(rows.keys());
      status.hidden = false;
      setText(status, SETTINGS_TEXTS.reading);
      root.hidden = false;
      box.focus();
      void deps.act({ kind: 'settings' }).then((result) => {
        if (!shown || open !== opens) {
          return;
        }
        if (result.settings === undefined) {
          setText(status, result.error ?? 'skydeck could not read the settings');
          return;
        }
        draw(result.settings, fresh);
        if (document.activeElement === box) {
          focusable()[0]?.focus();
        }
      });
    },
    /** A change from any window (`settings`): the screen follows, typed text stays. */
    /** @param {SettingsPayload} payload */
    update(payload) {
      if (shown && screen !== null) {
        draw(payload);
      }
    },
    /** Esc, from app.js's capture phase. */
    escape: hide,
    /**
     * A keydown while shown, from app.js's capture phase: true when the dialog took it — Tab and
     * Shift+Tab walk its controls and stay inside, Enter in a field saves that field.
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
      if (event.key === 'Tab') {
        const controls = focusable();
        const first = controls[0];
        const last = controls.at(-1);
        if (first === undefined || last === undefined) {
          event.preventDefault();
          box.focus();
          return true;
        }
        const at = controls.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        if (event.shiftKey ? at <= 0 : at === controls.length - 1 || at === -1) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return true;
        }
        return false; // the browser's own step, inside the dialog
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const holder = document.activeElement;
        const row = [...rows.entries()].find(([, one]) => one.control === holder);
        if (row === undefined) {
          return false; // a button: the browser presses it
        }
        event.preventDefault();
        if (!event.repeat) {
          void send(row[0], false);
        }
        return true;
      }
      return false;
    },
    /** @returns {boolean} */
    shown: () => shown,
    changed,
  };
}
