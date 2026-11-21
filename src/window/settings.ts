/**
 * Follow-up F36 (issue #164; S2 12.13): the settings screen's server side — the one table of every
 * key of config.json, the screen's payload, and the change of ONE key of the file.
 *
 * The owner's two decisions (2026-11-20): "plain values only" — a setting that names a program, a
 * folder, or the port, is shown and changed in the file only (a page must not be able to tell
 * skydeck which program to run or which file to read); "at once where possible" — a change takes
 * effect from the running server's next use of it where that is safe, a key the server reads at its
 * start says so, and nothing is restarted, stopped or started by a change.
 *
 * Everything is decided here, never by the page: a page names one key and a value, and the key must
 * be a changeable one of `SETTINGS`; the value is checked by config.json's own rules
 * (`parseConfig`, with its messages) as part of the whole file it would make. The file is read
 * again for every change and written back whole — every other key, known or shown-only, as it was,
 * in its order, with its indentation and line ends — through a temporary file beside it and a
 * rename, with its mode; the first time a server writes over the file a copy of it is kept beside it
 * first (`<file>.skydeck-backup`, mode 600, one copy, replaced by the next server's). A file its
 * owner may not write, or another user's, is not written over. A file that does not parse is never written
 * ("repaired"): the screen says what `doctor` says. A symbolic link is followed as install's
 * settings file is (its file is replaced, the link stays; one to nothing is refused), and a path
 * that is not a regular file is refused. Only the keys the running server reads at each use (AT
 * ONCE) are put into its configuration; a key read at the start never is (the keep-alive holds
 * `config.window` itself), so a change of one shows "applies after the window restarts".
 */
import { DEFAULT_CONFIG, parseConfig } from '../platform/config.ts';
import type { Config } from '../platform/config.ts';
import { ConfigError } from '../platform/errors.ts';
import type { FileInfo, Files } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { describeError } from '../sessions/problems.ts';
import { sanitize } from '../text/sanitize.ts';
import type { SettingApplies, SettingPayload, SettingsPayload, SettingValue } from './protocol.ts';

/** The keys of Config that hold an object of keys (`wezterm`, `window`); a list is one value. */
type Nested = {
  [K in keyof Config]: Config[K] extends readonly unknown[]
    ? never
    : Config[K] extends object
      ? K
      : never;
}[keyof Config];

/** Every key of config.json as the file names it: `prRefreshMinutes`, `window.links`. */
export type SettingKey =
  Exclude<keyof Config, Nested> | { [K in Nested]: `${K}.${keyof Config[K] & string}` }[Nested];

/** One row of the table. Its default is DEFAULT_CONFIG's at the key (one place for defaults). */
export interface SettingRow {
  /** The heading it is listed under: the guide's order of config.json's keys. */
  group: string;
  /** Its meaning in one plain line, the guide's words. */
  meaning: string;
  /** `change`: changed in the window; `show`: shown, changed in the file only. */
  kind: 'change' | 'show';
  /** What a shown one names; null for a changeable one. */
  names: 'program' | 'folder' | 'port' | null;
  control: 'number' | 'text' | 'choice';
  /** The values a choice takes, exactly those config.json's rules take; [] for the others. */
  choices: readonly string[];
  /** An empty text field means null (config.json's rule takes null and refuses ''). */
  nullable: boolean;
  /** When a change takes effect (G4). */
  applies: SettingApplies;
}

const TEXT = { control: 'text', choices: [], nullable: false } as const;
const NUMBER = { control: 'number', choices: [], nullable: false } as const;

/**
 * THE TABLE: every key of Config once, in the guide's order (docs/install.md "config.json" and
 * "The `window` keys"); a key added to Config without a row here does not compile, and the table
 * against DEFAULT_CONFIG is a test (test/window/settings.test.ts).
 *
 * AT ONCE (`now`): the running server reads `deck.config.<key>` at each use — the next list (the
 * rows are loaded again at once after a change), the next refresh, the next link, the next restore.
 * Shown-only keys are never changed here, whatever they say about when they apply.
 */
