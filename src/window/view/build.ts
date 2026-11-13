/**
 * The window's view model (S2 12, stage A): the rows step 1 loads, the window's terminals and one
 * page's view state become that page's `list` message. Pure: it needs nothing but its input.
 *
 * Imports (S2 4.3, plan A8): types of `sessions`, step 1's `isListed` and `matchesFilter` (stage
 * A's filter is design 7.4's, one implementation), the window's message and hub types, and `text`.
 */
import type { Ns } from '../../platform/types.ts';
import { isListed, matchesFilter } from '../../sessions/list.ts';
import type { ListRow } from '../../sessions/list.ts';
import type { DerivedSession } from '../../sessions/types.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { TerminalInfo } from '../hub.ts';
import type {
  ListMessage,
  RowPayload,
  SectionPayload,
  SelectedPayload,
  TerminalPayload,
} from '../protocol.ts';
import { MAY_START, projectDirs, rowPayload, sectionOf } from './sections.ts';

export interface ViewInput {
  rows: readonly ListRow[];
  terminals: readonly TerminalInfo[];
  /** Holders that belong to no terminal of the window, by session id (from the mapping, task 21). */
  elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }>;
  view: { filter: string; unfolded: readonly string[]; showDone: boolean; selected: string | null };
  /** The resume card of the selected row (task 32's selectedPayload). */
  selected: SelectedPayload | null;
  nowNs: Ns;
}

/** Design 7.4: the short id is the first 8 characters of the id. */
const SHORT_ID_LENGTH = 8;

type SectionName = SectionPayload['name'];
const SECTIONS: readonly SectionName[] = ['open', 'week', 'earlier'];

/** One row of the message and what places it. */
interface Entry {
  row: ListRow;
  terminal: TerminalInfo | null;
  payload: RowPayload;
}

function compareNs(a: Ns, b: Ns): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Slot 1–9 first, by slot; then terminals without a slot by opening time (S2 7.6, 12.1). */
function compareTerminals(a: TerminalInfo, b: TerminalInfo): number {
  if (a.slot !== b.slot) {
    if (a.slot === null || b.slot === null) {
      return a.slot === null ? 1 : -1;
    }
    return a.slot - b.slot;
  }
  return compareNs(a.openedNs, b.openedNs) || compareText(a.id, b.id);
}

/** Which terminal a session's row gets when several want it: one whose program may still run
 *  first (an ended terminal never hides the one that resumed the session again), then one that
 *  shows the session before one still waiting for it. */
function claimRank(terminal: TerminalInfo): number {
  return (MAY_START.has(terminal.state) ? 0 : 2) + (terminal.sessionId === null ? 1 : 0);
}

/**
 * The terminal each session's row is shown with. A terminal goes to the session it shows (S2 7.5)
 * or, while its program holds none, to the session it was opened for; of several, the first by
 * `claimRank`, then by slot and opening time. A terminal whose session already has one is on no
 * row (the page still has it in `terminals`).
 */
function terminalsBySession(terminals: readonly TerminalInfo[]): Map<string, TerminalInfo> {
  const ordered = [...terminals].sort(
    (a, b) => claimRank(a) - claimRank(b) || compareTerminals(a, b),
  );
  const bySession = new Map<string, TerminalInfo>();
  for (const terminal of ordered) {
    const sessionId = terminal.sessionId ?? terminal.expectedSessionId;
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, terminal);
    }
  }
  return bySession;
}

/**
 * A8 / A28: the row of a terminal opened for `new` whose session has no row yet: the new session's
 * id, titled with the label or "new session in <dir>", last active when the terminal was opened.
 * It is a list row like the others, so that the filter, the sections and the payload treat it
 * alike; it is listed for as long as its terminal is there.
 */
