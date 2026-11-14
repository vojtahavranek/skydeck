/**
 * Which session each terminal of the window shows, and which sessions run in another terminal
 * (S2 7.5, 7.9; plan task 21). Pure over its input: the server's tick (task 23) passes the
 * registry's terminals, the derived sessions of its refresh, /proc, the boot id and the clock, and
 * hands the result to `registry.setSession` and the view model.
 */
import { parentPidFromStat, procStartFromStat } from '../claude/procstat.ts';
import type { Ns, Proc } from '../platform/types.ts';
import type { DerivedSession, Holder } from '../sessions/types.ts';
import type { TerminalInfo } from './hub.ts';

export interface Mapping {
  /** termId → the session it shows, null while starting. */
  shown: ReadonlyMap<string, string | null>;
  /** Terminals past restoreStartTimeoutSeconds without a holder. */
  notReported: ReadonlySet<string>;
  /** Running sessions none of whose holders belongs to a terminal, with the first holder's pid and tty. */
  elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }>;
}

/** S2 7.5: a holder belongs to a terminal when the program is at most this many parents above it. */
const MAX_STEPS = 8;

/** The terminal a holder belongs to, and how many steps up its program is (0: the holder itself). */
interface Belonging {
  termId: string;
  steps: number;
}

/**
 * S2 7.5: walks up from the holder's process — the holder itself, then its parent, at most
 * MAX_STEPS parents — until it reaches a terminal's program (pid AND process start). Each step is
 * judged alive by design 5.5's rule: its stat line exists and its start is the one known for it (the
 * holder's recorded start; for a parent, the start its own stat line gives, which may not be later
 * than its child's — a parent that started after its child is another process that took a pid
 * freed meanwhile). A stat line that cannot be read, or a step that is not alive, ends the walk:
 * the holder belongs to no terminal.
 */
function belongingOf(
  holder: Holder,
  programs: ReadonlyMap<number, { procStart: number; termId: string }>,
  proc: Proc,
): Belonging | null {
  let pid = holder.process.pid;
  let start = holder.process.procStart;
  for (let steps = 0; start !== null; steps++) {
    const program = programs.get(pid);
    if (program !== undefined && program.procStart === start) {
      return { termId: program.termId, steps };
    }
    if (steps === MAX_STEPS) {
      return null;
    }
    let stat: string | null;
    let parentStat: string | null;
    let parent: number | null;
    try {
      stat = proc.stat(pid);
      if (stat === null || procStartFromStat(stat) !== start) {
        return null; // gone, or another process now has the pid
      }
      parent = parentPidFromStat(stat);
      if (parent === null || parent <= 1) {
        return null; // no parent, or init: the chain has left every terminal
      }
      parentStat = proc.stat(parent);
    } catch {
      return null; // a /proc read failed: nothing is decided on it
    }
    const parentStart = parentStat === null ? null : procStartFromStat(parentStat);
    if (parentStart === null || parentStart > start) {
      return null;
    }
    pid = parent;
    start = parentStart;
  }
  return null;
}

/**
 * S2 7.5 and 7.9 for every terminal and every running session:
 *
 * - A terminal's program is the process its keeper reported (`program`), while the terminal has no
 *   exit; a holder of the current boot (`bootId`; none without one) belongs to the terminal whose
 *   program it is or descends from (`belongingOf`).
 * - `shown`: of the holders that belong to a terminal, the one nearest its program decides (a
 *   scripted run that the program started does not move it), then the latest event, then the
 *   session id. A terminal none of whose holders belongs to it keeps the session it showed
 *   (`sessionId` of its input) — it is starting only until a holder first appears ("no holder
 *   yet"): between the end and the start of `/clear`, and after its program ended, it stays with
 *   its session — else null.
 * - `notReported`: a terminal with a program, no exit and nothing shown, opened `startTimeoutNs`
 *   or longer before `nowNs`.
 * - `elsewhere`: a session with holders none of which belongs to a terminal, with its first
 *   holder's pid (holders are latest first) and the target of that process's fd 0, null when it
 *   cannot be read.
 */
export function mapTerminals(input: {
  terminals: readonly TerminalInfo[];
  sessions: readonly DerivedSession[];
  proc: Proc;
  bootId: string | null;
  nowNs: Ns;
  startTimeoutNs: Ns;
}): Mapping {
  const { terminals, sessions, proc, bootId, nowNs, startTimeoutNs } = input;
  const programs = new Map<number, { procStart: number; termId: string }>();
  for (const terminal of terminals) {
    if (terminal.program !== null && terminal.exit === null) {
      programs.set(terminal.program.pid, {
        procStart: terminal.program.procStart,
        termId: terminal.id,
      });
    }
  }

  /** termId → the holder that decides what the terminal shows so far. */
  const best = new Map<string, { sessionId: string; steps: number; sinceNs: Ns }>();
  const elsewhere = new Map<string, { pid: number; tty: string | null }>();
  for (const session of sessions) {
    if (session.holders.length === 0) {
      continue;
    }
    let inTerminal = false;
    for (const holder of session.holders) {
      if (bootId === null || holder.process.bootId !== bootId || programs.size === 0) {
        continue;
      }
      const belonging = belongingOf(holder, programs, proc);
      if (belonging === null) {
        continue;
      }
      inTerminal = true;
      const current = best.get(belonging.termId);
      const candidate = { sessionId: session.id, steps: belonging.steps, sinceNs: holder.sinceNs };
      if (current === undefined || nearer(candidate, current)) {
        best.set(belonging.termId, candidate);
      }
    }
    if (!inTerminal) {
      const first = session.holders[0];
      if (first !== undefined) {
        elsewhere.set(session.id, {
          pid: first.process.pid,
          tty: proc.fdTarget(first.process.pid, 0),
        });
      }
    }
  }

  const shown = new Map<string, string | null>();
  const notReported = new Set<string>();
  for (const terminal of terminals) {
    const sessionId = best.get(terminal.id)?.sessionId ?? terminal.sessionId;
    shown.set(terminal.id, sessionId);
    if (
      sessionId === null &&
      terminal.program !== null &&
      terminal.exit === null &&
      nowNs - terminal.openedNs >= startTimeoutNs
    ) {
      notReported.add(terminal.id);
    }
  }
  return { shown, notReported, elsewhere };
}

/** Nearer the program first, then the later event, then the lower session id. */
function nearer(
  a: { sessionId: string; steps: number; sinceNs: Ns },
  b: { sessionId: string; steps: number; sinceNs: Ns },
): boolean {
  if (a.steps !== b.steps) return a.steps < b.steps;
  if (a.sinceNs !== b.sinceNs) return a.sinceNs > b.sinceNs;
  return a.sessionId < b.sessionId;
}
