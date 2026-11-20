// Derived state (design 6): which process holds which session, the state a session is in, and its
// marks. A pure function of what it is given: no file access, no clock, no store.
import type { LiveFile, ProcessKey } from '../claude/live.ts';
import { NS_PER_DAY } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import { ENDED_IN_WINDOW } from '../store/types.ts';
import type { EndDetail, EventRow, LinkRow, SessionMeta, TranscriptRow } from '../store/types.ts';
import { MARK_ORDER } from './types.ts';
import type { DerivedSession, Holder, LastHolding, Mark, State } from './types.ts';

export interface DeriveInput {
  events: readonly EventRow[]; // ordered by (timeNs, id)
  links: readonly LinkRow[];
  transcripts: readonly TranscriptRow[];
  metas: readonly SessionMeta[];
  liveFiles: readonly LiveFile[]; // every file read, trusted or not
  /** The boot id `isAlive` judges against, read once; null when it could not be read. */
  bootId: string | null;
  isAlive: (p: ProcessKey) => boolean;
  isTrusted: (f: LiveFile) => boolean;
  nowNs: Ns;
  /** `cleanupPeriodDays`: a positive safe integer (the settings reader never gives anything else). */
  retentionDays: number;
}

/** The transcript is deleted after `retentionDays`; a session is `expiring` this many days before. */
const EXPIRING_WARNING_DAYS = 5;

/**
 * Design 6 for every session id found in events or transcripts. Pure. Sorted by id.
 *
 * Events are put in (timeNs, id) order here as well, and links and transcripts are chosen without
 * relying on the order they come in: the store does not promise the order of those two.
 */
