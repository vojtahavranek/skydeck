// Follow-up F36 (S2 12.13): the settings screen, a dialog over the page in the manner of stage D's
// dialogs (web/edit.js, edit.css; modal: app.js makes the page inert under it, D2). It is opened by
// the title bar's gear (F39) and by the quick switcher's command `> settings`.
//
// Follow-up F39: the short screen. The groups of web/settings-short.js, in its order: the
// Appearance group's Mode and Colour theme are the page's own (web/theme.js), drawn at once
// without the server; every other entry is a key of config.json under its plain label, shown once
// the server's screen came. Each is saved as it is picked — a choice or a switch at its change, the
// one-line text on Enter or when the keyboard leaves it (Esc drops it unsaved; the window losing
// the focus is not leaving it), and only when its text changed; no Save, no Default. The answer's
// words stand beside the control: `Saved.`, or the refusal's (a choice or a switch then shows the
// file's value again, a text keeps what was typed). A setting whose change counts after the window
// restarts, and a value the running server does not use yet, is marked `after a restart` — while
// the server uses another value, which, in the control's words (`… still on until then`).
// A file that cannot be used is named at the top; the server refuses every change until mended.
//
// Then the closed section `Advanced (N more settings)`, closed again at each opening: every other
// setting of the server's table as F36 showed them, the file's path and where its copy is kept on
// top — its name as in the file, its meaning, its value in a control that fits its type (a number
// field, a text field, a choice), the default and whether the file sets it, when a change applies,
// and — when the running server uses another value — "applies after the window restarts". A
// changeable one has `Save` and `Default`; a shown-only one shows its value as text and says what
// it names and that it is changed in the file only.
//
// It decides no rule (S2 4.3): the table, what may be changed and what a value may be are the
// server's (src/window/settings.ts); which keys the short screen shows, and their words, are the
// short table's. One setting is saved at a time: `act setting-set` for that one, Advanced's
// `Default` `act setting-default`; the answer's screen is drawn. A text longer than a request
// carries (4,096 bytes of UTF-8) is refused here, before sending, in words that name the limit and
// the file. Nothing is disabled while an answer waits (a field is read-only, Advanced's buttons
// say so), and a draw moves no element (each row and each group's heading is made once), so that
// the keyboard and the scroll stay where they are — also when another window's change draws the
// screen again (a `settings` message); a field whose text the user changed and did not save keeps
// that text. Keys come from app.js's capture phase: Esc closes (`escape()`); Tab and Shift+Tab walk
// the dialog's controls and stay in it (`key()`); Enter in a field saves it. Every text reaches the
// DOM as text, a value only as a control's value or as text, each isolated for right-to-left text.
//
// Follow-up F38 (S2 12.13, 16.5): the group Updates holds, after its choice, the extra block of the
// check for a newer skydeck — the version it runs (`skydeck 0.9.16`, the server's), when the
// window's server last looked and what it found, a failed
// last check and why, `Checking…` while one runs (web/update-text.js) —, and `Check now`
// (`deps.checkNow`, `act update-check`), which works whatever the choice `window.updateCheck`
// says. It follows every state the page is given (`updateState`), also while the screen is closed,
// and draws it while it is shown.

/** @import { ResultMessage, SettingPayload, SettingsPayload, UpdatePayload } from '../src/window/protocol.ts' */
/** @import { ThemeState } from './theme.js' */
/** @import { KeyEntry, LocalEntry, ShortGroup } from './settings-short.js' */
import { SHORT, SHORT_KEYS } from './settings-short.js';
import {
  advancedText,
  appliesText,
  notSavedText,
  restartText,
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
import { MODES, paletteWord, themeWord } from './theme-text.js';
import { settingsLines, UPDATE_TEXTS } from './update-text.js';

/**
 * @typedef {object} SettingsDeps
 * @property {(action: Record<string, unknown> & { kind: string }) => Promise<ResultMessage>} act
 * @property {() => void} closed called once whenever the dialog closes, whatever closed it
 * @property {(text: string) => void} say  the key bar's message: the refusal of a short text saved
 *   as the dialog closed (`Close`), whose words the dialog no longer shows
 * @property {ThemeState} theme  the Appearance group's mode and colour theme
 * @property {() => Promise<ResultMessage>} checkNow F38: `act update-check`
 * @property {() => string} now F38: the server's time now (ns, decimal; '' when not known)
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
 * Puts `values` into `select` as its options, each with its word, unless it holds exactly those.
 * @template {string} T
 * @param {HTMLSelectElement} select
 * @param {readonly T[]} values
 * @param {(value: T) => string} word
 */
function setOptions(select, values, word) {
  const now = [...select.options].map((option) => option.value);
  if (now.length === values.length && now.every((value, at) => value === values[at])) {
    return;
  }
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = word(value);
      return option;
    }),
  );
}

