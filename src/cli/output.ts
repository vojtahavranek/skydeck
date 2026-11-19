// What `skydeck ls` and `skydeck show` print: the stable JSON of design 7.5 (plan 2.10.5) and the
// text forms. Pure. The strings of a `ListRow` and of a `PrView` were sanitised when the list model
// was built; what a row carries raw (the note, the launch command) is sanitised here for the text,
// and written with escapes by `jsonText` for the JSON, which also holds a process's boot id.
import { unknownFlags } from '../claude/launch.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import { SHORT_ID_LENGTH, flatRows } from '../sessions/list.ts';
import type { ListModel, ListRow, PrView, TitleSource } from '../sessions/list.ts';
import type { Holder, Mark, State } from '../sessions/types.ts';
import type {
  LinkKind,
  LinkRow,
  PrChecks,
  PrReview,
  PrState,
  TicketCategory,
} from '../store/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { shellJoin } from '../text/shell.ts';
import { formatNoteLines, formatPrLine, formatRow, stateDetailSuffix } from './row.ts';

// --- JSON (key order is the order written here) -----------------------------------------------------

export interface PrJson {
  url: string;
  repo: string;
  number: number;
  state: PrState | null;
  review: PrReview | null;
  checks: PrChecks | null;
  okAt: string | null;
  error: string | null;
}

export interface SessionJson {
  id: string;
  shortId: string;
  title: string;
  titleSource: TitleSource;
  label: string | null;
  group: string | null;
  state: State;
  stateDetail: string | null;
  since: string;
  lastActivity: string;
  dir: string;
  marks: Mark[];
  hasNote: boolean;
  continuedFrom: string | null;
  done: boolean;
  prs: PrJson[];
}

export interface ListJson {
  version: 1;
  generatedAt: string;
  sessions: SessionJson[];
}

export interface LinkJson {
  kind: LinkKind;
  from: string;
  to: string;
  at: string;
}

export interface HolderJson {
  pid: number;
  bootId: string;
  procStart: number | null;
  since: string;
  /** The holder is a scripted run (`claude -p`, an SDK run; design 5.3). */
  scripted: boolean;
}

export interface ShowJson extends SessionJson {
  doneAt: string | null;
  note: string | null;
  /** F18: the ticket the user set — its address and its name (ticketText) —, null for none; F19:
   *  its status, the status' category, when it was last read and tried and the last failure,
   *  each null when not known (or when no provider reads its address). */
  ticket: TicketJson | null;
  launch: string[] | null;
  unknownFlags: string[];
  links: LinkJson[];
  holders: HolderJson[];
}

/** F18's ticket and F19's status of it (design 7.5). */
export interface TicketJson {
  url: string;
  text: string;
  status: string | null;
  category: TicketCategory | null;
  okAt: string | null;
  triedAt: string | null;
  error: string | null;
}

/** The stored ticket of `row` with its status (F19: the row's, of the same address), or null. */
function ticketJson(row: ListRow): TicketJson | null {
  if (row.ticket === null) return null;
  const view = row.ticketStatus?.url === row.ticket.url ? row.ticketStatus : null;
  return {
    url: row.ticket.url,
    text: row.ticket.text,
    status: view?.status ?? null,
    category: view?.category ?? null,
    okAt: view?.okAtNs == null ? null : isoFromNs(view.okAtNs),
    triedAt: view?.triedAtNs == null ? null : isoFromNs(view.triedAtNs),
    error: view?.error ?? null,
  };
}

function prJson(pr: PrView): PrJson {
  return {
    url: pr.url,
    repo: pr.repo,
    number: pr.number,
    state: pr.state,
    review: pr.review,
    checks: pr.checks,
    okAt: pr.okAtNs === null ? null : isoFromNs(pr.okAtNs),
    error: pr.error,
  };
}

/**
 * The session object of design 7.5. `dir` is the project directory as stored, not the sanitised
 * text of the row (`row.dir`, for display only): someone has to be able to `cd` to it, and
 * `jsonText` makes raw text safe to print. It is "" when the directory is not known.
 */
