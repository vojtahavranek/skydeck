// Claude Code's global config file and the one key of it skydeck touches, `leftArrowOpensAgents`
// (follow-up F11, S2 7.9). Claude Code's documentation: the key is a boolean, default true, kept
// in the global config file `~/.claude.json` (inside CLAUDE_CONFIG_DIR when that is set; "Claude
// Code ignores this key in settings.json"); `false` turns off the shortcut that makes `←` on an
// empty prompt send the session to the background and open agent view. `/config` writes the key,
// "and you can also edit them by hand".
//
// The file also holds the user's account details and the MCP servers' settings: secrets. So
// nothing here returns, logs or throws any of its content: a reading or a result carries a state,
// and a reason made of the file's path and this key's name only. JSON.parse's own messages quote
// the text they failed on and are never passed on.
//
// The one write sets only this key and keeps every other byte of the file: no parse and rewrite,
// which would reorder numeric keys, lose digits and re-escape strings. A half-written or
// reordered file would break every Claude Code session of the user, so the new text is checked
// by parsing it again, written to a temporary file of mode 600 and synced, read back and checked
// again, and only then renamed over the file, provided the file is still the one that was read.
import type { FileInfo, Files } from '../platform/types.ts';
import { SkydeckError } from '../platform/errors.ts';

export const LEFT_ARROW_KEY = 'leftArrowOpensAgents';
/** The key's label in Claude Code's `/config` menu. */
export const LEFT_ARROW_LABEL = '← opens agents';
/** How many times the write reads the file again when it changed meanwhile. */
export const TURN_OFF_ATTEMPTS = 3;

/** The global config file holds secrets: what skydeck writes there is the user's alone. */
const MODE = 0o600;

export type LeftArrowState = 'on' | 'off' | 'unknown';

export interface LeftArrowReading {
  /** `off`: the key is exactly false; `on`: absent or true; `unknown`: anything else. */
  state: LeftArrowState;
  path: string;
  /** Why the state is unknown, without any value of the file; null when it is known. */
  reason: string | null;
}

export type TurnOffResult =
  /** The key is false now; `backup` is what the keep callback returned for the replaced text. */
  | { kind: 'written'; backup: string }
  /** The key was false already: nothing written. */
  | { kind: 'off' }
  /** Never written (a symbolic link, another user's file, not a JSON object, …). */
  | { kind: 'unknown'; reason: string }
  /** The file changed between the read and the rename TURN_OFF_ATTEMPTS times: nothing written. */
  | { kind: 'kept-changing' };

/** What one look at the file found: the reading, and for `on` the text and the file it came from. */
type Look =
  | { state: 'on'; text: string; info: FileInfo }
  | { state: 'off' }
  | { state: 'unknown'; reason: string };

/**
 * The state of the ← shortcut in the global config file at `path` (Places.claudeGlobalConfig).
 * Never creates the file, never follows a symbolic link, never throws: a file that cannot be
 * looked at or read is `unknown`. A file of another user than `uid`, or one without its owner's
 * write bit, is `unknown` too: skydeck would never write it.
 */
export function readLeftArrow(files: Files, uid: number, path: string): LeftArrowReading {
  const look = lookAt(files, uid, path);
  return look.state === 'unknown'
    ? { state: 'unknown', path, reason: look.reason }
    : { state: look.state, path, reason: null };
}

/**
 * Sets `leftArrowOpensAgents` to false in the file at `path`, changing nothing else, when it reads
 * `on`. Each try reads the file fresh; `keep(text)` makes the backup of the text about to be
 * replaced and returns its path (a backup of a try that does not rename is removed again). The new
 * file is written beside the old one with mode 600, synced, read back, and renamed over it only
 * while the old one is still the file that was read (inode, size, modification time); else the next
 * try starts. A file that is not `on` is never written: its state is the result. Throws a
 * SkydeckError naming `path` (and an error code, never a value of the file) when a write fails;
 * the file is then unchanged and nothing is left beside it.
 */
export function turnLeftArrowOff(
  files: Files,
  uid: number,
  path: string,
  keep: (text: string) => string,
): TurnOffResult {
  for (let attempt = 0; attempt < TURN_OFF_ATTEMPTS; attempt++) {
    const look = lookAt(files, uid, path);
    if (look.state === 'off') {
      return { kind: 'off' };
    }
    if (look.state === 'unknown') {
      return { kind: 'unknown', reason: look.reason };
    }
    const edit = withKeyOff(look.text);
    if (typeof edit !== 'string') {
      return { kind: 'unknown', reason: edit.reason };
    }
    const backup = replaceIfUnchanged(files, path, look, edit, keep);
    if (backup !== null) {
      return { kind: 'written', backup };
    }
  }
  return { kind: 'kept-changing' };
}