export function deriveSessions(input: DeriveInput): DerivedSession[] {
  const { nowNs } = input;
  const events = [...input.events].sort(compareEvents);

  const eventsBySession = new Map<string, EventRow[]>();
  const eventsOfProcess = new Map<string, EventRow[]>(); // process id → its events, in order
  for (const event of events) {
    push(eventsBySession, event.sessionId, event);
    if (event.pid !== 0) {
      push(eventsOfProcess, processId(event), event);
    }
  }
  // A process holds the session of its latest event unless that event is an `end` or a `scripted-end`.
  const holdingEvents = new Map<string, EventRow[]>(); // session id → latest events of its processes
  for (const processEvents of eventsOfProcess.values()) {
    const latest = processEvents.at(-1);
    if (latest !== undefined && latest.kind !== 'end' && latest.kind !== 'scripted-end') {
      push(holdingEvents, latest.sessionId, latest);
    }
  }

  const transcriptOf = new Map<string, TranscriptRow>();
  for (const transcript of input.transcripts) {
    const chosen = transcriptOf.get(transcript.sessionId);
    if (chosen === undefined || compareTranscripts(transcript, chosen) < 0) {
      transcriptOf.set(transcript.sessionId, transcript);
    }
  }

  // Target session → its latest clear, fork or copy link; and its latest copy link (F33).
  const continuation = new Map<string, LinkRow>();
  const copied = new Map<string, LinkRow>();
  for (const link of input.links) {
    if (link.kind === 'copy') {
      keepLatest(copied, link);
    }
    if (link.kind === 'clear' || link.kind === 'fork' || link.kind === 'copy') {
      keepLatest(continuation, link);
    }
  }

  const metaOf = new Map<string, SessionMeta>(input.metas.map((meta) => [meta.sessionId, meta]));
  const liveFilesOfPid = new Map<number, LiveFile[]>();
  for (const file of input.liveFiles) {
    push(liveFilesOfPid, file.pid, file);
  }

  const aliveMemo = new Map<string, boolean>();
  const isAlive = (event: EventRow): boolean => {
    const id = processId(event);
    let alive = aliveMemo.get(id);
    if (alive === undefined) {
      alive = input.isAlive(processOf(event));
      aliveMemo.set(id, alive);
    }
    return alive;
  };

  const expiringBeforeNs =
    nowNs - BigInt(Math.max(input.retentionDays - EXPIRING_WARNING_DAYS, 0)) * NS_PER_DAY;

  const ids = [...new Set([...eventsBySession.keys(), ...transcriptOf.keys()])].sort(compareText);
  return ids.map((id): DerivedSession => {
    const sessionEvents = eventsBySession.get(id) ?? [];
    // A `scripted` event says only that its process holds the session, a `scripted-end` that it no
    // longer does (5.3): they supply no directory, launch command or last holding.
    const ownEvents = sessionEvents.filter(
      (event) => event.kind !== 'scripted' && event.kind !== 'scripted-end',
    );
    const transcript = transcriptOf.get(id) ?? null;
    const doneAtNs = metaOf.get(id)?.doneAtNs ?? null;

    const holders: Holder[] = (holdingEvents.get(id) ?? [])
      .filter(isAlive)
      .sort((a, b) => compareEvents(b, a))
      .map((event) => {
        const process = processOf(event);
        const live =
          (liveFilesOfPid.get(process.pid) ?? []).find(
            (file) => isFileOf(file, process) && file.sessionId === id && input.isTrusted(file),
          ) ?? null;
        return { process, sinceNs: event.timeNs, live, scripted: event.kind === 'scripted' };
      });

    // A dead process's last sign of life while it held the session: the last write of the live
    // file it left that names the session (null when there is none).
    const lastWriteNs = (process: ProcessKey): Ns | null =>
      (liveFilesOfPid.get(process.pid) ?? [])
        .filter((file) => isFileOf(file, process) && file.sessionId === id)
        .reduce<Ns | null>((seen, file) => latest(seen, file.mtimeNs), null);
    const lastHolding = lastHoldingOf(ownEvents, eventsOfProcess, isAlive, lastWriteNs);
    const lastActivityNs =
      latest(transcript?.lastRecordNs ?? null, sessionEvents.at(-1)?.timeNs ?? null) ??
      transcript?.mtimeNs ??
      0n; // unreachable: a session is known from an event or a transcript
    const firstSeenNs =
      earliest(transcript?.firstRecordNs ?? null, sessionEvents[0]?.timeNs ?? null) ??
      transcript?.mtimeNs ??
      0n; // unreachable, as above
    const holder = holders[0];
    const { state, stateDetail, sinceNs } = stateOf(
      holders,
      lastActivityNs,
      holder === undefined ? null : holdingBeganNs(sessionEvents, holder.process),
    );

    const endedUnexpectedly =
      state === 'not-running' &&
      lastHolding !== null &&
      !lastHolding.alive &&
      (lastHolding.endDetail === null || lastHolding.endDetail === 'other');
    const wasWorking =
      endedUnexpectedly &&
      lastHolding !== null &&
      (transcript?.lastTurnRole === 'user' ||
        // A leftover file of the dead process; it need not be trusted (the process is gone).
        (liveFilesOfPid.get(lastHolding.process.pid) ?? []).some(
          (file) => isFileOf(file, lastHolding.process) && file.status === 'busy',
        ));
    const continuedBy = continuation.get(id);
    const copyOf = copied.get(id)?.fromSession;
    // F33 (ruled): a copy whose process works, or waits for an answer to a question (a dialog), is
    // in use whatever its transcript says yet; only one idle at its first prompt, or not running, is
    // empty.
    const inUse = holders.some(
      (held) => held.live?.status === 'busy' || held.live?.status === 'waiting',
    );
    const has: Record<Mark, boolean> = {
      'ended-unexpectedly': endedUnexpectedly,
      'was-working': wasWorking,
      continued: continuedBy !== undefined,
      // F33: a copy with no turn and no input yet (no transcript, or one with only a title).
      'empty-copy':
        copyOf !== undefined &&
        !inUse &&
        (transcript === null ||
          (transcript.lastTurnRole === null && transcript.lastUserNs === null)),
      expired: transcript !== null && transcript.missingSinceNs !== null,
      expiring:
        transcript !== null &&
        transcript.missingSinceNs === null &&
        transcript.mtimeNs < expiringBeforeNs,
      duplicate: holders.length >= 2,
    };

    return {
      id,
      state,
      stateDetail,
      sinceNs,
      lastActivityNs,
      firstSeenNs,
      holders,
      marks: MARK_ORDER.filter((mark) => has[mark]),
      continuedFrom: continuedBy?.fromSession ?? null,
      dir: transcript?.firstCwd ?? ownEvents.find((event) => event.cwd !== null)?.cwd ?? null,
      launch:
        ownEvents.findLast((event) => event.kind !== 'end' && event.argv !== null)?.argv ?? null,
      transcript,
      lastHolding,
      // The events are in (time, id) order, so the highest id is not necessarily the last one.
      lastEventId: sessionEvents.reduce<number | null>(
        (highest, event) => (highest === null || event.id > highest ? event.id : highest),
        null,
      ),
      bootId: input.bootId,
      doneAtNs,
      hidden: doneAtNs !== null && !activityAfter(doneAtNs, transcript, sessionEvents),
      ...(copyOf === undefined ? {} : { copyOf }),
    };
  });
}

