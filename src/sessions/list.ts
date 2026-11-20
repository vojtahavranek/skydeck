// The list model (design 7.2 to 7.4): one row per derived session with every foreign string
// sanitised, which rows are listed, how they are filtered, grouped and ordered. Pure.
import { basename } from 'node:path';

import { chipFor, prLevel, statusProvider } from '../github.ts';
import type { ChipLevel } from '../github.ts';
import type { TicketStatusRule } from '../platform/config.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type {
  PrChecks,
  PrReview,
  PrRow,
  PrState,
  SessionMeta,
  SessionPrRow,
  TicketCategory,
  TicketStatusRow,
} from '../store/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { readTicket, ticketAddress, ticketText } from './ticket.ts';
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

/**
 * F19 (T1): the status of a session's ticket — the ticket the user set, else the address its
 * group gives through ticketUrl —, there exactly when a provider takes that address (a configured
 * rule, or GitHub for an issue): the cached row of the address, or nothing known yet.
 */
export interface TicketStatusView {
  /** The ticket's address: the one the status is of. */
  url: string;
  /** The ticket's short name (ticketText, F18's K2): sanitised. */
  name: string;
  /** The ticket is the one the user set (F18); false: its group's link. */
  stored: boolean;
  /** The last status read, sanitised; null before a read succeeded. */
  status: string | null;
  category: TicketCategory | null;
  okAtNs: Ns | null;
  /** The last attempt; null when it was never tried. */
  triedAtNs: Ns | null;
  /** The last attempt's failure, sanitised; null after a success. */
  error: string | null;
}

/**
 * Follow-up F33: the session a row began as a copy of (design 5.3 "Copies"): its id, and its title
 * as the list shows it (sanitised), null when skydeck has no row for it; and whether the user set
 * on the copy something that only the user can set (ruled: a label, a group, a note, a ticket, or
 * a pull request attached by hand — not one skydeck attached by itself from a `pr-link` record,
 * which Claude Code may have copied with the title), which keeps it listed while it is empty.
 */
export interface CopyView {
  id: string;
  title: string | null;
  keptByUser: boolean;
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
  /** F19: its ticket's status, null without a ticket or a provider for its address. */
  ticketStatus: TicketStatusView | null;
  /** F33: what it is a copy of, present exactly when `session.copyOf` is. */
  copyOf?: CopyView;
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

/**
 * F19 (T1): the status view of a ticket's `url` (the stored ticket's address, else the group's
 * link), named by `name` (asked only when a provider takes the address); null when there is no address or no provider takes it. Its cached row is
 * the one of that address in `cache`.
 */
function statusOf(
  url: string | null,
  name: () => string,
  stored: boolean,
  rules: readonly TicketStatusRule[],
  cache: ReadonlyMap<string, TicketStatusRow>,
): TicketStatusView | null {
  if (url === null || statusProvider(url, rules) === null) return null;
  const row = cache.get(url);
  return {
    url,
    name: name(),
    stored,
    status: shown(row?.status ?? null),
    category: row?.category ?? null,
    okAtNs: row?.okAtNs ?? null,
    triedAtNs: row?.triedAtNs ?? null,
    error: shown(row?.error ?? null),
  };
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
 * ticket's name is worked out with `ticketUrl` (F18, ticketOf). F19: `ticketStatus` gives the
 * configured rules and the cached statuses; without it no row has a ticket status. F33: a copy's
 * row names its original (`copyOf`) with the title of the original's row, and says whether the user
 * kept it (`CopyView.keptByUser`).
 */
export function buildRows(input: {
  sessions: readonly DerivedSession[];
  metas: readonly SessionMeta[];
  prs: readonly PrRow[];
  sessionPrs: readonly SessionPrRow[];
  groupPattern: string;
  ticketUrl: string | null;
  ticketStatus?: { rules: readonly TicketStatusRule[]; rows: readonly TicketStatusRow[] };
}): ListRow[] {
  const metaOf = new Map(input.metas.map((meta) => [meta.sessionId, meta]));
  const prsOf = attachedPrs(input.prs, input.sessionPrs);
  // F33: the sessions with a pull request the user attached by hand (and did not detach).
  const attachedByHand = new Set(
    input.sessionPrs
      .filter((link) => link.origin === 'manual' && link.detachedAtNs === null)
      .map((link) => link.sessionId),
  );
  const groupPattern = new RegExp(input.groupPattern);
  const statuses = input.ticketStatus;
  const cache = new Map((statuses?.rows ?? []).map((row) => [row.url, row]));
  const built = input.sessions.map((session): ListRow => {
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
    const ticket = ticketOf(meta?.ticket ?? null, input.ticketUrl);
    // F19: the stored ticket, else the group's link (S2 12.5's ticketAddress).
    const statusUrl = ticket?.url ?? ticketAddress(group, input.groupPattern, input.ticketUrl);
    const ticketStatus =
      statuses === undefined || statusUrl === null
        ? null
        : statusOf(
            statusUrl,
            // Worked out only when a provider takes the address (review 2, C7).
            () => ticket?.text ?? ticketText(statusUrl, input.ticketUrl),
            ticket !== null,
            statuses.rules,
            cache,
          );
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
      ticket,
      ticketStatus,
      session,
    };
  });
  const titles = new Map(built.map((row) => [row.id, row.title]));
  return built.map((row) => {
    const original = row.session.copyOf;
    if (original === undefined) {
      return row;
    }
    const keptByUser =
      row.label !== null ||
      row.groupSource === 'meta' ||
      row.hasNote ||
      row.ticket !== null ||
      attachedByHand.has(row.id);
    return { ...row, copyOf: { id: original, title: titles.get(original) ?? null, keptByUser } };
  });
}

/**
 * Whether the user attached nothing to the row (7.2): no label, no group set by the user, no
 * note, no pull request, no ticket. A group that only `groupPattern` took from the title is not
 * something the user attached.
 */
function nothingAttached(row: ListRow): boolean {
  return (
    row.label === null &&
    row.groupSource !== 'meta' &&
    !row.hasNote &&
    row.prs.length === 0 &&
    row.ticket === null
  );
}

/**
 * F33 (7.2): a row that `isListed` hides as an empty copy unless it shows done ones: marked
 * `empty-copy` (6.3: no message yet, neither working nor asking) and not kept by the user
 * (`CopyView.keptByUser`). The window keeps it listed while a terminal of the window shows it.
 */
export function isHiddenCopy(row: ListRow): boolean {
  return row.marks.includes('empty-copy') && row.copyOf?.keptByUser !== true;
}

/**
 * 7.2: entrypoint other than cli → false; not running and no transcript → false (D27, also with
 * showAll); done (unless showAll) → false; an empty copy the user did not keep (F33,
 * `isHiddenCopy`) unless showAll or a terminal of the window shows it (`inWindow`, the window's
 * own knowledge) → false, running or not; expired with nothing the user attached
 * (`nothingAttached`) → false.
 */
export function isListed(row: ListRow, showAll: boolean, inWindow = false): boolean {
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
  if (!showAll && !inWindow && isHiddenCopy(row)) {
    return false;
  }
  return !(row.marks.includes('expired') && nothingAttached(row));
}

/**
 * Case-insensitive substring match on title, group, note, dir, per PR "<repo>", "<number>",
 * "<repo>#<number>", the ticket's name and address (F18), and its status' text (F19). Empty
 * filter matches all.
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
  // F19: the status' text.
  texts.push(row.ticketStatus?.status ?? null);
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
