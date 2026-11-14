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
  /**
   * Ruled by the plan owner (task 21, review 1): the sessions with a holder whose chain could not
   * be read (design 5.5's "unknown": a /proc read that failed, a stat line without a readable
   * process start or parent, no boot id). Such a session is not put into `elsewhere` by this pass
   * and is not given to a terminal by that holder; in a pass where this set is not empty no terminal
   * is newly put into `notReported` (the unread holder may be its holder). A consumer keeps the
   * previous pass's answer for a session in `unknown` and takes no action that rests on it (task
   * 23's tick: no terminal is closed because "its session runs elsewhere", nothing is marked not
   * reported).
   */
  unknown: ReadonlySet<string>;
}

/** S2 7.5: a holder belongs to a terminal when the program is at most this many parents above it. */
const MAX_STEPS = 8;

/**
 * Where a holder is: in a terminal (its program `steps` parents up, 0 being the holder itself),
 * outside every terminal, gone (it is dead: no holder at all), or unknown (its chain could not be
 * read).
 */
type Place = { termId: string; steps: number } | 'outside' | 'gone' | 'unknown';

/**
 * S2 7.5: walks up from the holder's process — the holder itself, then its parent, at most
 * MAX_STEPS parents — until it reaches a terminal's program (pid AND process start). Each step is
 * judged alive by design 5.5's rule: its stat line exists and its start is the one known for it (the
 * holder's recorded start; for a parent, the start its own stat line gives, which may not be later
 * than its child's — a parent that started after its child is another process that took a pid
 * freed meanwhile). The holder itself is judged first, also when there is no terminal: when its
 * stat line is gone or names another start it is dead by design 5.5 — 'gone', running nowhere
 * (review 2: sessions derived a moment before the terminals or /proc were read). A parent that is
 * gone or not alive, a chain that leaves through init or goes on past MAX_STEPS, is 'outside' (the
 * holder lives). A read that throws, a stat line without a readable process start or parent, or a
 * holder without a recorded start is 'unknown': nothing is decided on it (design 5.5; ruled).
 */
function placeOf(
  holder: Holder,
  programs: ReadonlyMap<number, { procStart: number; termId: string }>,
  proc: Proc,
): Place {
  let pid = holder.process.pid;
  let start = holder.process.procStart;
  if (start === null) {
    return 'unknown';
  }
  for (let steps = 0; ; steps++) {
    const program = programs.get(pid);
    if (program !== undefined && program.procStart === start) {
      return { termId: program.termId, steps };
    }
    if (steps === MAX_STEPS) {
      return 'outside';
    }
    let stat: string | null;
    let parentStat: string | null;
    try {
      stat = proc.stat(pid);
      if (stat === null) {
        return steps === 0 ? 'gone' : 'outside'; // no such process
      }
      const own = procStartFromStat(stat);
      const parent = parentPidFromStat(stat);
      if (own === null || parent === null) {
        return 'unknown';
      }
      if (own !== start) {
        return steps === 0 ? 'gone' : 'outside'; // another process now has the pid
      }
      if (programs.size === 0) {
        return 'outside'; // alive, and no terminal to reach
      }
      if (parent <= 1) {
        return 'outside'; // no parent, or init: the chain has left every terminal
      }
      parentStat = proc.stat(parent);
      if (parentStat === null) {
        return 'outside'; // the parent is gone (the child is being given to init)
      }
      const parentStart = procStartFromStat(parentStat);
      if (parentStart === null) {
        return 'unknown';
      }
      if (parentStart > start) {
        return 'outside';
      }
      pid = parent;
      start = parentStart;
    } catch {
      return 'unknown'; // a /proc read failed: nothing is decided on it
    }
  }
}

/**
 * S2 7.5 and 7.9 for every terminal and every running session:
 *
 * - A terminal's program is the process its keeper reported (`program`), while the terminal has no
 *   exit; a holder of the current boot belongs to the terminal whose program it is or descends from
 *   (`placeOf`). A holder of another boot is no live holder and is left out. Without a boot id no
 *   holder can be judged: each is unknown.
 * - `shown`: of the holders that belong to a terminal, the one nearest its program decides (a
 *   scripted run that the program started does not move it), then the latest event, then the
 *   session id. A terminal none of whose holders belongs to it keeps the session it showed
 *   (`sessionId` of its input) — it is starting only until a holder first appears ("no holder
 *   yet"): between the end and the start of `/clear`, and after its program ended, it stays with
 *   its session — else null.
 * - `notReported`: a terminal with a program, no exit and nothing shown, opened `startTimeoutNs`
 *   or longer before `nowNs`. While `unknown` is not empty, or without a boot id, no terminal is
 *   added: only one already marked (its input's `notReported`) stays marked.
 * - `elsewhere`: a session with a live holder outside every terminal, none in one and none unknown,
 *   with the first such holder's pid (holders are latest first) and the target of that process's fd 0,
 *   null when it cannot be read.
 * - `unknown`: see Mapping (ruled).
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
  const unknown = new Set<string>();
  for (const session of sessions) {
    let inTerminal = false;
    let outside: Holder | null = null;
    for (const holder of session.holders) {
      if (bootId !== null && holder.process.bootId !== bootId) {
        continue; // of another boot: not alive now
      }
      const place: Place = bootId === null ? 'unknown' : placeOf(holder, programs, proc);
      if (place === 'gone') {
        continue; // dead since the sessions were derived: it holds nothing
      }
      if (place === 'unknown') {
        unknown.add(session.id);
      } else if (place === 'outside') {
        outside ??= holder;
      } else {
        inTerminal = true;
        const current = best.get(place.termId);
        const candidate = { sessionId: session.id, steps: place.steps, sinceNs: holder.sinceNs };
        if (current === undefined || nearer(candidate, current)) {
          best.set(place.termId, candidate);
        }
      }
    }
    if (!inTerminal && !unknown.has(session.id) && outside !== null) {
      const { pid } = outside.process;
      elsewhere.set(session.id, { pid, tty: proc.fdTarget(pid, 0) });
    }
  }

  // Without a boot id derive saw no holder at all, so an empty `unknown` proves nothing either.
  const decided = unknown.size === 0 && bootId !== null;
  const shown = new Map<string, string | null>();
  const notReported = new Set<string>();
  for (const terminal of terminals) {
    const sessionId = best.get(terminal.id)?.sessionId ?? terminal.sessionId;
    shown.set(terminal.id, sessionId);
    if (
      sessionId === null &&
      terminal.program !== null &&
      terminal.exit === null &&
      nowNs - terminal.openedNs >= startTimeoutNs &&
      (decided || terminal.notReported)
    ) {
      notReported.add(terminal.id);
    }
  }
  return { shown, notReported, elsewhere, unknown };
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
