// The list model (design 7.2 to 7.4): one row per derived session with every foreign string
// sanitised, which rows are listed, how they are filtered, grouped and ordered. Pure.
import { basename } from 'node:path';

import { chipFor, prLevel } from '../github.ts';
import type { ChipLevel } from '../github.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type {
  PrChecks,
  PrReview,
  PrRow,
  PrState,
  SessionMeta,
  SessionPrRow,
} from '../store/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { readTicket, ticketText } from './ticket.ts';
import type { DerivedSession, Mark, State } from './types.ts';

export type TitleSource = 'label' | 'name' | 'generated' | 'fallback';
/** Where a row's group comes from: the user set it, or `groupPattern` took it from the title. */
export type GroupSource = 'meta' | 'title';

export interface PrView {
  url: string;
  repo: string; // "<owner>/<repo>"
  number: number;
  title: string | null; // sanitised
  state: PrState | null;
  review: PrReview | null;
  checks: PrChecks | null;
  okAtNs: Ns | null;
  error: string | null; // sanitised
  level: ChipLevel;
}

/** F18: the ticket the user set — its address as stored, and the short name of its chip (K2). */
export interface TicketView {
  url: string;
  text: string; // ticketText's: sanitised
}

export interface ListRow {
  id: string;
  shortId: string;
  title: string; // sanitised
  titleSource: TitleSource;
  label: string | null; // sanitised
  group: string | null; // sanitised; meta group, else groupPattern match on the title
  groupSource: GroupSource | null; // null exactly when `group` is
  state: State;
  stateDetail: string | null; // sanitised
  sinceNs: Ns;
  lastActivityNs: Ns;
  dir: string | null; // sanitised, so for display only: the path to use is `session.dir`
  marks: Mark[];
  hasNote: boolean;
  note: string | null;
  continuedFrom: string | null;
  done: boolean; // = session.hidden
  prs: PrView[]; // attached and not detached, sorted by url
  chip: { level: ChipLevel; count: number } | null;
  /** F18: the ticket the user set, null for none. */
  ticket: TicketView | null;
  session: DerivedSession;
}

export interface ListGroup {
  name: string | null;
  rows: ListRow[];
}

export interface ListModel {
  generatedAtNs: Ns;
  groups: ListGroup[];
}

/** A session's short id is the first 8 characters of its id (design 7.4). */
export const SHORT_ID_LENGTH = 8;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNs(a: Ns, b: Ns): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The sanitised and trimmed text, or null when there is none left to show (a cleared name is an
 * empty string). Trimmed, so that a title the sanitiser leaves a leading space on still starts
 * with its ticket key.
 */
function shown(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const clean = sanitize(text).trim();
  return clean === '' ? null : clean;
}

