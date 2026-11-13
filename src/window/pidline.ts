/**
 * The `.pid` lines of the runtime directory (S2 4.2): `server.pid`, `keepalive.pid` and
 * `terms/<id>.pid`. The line, exactly, with one '\n' at the end:
 *   server.pid, keepalive.pid:  "4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
 *   terms/<id>.pid (a keeper): "4242 51234567 6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f 1 0"
 * — pid, process start (field 22), boot id, and for a keeper its KEEPER_VERSION and started 0|1,
 * separated by one space. The keep-alive script (sh) and the keeper (python) write and read the
 * same form. A reader judges a line by design 5.5's liveness rule, never by the pid alone.
 */

import { procStartFromStat } from '../claude/procstat.ts';
import type { Proc } from '../platform/types.ts';

export interface PidLine {
  pid: number;
  procStart: number;
  bootId: string;
  keeper?: { version: string; started: boolean };
}

/**
 * Contract 2.8: pid and process start are decimal integers; the boot id and a keeper's version are
 * any token without whitespace (tests invent their own boot ids); started is 0 or 1.
 */
const LINE = /^([0-9]+) ([0-9]+) (\S+)(?: (\S+) ([01]))?\n?$/;

/** The decimal text as a number, or null when it is beyond what a number holds exactly. */
function safeInteger(text: string): number | null {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A text field that would break the line: empty, or holding whitespace (a separator, a newline). */
function breaksLine(field: string): boolean {
  return field === '' || /\s/.test(field);
}

/**
 * The line with its one '\n'. Throws for a field that would break the line or that no reader
 * accepts: a pid that is not a positive whole number, a process start that is not a non-negative
 * whole number (both safe integers), an empty boot id or version, or one holding whitespace.
 */
export function formatPidLine(line: PidLine): string {
  const fields = [String(line.pid), String(line.procStart), line.bootId];
  if (line.keeper !== undefined) {
    fields.push(line.keeper.version, line.keeper.started ? '1' : '0');
  }
  if (
    !Number.isSafeInteger(line.pid) ||
    line.pid < 1 ||
    !Number.isSafeInteger(line.procStart) ||
    line.procStart < 0 ||
    breaksLine(line.bootId) ||
    (line.keeper !== undefined && breaksLine(line.keeper.version))
  ) {
    throw new Error(`not a valid pid line: ${JSON.stringify(fields.join(' '))}`);
  }
  return `${fields.join(' ')}\n`;
}

/**
 * The fields of one pid line, or null for anything else (another separator, a missing or extra
 * field, a second line, a number that is not decimal digits or not a safe integer, pid 0 — a
 * signal to pid 0 would reach the caller's own process group). The final '\n' may be missing;
 * nothing else is tolerated.
 */
export function parsePidLine(text: string): PidLine | null {
  const match = LINE.exec(text);
  if (match === null) return null;
  const [, pidText, startText, bootId, version, started] = match;
  if (pidText === undefined || startText === undefined || bootId === undefined) return null;
  const pid = safeInteger(pidText);
  const procStart = safeInteger(startText);
  if (pid === null || pid < 1 || procStart === null) return null;
  const line: PidLine = { pid, procStart, bootId };
  if (version !== undefined && started !== undefined) {
    line.keeper = { version, started: started === '1' };
  }
  return line;
}

/**
 * What design 5.5's rule can say about a line: alive, dead, or unknown — it could not tell.
 * Nothing is ever removed, ended or given up on 'unknown': only 'dead' allows removing a socket or
 * a pid file.
 */
export type PidLineState = 'alive' | 'dead' | 'unknown';

/**
 * Design 5.5, three-valued. `bootId` is the current boot id, read once by the caller (null when it
 * could not be read).
 * - unknown: no current boot id; reading /proc/<pid>/stat failed (the platform threw); or the
 *   stat line exists but its process start cannot be read;
 * - dead: the line is from another boot; no process has the pid; or its process start differs
 *   (the pid was reused);
 * - alive: the boot id, the pid and the process start all match.
 */
export function pidLineState(line: PidLine, proc: Proc, bootId: string | null): PidLineState {
  if (bootId === null) return 'unknown';
  if (line.bootId !== bootId) return 'dead';
  let stat: string | null;
  try {
    stat = proc.stat(line.pid);
  } catch {
    return 'unknown';
  }
  if (stat === null) return 'dead';
  const start = procStartFromStat(stat);
  if (start === null) return 'unknown';
  return start === line.procStart ? 'alive' : 'dead';
}

/**
 * "Known alive": pidLineState is 'alive'. For showing and counting, and before signalling a
 * process. A caller that removes something of the line's owner or gives up on it uses
 * pidLineState and acts only on 'dead'.
 */
export function isPidLineAlive(line: PidLine, proc: Proc, bootId: string | null): boolean {
  return pidLineState(line, proc, bootId) === 'alive';
}
