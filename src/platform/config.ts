import { isAbsolute } from 'node:path';

import { ConfigError } from './errors.ts';
import type { Files } from './types.ts';

/** The keys of `window` (S2 16.4). */
export interface WindowConfig {
  port: number; // 1..65535 (A6)
  edge: string; // absolute path
  profileDir: string | null; // an absolute Windows path, `<letter>:\…`
  keepAlive: 'wsl' | 'off';
  /** S2 9.6: where a link the window opens goes — the Windows default browser, or `edge`. */
  links: 'default' | 'edge';
}

/**
 * Follow-up F19 (S2 16.4): a rule of `ticketStatus` — the program that reads the status of a ticket
 * whose address starts with `match`, as a list of words (no shell): the program, then its
 * arguments, in which `{url}` stands for the address and `{key}` for the ticket's short name.
 */
export interface TicketStatusRule {
  match: string;
  command: string[];
}

export interface Config {
  /** Where `resume`, `new`, `restore` and the interactive list's `R` start a session (design 7.6
   *  "Where"; S2 11.4, 16.4: `window` sends them to the window's server). */
  terminal: 'here' | 'wezterm' | 'window';
  wezterm: { domain: string | null };
  groupPattern: string; // a RegExp source
  firstRunDoneAfterDays: number;
  prRefreshMinutes: number;
  restoreBatch: number;
  restoreMinFreeMb: number;
  restoreStartTimeoutSeconds: number;
  claudeHome: string | null;
  claudeCommand: string;
  /** S2 16.4: a ticket's address with `{key}` where its key goes, or null for no link. */
  ticketUrl: string | null;
  /** F19 (S2 16.4): the programs that read a ticket's status, the first whose `match` fits. */
  ticketStatus: TicketStatusRule[];
  /** F19 (S2 16.4): how often, in minutes, a ticket's status is read again (1 to 1440). */
  ticketRefreshMinutes: number;
  window: WindowConfig;
}

export const DEFAULT_CONFIG: Config = {
  terminal: 'here',
  wezterm: { domain: null },
  groupPattern: '^[A-Z][A-Z0-9]+-[0-9]+',
  firstRunDoneAfterDays: 7,
  prRefreshMinutes: 5,
  restoreBatch: 3,
  restoreMinFreeMb: 4096,
  restoreStartTimeoutSeconds: 120,
  claudeHome: null,
  claudeCommand: 'claude',
  ticketUrl: null,
  ticketStatus: [],
  ticketRefreshMinutes: 10,
  window: {
    port: 47613,
    edge: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    profileDir: null,
    keepAlive: 'wsl',
    links: 'default',
  },
};

/** A copy of the defaults that the caller may change. */
function defaults(): Config {
  return {
    ...DEFAULT_CONFIG,
    wezterm: { ...DEFAULT_CONFIG.wezterm },
    ticketStatus: [],
    window: { ...DEFAULT_CONFIG.window },
  };
}

/** An absolute Windows path: a drive letter, a colon and a backslash (`C:\…`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where the key goes in `ticketUrl` (S2 16.4). */
const KEY_PLACE = '{key}';
/** The two different keys that `ticketUrl` is read with, in place of `{key}` (S2 16.4). */
const SAMPLE_KEY = 'KEY-1';
const OTHER_SAMPLE_KEY = 'OTHER-2';
const MAX_TICKET_URL_LENGTH = 2048;
/** White space, the control characters of S2 2, '"' and the backslash. */
const NOT_IN_A_TICKET_URL = /[\s\u0000-\u001f\u007f-\u009f"\\]/;
/** A percent-escape left unfinished: a key right after it would finish it (S2 16.4). */
const UNFINISHED_ESCAPE = /%[0-9A-Fa-f]?$/;

/**
 * The host that the URL parser reads in `pieces` joined by `key`; null when it reads no http or
 * https URL, or one with a user name or a password.
 */
function hostWith(pieces: string[], key: string): string | null {
  const url = URL.parse(pieces.join(key));
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  return url.username === '' && url.password === '' ? url.host : null;
}

/**
 * S2 16.4: null, or a string of at most 2,048 characters holding `{key}` exactly once and no
 * white space, control character, '"' or backslash, with no `%`, or `%` and one hex digit, right
 * before `{key}`, that the URL parser reads with each of two different sample keys in place of
 * `{key}` as http or https without a user name or password and with the same host — a host the
 * key went into would differ. Where the key stands among the address's parts is the parser's to
 * decide, not the text's: it skips extra slashes, and reads `https:{key}` with the key as the host.
 */
function isTicketUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (
    typeof value !== 'string' ||
    value.length > MAX_TICKET_URL_LENGTH ||
    NOT_IN_A_TICKET_URL.test(value)
  ) {
    return false;
  }
  const pieces = value.split(KEY_PLACE);
  const [before = ''] = pieces;
  if (pieces.length !== 2 || UNFINISHED_ESCAPE.test(before)) return false;
  const host = hostWith(pieces, SAMPLE_KEY);
  return host !== null && host === hostWith(pieces, OTHER_SAMPLE_KEY);
}