/**
 * The file is read as bytes and decoded strictly: a byte sequence that is not UTF-8 would come out
 * as U+FFFD, and neither the edited file nor its backup would then hold the bytes as they were. The
 * BOM is kept in the text, so a file that starts with one is not JSON.
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function lookAt(files: Files, uid: number, path: string): Look {
  let info: FileInfo | null;
  let bytes: Uint8Array;
  try {
    info = files.lstat(path);
    if (info === null) {
      return unknown('it does not exist');
    }
    if (info.kind === 'symlink') {
      return unknown('it is a symbolic link');
    }
    if (info.kind !== 'file') {
      return unknown('it is not a regular file');
    }
    if (info.uid !== uid) {
      return unknown('it belongs to another user');
    }
    // To its end as it is now (readBytes stops there): a file that grew since lstat is read whole,
    // and the write's check of inode, size and modification time then sees that it changed.
    bytes = files.readBytes(path, 0, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    const code = codeOf(error);
    return unknown(
      code === 'ENOENT' || code === 'ENOTDIR' ? 'it does not exist' : `it cannot be read: ${code}`,
    );
  }
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return unknown('it is not UTF-8 text');
  }
  const object = parseObject(text);
  if (typeof object === 'string') {
    return unknown(object);
  }
  if (!Object.hasOwn(object, LEFT_ARROW_KEY) || object[LEFT_ARROW_KEY] === true) {
    // Its owner made it read-only: a statement skydeck does not overrule by renaming over it. Only
    // `on` would be written, so a read-only file that is off still reads off.
    if ((info.mode & 0o200) === 0) {
      return unknown('it is read-only');
    }
    return { state: 'on', text, info };
  }
  if (object[LEFT_ARROW_KEY] === false) {
    return { state: 'off' };
  }
  return unknown(`${LEFT_ARROW_KEY} is neither true nor false`);
}

function unknown(reason: string): Look {
  return { state: 'unknown', reason };
}

/** The parsed object, or why there is none (never JSON.parse's message: it quotes the text). */
function parseObject(text: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'it is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'it is not a JSON object';
  }
  return value as Record<string, unknown>;
}

/** An error's code (EACCES, …) or, for an error without one, its name: never its message. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    return code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/**
 * One try of the write. The backup's path when the file was replaced; null when the file changed
 * since it was read (nothing written, nothing left). Throws a SkydeckError when a write fails.
 */
function replaceIfUnchanged(
  files: Files,
  path: string,
  read: { text: string; info: FileInfo },
  next: string,
  keep: (text: string) => string,
): string | null {
  let temp: string | null = null;
  let backup: string | null = null;
  let renamed = false;
  try {
    temp = files.createTempBeside(path, next, MODE);
    // What is on disk, not what was meant to be: parsed and compared again before the rename.
    const written = files.readText(temp);
    if (written !== next || !keepsEverythingElse(read.text, written)) {
      throw new SkydeckError(
        `what skydeck wrote for ${path} did not read back as written; it was not changed`,
      );
    }
    backup = keep(read.text);
    if (!sameFile(read.info, files.lstat(path))) {
      return null;
    }
    files.rename(temp, path);
    renamed = true;
    return backup;
  } catch (error) {
    if (error instanceof SkydeckError) {
      throw error;
    }
    throw new SkydeckError(`cannot write ${path} (${codeOf(error)}); it was not changed`);
  } finally {
    if (!renamed) {
      for (const leftover of [temp, backup]) {
        if (leftover !== null) {
          try {
            files.remove(leftover);
          } catch {
            // the error, or the next try, is what matters; a leftover is skydeck's own file
          }
        }
      }
    }
  }
}

/** Still the file that was read: the same inode, size and modification time. */
function sameFile(before: FileInfo, now: FileInfo | null): boolean {
  return (
    now !== null &&
    now.kind === before.kind &&
    now.ino === before.ino &&
    now.size === before.size &&
    now.mtimeNs === before.mtimeNs
  );
}

/**
 * `after` parses to an object whose key is false, with the keys of `before` in the same order
 * (the key appended when it was not there) and every other value as `before` parses it.
 */
function keepsEverythingElse(before: string, after: string): boolean {
  const old = parseObject(before);
  const now = parseObject(after);
  if (typeof old === 'string' || typeof now === 'string' || now[LEFT_ARROW_KEY] !== false) {
    return false;
  }
  const keys = Object.keys(old);
  const expected = Object.hasOwn(old, LEFT_ARROW_KEY) ? keys : [...keys, LEFT_ARROW_KEY];
  const found = Object.keys(now);
  return (
    found.length === expected.length &&
    found.every((key, i) => key === expected[i]) &&
    keys.every(
      (key) => key === LEFT_ARROW_KEY || JSON.stringify(old[key]) === JSON.stringify(now[key]),
    )
  );
}