export function sessionJson(row: ListRow): SessionJson {
  return {
    id: row.id,
    shortId: row.shortId,
    title: row.title,
    titleSource: row.titleSource,
    label: row.label,
    group: row.group,
    state: row.state,
    stateDetail: row.stateDetail,
    since: isoFromNs(row.sinceNs),
    lastActivity: isoFromNs(row.lastActivityNs),
    dir: row.session.dir ?? '',
    marks: [...row.marks],
    hasNote: row.hasNote,
    continuedFrom: row.continuedFrom,
    done: row.done,
    prs: row.prs.map(prJson),
  };
}

/** Version 1 of the list: the sessions of the model in display order (groups, then rows). */
export function listJson(model: ListModel): ListJson {
  return {
    version: 1,
    generatedAt: isoFromNs(model.generatedAtNs),
    sessions: flatRows(model).map(sessionJson),
  };
}

/** The links from or to the row, by time (then by the event that made them). */
function linksOf(row: ListRow, links: readonly LinkRow[]): LinkRow[] {
  return links
    .filter((link) => link.fromSession === row.id || link.toSession === row.id)
    .sort((a, b) => (a.timeNs < b.timeNs ? -1 : a.timeNs > b.timeNs ? 1 : a.eventId - b.eventId));
}

function holderJson(holder: Holder): HolderJson {
  return {
    pid: holder.process.pid,
    bootId: holder.process.bootId,
    procStart: holder.process.procStart,
    since: isoFromNs(holder.sinceNs),
    scripted: holder.scripted,
  };
}

/** The time the user marked a session that is done as done; null for one that is not done (or when it is not known). */
function doneAt(row: ListRow): string | null {
  const { doneAtNs } = row.session;
  return row.done && doneAtNs !== null ? isoFromNs(doneAtNs) : null;
}

/**
 * The session object, then the time it was marked done, the note (as stored), the ticket the user
 * set (F18), the launch command, the names of the flags in it
 * that skydeck does not know, the links of the session and the processes that hold it.
 */
export function showJson(row: ListRow, links: readonly LinkRow[]): ShowJson {
  const launch = row.session.launch;
  return {
    ...sessionJson(row),
    doneAt: doneAt(row),
    note: row.note,
    ticket: ticketJson(row),
    launch: launch === null ? null : [...launch],
    unknownFlags: launch === null ? [] : unknownFlags(launch),
    links: linksOf(row, links).map((link) => ({
      kind: link.kind,
      from: link.fromSession,
      to: link.toSession,
      at: isoFromNs(link.timeNs),
    })),
    holders: row.session.holders.map(holderJson),
  };
}

// --- text -------------------------------------------------------------------------------------------

const INDENT = '  ';

/**
 * Per group a line with its name ("no group" for none), then its rows, each indented by two
 * characters and fitted to `width` less that; an empty line between groups.
 */
export function formatList(model: ListModel, nowNs: Ns, width: number): string {
  const blocks = model.groups
    .filter((group) => group.rows.length > 0)
    .map((group) =>
      [
        group.name ?? 'no group',
        ...group.rows.map((row) => INDENT + formatRow(row, nowNs, width - INDENT.length)),
      ].join('\n'),
    );
  return blocks.length === 0 ? 'no sessions\n' : `${blocks.join('\n\n')}\n`;
}

const LABEL_WIDTH = 11;

/** One field of `show`: its name padded to 11 characters, then the value. */
function field(name: string, value: string): string {
  return `${name.padEnd(LABEL_WIDTH)}${value}`;
}

/** The status of a pull request as `show` prints it: the line of the list, then review and checks. */
function prField(pr: PrView): string {
  let line = formatPrLine(pr);
  if (pr.level !== 'cant-read') {
    // What an unreadable pull request knew from an earlier fetch is not shown as if it were current.
    line += pr.review === null ? '' : ` review ${pr.review}`;
    line += pr.checks === null ? '' : ` checks ${pr.checks}`;
  }
  return field('pr:', line);
}