/** Keeps in `map`, under its target session, the later of `link` and the link already there. */
function keepLatest(map: Map<string, LinkRow>, link: LinkRow): void {
  const chosen = map.get(link.toSession);
  if (chosen === undefined || compareLinks(link, chosen) > 0) {
    map.set(link.toSession, link);
  }
}

/** 6.2: the state from the latest holder's live file, and the time the session has been in it. */
function stateOf(
  holders: readonly Holder[],
  lastActivityNs: Ns,
  beganNs: Ns | null,
): { state: State; stateDetail: string | null; sinceNs: Ns } {
  const holder = holders[0];
  if (holder === undefined) {
    return { state: 'not-running', stateDetail: null, sinceNs: lastActivityNs };
  }
  const live = holder.live;
  // The file keeps its status time when the process changes session (`/clear`): a session the
  // holder began to hold later than that is not in the state since before it existed.
  const statusNs = live?.statusUpdatedAtNs ?? live?.updatedAtNs ?? holder.sinceNs;
  const statusSinceNs = beganNs !== null && beganNs > statusNs ? beganNs : statusNs;
  switch (live?.status) {
    case 'busy':
      return { state: 'working', stateDetail: null, sinceNs: statusSinceNs };
    case 'idle':
    case 'waiting':
      return { state: 'waiting', stateDetail: live.waitingFor, sinceNs: statusSinceNs };
    default:
      return { state: 'running', stateDetail: null, sinceNs: holder.sinceNs };
  }
}

/**
 * When `process` began to hold the session: its latest `start` event naming it, a compaction aside
 * (the session id stays). null when it has none: a session found by reconcile (`observed`) is
 * not known to have begun anywhere.
 */
function holdingBeganNs(sessionEvents: readonly EventRow[], process: ProcessKey): Ns | null {
  const began = sessionEvents.findLast(
    (event) =>
      event.kind === 'start' &&
      event.detail !== 'compact' &&
      event.bootId === process.bootId &&
      event.pid === process.pid &&
      event.procStart === process.procStart,
  );
  return began?.timeNs ?? null;
}

/**
 * Where a holding stands among the others: one that still goes on (a live process holds the
 * session) comes after every one that ended; among those, the later end, then the higher event id.
 */
interface HoldingRank {
  goesOn: boolean;
  atNs: Ns;
  eventId: number;
}

/**
 * 6.1 and 6.3: the session's last holding — of the holdings of the processes that held it (one per
 * process: its latest event naming the session), the one that ended last, not the one with the
 * latest event row. A holding ends at the process's `end` for the session, or at the process's
 * first event after it (it moved on to another session without one). One the process still had at
 * its last event goes on while the process is alive; a process that is gone without an end event
 * ended when it was last seen: its last event, or the last write of the live file it left naming
 * the session (`lastWriteNs`), whichever is later. A move that only reconcile saw (the next event
 * is `observed`) is ranked at the process's last event for the session.
 */
function lastHoldingOf(
  sessionEvents: readonly EventRow[],
  eventsOfProcess: ReadonlyMap<string, readonly EventRow[]>,
  isAlive: (event: EventRow) => boolean,
  lastWriteNs: (process: ProcessKey) => Ns | null,
): LastHolding | null {
  const lastOfProcess = new Map<string, EventRow>(); // process id → its latest event naming the session
  for (const event of sessionEvents) {
    if (event.pid !== 0) {
      lastOfProcess.set(processId(event), event);
    }
  }
  let chosen: { holding: LastHolding; rank: HoldingRank } | null = null;
  for (const [id, last] of lastOfProcess) {
    const candidate = holdingOf(
      last,
      eventsOfProcess.get(id) ?? [last],
      isAlive(last),
      lastWriteNs,
    );
    if (chosen === null || compareRanks(candidate.rank, chosen.rank) > 0) {
      chosen = candidate;
    }
  }
  return chosen?.holding ?? null;
}