/** F19 (S2 16.4): the most rules `ticketStatus` holds, and the most words of a rule's command. */
const MAX_STATUS_RULES = 8;
const MAX_STATUS_WORDS = 16;
/** F19: a rule's `match` is at most as long as the longest link the window opens. */
const MAX_MATCH_LENGTH = 2048;
/** Printable ASCII without a space: what a stored address is made of (linkToOpen's one word). */
const ADDRESS_TEXT = /^[\x21-\x7e]+$/;
/** The control characters of S2 2 (C0, DEL, C1). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** F19's longest `ticketRefreshMinutes`: a day. */
const MAX_TICKET_REFRESH_MINUTES = 1440;

/**
 * F19: a rule's `match` — the start of an address as skydeck stores one (the URL parser's
 * serialisation, S2 9.6): at most 2,048 characters of printable ASCII, read by the URL parser as
 * http or https without a user name or a password, and starting with its own scheme and host as
 * the parser writes them (lower case, a default port left out) and a `/`, so that the host is
 * whole: `https://tickets.example.com/` never takes `https://tickets.example.com.other.net/…`.
 */
function isAddressStart(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_MATCH_LENGTH || !ADDRESS_TEXT.test(value)) {
    return false;
  }
  const url = URL.parse(value);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  if (url.username !== '' || url.password !== '' || url.host === '') return false;
  return value.startsWith(`${url.protocol}//${url.host}/`);
}

/** F19: a rule's `command` — 1 to 16 non-empty strings without a control character. */
function isCommandWords(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_STATUS_WORDS &&
    value.every((word) => typeof word === 'string' && word !== '' && !CONTROL.test(word))
  );
}

/**
 * F19 (S2 16.4): `ticketStatus` read from config.json — a list of at most 8 rules, each an object
 * with exactly `match` (isAddressStart) and `command` (isCommandWords) — as new objects, in their
 * order. `fail` is parseConfig's.
 */
function readStatusRules(value: unknown, fail: (problem: string) => never): TicketStatusRule[] {
  if (!Array.isArray(value) || value.length > MAX_STATUS_RULES) {
    fail(`"ticketStatus" must be a list of at most ${MAX_STATUS_RULES} rules`);
  }
  return value.map((rule: unknown, at): TicketStatusRule => {
    const name = `ticketStatus[${at}]`;
    if (!isObject(rule) || !('match' in rule) || !('command' in rule)) {
      fail(`"${name}" must be an object with "match" and "command"`);
    }
    for (const key of Object.keys(rule)) {
      if (key !== 'match' && key !== 'command') fail(`unknown key "${name}.${key}"`);
    }
    const { match, command } = rule;
    if (!isAddressStart(match)) {
      fail(
        `"${name}.match" must be the start of an http or https address, its scheme and host in lower case and followed by "/", at most 2,048 characters`,
      );
    }
    if (!isCommandWords(command)) {
      fail(
        `"${name}.command" must be a list of 1 to ${MAX_STATUS_WORDS} non-empty strings without control characters`,
      );
    }
    return { match, command: [...command] };
  });
}

/**
 * Parses config.json text and merges it over DEFAULT_CONFIG. Throws ConfigError naming `source`
 * and the key on: invalid JSON; a top level that is not an object; an unknown key (also inside
 * `wezterm`); a wrong type; `terminal` not here|wezterm|window (S2 16.4); a number that is not a
 * positive integer; `groupPattern` that `new RegExp` rejects; `claudeHome` not absolute;
 * `claudeCommand` empty; `ticketUrl` that isTicketUrl refuses (S2 16.4); `ticketStatus` that
 * readStatusRules refuses and `ticketRefreshMinutes` not a whole number from 1 to 1440 (F19); in `window` (S2 16.4): an
 * unknown key, `port` outside 1–65535, `edge` not absolute, `profileDir` neither null nor an absolute Windows path,
 * `keepAlive` neither "wsl" nor "off", `links` neither "default" nor "edge".
 *
 * `claudeHome`, `ticketUrl` and `wezterm.domain` may also be `null`, which is their default; an
 * empty `wezterm.domain` is an error like an empty `claudeCommand`.
 */
