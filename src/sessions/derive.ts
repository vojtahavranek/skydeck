// Derived state (design 6): which process holds which session, the state a session is in, and its
// marks. A pure function of what it is given: no file access, no clock, no store.
import type { LiveFile, ProcessKey } from '../claude/live.ts';
import { NS_PER_DAY } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
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
  const latestOfProcess = new Map<string, EventRow>(); // process id → its latest event
  for (const event of events) {
    push(eventsBySession, event.sessionId, event);
    if (event.pid !== 0) {
      latestOfProcess.set(processId(event), event);
    }
  }
  // A process holds the session of its latest event unless that event is an `end`.
  const holdingEvents = new Map<string, EventRow[]>(); // session id → latest events of its processes
  for (const latest of latestOfProcess.values()) {
    if (latest.kind !== 'end') {
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

  const continuation = new Map<string, LinkRow>(); // target session → its latest clear or fork link
  for (const link of input.links) {
    if (link.kind !== 'clear' && link.kind !== 'fork') {
      continue;
    }
    const chosen = continuation.get(link.toSession);
    if (chosen === undefined || compareLinks(link, chosen) > 0) {
      continuation.set(link.toSession, link);
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
        return { process, sinceNs: event.timeNs, live };
      });

    const lastHolding = lastHoldingOf(id, sessionEvents, latestOfProcess, isAlive);
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
    const has: Record<Mark, boolean> = {
      'ended-unexpectedly': endedUnexpectedly,
      'was-working': wasWorking,
      continued: continuedBy !== undefined,
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
      dir: transcript?.firstCwd ?? sessionEvents.find((event) => event.cwd !== null)?.cwd ?? null,
      launch:
        sessionEvents.findLast((event) => event.kind !== 'end' && event.argv !== null)?.argv ??
        null,
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
    };
  });
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
 * 6.1 and 6.3: the last process that held the session and how the holding ended. `E` is the latest
 * event naming the session that has a process; an `end` closes the holding at once, otherwise the
 * process's own latest event says whether it still holds the session or has moved on.
 */
function lastHoldingOf(
  sessionId: string,
  sessionEvents: readonly EventRow[],
  latestOfProcess: ReadonlyMap<string, EventRow>,
  isAlive: (event: EventRow) => boolean,
): LastHolding | null {
  const last = sessionEvents.findLast((event) => event.pid !== 0);
  if (last === undefined) {
    return null;
  }
  const process = processOf(last);
  const alive = isAlive(last);
  if (last.kind === 'end') {
    return { process, alive, endedAtNs: last.timeNs, endDetail: endDetailOf(last) };
  }
  const latestOfIt = latestOfProcess.get(processId(last)) ?? last;
  if (latestOfIt.sessionId === sessionId && latestOfIt.kind !== 'end') {
    return { process, alive, endedAtNs: null, endDetail: null };
  }
  return { process, alive, endedAtNs: latestOfIt.timeNs, endDetail: 'moved-on' };
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
