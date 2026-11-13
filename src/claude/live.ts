// Claude Code's live-session files, `<claudeHome>/sessions/<pid>.json` (design 5.5, 6.2, 14), and
// the liveness rule that decides whether the process a file or an event names still runs.
// Read-only: skydeck never writes to these files (principle 2).
import { join } from 'node:path';

import { nsFromMs } from '../platform/time.ts';
import type { Files, Ns, Proc } from '../platform/types.ts';
import { procStartFromStat } from './procstat.ts';

/** A process as recorded: the boot it ran in, its pid, and field 22 of its stat line. */
export interface ProcessKey {
  bootId: string;
  pid: number;
  procStart: number | null;
}

/** A live-session file <claudeHome>/sessions/<pid>.json, normalised (D2). */
export interface LiveFile {
  pid: number;
  sessionId: string;
  cwd: string | null;
  procStart: number | null; // the file's procStart string parsed as an integer
  entrypoint: string | null;
  name: string | null;
  status: string | null; // 'idle' | 'busy' | 'waiting' | anything else, as found
  waitingFor: string | null;
  updatedAtNs: Ns | null; // from epoch ms
  statusUpdatedAtNs: Ns | null; // from epoch ms
  mtimeNs: Ns; // of the file
}

/** The names that are live-session files; the directory also holds credential files. */
const LIVE_FILE_NAME = /^[0-9]+\.json$/;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `text` is a session id: a lowercase UUID (8-4-4-4-12 hex digits) and nothing more. Every
 * session id skydeck takes from a Claude Code file passes through this check, because the id ends
 * up on a command line after `--resume`, where a value such as `--dangerously-skip-permissions`
 * would be read as a flag (principle 5).
 */
export function isSessionId(text: string): boolean {
  return SESSION_ID.test(text);
}

/** The largest epoch-millisecond value `Date` can show, and so the largest time skydeck converts. */
const MAX_EPOCH_MS = 8.64e15;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Epoch milliseconds (a number, D2) to Ns; null for anything else, or a time `Date` cannot show. */
function nsFromEpochMs(value: unknown): Ns | null {
  if (typeof value !== 'number' || !(value >= 0 && value <= MAX_EPOCH_MS)) {
    return null;
  }
  return nsFromMs(Math.trunc(value));
}

/** `procStart` is a decimal string (D2); a safe non-negative integer is taken as it is. */
function procStartOf(value: unknown): number | null {
  const number =
    typeof value === 'string' && /^[0-9]+$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null;
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of one file, or null when it is gone, is not a regular file, or cannot be read. */
function readSessionFile(files: Files, path: string): { text: string; mtimeNs: Ns } | null {
  try {
    const info = files.stat(path);
    if (info === null || info.kind !== 'file') {
      return null;
    }
    const text = files.readText(path);
    return text === null ? null : { text, mtimeNs: info.mtimeNs };
  } catch {
    // Unreadable (permissions): the same as a file that is not there (design 6.2, "can be read").
    return null;
  }
}

/** The names in a directory; none when it cannot be listed, like a file that cannot be read. */
function listOrEmpty(files: Files, dir: string): string[] {
  try {
    return files.list(dir);
  } catch {
    return [];
  }
}

/**
 * Reads <claudeHome>/sessions/ — only names matching ^[0-9]+\.json$ are opened (the directory also
 * holds credential files). Files that do not parse, or lack a numeric pid or a session id (a
 * lowercase UUID), are skipped, and so are files whose pid is not the number in their name and
 * files that cannot be read. An unreadable sessions directory gives []. Sorted by pid.
 */
export function readLiveFiles(files: Files, claudeHome: string): LiveFile[] {
  const dir = join(claudeHome, 'sessions');
  const result: LiveFile[] = [];
  for (const name of listOrEmpty(files, dir)) {
    if (!LIVE_FILE_NAME.test(name)) {
      continue;
    }
    const read = readSessionFile(files, join(dir, name));
    if (read === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const { pid, sessionId } = parsed;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    // The file is named by the process that wrote it; another pid inside means it is not what it
    // seems, and `04245.json` beside `4245.json` would be two files for one process.
    if (name !== `${pid}.json`) {
      continue;
    }
    if (typeof sessionId !== 'string' || !isSessionId(sessionId)) {
      continue;
    }
    result.push({
      pid,
      sessionId,
      cwd: stringOrNull(parsed.cwd),
      procStart: procStartOf(parsed.procStart),
      entrypoint: stringOrNull(parsed.entrypoint),
      name: stringOrNull(parsed.name),
      status: stringOrNull(parsed.status),
      waitingFor: stringOrNull(parsed.waitingFor),
      updatedAtNs: nsFromEpochMs(parsed.updatedAt),
      statusUpdatedAtNs: nsFromEpochMs(parsed.statusUpdatedAt),
      mtimeNs: read.mtimeNs,
    });
  }
  return result.sort((a, b) => a.pid - b.pid);
}

/** Field 22 of /proc/<pid>/stat, null when the process does not exist or the line is unreadable. */
function startOf(pid: number, proc: Proc): number | null {
  const line = proc.stat(pid);
  return line === null ? null : procStartFromStat(line);
}

/** 5.5: bootId equals currentBootId, /proc/<pid>/stat exists, and its field 22 equals procStart (non-null). */
export function isAlive(p: ProcessKey, proc: Proc, currentBootId: string | null): boolean {
  if (currentBootId === null || p.bootId !== currentBootId || p.procStart === null) {
    return false;
  }
  return startOf(p.pid, proc) === p.procStart;
}

/** 5.5: a live file is trusted when /proc/<pid>/stat exists and its field 22 equals the file's procStart. */
export function isLiveFileTrusted(f: LiveFile, proc: Proc): boolean {
  return f.procStart !== null && startOf(f.pid, proc) === f.procStart;
}