export const SETTINGS: Readonly<Record<SettingKey, SettingRow>> = {
  // Read by `resume`, `new`, `restore` and the interactive list's `R` at each run; the window's
  // server never reads it (its own launches are the window's terminals).
  terminal: {
    group: 'Starting sessions',
    meaning:
      'Where resume, new, restore and R start claude when no option says: "here" (this terminal), "wezterm" (a new WezTerm tab) or "window" (the skydeck window).',
    kind: 'change',
    names: null,
    control: 'choice',
    choices: ['here', 'wezterm', 'window'],
    nullable: false,
    applies: 'commands',
  },
  // Read by the commands that open a WezTerm tab, at each run; passed as the one value of
  // `--domain-name` in an argument list (the program after `--` is skydeck's own launch).
  'wezterm.domain': {
    group: 'Starting sessions',
    meaning: 'The WezTerm domain a tab opens in (--domain-name). Empty: no domain is passed.',
    kind: 'change',
    names: null,
    ...TEXT,
    nullable: true,
    applies: 'commands',
  },
  // loadRows and selectedPayload read it at each list.
  groupPattern: {
    group: 'The list',
    meaning:
      'A JavaScript regular expression, run on every session’s title at every list: when a session has no group, the text it matches in its title is the group.',
    kind: 'change',
    names: null,
    ...TEXT,
    applies: 'now',
  },
  // Read by `skydeck install` only (its one-time offer).
  firstRunDoneAfterDays: {
    group: 'Install',
    meaning:
      'install’s one-time offer marks as done the sessions not running whose last activity is older than this many days.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'install',
  },
  // The tick and the explicit refresh read it at each fetch.
  prRefreshMinutes: {
    group: 'Pull requests',
    meaning: 'The least time, in minutes, between two automatic reads of a pull request’s status.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'now',
  },
  // runRestore reads the three at each restore (the tick's mapping the timeout at each tick too).
  restoreBatch: {
    group: 'Restore',
    meaning: 'How many sessions a restore opens at a time.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'now',
  },
  restoreMinFreeMb: {
    group: 'Restore',
    meaning: 'A restore stops before a batch when less memory than this (MiB) is free.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'now',
  },
  restoreStartTimeoutSeconds: {
    group: 'Restore',
    meaning:
      'How long, in seconds, a restore waits for the sessions of a batch to report their start.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'now',
  },
  // A folder: the places (the database's sessions, the live files) are resolved from it at the
  // server's start.
  claudeHome: {
    group: 'Claude Code',
    meaning: 'Claude Code’s folder. null: $CLAUDE_CONFIG_DIR, else ~/.claude.',
    kind: 'show',
    names: 'folder',
    ...TEXT,
    applies: 'restart',
  },
  // A program: the one every session is started with; the server reads its configuration once.
  claudeCommand: {
    group: 'Claude Code',
    meaning:
      'The program resume, new, restore and the window run: a name on PATH or an absolute path.',
    kind: 'show',
    names: 'program',
    ...TEXT,
    applies: 'restart',
  },
  // loadRows, selectedPayload, the ticket action and the reads of a status read it at each use.
  ticketUrl: {
    group: 'Tickets',
    meaning:
      'A ticket’s address with {key} where the ticket key goes; the group chip then opens the session’s ticket. Empty: no link.',
    kind: 'change',
    names: null,
    ...TEXT,
    nullable: true,
    applies: 'now',
  },
  // Programs that are run: shown only, read at the server's start (S2 16.4).
  ticketStatus: {
    group: 'Tickets',
    meaning: 'The programs that read a ticket’s status, for the trackers gh does not know.',
    kind: 'show',
    names: 'program',
    ...TEXT,
    applies: 'restart',
  },
  // Each round of the reads of a status reads it.
  ticketRefreshMinutes: {
    group: 'Tickets',
    meaning:
      'The least time, in minutes (1 to 1440), between two automatic reads of a ticket’s status.',
    kind: 'change',
    names: null,
    ...NUMBER,
    applies: 'now',
  },
  // The port the server listens on, bound at its start.
  'window.port': {
    group: 'The window',
    meaning: 'The window server’s port on 127.0.0.1.',
    kind: 'show',
    names: 'port',
    ...NUMBER,
    applies: 'restart',
  },
  // A program (the window, and links with window.links "edge").
  'window.edge': {
    group: 'The window',
    meaning: 'The Edge program: an absolute path in WSL.',
    kind: 'show',
    names: 'program',
    ...TEXT,
    applies: 'restart',
  },
  // A folder Edge is given; only `skydeck window` reads it, at each run.
  'window.profileDir': {
    group: 'The window',
    meaning: 'The window’s Edge profile folder, an absolute Windows path. null: found by itself.',
    kind: 'show',
    names: 'folder',
    ...TEXT,
    applies: 'commands',
  },
  // AFTER THE WINDOW RESTARTS: the keep-alive is made from it at the server's start, and a running
  // one keeps running until the window restarts (nothing is stopped or started by a change).
  'window.keepAlive': {
    group: 'The window',
    meaning:
      '"wsl": the server keeps WSL running while the window runs anything; "off": it does not, and unless instanceIdleTimeout is -1 WSL stops 15 s after its last Windows terminal, ending every session.',
    kind: 'change',
    names: null,
    control: 'choice',
    choices: ['wsl', 'off'],
    nullable: false,
    applies: 'restart',
  },
  // openLink reads it at each link.
  'window.links': {
    group: 'The window',
    meaning:
      'Where the links the window opens go: "default" (the Windows default browser) or "edge" (your own Edge profile).',
    kind: 'change',
    names: null,
    control: 'choice',
    choices: ['default', 'edge'],
    nullable: false,
    applies: 'now',
  },
};

