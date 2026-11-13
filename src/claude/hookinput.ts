/**
 * Spool files → normalised events (design 5.2, 5.3; format: plan 2.10.1). The one place that knows
 * what `bin/skydeck-hook` writes and what Claude Code's hook inputs look like (design principle 9).
 * Pure: it reads no file and calls no program; whether a path exists is asked through a callback.
 */
import type { Ns } from '../platform/types.ts';
import { absolutizePathFlags, isPrintRun, storableArgv } from './launch.ts';
import { argvFromCmdline, procStartFromStat } from './procstat.ts';

export interface SpoolEvent {
  spoolName: string;
  timeNs: Ns;
  kind: 'start' | 'end';
  detail:
    'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'unknown' | 'switch' | 'exit' | 'other';
  rawDetail: string | null; // source / reason as received
  sessionId: string;
  bootId: string;
  pid: number; // 0 when claude_pid is empty (D7)
  procStart: number | null; // null too when there is no pid (D7)
  cwd: string | null; // hook input cwd, else the pwd key (empty → null)
  /**
   * SessionStart with a non-empty argv_b64 only: storableArgv of the recorded command with its path
   * flags absolute — no positional arguments, no removed flags, unknown flags as bare names (a
   * prompt is conversation text; principle 4).
   */
  argv: string[] | null;
  name: string | null; // SessionStart session_title
  payload: string; // the hook input exactly as received
  entrypointEnv: string | null; // empty → null
  /**
   * 5.3 "scripted runs": isPrintRun(recorded argv) — the command as recorded, before storableArgv
   * drops `-cp` whole — or entrypointEnv non-null and not 'cli' (design 14: `claude -p` hooks see
   * 'sdk-cli'). An end event has no command: only entrypointEnv decides.
   */
  scripted: boolean;
}

/**
 * SessionStart.source → detail. Anything else → 'unknown'. Look names up with `Object.hasOwn`: a
 * source such as "constructor" is not a key of this table.
 */
export const START_DETAILS: Readonly<Record<string, SpoolEvent['detail']>> = Object.freeze({
  startup: 'startup',
  resume: 'resume',
  clear: 'clear',
  compact: 'compact',
  fork: 'fork',
});

/**
 * SessionEnd.reason → detail. Anything else → 'other' — including the reason 'other' that closing
 * the terminal (SIGHUP) reports (design 14). Look names up with `Object.hasOwn`, as above.
 */
export const END_DETAILS: Readonly<Record<string, SpoolEvent['detail']>> = Object.freeze({
  clear: 'clear',
  resume: 'switch',
  prompt_input_exit: 'exit',
  logout: 'exit',
});

/** A spool file that cannot be used: ingest moves it to `spool/bad/` (design 5.3). */
export class SpoolParseError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

const NAME = /^[0-9]+-[0-9]+-[0-9]+\.ev$/;
const DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The database column is a signed 64-bit integer. */
const INT64_MAX = 9_223_372_036_854_775_807n;

/** A key of the file for a message: the file is not trusted, so it is quoted and cut. */
function quoted(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
}

/** The value when it is a non-empty string. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The value as a lower-case UUID when it is a string that is one. */
function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The lines before the first line that is exactly `--`, as key → value (the value is everything
 * after the first `=`, verbatim), and everything after that line. A line ends at '\n' and nothing
 * else: a '\r' belongs to the value.
 */
function splitFile(content: string): { keys: Map<string, string>; payload: string } {
  const keys = new Map<string, string>();
  let start = 0;
  while (true) {
    const end = content.indexOf('\n', start);
    const line = end === -1 ? content.slice(start) : content.slice(start, end);
    if (line === '--') {
      return { keys, payload: end === -1 ? '' : content.slice(end + 1) };
    }
    if (end === -1) throw new SpoolParseError('there is no line "--"');
    const equals = line.indexOf('=');
    if (equals === -1) throw new SpoolParseError(`a line without "=" before "--": ${quoted(line)}`);
    const key = line.slice(0, equals);
    if (keys.has(key)) throw new SpoolParseError(`the key ${quoted(key)} appears twice`);
    keys.set(key, line.slice(equals + 1));
    start = end + 1;
  }
}

/** The launch command from the `argv_b64` value (never empty here). */
function recordedCommand(encoded: string): string[] | null {
  if (!BASE64.test(encoded)) throw new SpoolParseError('argv_b64 is not base64');
  const argv = argvFromCmdline(Buffer.from(encoded, 'base64'));
  return argv.length === 0 ? null : argv;
}