/** The words of a refusal: the server's error, else its lines. @param {ResultMessage} result */
function refusalOf(result) {
  return result.error ?? (result.lines.join(' ') || 'skydeck could not do that');
}

/**
 * One setting of Advanced, its elements made once per key and kept across screens.
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
 * One key of the short screen, its elements made once with the dialog.
 * @typedef {object} ShortRow
 * @property {KeyEntry} entry
 * @property {HTMLElement} root  hidden until the server's screen holds the key
 * @property {HTMLInputElement | HTMLSelectElement} control  a switch is a checkbox
 * @property {HTMLElement} value  a text the field cannot hold faithfully, shown as text
 * @property {HTMLElement} note  then: that it is changed in the file
 * @property {HTMLElement | null} hint
 * @property {HTMLElement} mark  `after a restart`
 * @property {HTMLElement} markText  its words
 * @property {HTMLElement} message  the answer's words
 * @property {string} drawn  the control's value as last drawn (another: the user changed it)
 * @property {boolean} ever  drawn from a screen once (until then hidden, nothing to keep)
 * @property {boolean} waiting
 * @property {boolean} again  changed again while an answer waited: sent once it came
 * @property {string | null} refused  the text last refused, not sent again when the field is left
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
  const problem = element('div', 'settings-problem');
  problem.setAttribute('role', 'alert');
  const problemText = element('div', 'settings-problem-text');
  problem.append(problemText, element('div', 'settings-problem-mend', SETTINGS_TEXTS.mend));
  const status = element('div', 'settings-status');

  // F38: the extra block of the group Updates: the last check's lines and `Check now`.
  const updates = element('div', 'settings-updates');
  updates.setAttribute('aria-live', 'polite');
  const updatesLines = element('div', 'settings-updates-lines');
  const checkNow = button('settings-check-now', UPDATE_TEXTS.checkNow);
  updates.append(updatesLines, checkNow);
  /** Each group's extra block, by its id: shown with the group from the start. */
  /** @type {Readonly<Record<string, HTMLElement>>} */
  const extras = { updates };

  // Advanced: closed, a button that opens and closes it, then today's whole screen of the rest.
  const advancedButton = button('settings-advanced-button', '');
  advancedButton.setAttribute('aria-expanded', 'false');
  advancedButton.setAttribute('aria-controls', 'settings-advanced');
  advancedButton.hidden = true;
  const advanced = element('div', 'settings-advanced');
  advanced.id = 'settings-advanced';
  advanced.hidden = true;
  const fileLine = element('div', 'settings-file');
  const filePath = element('bdi', 'settings-path');
  fileLine.append(SETTINGS_TEXTS.file, filePath);
  const copyLine = element('div', 'settings-copy');
  const copyPath = element('bdi', 'settings-path');
  copyLine.append(SETTINGS_TEXTS.copy, copyPath, '.');
  const noFile = element('div', 'settings-copy settings-no-file', SETTINGS_TEXTS.noFile);
  const help = element('div', 'settings-help', SETTINGS_TEXTS.help);
  const list = element('div', 'settings-list');
  advanced.append(fileLine, copyLine, noFile, help, list);

  const close = button('settings-close', SETTINGS_TEXTS.close);
  const actions = element('div', 'edit-actions settings-actions');
  actions.append(close);

  /** Advanced shown or not (aria-expanded and its section). @param {boolean} open */
  const expand = (open) => {
    advancedButton.setAttribute('aria-expanded', String(open));
    advanced.hidden = !open;
  };
  advancedButton.addEventListener('click', () => {
    expand(advancedButton.getAttribute('aria-expanded') !== 'true');
  });

  let shown = false;
  /** Opens counted, so that the answer of an earlier open draws nothing after a close. */
  let opens = 0;
  /** @type {SettingsPayload | null} */
  let screen = null;
  /** F38: the last state of the check the page was given. @type {UpdatePayload | null} */
  let updateState = null;

  /** F38: the block's lines, one element each, made again only when a text changed. */
  const drawUpdates = () => {
    const texts = settingsLines(updateState, deps.now());
    const now = [...updatesLines.children].map((one) => one.textContent);
    if (now.length === texts.length && now.every((text, i) => text === texts[i])) {
      return;
    }
    updatesLines.replaceChildren(
      ...texts.map((text) => element('div', 'settings-updates-line', text)),
    );
  };
  checkNow.addEventListener('click', () => {
    void deps.checkNow().then((result) => {
      if (result.update !== undefined) {
        updateState = result.update;
      }
      if (shown) {
        drawUpdates();
      }
    });
  });
  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {Map<string, SettingPayload>} */
  const settings = new Map();
  /** Each group's heading in Advanced, made once and kept across screens as the rows are. */
  /** @type {Map<string, HTMLElement>} */
  const headings = new Map();
  /** The Appearance group's two controls, drawn from the theme (`drawLocal`). */
  /** @type {Map<LocalEntry['local'], HTMLSelectElement>} */
  const locals = new Map();
  /** The short screen's keys, in the table's order. */
  /** @type {Map<string, ShortRow>} */
  const shortRows = new Map();
  /** Each short group's section, with what it holds; shown while one of its settings is. */
  /** @type {{ section: HTMLElement, always: boolean, keys: string[] }[]} */
  const shortGroups = [];

  /**
   * A short row's value as its control holds it now: a switch's `on` or `off`, else the control's.
   * @param {ShortRow} row
   */
  const valueOf = (row) =>
    row.entry.control === 'switch'
      ? /** @type {HTMLInputElement} */ (row.control).checked
        ? row.entry.on
        : row.entry.off
      : row.control.value;

  /** Puts `text` into a short row's control. @param {ShortRow} row @param {string} text */
  const setValue = (row, text) => {
    if (row.entry.control === 'switch') {
      /** @type {HTMLInputElement} */ (row.control).checked = text === row.entry.on;
    } else {
      row.control.value = text;
    }
  };

  /** Whether, while the screen is shown, the user changed a field's text and did not save it. */
  const changed = () =>
    shown &&
    ([...rows.values()].some((row) => row.control !== null && row.control.value !== row.drawn) ||
      [...shortRows.values()].some(
        (row) => row.entry.control === 'text' && !row.root.hidden && valueOf(row) !== row.drawn,
      ));

  /**
   * One choice of the page's own, made once: its label, its choice, its hint. A pick applies it.
   * @param {LocalEntry} entry
   * @returns {HTMLElement}
   */
  const makeLocal = (entry) => {
    const rowRoot = element('div', 'short-setting');
    rowRoot.dataset['local'] = entry.local;
    const id = `settings-${entry.local}`;
    const label = /** @type {HTMLLabelElement} */ (element('label', 'short-label', entry.label));
    label.htmlFor = id;
    const select = document.createElement('select');
    select.className = 'edit-field short-control';
    select.id = id;
    const line = element('div', 'short-line');
    line.append(label, select);
    rowRoot.append(line);
    if (entry.hint !== null) {
      const hint = element('div', 'short-hint', entry.hint);
      hint.id = `${id}-hint`;
      select.setAttribute('aria-describedby', hint.id);
      rowRoot.append(hint);
    }
    select.addEventListener('change', () => {
      if (entry.local === 'mode') {
        const mode = MODES.find((one) => one === select.value);
        if (mode !== undefined) deps.theme.setMode(mode);
      } else {
        const palette = deps.theme.palettes().find((one) => one === select.value);
        if (palette !== undefined) deps.theme.setPalette(palette);
      }
    });
    locals.set(entry.local, select);
    return rowRoot;
  };

  /**
   * One key of the short screen, made once: its label, its control, `after a restart`, the
   * answer's words, its hint. Hidden until the server's screen holds the key.
   * @param {KeyEntry} entry
   * @returns {HTMLElement}
   */
  const makeShort = (entry) => {
    const rowRoot = element('div', 'short-setting');
    rowRoot.dataset['key'] = entry.key;
    rowRoot.hidden = true;
    const id = `settings-key-${entry.key.replace(/[^A-Za-z0-9]/g, '-')}`;
    const label = /** @type {HTMLLabelElement} */ (element('label', 'short-label', entry.label));
    label.htmlFor = id;
    /** @type {HTMLInputElement | HTMLSelectElement} */
    let control;
    if (entry.control === 'choice') {
      control = document.createElement('select');
      control.className = 'edit-field short-control';
    } else {
      const input = document.createElement('input');
      if (entry.control === 'switch') {
        input.type = 'checkbox';
        input.setAttribute('role', 'switch');
        input.className = 'short-switch';
      } else {
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.dir = 'auto';
        input.className = 'edit-field short-control';
      }
      control = input;
    }
    control.id = id;
    const value = element('bdi', 'setting-value short-value');
    value.dir = 'auto';
    value.hidden = true;
    // The mark wraps inside its room beside the control (a running address can be long); its
    // ground is on its words only.
    const mark = element('span', 'short-mark');
    const markText = element('span', 'short-mark-text', SETTINGS_TEXTS.afterRestart);
    mark.append(markText);
    mark.id = `${id}-mark`;
    mark.hidden = true;
    const message = element('span', 'short-message');
    message.setAttribute('aria-live', 'polite');
    const line = element('div', 'short-line');
    line.append(label, control, value, mark, message);
    const note = element('div', 'setting-note short-note', SETTINGS_TEXTS.unshowable);
    note.hidden = true;
    rowRoot.append(line, note);
    /** @type {HTMLElement | null} */
    let hint = null;
    if (entry.hint !== null) {
      hint = element('div', 'short-hint', entry.hint);
      hint.id = `${id}-hint`;
      rowRoot.append(hint);
    }
    /** @type {ShortRow} */
    const row = {
      entry,
      root: rowRoot,
      control,
      value,
      note,
      hint,
      mark,
      markText,
      message,
      drawn: '',
      ever: false,
      waiting: false,
      again: false,
      refused: null,
    };
    if (entry.control === 'text') {
      // The line beside the field is about what was sent: it goes once the text changes again.
      control.addEventListener('input', () => {
        if (!row.waiting) {
          setText(message, '');
          delete message.dataset['outcome'];
        }
      });
      // Left — another control, a click elsewhere, the dialog closed — it is saved when changed.
      // The window losing the focus (Alt+Tab) leaves the field the active element: that is not
      // leaving it, and nothing is saved.
      control.addEventListener('blur', () => {
        if (document.activeElement === control) return;
        void sendShort(row, true);
      });
    } else {
      control.addEventListener('change', () => void sendShort(row, false));
    }
    shortRows.set(entry.key, row);
    return rowRoot;
  };

  // The short screen: each group of the table, in its order, its heading and its settings.
  const short = element('div', 'settings-short');
  /** @param {ShortGroup} group */
  const makeGroup = (group) => {
    const section = element('section', 'settings-short-group');
    section.dataset['group'] = group.id;
    const title = element('div', 'settings-group', group.title);
    title.id = `settings-group-${group.id}`;
    section.setAttribute('aria-labelledby', title.id);
    section.append(title);
    for (const entry of group.entries) {
      section.append('key' in entry ? makeShort(entry) : makeLocal(entry));
    }
    // A group's extra block is made here, after its settings, and appended to `section` (F38:
    // Updates' check for a newer skydeck); a group that has one is shown from the start.
    const extra = extras[group.id];
    if (extra !== undefined) section.append(extra);
    const keys = group.entries.flatMap((entry) => ('key' in entry ? [entry.key] : []));
    // Shown from the start: a group of the page's own choices, or one with an extra block.
    const always = group.entries.some((entry) => !('key' in entry)) || extra !== undefined;
    section.hidden = !always;
    shortGroups.push({ section, always, keys });
    return section;
  };
  for (const group of SHORT) {
    short.append(makeGroup(group));
  }

  box.append(heading, problem, status, short, advancedButton, advanced, actions);
  root.replaceChildren(scrim, box);
  root.hidden = true;

  /** The Appearance group as the theme is now: the mode, the shown scheme's themes and its one. */
  const drawLocal = () => {
    const mode = locals.get('mode');
    if (mode !== undefined) {
      setOptions(mode, MODES, themeWord);
      mode.value = deps.theme.mode();
    }
    const palette = locals.get('palette');
    if (palette !== undefined) {
      setOptions(palette, deps.theme.palettes(), paletteWord);
      palette.value = deps.theme.palette();
    }
  };
  drawLocal();
  deps.theme.watch(drawLocal);

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
   * Draws the short screen's keys from `payload`: each control's value unless the user changed it
   * since it was drawn (`redraw`: the keys drawn whatever they hold), the marks; a group is shown
   * once one of its settings is.
   * The first answer of an opening follows the same rule: `open` put each control back to its
   * drawn value, so a control that differs then was changed since this opening, and keeps it.
   * @param {SettingsPayload} payload
   * @param {ReadonlySet<string>} redraw
   */
  const drawShort = (payload, redraw) => {
    for (const row of shortRows.values()) {
      const setting = settings.get(row.entry.key);
      const there = setting !== undefined && payload.settings.includes(setting);
      if (row.root.hidden === there) row.root.hidden = !there;
      if (setting === undefined || !there) continue;
      const asText = row.entry.control === 'text' && !faithful(setting);
      if (row.control.hidden !== asText) row.control.hidden = asText;
      row.value.hidden = !asText;
      row.note.hidden = !asText;
      if (asText) setText(row.value, setting.valueText);
      if (row.entry.control === 'choice') {
        const words = row.entry.words;
        setOptions(
          /** @type {HTMLSelectElement} */ (row.control),
          setting.choices,
          (choice) => words[choice] ?? choice,
        );
      }
      const text = controlText(setting);
      if (!row.ever || redraw.has(row.entry.key) || (!row.waiting && valueOf(row) === row.drawn)) {
        setValue(row, text);
        row.drawn = valueOf(row);
        row.ever = true;
      } else {
        // The user's own text or pick stays; the file's value is what it is compared with.
        row.drawn = text;
      }
      const pendingLine = pendingText(setting);
      const marked = setting.applies === 'restart' || pendingLine !== null;
      row.mark.hidden = !marked;
      // While the running server uses another value, the mark says which, in the control's words.
      setText(row.markText, restartText(row.entry, setting));
      row.mark.title = pendingLine ?? '';
      // The control is described by its hint, and by the mark while it is shown.
      const described = [row.hint?.id, marked ? row.mark.id : undefined].filter(Boolean).join(' ');
      if (described === '') row.control.removeAttribute('aria-describedby');
      else row.control.setAttribute('aria-describedby', described);
    }
    for (const group of shortGroups) {
      const visible = group.always || group.keys.some((key) => !shortRows.get(key)?.root.hidden);
      if (group.section.hidden === visible) group.section.hidden = !visible;
    }
  };

  /**
   * Draws `payload`: the short screen, then Advanced — every row's texts, and each control's value
   * unless the user changed its text since it was drawn (`redraw`: the keys whose field is drawn
   * whatever it holds). Only what is out of place moves: an unchanged screen moves no element.
   * @param {SettingsPayload} payload
   * @param {ReadonlySet<string>} [redraw]
   */
  const draw = (payload, redraw = new Set()) => {
    screen = payload;
    for (const setting of payload.settings) {
      settings.set(setting.key, setting);
    }
    problem.hidden = payload.problem === null;
    setText(problemText, payload.problem ?? '');
    status.hidden = true;
    drawShort(payload, redraw);

    setText(filePath, payload.path);
    setText(copyPath, payload.backup);
    noFile.hidden = payload.exists;
    const rest = payload.settings.filter((setting) => !SHORT_KEYS.has(setting.key));
    setText(advancedButton, advancedText(rest.length));
    advancedButton.hidden = false;
    /** @type {HTMLElement[]} */
    const children = [];
    let group = '';
    for (const setting of rest) {
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
   * One key of the short screen saved, when its value is not the one drawn: a choice or a switch
   * at its change, a text on Enter (`left` false) or when the keyboard leaves it (`left`; a text
   * just refused is not sent again then). Changed again while the answer waits, it is sent again
   * once the answer came.
   * @param {ShortRow} row
   * @param {boolean} left
   */
  const sendShort = async (row, left) => {
    const key = row.entry.key;
    const setting = settings.get(key);
    if (setting === undefined || row.root.hidden || row.control.hidden) {
      return;
    }
    if (row.waiting) {
      row.again = true;
      return;
    }
    const text = valueOf(row);
    if (text === row.drawn || (left && text === row.refused)) {
      return; // nothing changed since it was drawn: nothing sent, nothing written
    }
    const value = valueToSend(setting, text);
    if (typeof value === 'string' && overLimit(value)) {
      row.message.dataset['outcome'] = 'refused';
      setText(row.message, SETTINGS_TEXTS.tooLong);
      row.refused = text;
      return;
    }
    const open = opens;
    row.waiting = true;
    row.root.dataset['waiting'] = 'true';
    if (row.control instanceof HTMLInputElement && row.entry.control === 'text') {
      row.control.readOnly = true;
    }
    delete row.message.dataset['outcome'];
    setText(row.message, SETTINGS_TEXTS.saving);
    const result = await deps.act({ kind: 'setting-set', key, value });
    row.waiting = false;
    delete row.root.dataset['waiting'];
    if (row.control instanceof HTMLInputElement) row.control.readOnly = false;
    if (!shown || open !== opens) {
      // Saved as the dialog closed (the field left by a click on `Close`): a refusal is not lost,
      // the key bar says it.
      row.again = false;
      if (!result.ok) deps.say(notSavedText(row.entry.label, refusalOf(result)));
      return;
    }
    if (row.again) {
      row.again = false;
      if (valueOf(row) !== text) {
        // Changed again meanwhile: the new value is sent; the control keeps it.
        if (result.settings !== undefined) draw(result.settings);
        if (valueOf(row) !== row.drawn) {
          void sendShort(row, false);
          return;
        }
        // Changed back to what the file holds: nothing to send; the answer is the outcome.
      }
      // Asked again for the value just answered (Enter, then leaving it): its answer is the outcome.
    }
    // A choice or a switch shows the file's value again after a refusal; a text keeps what was
    // typed.
    const back = result.ok || row.entry.control !== 'text';
    if (result.settings !== undefined) {
      draw(result.settings, back ? new Set([key]) : new Set());
    }
    row.refused = result.ok ? null : text;
    row.message.dataset['outcome'] = result.ok ? 'saved' : 'refused';
    setText(row.message, result.ok ? SETTINGS_TEXTS.saved : refusalOf(result));
  };

  /**
   * One setting of Advanced saved (`reset`: put back to its default): its field and buttons wait
   * for the answer, whose words stand beside it.
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
    setText(row.message, result.ok ? savedText(setting.applies, reset) : refusalOf(result));
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
    // The keyboard leaves the dialog before it is hidden: app.js gives it back. A short text left
    // so is saved when changed (its blur), and its answer is not drawn.
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && root.contains(holder)) {
      holder.blur();
    }
    root.hidden = true;
    deps.closed();
  };

  /**
   * Esc: the way out without saving. A short text typed and not saved is dropped — the field shows
   * what was drawn again, so that leaving it sends nothing —, then the dialog closes.
   */
  const escape = () => {
    for (const row of shortRows.values()) {
      if (row.entry.control === 'text' && !row.waiting && valueOf(row) !== row.drawn) {
        setValue(row, row.drawn);
        setText(row.message, '');
        delete row.message.dataset['outcome'];
      }
    }
    hide();
  };

  close.addEventListener('click', hide);
  scrim.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    /** Shows the dialog and asks the server for the screen; the keyboard on its first choice. */
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
      for (const row of shortRows.values()) {
        setText(row.message, '');
        delete row.message.dataset['outcome'];
        row.refused = null;
        setValue(row, row.drawn); // nothing typed before stays, also until the answer came
      }
      // Every field is drawn from the server's answer: nothing typed before stays.
      const fresh = new Set(rows.keys());
      expand(false);
      status.hidden = false;
      setText(status, SETTINGS_TEXTS.reading);
      drawLocal();
      drawUpdates();
      root.hidden = false;
      box.scrollTop = 0;
      // The short screen's first choice is the page's own, drawn already: the keyboard starts there.
      (focusable()[0] ?? box).focus();
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
    /**
     * F38: the check's state (every `update` message, and the answers of the page's acts); drawn
     * while the screen is shown.
     * @param {UpdatePayload} payload
     */
    updateState(payload) {
      updateState = payload;
      if (shown) {
        drawUpdates();
      }
    },
    /** Esc, from app.js's capture phase: closes, a typed short text dropped (`escape`). */
    escape,
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
        const typed = [...shortRows.values()].find(
          (one) => one.entry.control === 'text' && one.control === holder,
        );
        if (typed !== undefined) {
          event.preventDefault();
          if (!event.repeat) {
            void sendShort(typed, false);
          }
          return true;
        }
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
