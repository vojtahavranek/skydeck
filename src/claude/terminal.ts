/**
 * What Claude Code puts into the environment of the programs it starts (S2 7.4, principle 9).
 * The window removes these from the environment of every terminal's program, so that no program
 * in the window looks like another session's child or carries its messaging token.
 *
 * And what a change of a live-session file means for a turn end (S2 10.3), as pure functions over
 * the files a look read: the server's attention reads them, this module only judges.
 */
import type { Ns } from '../platform/types.ts';

/**
 * S2 7.4's list, names only (never a prefix): `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CONFIG_DIR`
 * are the user's own settings and must pass. To be confirmed by check W23.
 */
export const CLAUDE_CHILD_VARIABLES: readonly string[] = Object.freeze([
  // Known: in a hook's environment (design 14).
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  // Known: in the environment of a Claude Code session's command (seen 2026-11-13).
  'CLAUDECODE',
  // Seen in the environment of a Claude Code session's command; origin not yet known.
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_EFFORT',
]);

/**
 * A live-session file as a look takes it: read whole, parsed and trusted (S2 10.3). `sinceNs`:
 * its statusUpdatedAt, else updatedAt.
 */
export interface LookedFile {
  pid: number;
  procStart: number;
  sessionId: string;
  status: string | null;
  waitingFor: string | null;
  sinceNs: Ns | null;
}

/** The statuses a turn is in: a dialog opened inside the turn (`waiting`) is still the turn. */
const IN_A_TURN: ReadonlySet<string | null> = new Set(['busy', 'waiting']);

/**
 * S2 10.3: the same pid, process start and session, and the status went from `busy` or `waiting`
 * to `idle`. `busy` → `waiting` is not; another session (/clear) or another process start is not
 * (it starts over).
 */
export function isTurnEnd(before: LookedFile, after: LookedFile): boolean {
  return (
    before.pid === after.pid &&
    before.procStart === after.procStart &&
    before.sessionId === after.sessionId &&
    IN_A_TURN.has(before.status) &&
    after.status === 'idle'
  );
}

/**
 * One look (S2 10.3, B4). `files`: those read at this look, at most one per pid (`readLiveFiles`
 * reads `<pid>.json`); `gone`: the baselines' pids that /proc says have no process, or a process
 * with another start than the baseline's (the caller judges).
 * A pid with no file keeps its baseline unless it is gone; a file is the new baseline of its pid
 * (and is judged against the old one whatever `gone` says: `gone` speaks of pids without a file);
 * `first` (the server's first look) sets baselines only. `ends`: the turn ends of this look, in the
 * order of `files`, with the file's `sinceNs` (null: the caller uses its clock, "the time it saw
 * the change"). The arguments are left as they are.
 */
export function lookAt(
  baselines: ReadonlyMap<number, LookedFile>,
  files: readonly LookedFile[],
  gone: ReadonlySet<number>,
  first: boolean,
): {
  baselines: Map<number, LookedFile>;
  ends: { pid: number; sessionId: string; atNs: Ns | null }[];
} {
  const read = new Set(files.map((file) => file.pid));
  const next = new Map<number, LookedFile>();
  for (const [pid, baseline] of baselines) {
    if (read.has(pid) || !gone.has(pid)) {
      next.set(pid, baseline);
    }
  }
  const ends: { pid: number; sessionId: string; atNs: Ns | null }[] = [];
  for (const file of files) {
    const before = next.get(file.pid);
    if (!first && before !== undefined && isTurnEnd(before, file)) {
      ends.push({ pid: file.pid, sessionId: file.sessionId, atNs: file.sinceNs });
    }
    next.set(file.pid, file);
  }
  return { baselines: next, ends };
}
