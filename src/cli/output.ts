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
import type { LinkKind, LinkRow, PrChecks, PrReview, PrState } from '../store/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { shellJoin } from '../text/shell.ts';
import { formatPrLine, formatRow } from './row.ts';

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
}

export interface ShowJson extends SessionJson {
  doneAt: string | null;
  note: string | null;
  launch: string[] | null;
  unknownFlags: string[];
  links: LinkJson[];
  holders: HolderJson[];
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

/** The session object of design 7.5; `dir` is "" when the directory is not known. */
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
    dir: row.dir ?? '',
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
  };
}

/** The time the user marked a session that is done as done; null for one that is not done (or when it is not known). */
function doneAt(row: ListRow): string | null {
  const { doneAtNs } = row.session;
  return row.done && doneAtNs !== null ? isoFromNs(doneAtNs) : null;
}

/**
 * The session object, then the time it was marked done, the note (as stored), the launch command, the names of the flags in it
 * that skydeck does not know, the links of the session and the processes that hold it.
 */
export function showJson(row: ListRow, links: readonly LinkRow[]): ShowJson {
  const launch = row.session.launch;
  return {
    ...sessionJson(row),
    doneAt: doneAt(row),
    note: row.note,
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
 * relative time, so `nowNs` is not used; it is part of the contract of 2.9.4.
 */
export function formatShow(row: ListRow, links: readonly LinkRow[], nowNs: Ns): string {
  const launch =
    row.session.launch === null || row.session.launch.length === 0 ? null : row.session.launch;
  const lines = [
    row.title,
    field('id:', row.id),
    field(
      'state:',
      `${row.state}${row.stateDetail === null ? '' : ` (${row.stateDetail})`} since ${isoFromNs(row.sinceNs)}`,
    ),
    ...doneField(row),
    field('marks:', row.marks.length === 0 ? '-' : row.marks.join(',')),
    field('label:', row.label ?? '-'),
    field('group:', row.group ?? '-'),
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
    lines.push(field('holder:', `pid ${holder.process.pid} since ${isoFromNs(holder.sinceNs)}`));
  }
  lines.push(...row.prs.map(prField));
  // A note is free multi-line text: sanitised line by line, so that its line breaks stay. Lines
  // that are nothing once sanitised (only escape sequences) are not shown at its start and end,
  // and a note of nothing else has nothing to show under a heading.
  const noteLines = (row.note?.trimEnd() ?? '').split('\n').map((line) => {
    const clean = sanitize(line);
    return clean.trim() === '' ? '' : INDENT + clean;
  });
  while (noteLines[0] === '') {
    noteLines.shift();
  }
  while (noteLines.at(-1) === '') {
    noteLines.pop();
  }
  if (noteLines.length > 0) {
    lines.push('note:', ...noteLines);
  }
  return `${lines.join('\n')}\n`;
}
