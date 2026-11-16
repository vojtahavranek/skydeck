/**
 * The window's view model (S2 12, stage A): the rows step 1 loads, the window's terminals and one
 * page's view state become that page's `list` message. Pure: it needs nothing but its input.
 *
 * Imports (S2 4.3, plan A8): types of `sessions`, step 1's `isListed`, the window's message and hub
 * types, and `text`. Stage B adds attention (`./attention.ts`, plan B 2.4): each row's, and the
 * page's `needYou`. Stage E adds search (`./search/`, plan E1): the filter's words and chips, the
 * stacks and the switcher's ranking; design 7.4's `matchesFilter` stays for `ls` and the
 * interactive list.
 */
import type { Ns } from '../../platform/types.ts';
import { isListed } from '../../sessions/list.ts';
import type { ListRow } from '../../sessions/list.ts';
import type { DerivedSession } from '../../sessions/types.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { TerminalInfo } from '../hub.ts';
import type {
  AttentionPayload,
  ClosedBlock,
  HiddenBy,
  ListMessage,
  RowPayload,
  SearchChip,
  SectionPayload,
  SelectedPayload,
  SwitcherPayload,
  TerminalPayload,
} from '../protocol.ts';
import { attentionOf, attentionOrder, NO_ATTENTION } from './attention.ts';
import type { AttentionFacts } from './attention.ts';
import {
  isFiltering,
  matchesChips,
  matchesWords,
  searchable,
  searchWords,
} from './search/filter.ts';
import { stackRows } from './search/stacks.ts';
import { switcherPayload } from './search/switcher.ts';
import type { SwitchCandidate } from './search/switcher.ts';
import { MAY_START, projectDirs, rowPayload, sectionOf } from './sections.ts';