/** How the holding that `last` (the process's latest event naming the session) belongs to ended. */
function holdingOf(
  last: EventRow,
  processEvents: readonly EventRow[],
  alive: boolean,
  lastWriteNs: (process: ProcessKey) => Ns | null,
): { holding: LastHolding; rank: HoldingRank } {
  const process = processOf(last);
  if (last.kind === 'end') {
    // F30: a holding the user ended in the window is an exit, whichever of its ends came last.
    const detail = endedInWindow(last.sessionId, processEvents) ? 'exit' : endDetailOf(last);
    return {
      holding: { process, alive, endedAtNs: last.timeNs, endDetail: detail },
      rank: { goesOn: false, atNs: last.timeNs, eventId: last.id },
    };
  }
  const after = processEvents[processEvents.indexOf(last) + 1];
  if (after !== undefined) {
    // An `observed` event is stamped when reconcile noticed the move, which can be much later than
    // the move itself: only the process's last event for the session is known to be before it.
    const movedAt = after.kind === 'observed' ? last : after;
    return {
      holding: { process, alive, endedAtNs: after.timeNs, endDetail: 'moved-on' },
      rank: { goesOn: false, atNs: movedAt.timeNs, eventId: movedAt.id },
    };
  }
  const seenNs = alive ? last.timeNs : (latest(last.timeNs, lastWriteNs(process)) ?? last.timeNs);
  return {
    holding: { process, alive, endedAtNs: null, endDetail: null },
    rank: { goesOn: alive, atNs: seenNs, eventId: last.id },
  };
}

function compareRanks(a: HoldingRank, b: HoldingRank): number {
  return Number(a.goesOn) - Number(b.goesOn) || compareNs(a.atNs, b.atNs) || a.eventId - b.eventId;
}

/** 7.1: user input in the transcript, or a start by `startup` or `resume`, after the done time. */
function activityAfter(
  doneAtNs: Ns,
  transcript: TranscriptRow | null,
  sessionEvents: readonly EventRow[],
): boolean {
  if (transcript?.lastUserNs != null && transcript.lastUserNs > doneAtNs) {
    return true;
  }
  return sessionEvents.some(
    (event) =>
      event.kind === 'start' &&
      (event.detail === 'startup' || event.detail === 'resume') &&
      event.timeNs > doneAtNs,
  );
}

/**
 * F30: whether the process's events hold the end the window records for `sessionId` once the
 * user's end of it there has exited (ENDED_IN_WINDOW): the hang-up made Claude Code end the
 * session as a closed terminal does (its hook's reason `other`, design 14), which would read as an
 * unexpected end.
 */
function endedInWindow(sessionId: string, processEvents: readonly EventRow[]): boolean {
  return processEvents.some(
    (event) =>
      event.kind === 'end' &&
      event.sessionId === sessionId &&
      event.detail === 'exit' &&
      event.rawDetail === ENDED_IN_WINDOW,
  );
}

function endDetailOf(event: EventRow): EndDetail {
  const detail = event.detail;
  return detail === 'clear' || detail === 'switch' || detail === 'exit' ? detail : 'other';
}

/** A process is its boot, pid and start time; an event without a pid (0) belongs to none. */
function processOf(event: EventRow): ProcessKey {
  return { bootId: event.bootId, pid: event.pid, procStart: event.procStart };
}

function processId(event: EventRow): string {
  return JSON.stringify([event.bootId, event.pid, event.procStart]);
}

/** Whether a live-session file is the one of this process; an unknown start never matches. */
function isFileOf(file: LiveFile, process: ProcessKey): boolean {
  return (
    file.pid === process.pid && file.procStart !== null && file.procStart === process.procStart
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNs(a: Ns, b: Ns): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a: EventRow, b: EventRow): number {
  return compareNs(a.timeNs, b.timeNs) || a.id - b.id;
}

function compareLinks(a: LinkRow, b: LinkRow): number {
  return compareNs(a.timeNs, b.timeNs) || a.eventId - b.eventId;
}

/** Negative when `a` is the transcript to use: one that is not missing, then the newest, then the smaller path. */
function compareTranscripts(a: TranscriptRow, b: TranscriptRow): number {
  return (
    Number(a.missingSinceNs !== null) - Number(b.missingSinceNs !== null) ||
    compareNs(b.mtimeNs, a.mtimeNs) ||
    compareText(a.path, b.path)
  );
}

function latest(a: Ns | null, b: Ns | null): Ns | null {
  return a === null ? b : b === null ? a : a > b ? a : b;
}

function earliest(a: Ns | null, b: Ns | null): Ns | null {
  return a === null ? b : b === null ? a : a < b ? a : b;
}