/** Beside config.json: the copy kept before a server's first change. */
export const BACKUP_SUFFIX = '.skydeck-backup';
/** A file the window creates, and the copy: the user's alone (as install's backups). */
const NEW_MODE = 0o600;
const BACKUP_MODE = 0o600;
/** The indentation of a file that shows none (one line). */
const DEFAULT_INDENT = '  ';

const NAMES = {
  program: 'names a program',
  folder: 'names a folder',
  port: "is the window's port",
} as const;

export interface SettingsDeps {
  /** The running server's deck: its `config` is the configuration the server uses. */
  deck: Deck;
  log: (line: string) => void;
}

export type SettingOutcome =
  { ok: true; payload: SettingsPayload } | { ok: false; error: string; payload: SettingsPayload };

export interface Settings {
  /** The screen, as the file and the running server are now (the file read again). */
  payload(): SettingsPayload;
  /** Sets one changeable key to `value` (G2, G3, G4); a refusal changes nothing. */
  set(key: string, value: string | number | null): SettingOutcome;
  /** Removes one changeable key from the file: back to its default. */
  reset(key: string): SettingOutcome;
}

type Raw = Record<string, unknown>;

/** What is at config.json's path now. */
type Look =
  | { state: 'none' }
  | {
      state: 'file';
      /** The file written: the path, or the file a symbolic link there points to. */
      target: string;
      mode: number;
      /** The owner's uid. */
      uid: number;
      text: string;
      raw: Raw;
      config: Config;
    }
  | { state: 'refused'; problem: string };

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** The two parts of a key: `window.links` → ['window', 'links']; `prRefreshMinutes` → [it]. */
function partsOf(key: SettingKey): [string] | [string, string] {
  const dot = key.indexOf('.');
  return dot === -1 ? [key] : [key.slice(0, dot), key.slice(dot + 1)];
}