export function parseConfig(text: string, source: string): Config {
  function fail(problem: string): never {
    throw new ConfigError(`${source}: ${problem}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(parsed)) {
    fail('the top level must be an object');
  }

  const config = defaults();
  for (const [key, value] of Object.entries(parsed)) {
    switch (key) {
      case 'terminal':
        if (value !== 'here' && value !== 'wezterm' && value !== 'window') {
          fail('"terminal" must be "here", "wezterm" or "window"');
        }
        config.terminal = value;
        break;
      case 'wezterm':
        if (!isObject(value)) {
          fail('"wezterm" must be an object');
        }
        for (const [name, domain] of Object.entries(value)) {
          if (name !== 'domain') {
            fail(`unknown key "wezterm.${name}"`);
          }
          if (domain !== null && (typeof domain !== 'string' || domain === '')) {
            fail('"wezterm.domain" must be a non-empty string or null');
          }
          config.wezterm.domain = domain;
        }
        break;
      case 'groupPattern':
        if (typeof value !== 'string') {
          fail('"groupPattern" must be a string');
        }
        try {
          new RegExp(value);
        } catch (error) {
          fail(
            `"groupPattern" is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        config.groupPattern = value;
        break;
      case 'firstRunDoneAfterDays':
      case 'prRefreshMinutes':
      case 'restoreBatch':
      case 'restoreMinFreeMb':
      case 'restoreStartTimeoutSeconds':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          fail(`"${key}" must be a positive integer`);
        }
        config[key] = value;
        break;
      case 'claudeHome':
        if (value !== null && (typeof value !== 'string' || !isAbsolute(value))) {
          fail('"claudeHome" must be an absolute path');
        }
        config.claudeHome = value;
        break;
      case 'claudeCommand':
        if (typeof value !== 'string' || value === '') {
          fail('"claudeCommand" must be a non-empty string');
        }
        config.claudeCommand = value;
        break;
      case 'ticketUrl':
        if (!isTicketUrl(value)) {
          fail(
            '"ticketUrl" must be null or an http or https address with {key} once, after its host',
          );
        }
        config.ticketUrl = value;
        break;
      case 'ticketStatus':
        config.ticketStatus = readStatusRules(value, fail);
        break;
      case 'ticketRefreshMinutes':
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > MAX_TICKET_REFRESH_MINUTES
        ) {
          fail(
            `"ticketRefreshMinutes" must be a whole number from 1 to ${MAX_TICKET_REFRESH_MINUTES}`,
          );
        }
        config.ticketRefreshMinutes = value;
        break;
      case 'window':
        if (!isObject(value)) {
          fail('"window" must be an object');
        }
        for (const [name, item] of Object.entries(value)) {
          switch (name) {
            case 'port':
              // 0 is not a setting: tests pass port 0 to the server directly (A6).
              if (
                typeof item !== 'number' ||
                !Number.isSafeInteger(item) ||
                item < 1 ||
                item > 65535
              ) {
                fail('"window.port" must be a whole number from 1 to 65535');
              }
              config.window.port = item;
              break;
            case 'edge':
              if (typeof item !== 'string' || !isAbsolute(item)) {
                fail('"window.edge" must be an absolute path');
              }
              config.window.edge = item;
              break;
            case 'profileDir':
              if (item !== null && (typeof item !== 'string' || !WINDOWS_ABSOLUTE.test(item))) {
                fail('"window.profileDir" must be an absolute Windows path (C:\\…) or null');
              }
              config.window.profileDir = item;
              break;
            case 'keepAlive':
              if (item !== 'wsl' && item !== 'off') {
                fail('"window.keepAlive" must be "wsl" or "off"');
              }
              config.window.keepAlive = item;
              break;
            case 'links':
              if (item !== 'default' && item !== 'edge') {
                fail('"window.links" must be "default" or "edge"');
              }
              config.window.links = item;
              break;
            default:
              fail(`unknown key "window.${name}"`);
          }
        }
        break;
      default:
        fail(`unknown key "${key}"`);
    }
  }
  return config;
}

/** DEFAULT_CONFIG when the file does not exist, else parseConfig(content, path). */
export function loadConfig(files: Files, configPath: string): Config {
  const text = files.readText(configPath);
  return text === null ? defaults() : parseConfig(text, configPath);
}
