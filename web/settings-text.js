// Follow-up F36's words and rules for the settings screen (web/settings.js), pure (no DOM): what it
// says of when a change applies, of the default and the file, of a value the running server does
// not use yet and of a shown-only setting, and what a field's text becomes in the request. The
// page decides nothing about a value: the server checks it by config.json's own rules and answers
// the refusal's words, which the screen shows beside the field.

/** @import { SettingApplies, SettingPayload, SettingValue } from '../src/window/protocol.ts' */

export const SETTINGS_TEXTS = {
  heading: 'Settings',
  file: 'The file: ',
  copy: 'The first time the window writes over the file after its server starts, it first keeps a copy of it as ',
  noFile: 'The file does not exist yet: a change creates it.',
  /** After a problem the server names (a file that does not parse, a path that is no file). */
  mend: 'Mend the file by hand first: the window changes nothing in it until then.',
  reading: 'Reading the settings…',
  save: 'Save',
  reset: 'Default',
  close: 'Close',
  saving: 'Saving…',
  /** Save, or Enter, with the field as it was drawn: no request (nothing is written). */
  unchanged: 'Nothing changed, nothing saved.',
  /** A text value a one-line field cannot hold faithfully (`faithful`): shown as text. */
  unshowable:
    'holds a line break or a control character, which this field cannot show: change it in the file while it does',
  /** A text longer than a request carries (VALUE_LIMIT): refused before it is sent. */
  tooLong: 'Longer than the window sends (4,096 bytes as UTF-8): change it in the file by hand.',
  help: 'Enter saves the field you are in; Esc closes. One setting is saved at a time.',
};

/** The most bytes of UTF-8 a setting's text may hold in a request (S2 8.2.3, the URL limit). */
export const VALUE_LIMIT = 4096;

/**
 * Whether `text` is longer than a request carries: the server would refuse the whole message.
 * @param {string} text
 * @returns {boolean}
 */
export function overLimit(text) {
  return new TextEncoder().encode(text).length > VALUE_LIMIT;
}

/** @type {Readonly<Record<SettingApplies, string>>} */
const APPLIES = {
  now: 'applies at once',
  restart: 'applies after the window restarts',
  commands: 'used by the commands at their next run; the window does not use it',
  install: 'used only by skydeck install',
};

/** @type {Readonly<Record<SettingApplies, string>>} */
const SAVED = {
  now: 'it applies at once.',
  restart: 'it applies after the window restarts.',
  commands: 'the commands use it at their next run.',
  install: 'skydeck install uses it.',
};

/** @type {Readonly<Record<'program' | 'folder' | 'port', string>>} */
const NAMES = {
  program: 'names a program',
  folder: 'names a folder',
  port: "is the window's port",
};

/**
 * When a change of the setting applies, in plain words.
 * @param {SettingApplies} applies
 * @returns {string}
 */
export function appliesText(applies) {
  return APPLIES[applies] ?? '';
}

/**
 * What a saved change says: saved (or put back to its default) and when it applies.
 * @param {SettingApplies} applies
 * @param {boolean} reset
 * @returns {string}
 */
export function savedText(applies, reset) {
  return `${reset ? 'Put back to its default' : 'Saved'}: ${SAVED[applies] ?? ''}`;
}

/**
 * The default, and whether the file sets it (`known`: the file could be read).
 * @param {SettingPayload} setting
 * @param {boolean} known
 * @returns {string}
 */
export function factsText(setting, known) {
  const fallback = `default ${setting.defaultText}`;
  if (!known) {
    return fallback;
  }
  return setting.inFile
    ? `${fallback} · set in the file`
    : `${fallback} · not in the file: the default is used`;
}

/**
 * Beside a value the running server does not use (a hand edit, a key read at its start): the words
 * the owner chose, and the value it uses until then; null when it uses the file's.
 * @param {SettingPayload} setting
 * @returns {string | null}
 */
export function pendingText(setting) {
  if (setting.pending !== true) {
    return null;
  }
  return `applies after the window restarts: the window uses ${setting.runningText ?? '?'} until then`;
}

/**
 * What a shown-only setting names and where it is changed; null for a changeable one.
 * @param {SettingPayload} setting
 * @returns {string | null}
 */
export function shownOnlyText(setting) {
  if (setting.kind !== 'show' || setting.names === null) {
    return null;
  }
  return `${NAMES[setting.names] ?? 'is shown only'}: it is changed in the file only`;
}

/**
 * What the request carries for a field's text: a number field's text as a number when it reads as
 * one, else as typed (the server refuses it in config.json's words); an empty field of a setting
 * that may be null, null; any other text as typed; a choice its value.
 * @param {SettingPayload} setting
 * @param {string} text
 * @returns {string | number | null}
 */
export function valueToSend(setting, text) {
  if (setting.control === 'number') {
    const number = Number(text);
    return text.trim() !== '' && Number.isFinite(number) ? number : text;
  }
  if (setting.nullable && text === '') {
    return null;
  }
  // A lone surrogate (a broken paste) is no text a message may carry: it becomes U+FFFD.
  return text.toWellFormed();
}

/** A line break, a control character (C0, DEL, C1): what a one-line field cannot hold as it is. */
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Whether the setting's value can stand in its control as it is: a text with a line break or a
 * control character cannot (an input drops a line break), and a Save would write it changed.
 * @param {SettingPayload} setting
 * @returns {boolean}
 */
export function faithful(setting) {
  return !(typeof setting.value === 'string' && UNSHOWABLE.test(setting.value));
}

/**
 * What a control shows of the setting's value (exact: the server sends it as the file holds it).
 * @param {SettingPayload} setting
 * @returns {string}
 */
export function controlText(setting) {
  /** @type {SettingValue} */
  const value = setting.value;
  if (value === null) {
    return '';
  }
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