/** The value at `key` of a configuration or a raw file; undefined when it holds none. */
function valueAt(from: object, key: SettingKey): unknown {
  const [head, tail] = partsOf(key);
  const top: unknown = Object.hasOwn(from, head) ? (from as Raw)[head] : undefined;
  if (tail === undefined) return top;
  return isRaw(top) && Object.hasOwn(top, tail) ? top[tail] : undefined;
}

/** The JSON value of what a configuration holds (they are all JSON values). */
function jsonOf(value: unknown): SettingValue {
  return structuredClone(value ?? null) as SettingValue;
}

/** What the screen shows of a value: its JSON text, sanitised. */
function textOf(value: unknown): string {
  return sanitize(JSON.stringify(value ?? null));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The file's line end: CRLF when every line ends so, else LF (a file on one line: LF). */
function lineEndOf(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') && !/(?:^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/**
 * Why the window does not write over this file, else null: one its owner may not write (a mode
 * without the owner's write bit, 444 say) is the owner's statement, which a rename would overrule;
 * one of another user would become the user's. Nothing is written over either.
 */
function notToWrite(path: string, look: { mode: number; uid: number }, uid: number): string | null {
  if ((look.mode & 0o200) === 0) {
    return `${path} is read-only (mode ${look.mode.toString(8).padStart(3, '0')}): the window does not write over it; make it writable (chmod u+w) or change it by hand: nothing was changed`;
  }
  if (look.uid !== uid) {
    return `${path} belongs to another user: the window does not write over it; nothing was changed`;
  }
  return null;
}

/** The indentation the file's own lines show (the first one indented), else two spaces. */
function indentOf(text: string): string {
  const found = /\n([ \t]+)\S/.exec(text)?.[1];
  return found === undefined || found.length > 10 ? DEFAULT_INDENT : found;
}

/** `raw` with `key` set to `value`, or removed when `value` is undefined (an emptied object too). */
function edited(raw: Raw, key: SettingKey, value: unknown): Raw {
  const next = structuredClone(raw);
  const [head, tail] = partsOf(key);
  if (tail === undefined) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const inner: Raw = isRaw(next[head]) ? next[head] : {};
  if (value === undefined) {
    delete inner[tail];
    if (Object.hasOwn(next, head) && Object.keys(inner).length === 0) delete next[head];
    return next;
  }
  inner[tail] = value;
  next[head] = inner;
  return next;
}

/** Puts `key` of `from` into the running configuration (an AT ONCE key only). */
function apply(running: Config, key: SettingKey, from: Config): void {
  const [head, tail] = partsOf(key);
  const target = running as unknown as Raw;
  const source = from as unknown as Raw;
  if (tail === undefined) {
    target[head] = structuredClone(source[head]);
  } else {
    (target[head] as Raw)[tail] = structuredClone((source[head] as Raw)[tail]);
  }
}

/**
 * The file is read as bytes and decoded strictly: a byte that is not UTF-8 would come out as
 * U+FFFD, and the file written back — a shown-only value in it too — and its copy would no longer
 * hold the bytes as they were (as install reads Claude Code's global config file). The BOM is kept
 * in the text, so a file that starts with one is not JSON, as for every command.
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A path that is not a regular file is never written (install's rule for odd files). */
function lookAt(files: Files, path: string): Look {
  let info: FileInfo | null;
  let target = path;
  let text: string;
  let mode: number;
  let uid: number;
  try {
    info = files.lstat(path);
    if (info === null) return { state: 'none' };
    if (info.kind === 'symlink') {
      const to = files.stat(path);
      if (to === null) {
        return {
          state: 'refused',
          problem: `${path} is a symbolic link to ${files.readlink(path) ?? '?'}, which does not exist; create that file or remove the link`,
        };
      }
      if (to.kind !== 'file') return { state: 'refused', problem: `${path} is not a regular file` };
      target = files.realpath(path) ?? path;
      info = to;
    } else if (info.kind !== 'file') {
      return { state: 'refused', problem: `${path} is not a regular file` };
    }
    mode = info.mode;
    uid = info.uid;
    let bytes: Uint8Array;
    try {
      bytes = files.readBytes(target, 0, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'none' }; // gone in between
      throw error;
    }
    try {
      text = STRICT_UTF8.decode(bytes);
    } catch {
      return { state: 'refused', problem: `${path}: it is not UTF-8 text` };
    }
  } catch (error) {
    return { state: 'refused', problem: `${path}: cannot be read (${describeError(error)})` };
  }
  let config: Config;
  try {
    config = parseConfig(text, path);
  } catch (error) {
    if (error instanceof ConfigError) return { state: 'refused', problem: error.message };
    throw error;
  }
  // parseConfig read it as JSON whose top level is an object.
  const raw = JSON.parse(text) as Raw;
  return { state: 'file', target, mode, uid, text, raw, config };
}

/** Writes `text` over `path` whole or not at all: a temporary file beside it with `mode`, then a
 *  rename; throws a message naming `path`, the temporary file removed. */
function writeWhole(files: Files, path: string, target: string, text: string, mode: number): void {
  let temp: string | null = null;
  try {
    temp = files.createTempBeside(target, text, mode);
    files.rename(temp, target);
    temp = null;
  } catch (error) {
    throw new Error(`cannot write ${path} (${describeError(error)}); it was not changed`, {
      cause: error,
    });
  } finally {
    if (temp !== null) {
      try {
        files.remove(temp);
      } catch {
        // the failure above is what the screen says; a leftover is skydeck's own file
      }
    }
  }
}

/**
 * The settings of the running server whose deck is `deps.deck` (one per server: its first write
 * keeps the copy). Every method reads the file again and never throws; `set` and `reset` are whole
 * synchronous steps, so two pages' changes cannot interleave.
 */
export function createSettings(deps: SettingsDeps): Settings {
  const { deck, log } = deps;
  const files = deck.platform.files;
  const path = deck.places.configPath;
  const backup = `${path}${BACKUP_SUFFIX}`;
  /** The copy of the file was kept by a change whose write over the file worked. */
  let copied = false;

  const payloadOf = (look: Look): SettingsPayload => {
    const file =
      look.state === 'file' ? look.config : look.state === 'none' ? DEFAULT_CONFIG : null;
    const settings = (Object.entries(SETTINGS) as [SettingKey, SettingRow][]).map(
      ([key, row]): SettingPayload => {
        const running = valueAt(deck.config, key);
        const value = file === null ? running : valueAt(file, key);
        const pending =
          file !== null &&
          (row.applies === 'now' || row.applies === 'restart') &&
          !same(value, running);
        const fallback = valueAt(DEFAULT_CONFIG, key);
        return {
          key,
          group: row.group,
          meaning: row.meaning,
          kind: row.kind,
          names: row.names,
          control: row.control,
          choices: [...row.choices],
          nullable: row.nullable,
          applies: row.applies,
          default: jsonOf(fallback),
          defaultText: textOf(fallback),
          inFile: look.state === 'file' && valueAt(look.raw, key) !== undefined,
          value: jsonOf(value),
          valueText: textOf(value),
          pending,
          runningText: pending ? textOf(running) : null,
        };
      },
    );
    return {
      path: sanitize(path),
      backup: sanitize(backup),
      exists: look.state !== 'none',
      problem: look.state === 'refused' ? sanitize(look.problem) : null,
      settings,
    };
  };

  const safely = (step: () => SettingOutcome): SettingOutcome => {
    try {
      return step();
    } catch (error) {
      log(`settings: the change failed (${describeError(error)})`);
      return refused('the change failed unexpectedly; nothing was changed');
    }
  };

  const payload = (): SettingsPayload => {
    try {
      return payloadOf(lookAt(files, path));
    } catch (error) {
      log(`settings: the file was not read (${describeError(error)})`);
      return payloadOf({ state: 'refused', problem: `${path}: cannot be read` });
    }
  };

  const refused = (error: string): SettingOutcome => ({ ok: false, error, payload: payload() });

  /** The key a page named, when it is one the window changes; else the refusal's words. */
  const changeable = (name: string): { key: SettingKey } | { refusal: string } => {
    if (!isKey(name))
      return { refusal: `skydeck has no setting ${JSON.stringify(sanitize(name))}` };
    const row = SETTINGS[name];
    if (row.kind === 'show') {
      const names = row.names === null ? 'is shown only' : NAMES[row.names];
      return { refusal: `${name} ${names}: it is changed in the file only (${path})` };
    }
    return { key: name };
  };

  /** G3: the one key set (`value`) or removed (undefined) in the file read now. */
  const change = (name: string, value: unknown): SettingOutcome => {
    const named = changeable(name);
    if ('refusal' in named) return refused(named.refusal);
    const { key } = named;
    const look = lookAt(files, path);
    if (look.state === 'refused') {
      return refused(`${look.problem}; mend the file by hand first: nothing was changed`);
    }
    if (look.state === 'file') {
      const why = notToWrite(path, look, deck.platform.uid);
      if (why !== null) return refused(why);
    }
    const before: Raw = look.state === 'file' ? look.raw : {};
    const after = edited(before, key, value);
    if (look.state === 'none' && Object.keys(after).length === 0) {
      // Nothing to write: no file, and the key put back to its default.
      if (SETTINGS[key].applies === 'now') apply(deck.config, key, DEFAULT_CONFIG);
      return { ok: true, payload: payload() };
    }
    // The file's own indentation and line ends, where it shows them.
    const lineEnd = look.state === 'file' ? lineEndOf(look.text) : '\n';
    const indent = look.state === 'file' ? indentOf(look.text) : DEFAULT_INDENT;
    const text = `${JSON.stringify(after, null, indent).replaceAll('\n', lineEnd)}${lineEnd}`;
    let next: Config;
    try {
      next = parseConfig(text, path);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // config.json's own words, without the path the screen shows at its top.
      const prefix = `${path}: `;
      return refused(
        error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
      );
    }
    if (!same(before, after)) {
      // The copy counts as kept only once it was made AND the write over the file worked: after a
      // write that failed, or a change that found no file, the next change that finds one makes it.
      const copying = !copied && look.state === 'file';
      if (copying) {
        try {
          writeWhole(files, backup, backup, look.text, BACKUP_MODE);
        } catch (error) {
          const why = error instanceof Error && error.cause !== undefined ? error.cause : error;
          return refused(
            `the copy of the file could not be kept in ${backup} (${describeError(why)}); nothing was changed`,
          );
        }
      }
      try {
        writeWhole(
          files,
          path,
          look.state === 'file' ? look.target : path,
          text,
          look.state === 'file' ? look.mode : NEW_MODE,
        );
      } catch (error) {
        return refused(error instanceof Error ? error.message : String(error));
      }
      if (copying) copied = true;
      log(
        `settings: ${key} ${value === undefined ? 'put back to its default' : 'changed'} in config.json`,
      );
    }
    if (SETTINGS[key].applies === 'now') apply(deck.config, key, next);
    return { ok: true, payload: payload() };
  };

  return {
    payload,
    set(key, value) {
      return safely(() => {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
          return refused("a setting's value cannot be an object, a list, true or false");
        }
        // JSON would write Infinity and NaN as null, which the file's rules take for some keys.
        if (typeof value === 'number' && !Number.isFinite(value)) {
          return refused("a setting's number must be finite");
        }
        return change(key, value);
      });
    },
    reset(key) {
      return safely(() => change(key, undefined));
    },
  };
}