function newSessionRow(terminal: TerminalInfo): ListRow {
  const id = terminal.expectedSessionId;
  const label = terminal.label === null ? '' : sanitize(terminal.label).trim();
  const dir = sanitize(terminal.dir);
  const session: DerivedSession = {
    id,
    state: 'not-running',
    stateDetail: null,
    sinceNs: terminal.openedNs,
    lastActivityNs: terminal.openedNs,
    firstSeenNs: terminal.openedNs,
    holders: [],
    marks: [],
    continuedFrom: null,
    dir: terminal.dir,
    launch: null,
    transcript: null,
    lastHolding: null,
    lastEventId: null,
    bootId: null,
    doneAtNs: null,
    hidden: false,
  };
  return {
    id,
    shortId: id.slice(0, SHORT_ID_LENGTH),
    title: label === '' ? `new session in ${dir}` : label,
    titleSource: label === '' ? 'fallback' : 'label',
    label: label === '' ? null : label,
    group: null,
    groupSource: null,
    state: 'not-running',
    stateDetail: null,
    sinceNs: terminal.openedNs,
    lastActivityNs: terminal.openedNs,
    dir,
    marks: [],
    hasNote: false,
    note: null,
    continuedFrom: null,
    done: false,
    prs: [],
    chip: null,
    session,
  };
}

/** The earliest process start among a session's holders; null when none is known. */
function startedAt(row: ListRow): number | null {
  let earliest: number | null = null;
  for (const holder of row.session.holders) {
    const start = holder.process.procStart;
    if (start !== null && (earliest === null || start < earliest)) {
      earliest = start;
    }
  }
  return earliest;
}

/**
 * S2 12.1, Open's order: the window's terminals by slot, then those without a slot by opening
 * time, then the sessions running elsewhere by the time their process started (the earliest
 * process start among the holders, unknown last). Nothing in it moves when activity changes.
 */
function compareOpen(a: Entry, b: Entry): number {
  if (a.terminal !== null || b.terminal !== null) {
    if (a.terminal === null || b.terminal === null) {
      return a.terminal === null ? 1 : -1;
    }
    return compareTerminals(a.terminal, b.terminal);
  }
  const aStart = startedAt(a.row);
  const bStart = startedAt(b.row);
  if (aStart !== bStart) {
    if (aStart === null || bStart === null) {
      return aStart === null ? 1 : -1;
    }
    return aStart - bStart;
  }
  return compareText(a.row.id, b.row.id);
}

/** This week and Earlier: the most recent first, ties by id. */
function compareRecent(a: Entry, b: Entry): number {
  return compareNs(b.row.lastActivityNs, a.row.lastActivityNs) || compareText(a.row.id, b.row.id);
}

function sectionPayload(
  name: SectionName,
  entries: readonly Entry[],
  folded: boolean,
): SectionPayload {
  let firstNs: Ns | null = null;
  let lastNs: Ns | null = null;
  for (const { row } of entries) {
    if (firstNs === null || row.lastActivityNs < firstNs) {
      firstNs = row.lastActivityNs;
    }
    if (lastNs === null || row.lastActivityNs > lastNs) {
      lastNs = row.lastActivityNs;
    }
  }
  return {
    name,
    folded,
    firstNs: firstNs === null ? null : String(firstNs),
    lastNs: lastNs === null ? null : String(lastNs),
    count: entries.length,
    rows: folded ? [] : entries.map((entry) => entry.payload),
  };
}

/**
 * The `list` message for one page, without each terminal's `ownsSize` (the page's, task 17).
 *
 * - Listed (design 7.2 through `isListed`): done sessions only with `showDone`; a session that is
 *   open — running, or starting in a terminal of the window — whatever its done mark (S2 12.10);
 *   the row of a `new` terminal's own session while the terminal is there, one of its own when
 *   the session has none yet (A28), unless it is done and stopped.
 * - Sections (S2 12.1, `sectionOf`): Open, This week, Earlier; Earlier folded unless the view
 *   unfolds it or a filter is set (S2 12.8, ruled), a folded one with its count and time span and
 *   no rows.
 * - The filter (design 7.4, `matchesFilter`) chooses the rows of the sections and `doneHidden`; it
 *   never shows a done session in stage A. `counts` are the title bar's: every listed row once,
 *   by state, the starting ones and those running elsewhere apart, whatever the filter.
 * - `selected` is the resume card given only when it is the card of the view's selected session.
 */