/** D12: `YYYY-MM-DD HH:MM <directory name>`, UTC, from the time the session was first seen. */
function fallbackTitle(firstSeenNs: Ns, dir: string | null): string {
  const iso = isoFromNs(firstSeenNs);
  // `dir` is sanitised already, so no escape sequence can be cut in two by taking the last part.
  const name = dir === null ? '' : basename(dir);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} ${name.trim() === '' ? '?' : name}`;
}

/** 7.1: the label; the name set in Claude Code; its generated title; else the fallback. */
function titleOf(
  session: DerivedSession,
  label: string | null,
  dir: string | null,
): { title: string; titleSource: TitleSource } {
  if (label !== null) {
    return { title: label, titleSource: 'label' };
  }
  const name = shown(session.transcript?.customTitle ?? null);
  if (name !== null) {
    return { title: name, titleSource: 'name' };
  }
  const generated = shown(session.transcript?.aiTitle ?? null);
  if (generated !== null) {
    return { title: generated, titleSource: 'generated' };
  }
  return { title: fallbackTitle(session.firstSeenNs, dir), titleSource: 'fallback' };
}

function prView(pr: PrRow): PrView {
  return {
    url: pr.url, // a key: prKey checked it before it was stored
    repo: sanitize(`${pr.owner}/${pr.repo}`),
    number: pr.number,
    title: pr.title === null ? null : sanitize(pr.title),
    state: pr.state,
    review: pr.review,
    checks: pr.checks,
    okAtNs: pr.okAtNs,
    error: pr.error === null ? null : sanitize(pr.error),
    level: prLevel(pr),
  };
}

/**
 * F18: the ticket of a stored address, its name worked out with `ticketUrl` (ticketText). The
 * database can be changed by other means, so the address is read again by readTicket's rule for a
 * whole link: one it refuses (not http or https, a control character, …) is none.
 */
function ticketOf(stored: string | null, ticketUrl: string | null): TicketView | null {
  if (stored === null) return null;
  const read = readTicket(stored, null);
  if (!read.ok || read.address === null) return null;
  return { url: read.address, text: ticketText(read.address, ticketUrl) };
}

/** The pull requests attached to each session (not detached, and known), sorted by url. */
function attachedPrs(
  prs: readonly PrRow[],
  sessionPrs: readonly SessionPrRow[],
): Map<string, PrRow[]> {
  const byUrl = new Map(prs.map((pr) => [pr.url, pr]));
  const bySession = new Map<string, PrRow[]>();
  for (const link of sessionPrs) {
    const pr = byUrl.get(link.url);
    if (link.detachedAtNs !== null || pr === undefined) {
      continue;
    }
    const list = bySession.get(link.sessionId);
    if (list === undefined) {
      bySession.set(link.sessionId, [pr]);
    } else {
      list.push(pr);
    }
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => compareText(a.url, b.url));
  }
  return bySession;
}

/**
 * One row per derived session (none dropped, in the order given), every foreign string sanitised
 * (7.4): the title unless it is the label, the state detail, the directory, and the title and
 * error of each pull request. The store gives no order, so pull requests are sorted here. The
 * ticket's name is worked out with `ticketUrl` (F18, ticketOf).
 */
export function buildRows(input: {
  sessions: readonly DerivedSession[];
  metas: readonly SessionMeta[];
  prs: readonly PrRow[];
  sessionPrs: readonly SessionPrRow[];
  groupPattern: string;
  ticketUrl: string | null;
}): ListRow[] {
  const metaOf = new Map(input.metas.map((meta) => [meta.sessionId, meta]));
  const prsOf = attachedPrs(input.prs, input.sessionPrs);
  const groupPattern = new RegExp(input.groupPattern);
  return input.sessions.map((session): ListRow => {
    const meta = metaOf.get(session.id);
    // A label and a group are clean when they are set (cleanLabel, cleanGroup); the database can be
    // changed by other means, so they are sanitised here like every other string.
    const label = shown(meta?.label ?? null);
    const note = meta?.note ?? null;
    const dir = session.dir === null ? null : sanitize(session.dir);
    const { title, titleSource } = titleOf(session, label, dir);
    // A pattern that matches nothing (or the empty string) names no group.
    const setGroup = shown(meta?.group ?? null);
    const titleGroup = groupPattern.exec(title)?.[0] || null;
    const group = setGroup ?? titleGroup;
    const groupSource: GroupSource | null =
      setGroup !== null ? 'meta' : titleGroup !== null ? 'title' : null;
    const attached = prsOf.get(session.id) ?? [];
    return {
      id: session.id,
      shortId: session.id.slice(0, SHORT_ID_LENGTH),
      title,
      titleSource,
      label,
      group,
      groupSource,
      state: session.state,
      stateDetail: session.stateDetail === null ? null : sanitize(session.stateDetail),
      sinceNs: session.sinceNs,
      lastActivityNs: session.lastActivityNs,
      dir,
      marks: [...session.marks],
      hasNote: note !== null,
      note,
      continuedFrom: session.continuedFrom,
      done: session.hidden,
      prs: attached.map(prView),
      chip: chipFor(attached),
      ticket: ticketOf(meta?.ticket ?? null, input.ticketUrl),
      session,
    };
  });
}

/**
 * 7.2: entrypoint other than cli → false; not running and no transcript → false (D27, also with
 * showAll); done (unless showAll) → false; expired with nothing the user attached (no label, no
 * group set by the user, no note, no pull request, no ticket) → false. A group that only
 * `groupPattern` took from the title is not something the user attached.
 */
export function isListed(row: ListRow, showAll: boolean): boolean {
  const transcript = row.session.transcript;
  const entrypoint = transcript?.entrypoint ?? null;
  if (entrypoint !== null && entrypoint !== 'cli') {
    return false;
  }
  if (row.state === 'not-running' && transcript === null) {
    return false;
  }
  if (row.done && !showAll) {
    return false;
  }
  const nothingAttached =
    row.label === null &&
    row.groupSource !== 'meta' &&
    !row.hasNote &&
    row.prs.length === 0 &&
    row.ticket === null;
  return !(row.marks.includes('expired') && nothingAttached);
}

/**
 * Case-insensitive substring match on title, group, note, dir, per PR "<repo>", "<number>",
 * "<repo>#<number>", and the ticket's name and address (F18). Empty filter matches all.
 */
export function matchesFilter(row: ListRow, filter: string): boolean {
  if (filter === '') {
    return true;
  }
  const needle = filter.toLowerCase();
  const texts: (string | null)[] = [row.title, row.group, row.note, row.dir];
  for (const pr of row.prs) {
    texts.push(pr.repo, String(pr.number), `${pr.repo}#${pr.number}`);
  }
  if (row.ticket !== null) {
    texts.push(row.ticket.text, row.ticket.url);
  }
  return texts.some((text) => text !== null && text.toLowerCase().includes(needle));
}