/**
 * Parses one spool file (format: plan 2.10.1). Throws SpoolParseError when: the name does not
 * match ^[0-9]+-[0-9]+-[0-9]+\.ev$; there is no line '--'; a line before it has no '='; a key
 * appears twice before it; v is not 1; event is not SessionStart or SessionEnd; time_ns is not
 * digits (or is too large for the database); boot_id is missing or empty; claude_pid is neither
 * empty nor the digits of a safe integer; argv_b64 of a SessionStart is not base64; the hook input
 * is not a JSON object; no session id (input session_id, else session_env) is a UUID.
 *
 * The hook writes a value that contained a newline or a carriage return as empty, and a claude_pid
 * that is not all digits as empty (name part 0), so pwd, session_env and entrypoint_env may be
 * empty: empty means "unknown", never a valid value. Keys other than v, event, time_ns and boot_id
 * may be missing, with the same meaning; keys this version does not know are ignored.
 *
 * The launch command is normalised: `argv` is storableArgv(absolutizePathFlags(recorded, cwd,
 * exists)), so no positional argument, no removed flag (with its values) and no value of an unknown
 * flag is stored. `scripted` is set from the command as recorded. `exists` is used only by
 * absolutizePathFlags.
 */
export function parseSpoolFile(
  name: string,
  content: string,
  exists: (path: string) => boolean,
): SpoolEvent {
  if (!NAME.test(name)) throw new SpoolParseError(`not a spool file name: ${quoted(name)}`);
  const { keys, payload } = splitFile(content);

  if (keys.get('v') !== '1') throw new SpoolParseError('v is not 1');
  const event = keys.get('event');
  if (event !== 'SessionStart' && event !== 'SessionEnd') {
    throw new SpoolParseError('event is neither SessionStart nor SessionEnd');
  }
  const time = keys.get('time_ns');
  if (time === undefined || !DIGITS.test(time)) throw new SpoolParseError('time_ns is not digits');
  const timeNs: Ns = BigInt(time);
  if (timeNs > INT64_MAX) throw new SpoolParseError('time_ns is too large');
  const bootId = keys.get('boot_id');
  if (bootId === undefined || bootId === '') throw new SpoolParseError('boot_id is empty');
  const pidText = keys.get('claude_pid') ?? '';
  if (pidText !== '' && !DIGITS.test(pidText))
    throw new SpoolParseError('claude_pid is not digits');
  const pid = pidText === '' ? 0 : Number(pidText);
  if (!Number.isSafeInteger(pid)) throw new SpoolParseError('claude_pid is too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new SpoolParseError('the hook input is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SpoolParseError('the hook input is not a JSON object');
  }
  const input = parsed as Record<string, unknown>;

  const sessionId = uuid(input['session_id']) ?? uuid(keys.get('session_env'));
  if (sessionId === null) throw new SpoolParseError('there is no session id');

  const isStart = event === 'SessionStart';
  const received = isStart ? input['source'] : input['reason'];
  const rawDetail = typeof received === 'string' ? received : null;
  const table = isStart ? START_DETAILS : END_DETAILS;
  const detail =
    (rawDetail !== null && Object.hasOwn(table, rawDetail) ? table[rawDetail] : undefined) ??
    (isStart ? 'unknown' : 'other');

  const cwd = nonEmpty(input['cwd']) ?? nonEmpty(keys.get('pwd'));
  const entrypointEnv = nonEmpty(keys.get('entrypoint_env'));
  const encoded = isStart ? (keys.get('argv_b64') ?? '') : '';
  const recorded = encoded === '' ? null : recordedCommand(encoded);

  return {
    spoolName: name,
    timeNs,
    kind: isStart ? 'start' : 'end',
    detail,
    rawDetail,
    sessionId,
    bootId,
    pid,
    procStart: pid === 0 ? null : procStartFromStat(keys.get('stat') ?? ''),
    cwd,
    argv: recorded === null ? null : storableArgv(absolutizePathFlags(recorded, cwd, exists)),
    name: isStart ? nonEmpty(input['session_title']) : null,
    payload,
    entrypointEnv,
    scripted:
      (recorded !== null && isPrintRun(recorded)) ||
      (entrypointEnv !== null && entrypointEnv !== 'cli'),
  };
}
