/**
 * The parts of the window's view model (S2 12.1, 12.2, stage A): which section a row is in, one
 * row as the page receives it, and the project directories the new form offers. Pure.
 *
 * Imports (S2 4.3, plan A8): types of `sessions`, step 1's `isListed`, the window's message and hub
 * types, `text`, and the window's chip (`./chip.ts`, plan D4).
 */
import type { Ns } from '../../platform/types.ts';
import { isListed } from '../../sessions/list.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { TerminalInfo, TerminalState } from '../hub.ts';
import type { RowPayload } from '../protocol.ts';
import { windowChip } from './chip.ts';

/** S2 12.1: Recent (key `week`) holds what was last active at most 7 days ago. */
const WEEK_NS: Ns = 7n * 86_400n * 1_000_000_000n;

/** The note lines a row carries (S2 8.2.3: "the note's first three lines"). */
const NOTE_HEAD_LINES = 3;

/** The longest note line a row carries, in UTF-16 units, the ellipsis included (ruled, #45): a
 *  note can be any length, and the list message is sent whole on every change. */
const NOTE_LINE_MAX = 1024;

/** A terminal in these states may still come to hold a session (S2 7.5); one that ended, was
 *  lost or never started has no program that could. Shared inside the view model (ruled, #45):
 *  `rowPayload`'s `starting` and `buildListMessage`'s choice of a row's terminal read this one set.
 *  THE PAGE COPIES IT (web/pane.js, `MAY_START`, held equal by test/web/pane.test.ts: which line ←
 *  and a caption click say on a block an unreported terminal holds open, F6); a change of one is a
 *  change of the other. */
export const MAY_START: ReadonlySet<TerminalState> = new Set([
  'starting',
  'running',
  'reconnecting',
  'newer-keeper',
]);

/**
 * S2 12.1: Open for a row that is open (running or starting, in the window or elsewhere: the caller
 * knows the terminals); else Recent (key `week`) when its last activity is at most 7 days before
 * `nowNs` (or after it: the clock can step back); else Earlier.
 */
export function sectionOf(row: ListRow, nowNs: Ns, isOpen: boolean): 'open' | 'week' | 'earlier' {
  if (isOpen) {
    return 'open';
  }
  return nowNs - row.lastActivityNs <= WEEK_NS ? 'week' : 'earlier';
}

/** `line` cut to NOTE_LINE_MAX units with the cut marked by '…', never inside a surrogate pair. */
function capLine(line: string): string {
  if (line.length <= NOTE_LINE_MAX) {
    return line;
  }
  let cut = NOTE_LINE_MAX - 1;
  const last = line.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return `${line.slice(0, cut)}…`;
}

/**
 * The first lines of a note as `show` prints a note (design 7.4): split at every line break (a
 * lone carriage return too), each line sanitised, a line that is nothing once sanitised empty,
 * empty lines at the start and the end dropped; then at most three, each capped (`capLine`).
 */
function noteHead(note: string | null): string[] {
  if (note === null) {
    return [];
  }
  const head: string[] = [];
  for (const line of note.split(/\r\n|\r|\n/)) {
    const clean = sanitize(line);
    if (clean.trim() === '') {
      if (head.length > 0) {
        head.push('');
      }
    } else {
      head.push(capLine(clean));
    }
    if (head.length === NOTE_HEAD_LINES) {
      break;
    }
  }
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
 * holds no session yet and may still come to (S2 7.5) while the session is not running. Each pull
 * request carries its level and its last successful read (`okAtNs`); the chip is the window's
 * (S2 12.3, `windowChip`), not design 7.3's of `ls`. Stage A has no attention and no stacks.
 * F19: `ticketStatus` is the session's ticket status while one is known — its name, its text and
 * its category —, else null (the row's chip is not drawn).
 */
export function rowPayload(
  row: ListRow,
  extra: { terminal: TerminalInfo | null; elsewhere: { pid: number; tty: string | null } | null },
): RowPayload {
  const { terminal, elsewhere } = extra;
  const prs = row.prs.map((pr) => ({
    url: pr.url,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    level: pr.level,
    error: pr.error,
    okAtNs: pr.okAtNs === null ? null : String(pr.okAtNs),
  }));
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
    prs,
    chip: windowChip(prs),
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
    ticketStatus:
      row.ticketStatus?.status == null
        ? null
        : {
            name: row.ticketStatus.name,
            status: row.ticketStatus.status,
            category: row.ticketStatus.category,
          },
  };
}

/**
 * The known project directories for the new form (S2 12.6), most recently active first, each once
 * (ties by name), of the rows step 1 lists (`isListed` with done ones: no scripted run's temporary
 * directory; ruled, #45). A directory is offered only as it really is: one the sanitiser changes
 * (a control character, a line break) is left out, since the form would show one path and start
 * another, and so is one that is not absolute, which `prepareNew` refuses.
 */
export function projectDirs(rows: readonly ListRow[]): string[] {
  const latest = new Map<string, Ns>();
  for (const row of rows) {
    const dir = row.session.dir;
    if (dir === null || row.dir !== dir || !dir.startsWith('/') || !isListed(row, true)) {
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