/** 7.4 rank inside a group: waiting, working, running, not running after an unexpected end, other. */
function rankOf(row: ListRow): number {
  switch (row.state) {
    case 'waiting':
      return 0;
    case 'working':
      return 1;
    case 'running':
      return 2;
    case 'not-running':
      return row.marks.includes('ended-unexpectedly') ? 3 : 4;
  }
}

function compareRows(a: ListRow, b: ListRow): number {
  return (
    rankOf(a) - rankOf(b) ||
    compareNs(b.lastActivityNs, a.lastActivityNs) ||
    compareText(a.id, b.id)
  );
}

/**
 * Listed rows that match `filter`, grouped and ordered as in 7.4: groups by the most recent
 * activity of a member, descending, the group of no name last, ties by name; rows by rank, then
 * most recent activity, then id. `rows` is not changed.
 */
export function buildList(
  rows: readonly ListRow[],
  options: { showAll: boolean; filter: string; nowNs: Ns },
): ListModel {
  const byGroup = new Map<string | null, ListRow[]>();
  for (const row of rows) {
    if (!isListed(row, options.showAll) || !matchesFilter(row, options.filter)) {
      continue;
    }
    const members = byGroup.get(row.group);
    if (members === undefined) {
      byGroup.set(row.group, [row]);
    } else {
      members.push(row);
    }
  }
  const groups = [...byGroup].map(([name, members]) => ({
    name,
    rows: members.sort(compareRows),
    newestNs: members.reduce(
      (newest, row) => (row.lastActivityNs > newest ? row.lastActivityNs : newest),
      members[0]?.lastActivityNs ?? 0n,
    ),
  }));
  groups.sort((a, b) => {
    if (a.name === null || b.name === null) {
      return Number(a.name === null) - Number(b.name === null);
    }
    return compareNs(b.newestNs, a.newestNs) || compareText(a.name, b.name);
  });
  return {
    generatedAtNs: options.nowNs,
    groups: groups.map(({ name, rows: members }) => ({ name, rows: members })),
  };
}

/** The rows of a model in display order. */
export function flatRows(model: ListModel): ListRow[] {
  return model.groups.flatMap((group) => group.rows);
}