export interface ViewInput {
  rows: readonly ListRow[];
  terminals: readonly TerminalInfo[];
  /** Holders that belong to no terminal of the window, by session id (from the mapping, task 21). */
  elsewhere: ReadonlyMap<string, { pid: number; tty: string | null }>;
  view: {
    filter: string;
    unfolded: readonly string[];
    showDone: boolean;
    selected: string | null;
    /** Stage E (plan E 2.4), each optional so that every caller of stages A–D compiles unchanged:
     *  absent `chips` is none (E4); absent `closed` closes no block (E6 as ruled 2026-11-16);
     *  `switcher` is the switcher's text while it is shown, null or absent while it is not (E8). */
    chips?: readonly SearchChip[];
    closed?: readonly ClosedBlock[];
    switcher?: string | null;
  };
  /** The resume card of the selected row (task 32's selectedPayload). */
  selected: SelectedPayload | null;
  nowNs: Ns;
  /** What attention is judged on (S2 12.4, plan B 2.4); absent: NO_ATTENTION, no row needs you. */
  attention?: AttentionFacts;
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

/** A row the switcher may list (every row listed with done ones shown, E9) and what it needs. */
interface SwitchEntry {
  entry: Entry;
  open: boolean;
  hiddenBy: HiddenBy[];
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

/** Recent and Earlier: the most recent first, ties by id. */
function compareRecent(a: Entry, b: Entry): number {
  return compareNs(b.row.lastActivityNs, a.row.lastActivityNs) || compareText(a.row.id, b.row.id);
}

/** A section of `entries` (in the section's order): `count`, `firstNs` and `lastNs` over all of
 *  them, `rows` the drawn ones (none while folded). */
function sectionPayload(
  name: SectionName,
  entries: readonly Entry[],
  folded: boolean,
  drawn: () => RowPayload[],
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
    rows: folded ? [] : drawn(),
  };
}

/**
 * E6 for one section (ruled 2026-11-16): the rows drawn, each head and open member with its
 * `stack`; every row of a group is in its block (G2), `closed` is `view.closed` as it comes
 * (absent: every block open); a closed block is drawn open while a member's row is drawn with a
 * terminal that has not reported a session.
 */
function stacked(
  name: SectionName,
  entries: readonly Entry[],
  closed: readonly ClosedBlock[] | undefined,
  selected: string | null,
): RowPayload[] {
  const stackable = entries.map(({ payload, terminal }) => ({
    id: payload.id,
    group: payload.group,
    needsYou: payload.attention !== null,
    // Ruled 2026-11-16 (review 2): its row's terminal has not reported a session (S2 7.5), so the
    // terminal's slot names no session for the page: the row stays on screen. THE PAGE COPIES THIS
    // RULE (web/list.js, `unreported`: the same terminal's `sessionId` null in `list.terminals`)
    // to forget the closing and refuse ← and `×n` there; a change of one is a change of the other.
    unreported: terminal !== null && terminal.sessionId === null,
    payload,
  }));
  return stackRows(stackable, name, closed, selected).map(({ entry, stack }) =>
    stack === null ? entry.payload : { ...entry.payload, stack },
  );
}

/**
 * The `list` message for one page, without each terminal's `ownsSize` (the page's, task 17).
 *
 * - Listed (design 7.2 through `isListed`): done sessions only with `showDone`; a session that is
 *   open — running, or starting in a terminal of the window — whatever its done mark (S2 12.10);
 *   the row of a `new` terminal's own session while the terminal is there, one of its own when
 *   the session has none yet (A28), unless it is done and stopped.
 * - Sections (S2 12.1, `sectionOf`): Open, Recent (key `week`), Earlier; Earlier folded unless the
 *   view unfolds it or the view is filtering (S2 12.8), a folded one with its count and time span
 *   and no rows.
 * - Search (S2 12.8, plan E2–E5): the view's words (`searchWords` of `filter`) and chips choose the
 *   rows of the sections; with either set the view is `filtering`: done rows are listed too (with
 *   their done mark), `doneHidden` is 0, no section is folded and no stack is formed. `counts` are
 *   the title bar's: every row listed without the filter once, by state, the starting ones and
 *   those running elsewhere apart, whatever the filter or the chips list.
 * - Blocks (S2 12.2, plan E6 as ruled 2026-11-16): in every section while not filtering,
 *   `stackRows` over the section's rows with `view.closed` as it comes (absent: every block open); a
 *   section's `count` and time span are all its rows', a closed block's hidden members too, its
 *   `rows` the drawn ones.
 * - The switcher (S2 12.8, plan E8, E9): while `view.switcher` is a string, `switcherPayload` over
 *   every row listed with done ones shown (Open's in Open's order, then the others most recent
 *   first), each with what hides it from this page's list; else null. Its `restore` is null here.
 * - `selected` is the resume card given only when it is the card of the view's selected session.
 * - `selectedRow` (S2 12.9, plan E13) is the payload of the row of the view's selected session as
 *   the sections would carry it, its `stack` null, also when they leave it out (a filter, the
 *   chips, done hidden, a folded Earlier); null when nothing is selected or the session is not
 *   listed even with done ones shown.
 * - Attention (S2 12.4, plan B7): a row's `attention` is `attentionOf` over `input.attention`.
 *   `needYou.count` counts the rows listed without the filter that need you, whatever the filter
 *   or the fold, and such a row is in no field of `counts` (the title bar's parts add up);
 *   `needYou.order` holds the ids of the rows of the sections that are not folded that need you —
 *   those the sections carry and those a closed block hides (G5: Ctrl+Shift+J reaches them, and
 *   the block opens for the selection) —, in B6's order (`attentionOrder`); also a done one a
 *   filter lists, which `needYou.count` does not count (E5: the title bar does not move with the
 *   filter).
 */
export function buildListMessage(
  input: ViewInput,
): Omit<ListMessage, 'terminals'> & { terminals: Omit<TerminalPayload, 'ownsSize'>[] } {
  const { view, nowNs } = input;
  const facts = input.attention ?? NO_ATTENTION;
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

  const words = searchWords(view.filter);
  const chips = view.chips ?? [];
  const filtering = isFiltering(words, chips);
  const unfolded = new Set(view.unfolded);
  // Earlier as the view has it once the filter is cleared; while filtering nothing is folded.
  const earlierFolded = !unfolded.has('earlier');
  const switching = typeof view.switcher === 'string';

  const counts = { working: 0, waiting: 0, running: 0, starting: 0, elsewhere: 0, notRunning: 0 };
  let needYouCount = 0;
  const shown = new Map<SectionName, Entry[]>(SECTIONS.map((name) => [name, []]));
  const switchable: SwitchEntry[] = [];
  let doneHidden = 0;
  // E13: the selected session's payload, whether the sections show it or not.
  let selectedRow: RowPayload | null = null;
  for (const row of candidates) {
    const claimed = bySession.get(row.id) ?? null;
    // A terminal whose program is gone stays with a session that is not running (the ended bar,
    // S2 7.8), not with one that runs again elsewhere: that row shows the card of 7.9 (S2 12.6).
    const terminal =
      claimed !== null && (MAY_START.has(claimed.state) || row.state === 'not-running')
        ? claimed
        : null;
    // A `new` terminal keeps its own session's row while it is there (A28, ruled), also a row step
    // 1 does not list (a session that ended before its first prompt has no transcript); a done one
    // is hidden as any done row that stopped.
    const ownNew =
      terminal !== null && terminal.kind === 'new' && terminal.expectedSessionId === row.id;
    if (!ownNew && !isListed(row, true)) {
      continue; // not listed even with done ones shown: no row, no count, no switcher item
    }
    const elsewhere = row.state === 'not-running' ? null : (input.elsewhere.get(row.id) ?? null);
    const payload: RowPayload = {
      ...rowPayload(row, { terminal, elsewhere }),
      attention: attentionOf(row, facts),
    };
    if (row.id === view.selected) {
      selectedRow = payload;
    }
    const open = payload.starting || row.state !== 'not-running';
    // Listed without the filter (stage A's rule with the view's showDone): the counts' rows.
    const listed =
      isListed(row, open || view.showDone) || (ownNew && (open || view.showDone || !row.done));
    // No Searchable is made while no word is set (task 90's review).
    const matches =
      (words.length === 0 || matchesWords(searchable(row), words)) &&
      matchesChips(row, open, chips);
    const name = sectionOf(row, nowNs, open);
    const entry: Entry = { row, terminal, payload };
    if (listed) {
      if (payload.attention !== null) {
        needYouCount += 1;
      } else if (payload.starting) {
        counts.starting += 1;
      } else if (payload.elsewhere !== null) {
        counts.elsewhere += 1;
      } else if (row.state === 'not-running') {
        counts.notRunning += 1;
      } else {
        counts[row.state] += 1;
      }
    }
    // While filtering a done row the words and chips match is listed too (E5).
    const inSection = matches && (listed || filtering);
    if (inSection) {
      shown.get(name)?.push(entry);
    } else if (!filtering) {
      doneHidden += 1; // not filtering, so it is done and the view hides done ones
    }
    if (switching) {
      // While filtering, a row the words and chips match is shown, done or in Earlier: nothing
      // hides it. Otherwise each part names what hides it now or once the filter is cleared.
      const hiddenBy: HiddenBy[] = [];
      if (!filtering || !matches) {
        if (!matches) hiddenBy.push('filter');
        if (!listed) hiddenBy.push('done');
        if (name === 'earlier' && earlierFolded) hiddenBy.push('folded');
      }
      switchable.push({ entry, open, hiddenBy });
    }
  }

  const needing: { id: string; attention: AttentionPayload }[] = [];
  const sections = SECTIONS.map((name) => {
    const entries = shown.get(name) ?? [];
    entries.sort(name === 'open' ? compareOpen : compareRecent);
    const folded = name === 'earlier' && !filtering && earlierFolded;
    if (!folded) {
      // G5: also a row a closed block hides, so that `needYou` does not move with the blocks.
      for (const { payload } of entries) {
        if (payload.attention !== null) {
          needing.push({ id: payload.id, attention: payload.attention });
        }
      }
    }
    // S2 12.2: a filter flattens every block.
    const drawn = filtering
      ? () => entries.map((entry) => entry.payload)
      : () => stacked(name, entries, view.closed, view.selected);
    return sectionPayload(name, entries, folded, drawn);
  });

  return {
    t: 'list',
    nowNs: String(nowNs),
    counts,
    needYou: { count: needYouCount, order: attentionOrder(needing, facts) },
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
      openedNs: String(terminal.openedNs),
    })),
    selected:
      input.selected !== null && input.selected.sessionId === view.selected ? input.selected : null,
    dirs: projectDirs(input.rows),
    filtering,
    switcher: typeof view.switcher === 'string' ? switcher(view.switcher, switchable, facts) : null,
    selectedRow,
  };
}

/**
 * E9's input: every row listed with done ones shown, Open's in Open's order and then the others
 * most recent first, each once with its payload (the list's, without a stack) and what hides it;
 * `needOrder` is B6's order (`attentionOrder`) over those that need you.
 */
function switcher(
  query: string,
  switchable: readonly SwitchEntry[],
  facts: AttentionFacts,
): SwitcherPayload {
  const ordered = [
    ...switchable.filter((one) => one.open).sort((a, b) => compareOpen(a.entry, b.entry)),
    ...switchable.filter((one) => !one.open).sort((a, b) => compareRecent(a.entry, b.entry)),
  ];
  const needing: { id: string; attention: AttentionPayload }[] = [];
  const candidates: SwitchCandidate[] = ordered.map(({ entry, open, hiddenBy }) => {
    const { attention } = entry.payload;
    if (attention !== null) {
      needing.push({ id: entry.payload.id, attention });
    }
    return {
      row: entry.payload,
      searchable: searchable(entry.row),
      open,
      need: attention !== null,
      hiddenBy,
    };
  });
  return switcherPayload(query, candidates, attentionOrder(needing, facts));
}