/** One member of the top-level object, as positions in the text. */
interface Member {
  /** Where the white space before the key starts: right after `{` or `,`. */
  spaceStart: number;
  keyStart: number;
  keyEnd: number;
  key: string;
  valueStart: number;
  valueEnd: number;
}

/**
 * The text with the key set to false, or why it cannot be: the key's `true` replaced in place, or
 * the key added after the last member, with the white space before that member's key (the file's
 * own indentation and line ends, or none on a single line) and the text between its key and its
 * value (`: ` or `:`). An empty object gets the key on a line of its own, indented by two spaces.
 * Every other byte stays, the final newline among them. The result is checked by parsing it.
 */
function withKeyOff(text: string): string | { reason: string } {
  const top = topLevel(text);
  const cannot = { reason: 'skydeck cannot edit its text safely' };
  if (top === null) {
    return cannot;
  }
  const found = top.members.filter((member) => member.key === LEFT_ARROW_KEY);
  if (found.length > 1) {
    return { reason: `${LEFT_ARROW_KEY} is in it more than once` };
  }
  const name = JSON.stringify(LEFT_ARROW_KEY);
  let next: string;
  const [member] = found;
  const last = top.members.at(-1);
  if (member !== undefined) {
    if (text.slice(member.valueStart, member.valueEnd) !== 'true') {
      return cannot;
    }
    next = `${text.slice(0, member.valueStart)}false${text.slice(member.valueEnd)}`;
  } else if (last === undefined) {
    next = `${text.slice(0, top.open)}\n  ${name}: false\n${text.slice(top.close)}`;
  } else {
    const space = text.slice(last.spaceStart, last.keyStart);
    const colon = text.slice(last.keyEnd, last.valueStart);
    next = `${text.slice(0, last.valueEnd)},${space}${name}${colon}false${text.slice(last.valueEnd)}`;
  }
  return keepsEverythingElse(text, next) ? next : cannot;
}

/**
 * The members of the top-level object of `text` (which JSON.parse has accepted), with `open`, the
 * position right after its `{`, and `close`, the position of its `}`; null when the text is not
 * what this scanner expects (it then is not written).
 */
function topLevel(text: string): { open: number; close: number; members: Member[] } | null {
  let i = skipSpace(text, 0);
  if (text[i] !== '{') {
    return null;
  }
  const open = i + 1;
  const members: Member[] = [];
  let spaceStart = open;
  i = skipSpace(text, open);
  if (text[i] !== '}') {
    for (;;) {
      const keyStart = i;
      const keyEnd = skipString(text, keyStart);
      if (keyEnd < 0) {
        return null;
      }
      const colonAt = skipSpace(text, keyEnd);
      if (text[colonAt] !== ':') {
        return null;
      }
      const valueStart = skipSpace(text, colonAt + 1);
      const valueEnd = skipValue(text, valueStart);
      if (valueEnd < 0) {
        return null;
      }
      const key: unknown = JSON.parse(text.slice(keyStart, keyEnd));
      if (typeof key !== 'string') {
        return null;
      }
      members.push({ spaceStart, keyStart, keyEnd, key, valueStart, valueEnd });
      i = skipSpace(text, valueEnd);
      if (text[i] === ',') {
        spaceStart = i + 1;
        i = skipSpace(text, spaceStart);
        continue;
      }
      if (text[i] === '}') {
        break;
      }
      return null;
    }
  }
  const close = i;
  return skipSpace(text, close + 1) === text.length ? { open, close, members } : null;
}

/** JSON's white space: space, tab, line feed, carriage return. */
function skipSpace(text: string, i: number): number {
  let at = i;
  while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) {
    at++;
  }
  return at;
}

/** The position after the string that starts at `i`, or -1. */
function skipString(text: string, i: number): number {
  if (text[i] !== '"') {
    return -1;
  }
  let at = i + 1;
  while (at < text.length) {
    const c = text[at];
    if (c === '\\') {
      at += 2;
    } else if (c === '"') {
      return at + 1;
    } else {
      at++;
    }
  }
  return -1;
}

/** The position after the value that starts at `i` (a string, an object, an array or a scalar), or -1. */
function skipValue(text: string, i: number): number {
  const first = text[i];
  if (first === '"') {
    return skipString(text, i);
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let at = i;
    while (at < text.length) {
      const c = text[at];
      if (c === '"') {
        at = skipString(text, at);
        if (at < 0) {
          return -1;
        }
        continue;
      }
      if (c === '{' || c === '[') {
        depth++;
      } else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          return at + 1;
        }
      }
      at++;
    }
    return -1;
  }
  let at = i;
  while (at < text.length && !',}] \t\n\r'.includes(text.charAt(at))) {
    at++;
  }
  return at > i ? at : -1;
}