/** F19: `ticket:` with its status (` · <status>`), and the last failure's words on a line under it. */
function ticketLines(row: ListRow, ticket: string): string[] {
  const view = row.ticketStatus?.url === ticket ? row.ticketStatus : null;
  const status = view?.status == null ? '' : ` · ${view.status}`;
  const lines = [field('ticket:', `${sanitize(ticket)}${status}`)];
  if (view?.error != null) lines.push(field('', `status not read: ${view.error}`));
  return lines;
}

/** `done:` with the time the user marked the session done; nothing for a session that is not hidden. */
function doneField(row: ListRow): string[] {
  if (!row.done) {
    return [];
  }
  const { doneAtNs } = row.session;
  return [field('done:', doneAtNs === null ? 'yes' : `since ${isoFromNs(doneAtNs)}`)];
}

/**
 * One session in full (design 7.5): its title, then one line per field. Nothing is left to a
 * relative time, so `nowNs` is not used; it is part of the contract of 2.9.4. `ticket` is the
 * session's ticket address, printed after the group when there is one: the ticket the user set
 * (F18), else the ticket link of its group (`ticketAddress`, S2 12.5) — the caller picks it. F19:
 * when the row's ticket status is of that address, the line ends with ` · <status>` once a status
 * is known, and a last read that failed adds a line under it, `status not read: <its words>`.
 * `inWindow` holds the pids of the holders that run in the window (`holdersInWindow`, S2 11.4):
 * their lines end with `(in the skydeck window)`. A row's holders are processes of this boot, so
 * a pid names one of them.
 */
export function formatShow(
  row: ListRow,
  links: readonly LinkRow[],
  nowNs: Ns,
  ticket: string | null = null,
  inWindow: ReadonlySet<number> = new Set(),
): string {
  const launch =
    row.session.launch === null || row.session.launch.length === 0 ? null : row.session.launch;
  const lines = [
    row.title,
    field('id:', row.id),
    field(
      'state:',
      `${row.state}${stateDetailSuffix(row.stateDetail)} since ${isoFromNs(row.sinceNs)}`,
    ),
    ...doneField(row),
    field('marks:', row.marks.length === 0 ? '-' : row.marks.join(',')),
    field('label:', row.label ?? '-'),
    field('group:', row.group ?? '-'),
    ...(ticket === null ? [] : ticketLines(row, ticket)),
    field('dir:', row.dir === null || row.dir === '' ? '-' : row.dir),
    // A recorded word can hold anything a process was started with: sanitised before it is quoted.
    field('launch:', launch === null ? 'unknown' : shellJoin(launch.map(sanitize))),
  ];
  const unknown = launch === null ? [] : unknownFlags(launch);
  if (unknown.length > 0) {
    lines.push(field('unknown:', unknown.map(sanitize).join(' ')));
  }
  if (row.continuedFrom !== null) {
    lines.push(field('continues:', row.continuedFrom));
  }
  for (const link of linksOf(row, links)) {
    const from = link.fromSession.slice(0, SHORT_ID_LENGTH);
    const to = link.toSession.slice(0, SHORT_ID_LENGTH);
    lines.push(field('link:', `${link.kind} ${from} -> ${to} at ${isoFromNs(link.timeNs)}`));
  }
  for (const holder of row.session.holders) {
    const what = holder.scripted ? ' (scripted run)' : '';
    const where = inWindow.has(holder.process.pid) ? ' (in the skydeck window)' : '';
    lines.push(
      field(
        'holder:',
        `pid ${holder.process.pid} since ${isoFromNs(holder.sinceNs)}${what}${where}`,
      ),
    );
  }
  lines.push(...row.prs.map(prField));
  // A note is free multi-line text; a note that has nothing to show gets no heading.
  const noteLines = row.note === null ? [] : formatNoteLines(row.note);
  if (noteLines.length > 0) {
    lines.push('note:', ...noteLines);
  }
  return `${lines.join('\n')}\n`;
}