export function buildListMessage(
  input: ViewInput,
): Omit<ListMessage, 'terminals'> & { terminals: Omit<TerminalPayload, 'ownsSize'>[] } {
  const { view, nowNs } = input;
  const bySession = terminalsBySession(input.terminals);
  const known = new Set(input.rows.map((row) => row.id));
  const candidates: ListRow[] = [...input.rows];
  for (const [sessionId, terminal] of bySession) {
    if (
      terminal.kind === 'new' &&
      sessionId === terminal.expectedSessionId &&
      !known.has(sessionId)
    ) {
      candidates.push(newSessionRow(terminal));
    }
  }

  const counts = { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 };
  const shown = new Map<SectionName, Entry[]>(SECTIONS.map((name) => [name, []]));
  let doneHidden = 0;
  for (const row of candidates) {
    const claimed = bySession.get(row.id) ?? null;
    // A terminal whose program is gone stays with a session that is not running (the ended bar,
    // S2 7.8), not with one that runs again elsewhere: that row shows the card of 7.9 (S2 12.6).
    const terminal =
      claimed !== null && (MAY_START.has(claimed.state) || row.state === 'not-running')
        ? claimed
        : null;
    const elsewhere = row.state === 'not-running' ? null : (input.elsewhere.get(row.id) ?? null);
    const payload = rowPayload(row, { terminal, elsewhere });
    const open = payload.starting || row.state !== 'not-running';
    const matches = matchesFilter(row, view.filter);
    // A `new` terminal keeps its own session's row while it is there (A28, ruled), also a row step
    // 1 does not list (a session that ended before its first prompt has no transcript); a done one
    // is hidden as any done row that stopped.
    const ownNew =
      terminal !== null && terminal.kind === 'new' && terminal.expectedSessionId === row.id;
    const listed =
      isListed(row, open || view.showDone) || (ownNew && (open || view.showDone || !row.done));
    if (!listed) {
      if (matches && (ownNew || isListed(row, true))) {
        doneHidden += 1;
      }
      continue;
    }
    if (payload.starting) {
      counts.starting += 1;
    } else if (payload.elsewhere !== null) {
      counts.elsewhere += 1;
    } else if (row.state === 'not-running') {
      counts.notRunning += 1;
    } else {
      counts[row.state] += 1;
    }
    if (matches) {
      shown.get(sectionOf(row, nowNs, open))?.push({ row, terminal, payload });
    }
  }

  // S2 12.8 (ruled for stage A): while a filter is set every section is unfolded, so that a match
  // in Earlier is seen.
  const unfolded = new Set(view.unfolded);
  const folded = (name: SectionName) =>
    name === 'earlier' && view.filter === '' && !unfolded.has(name);
  const sections = SECTIONS.map((name) => {
    const entries = shown.get(name) ?? [];
    entries.sort(name === 'open' ? compareOpen : compareRecent);
    return sectionPayload(name, entries, folded(name));
  });

  return {
    t: 'list',
    nowNs: String(nowNs),
    counts,
    sections,
    doneHidden,
    banner: null,
    terminals: input.terminals.map((terminal) => ({
      id: terminal.id,
      slot: terminal.slot,
      sessionId: terminal.sessionId,
      state: terminal.state,
      notReported: terminal.notReported,
      cols: terminal.cols,
      rows: terminal.rows,
    })),
    selected:
      input.selected !== null && input.selected.sessionId === view.selected ? input.selected : null,
    dirs: projectDirs(input.rows),
  };
}
