/**
 * Attention in the window's view model (S2 12.4, stage B): whether a session needs you and why,
 * from what the store holds of it (S2 10.2) and its status at the server's last look (S2 10.3);
 * the order Ctrl+Shift+J goes in; which sessions start to need you (S2 13). Pure: the server
 * gathers the facts, the page shows what these functions say (S2 4.3).
 *
 * Imports (S2 4.3, plan B 2.1): types of `sessions`, `text`'s `sanitize`, the window's message
 * types. Not the store's types: `AttentionMarks` has the fields of the store's `AttentionRow`, and
 * the server passes those rows as they are.
 */
import type { Ns } from '../../platform/types.ts';
import type { ListRow } from '../../sessions/list.ts';
import { sanitize } from '../../text/sanitize.ts';
import type { AttentionPayload, AttentionReason, NsText } from '../protocol.ts';

/** What the store holds of a session (S2 10.2): the fields of the store's AttentionRow. */
export interface AttentionMarks {
  turnEndedSeq: number | null;
  turnEndedNs: Ns | null;
  seenSeq: number | null;
  windowEndSeq: number | null;
  windowEndNs: Ns | null;
}
/** A session's status at the server's last look (plan B4, B5). `status` and `waitingFor` are the
 *  live file's, as found (not sanitised); `sinceNs` its statusUpdatedAt, else updatedAt. */
export interface LiveStatus {
  status: string | null;
  waitingFor: string | null;
  sinceNs: Ns | null;
}
/** Everything attention is judged on, by session id. */
export interface AttentionFacts {
  marks: ReadonlyMap<string, AttentionMarks>;
  live: ReadonlyMap<string, LiveStatus>;
}

/** No facts: no row needs you (stage A's and D's callers, which pass none). */
export const NO_ATTENTION: AttentionFacts = { marks: new Map(), live: new Map() };

/** The longest detail a row and a notification carry, in UTF-16 units, the ellipsis included
 *  (plan B13, ruled): a waitingFor has no length limit, and the list is sent whole. */
const DETAIL_MAX = 120;

/** B5: the status that wins among a session's holders, the strongest first. */
const STATUS_STRENGTH: readonly string[] = ['waiting', 'busy', 'idle'];

/** S2 12.4's order of the reasons (B6: Ctrl+Shift+J goes through them in this order). */
const REASON_ORDER: Readonly<Record<AttentionReason, number>> = { asks: 0, ended: 1, finished: 2 };

function strength(status: string | null): number {
  const index = status === null ? -1 : STATUS_STRENGTH.indexOf(status);
  return index === -1 ? STATUS_STRENGTH.length : index;
}

/**
 * B5: one status per session from its holders' baselines: `waiting` when any holder waits, else
 * `busy` when any is busy, else `idle` when any is idle, else the first one's. The LiveStatus is
 * that holder's whole (of several with the winning status, the first in `files`).
 */
export function liveStatuses(
  files: Iterable<{
    sessionId: string;
    status: string | null;
    waitingFor: string | null;
    sinceNs: Ns | null;
  }>,
): Map<string, LiveStatus> {
  const chosen = new Map<string, { strength: number; live: LiveStatus }>();
  for (const file of files) {
    const rank = strength(file.status);
    const held = chosen.get(file.sessionId);
    if (held === undefined || rank < held.strength) {
      chosen.set(file.sessionId, {
        strength: rank,
        live: { status: file.status, waitingFor: file.waitingFor, sinceNs: file.sinceNs },
      });
    }
  }
  const statuses = new Map<string, LiveStatus>();
  for (const [sessionId, { live }] of chosen) {
    statuses.set(sessionId, live);
  }
  return statuses;
}

/** B13: a waitingFor sanitised and trimmed, then cut to DETAIL_MAX units with the cut marked by
 *  '…', never inside a surrogate pair; null when there is none or it is blank once sanitised
 *  (empty, or only white space: the page would write `needs you ·  · 3m`; ruled). Trimmed (ruled
 *  on review 2), so that leading white space can neither show nor fill the cut. */
function detailOf(waitingFor: string | null): string | null {
  if (waitingFor === null) {
    return null;
  }
  const clean = sanitize(waitingFor).trim();
  if (clean === '') {
    return null;
  }
  if (clean.length <= DETAIL_MAX) {
    return clean;
  }
  let cut = DETAIL_MAX - 1;
  const last = clean.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return `${clean.slice(0, cut)}…`;
}

