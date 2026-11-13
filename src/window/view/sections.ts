/**
 * The parts of the window's view model (S2 12.1, 12.2, stage A): which section a row is in, one
 * row as the page receives it, and the project directories the new form offers. Pure.
 *
 * Imports (S2 4.3, plan A8): types of `sessions`, the window's message and hub types, and `text`.
 */
import type { Ns } from '../../platform/types.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { TerminalInfo, TerminalState } from '../hub.ts';
import type { RowPayload } from '../protocol.ts';

/** S2 12.1: This week holds what was last active at most 7 days ago. */
const WEEK_NS: Ns = 7n * 86_400n * 1_000_000_000n;

/** The note lines a row carries (S2 8.2.3: "the note's first three lines"). */
const NOTE_HEAD_LINES = 3;

/** A terminal in these states may still come to hold a session (S2 7.5); one that ended, was lost or
 *  never started has no program that could. */
const MAY_START: ReadonlySet<TerminalState> = new Set([
  'starting',
  'running',
  'reconnecting',
  'newer-keeper',
]);

/**
 * S2 12.1: Open for a row that is open (running or starting, in the window or elsewhere: the caller
 * knows the terminals); else This week when its last activity is at most 7 days before `nowNs` (or
 * after it: the clock can step back); else Earlier.
 */
export function sectionOf(row: ListRow, nowNs: Ns, isOpen: boolean): 'open' | 'week' | 'earlier' {
  if (isOpen) {
    return 'open';
  }
  return nowNs - row.lastActivityNs <= WEEK_NS ? 'week' : 'earlier';
}

/**
 * The first lines of a note as `show` prints a note (design 7.4): split at every line break (a
 * lone carriage return too), each line sanitised, a line that is nothing once sanitised empty,
 * empty lines at the start dropped; then at most three.
 */
function noteHead(note: string | null): string[] {
  if (note === null) {
    return [];
  }
  const lines = note.split(/\r\n|\r|\n/).map((line) => {
    const clean = sanitize(line);
    return clean.trim() === '' ? '' : clean;
  });
  const first = lines.findIndex((line) => line !== '');
  if (first === -1) {
    return [];
  }
  const head = lines.slice(first, first + NOTE_HEAD_LINES);
  while (head.at(-1) === '') {
    head.pop();
  }
  return head;
}

/**
 * One row as the page receives it (S2 8.2.3): the list row's display fields (its strings were
 * sanitised when the list model was built; the note is sanitised here, line by line), and the
 * window's own: `terminal` and `slot` from the terminal the row is shown with, `elsewhere` with the
 * holder's pid, its terminal device (sanitised: it is read from /proc) and the row's directory
 * (S2 7.9), and `starting` when that terminal's program
 * holds no session yet and may still come to (S2 7.5) while the session is not running. Stage A has
 * no attention and no stacks.
 */
export function rowPayload(
  row: ListRow,
  extra: { terminal: TerminalInfo | null; elsewhere: { pid: number; tty: string | null } | null },
): RowPayload {
  const { terminal, elsewhere } = extra;
  return {
    id: row.id,
    shortId: row.shortId,
    title: row.title,
    titleSource: row.titleSource,
    group: row.group,
    groupSource: row.groupSource,
    state: row.state,
    stateDetail: row.stateDetail,
    sinceNs: String(row.sinceNs),
    lastActivityNs: String(row.lastActivityNs),
    dir: row.dir,
    marks: [...row.marks],
    hasNote: row.hasNote,
    noteHead: noteHead(row.note),
    done: row.done,
    prs: row.prs.map((pr) => ({
      url: pr.url,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      level: pr.level,
      error: pr.error,
    })),
    chip: row.chip === null ? null : { level: row.chip.level, count: row.chip.count },
    terminal: terminal?.id ?? null,
    slot: terminal?.slot ?? null,
    elsewhere:
      elsewhere === null
        ? null
        : {
            pid: elsewhere.pid,
            tty: elsewhere.tty === null ? null : sanitize(elsewhere.tty),
            dir: row.dir,
          },
    starting:
      terminal !== null &&
      terminal.sessionId === null &&
      MAY_START.has(terminal.state) &&
      row.state === 'not-running',
    attention: null,
    stack: null,
  };
}

/**
 * The known project directories for the new form (S2 12.6), most recently active first, each once
 * (ties by name). A directory is offered only as it really is: one the sanitiser changes (a control
 * character, a line break) is left out, since the form would show one path and start another, and
 * so is one that is not absolute, which `prepareNew` refuses.
 */
export function projectDirs(rows: readonly ListRow[]): string[] {
  const latest = new Map<string, Ns>();
  for (const row of rows) {
    const dir = row.session.dir;
    if (dir === null || row.dir !== dir || !dir.startsWith('/')) {
      continue;
    }
    const seen = latest.get(dir);
    if (seen === undefined || row.lastActivityNs > seen) {
      latest.set(dir, row.lastActivityNs);
    }
  }
  return [...latest]
    .sort(([a, aNs], [b, bNs]) => (aNs === bNs ? (a < b ? -1 : a > b ? 1 : 0) : aNs > bNs ? -1 : 1))
    .map(([dir]) => dir);
}