function nsText(ns: Ns | null): NsText | null {
  return ns === null ? null : String(ns);
}

/** An observation `seq` the user has not seen: it exists and is later than `seenSeq` (S2 10.2: by
 *  the counter, never by a clock). */
function unseen(seq: number | null, seenSeq: number | null): boolean {
  return seq !== null && (seenSeq === null || seq > seenSeq);
}

/** A turn end of an earlier run (ruled on review 2): the idle status the row shows began after
 *  the recorded turn end. Within one run the look records the file's `sinceNs` as `turn_ended_ns`
 *  and keeps that file as the baseline, so while the session stays idle the two are the same
 *  value: an identity test, not an order by two clocks. Unknown on either side: not stale. */
function staleTurnEnd(marks: AttentionMarks, live: LiveStatus): boolean {
  return marks.turnEndedNs !== null && live.sinceNs !== null && live.sinceNs > marks.turnEndedNs;
}

/**
 * S2 12.4's reasons in their order, null when the row needs nothing ("running": the row's state
 * is not `not-running`; the LiveStatus is the session's in `facts.live`):
 * asks — the row is running and its LiveStatus is `waiting` (detail: its waitingFor, cut, B13);
 * ended — windowEndSeq is not null and greater than seenSeq (or seenSeq is null), running or not;
 * finished — turnEndedSeq is greater than seenSeq (or seenSeq is null), the row is running and its
 * LiveStatus is `idle` (B6), and that idle status did not begin after the recorded turn end (not
 * turnEndedNs and the LiveStatus's sinceNs both known and sinceNs the later: a turn end of an
 * earlier run, ruled on review 2).
 */
export function attentionOf(row: ListRow, facts: AttentionFacts): AttentionPayload | null {
  const running = row.state !== 'not-running';
  const live = facts.live.get(row.id);
  if (running && live?.status === 'waiting') {
    return { reason: 'asks', detail: detailOf(live.waitingFor), sinceNs: nsText(live.sinceNs) };
  }
  const marks = facts.marks.get(row.id);
  if (marks === undefined) {
    return null;
  }
  if (unseen(marks.windowEndSeq, marks.seenSeq)) {
    return { reason: 'ended', detail: null, sinceNs: nsText(marks.windowEndNs) };
  }
  if (
    running &&
    live?.status === 'idle' &&
    unseen(marks.turnEndedSeq, marks.seenSeq) &&
    !staleTurnEnd(marks, live)
  ) {
    return { reason: 'finished', detail: null, sinceNs: nsText(marks.turnEndedNs) };
  }
  return null;
}

/** What orders a row inside its reason (B6): the status time of one that asks, the counter of an
 *  end; null when not known. */
function orderKey(id: string, reason: AttentionReason, facts: AttentionFacts): bigint | null {
  if (reason === 'asks') {
    return facts.live.get(id)?.sinceNs ?? null;
  }
  const marks = facts.marks.get(id);
  const seq = reason === 'ended' ? marks?.windowEndSeq : marks?.turnEndedSeq;
  return seq === undefined || seq === null ? null : BigInt(seq);
}

/** Known first, the earlier first; unknown last. */
function compareKeys(a: bigint | null, b: bigint | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * B6's order of rows that need you, by id: those that ask by their status time (the longest
 * waiting first; unknown last), then those that ended by window_end_seq, then those that finished
 * by turn_ended_seq (the oldest first); ties by session id.
 */
export function attentionOrder(
  entries: readonly { id: string; attention: AttentionPayload }[],
  facts: AttentionFacts,
): string[] {
  const keyed = entries.map(({ id, attention }) => ({
    id,
    reason: REASON_ORDER[attention.reason],
    key: orderKey(id, attention.reason, facts),
  }));
  keyed.sort(
    (a, b) =>
      a.reason - b.reason || compareKeys(a.key, b.key) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return keyed.map((entry) => entry.id);
}

/** S2 13, B12: the ids of `after` that are not in `before`, in `after`'s order (a session whose
 *  reason changes does not start to need you). */
export function startsToNeed(
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): string[] {
  const started: string[] = [];
  for (const id of after.keys()) {
    if (!before.has(id)) {
      started.push(id);
    }
  }
  return started;
}
