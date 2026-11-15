/**
 * Attention on the server (S2 10.1's one-second look, 10.2, 10.3, 12.4's reason 2 and seen, 14's
 * busy store; stage B's plan, task 52, B9–B11): it reads the live-session files every second and
 * keeps one baseline per pid (B4), records in the store's `attention` each turn end (S2 10.3), each
 * end of a window terminal whose session ended unexpectedly (B10) and the moments the user saw a
 * session (B9), and holds the facts the view model judges attention on. What a change of a file
 * means is `lookAt` (src/claude/terminal.ts), when a session is being seen is `src/window/seen.ts`:
 * this module reads, writes and remembers.
 *
 * Writes. Each call makes at most one `recordAttention`, its entries in order. A store another
 * process keeps locked (busy, S2 14) keeps them, and the next look tries them again first, in their
 * order, each as an entry of its own (B11): only two turn ends of one session are folded, the later
 * kept. While writes are kept, `refreshed` and `seenNow` put theirs behind them without touching
 * the store, so that a busy store costs its 250 ms once a look, never at every key (`seenNow` runs
 * at every key press on some paths; ruled). Any other failure of a write — B2's limit at 2^53 − 1,
 * a damaged table — drops it; a seen that would still clear a mark is made anew at the next look or
 * key while the hold lasts, and each such try is refused at once (logged once). A store migrated
 * under the server (StoreNewerError) stops the module (S2 10.1). The marks are read once, at the
 * first look that can (only the server writes them), and then follow from what each write returns;
 * a read that fails for another reason than a busy store leaves no attention facts from the store
 * (ruled: one damaged row makes `attention()` throw for every session).
 *
 * It never throws: its callers are the tick and Seen's listener (ruled: the listener must not
 * throw). Each failure is logged by its kind, once until that work works again; a log line names a
 * kind, never a session's text.
 */
import { isLiveFileTrusted, readLiveFiles } from '../claude/live.ts';
import { procStartFromStat } from '../claude/procstat.ts';
import { lookAt } from '../claude/terminal.ts';
import type { LookedFile } from '../claude/terminal.ts';
import type { Ns } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import type { ListRow } from '../sessions/list.ts';
import { StoreNewerError } from '../store/store.ts';
import type { AttentionRow, AttentionWrite } from '../store/types.ts';
import { failureKind } from './auth.ts';
import { isBusy } from './busy.ts';
import type { TerminalHub } from './hub.ts';
import type { Seen } from './seen.ts';
import { liveStatuses } from './view/attention.ts';
import type { AttentionFacts, AttentionMarks, LiveStatus } from './view/attention.ts';

export interface AttentionDeps {
  /** The server's guarded connection; files, proc, clock and places.claudeHome. */
  deck: Deck;
  hub: Pick<TerminalHub, 'list'>;
  seen: Pick<Seen, 'take'>;
  /** The rows of the last reload (the tick's). */
  rows: () => readonly ListRow[];
  log: (line: string) => void;
  /** S2 10.1: the store was migrated under the server; told once, after which the module does
   *  nothing more. */
  storeNewer: (reason: string) => void;
}

export interface Attention {
  /** The one-second look (S2 10.3): readLiveFiles, trust, lookAt, then one recordAttention with the
   *  writes kept from a refused one first, in their order (B11), and this look's turn ends (the
   *  latest status time among the session's idle baselines, else the clock; ruled) and B9's seen
   *  writes for each id of seen.take(): in the write of its end, else on its own, for an id among
   *  rows(), when the marks after this write would still hold an unseen end (a mark that became
   *  known while the hold lasts; ruled) — none periodic. The marks
   *  are read from the store at the first look that can (only the server writes them). True when
   *  the facts changed. Never throws: a busy store keeps the writes (B11) and logs its kind once
   *  until a write works again. */
  look(): boolean;
  /** After a refresh that worked: B10's window ends, with the seen of a session being seen in the
   *  same write; nothing is judged before the marks are read. True when the facts changed. Never
   *  throws, as look. */
  refreshed(): boolean;
  /** A session began to be seen (Seen.onChange): only B9's seen writes, now; with writes kept, they
   *  join them for the next look and the store is not touched. Cheap when there is nothing to clear
   *  (no read, no write). As look. */
  seenNow(): boolean;
  /** B12: true once the marks have been read, a refresh has worked since (refreshed() was called)
   *  and nothing is kept, so that the window ends of that refresh are in the first judgement also
   *  when a busy store kept them (ruled); once true, it stays true. */
  ready(): boolean;
  /** The module's own maps, read-only to the caller: current until its next call that changes them
   *  (a caller builds its lists at once, as the server's do). */
  facts(): AttentionFacts;
}

/** A failure logged once by its kind, until the work it is of works again (S2 5.2: kinds only). */
interface Reporter {
  failed(error: unknown): void;
  worked(): void;
}

function reporter(log: (line: string) => void, what: string): Reporter {
  let last: string | null = null;
  return {
    failed(error) {
      const kind = failureKind(error);
      if (kind !== last) {
        last = kind;
        log(`attention: ${what} (${kind})`);
      }
    },
    worked() {
      last = null;
    },
  };
}

/** An observation `seq` later than `seenSeq` (S2 10.2: by the counter, never by a clock). */
function unseen(seq: number | null, seenSeq: number | null): boolean {
  return seq !== null && (seenSeq === null || seq > seenSeq);
}

function hasEnd(write: AttentionWrite): boolean {
  return write.turnEndedNs !== undefined || write.windowEndNs !== undefined;
}

/**
 * B9: whether `sessionId` holds an unseen end once `writes` are stored after `stored`: each value a
 * write takes is later than every stored one and than those of the writes before it, and inside one
 * write the seen comes after the ends (B3).
 */
function unseenAfter(
  stored: AttentionMarks | undefined,
  writes: readonly AttentionWrite[],
  sessionId: string,
): boolean {
  let open =
    stored !== undefined &&
    (unseen(stored.turnEndedSeq, stored.seenSeq) || unseen(stored.windowEndSeq, stored.seenSeq));
  for (const write of writes) {
    if (write.sessionId !== sessionId) continue;
    if (hasEnd(write)) open = true;
    if (write.seen === true) open = false;
  }
  return open;
}

/**
 * B11: `write` put behind `queue`. A turn end takes the place of an earlier one of its session (the
 * later is kept): the earlier write loses its turn end, and goes if nothing is left of it. Nothing
 * else is folded — a seen folded into a later turn end would make that turn seen (B3) although the
 * user had left. A turn end's write holds no window end (the look writes turn ends, `refreshed`
 * window ends), so what is left of it is its seen.
 */
function enqueue(queue: readonly AttentionWrite[], write: AttentionWrite): AttentionWrite[] {
  const next: AttentionWrite[] = [];
  for (const earlier of queue) {
    if (
      write.turnEndedNs === undefined ||
      earlier.sessionId !== write.sessionId ||
      earlier.turnEndedNs === undefined
    ) {
      next.push(earlier);
      continue;
    }
    if (earlier.seen === true) next.push({ sessionId: earlier.sessionId, seen: true });
  }
  next.push(write);
  return next;
}

/** The largest time an INTEGER column holds (design 9.2), in nanoseconds. */
const INT64_MAX = 2n ** 63n - 1n;

/** A live file's time, or null when no INTEGER column holds it (a foreign file's, from the year
 *  2262 on): unknown, so that one file cannot make the write of every session fail. */
function storable(ns: Ns | null): Ns | null {
  return ns !== null && ns <= INT64_MAX ? ns : null;
}

function sameLive(a: ReadonlyMap<string, LiveStatus>, b: ReadonlyMap<string, LiveStatus>): boolean {
  if (a.size !== b.size) return false;
  for (const [sessionId, x] of a) {
    const y = b.get(sessionId);
    if (
      y === undefined ||
      y.status !== x.status ||
      y.waitingFor !== x.waitingFor ||
      y.sinceNs !== x.sinceNs
    ) {
      return false;
    }
  }
  return true;
}

export function createAttention(deps: AttentionDeps): Attention {
  const { deck, log } = deps;
  const { store, places } = deck;
  const { files, proc, clock } = deck.platform;

  /** The stored rows by session (the facts' marks): filled by the read and by each write's rows. */
  const marks = new Map<string, AttentionRow>();
  /** The statuses of the baselines (B4, B5). */
  let live: ReadonlyMap<string, LiveStatus> = new Map();
  let baselines: ReadonlyMap<number, LookedFile> = new Map();
  let first = true;
  /** The writes a busy store refused, in their order (B11). */
  let kept: AttentionWrite[] = [];
  let marksRead = false;
  /** A refresh was judged with the marks read (B12). */
  let judged = false;
  /** ready() said true: it stays so. */
  let wasReady = false;
  /** The terminals whose end was judged (B10: once), forgotten when they leave the list. */
  const judgedTerminals = new Set<string>();
  let stopped = false;

  const readBusy = reporter(log, 'the marks cannot be read yet, the database is busy');
  const unreadable = reporter(log, 'the marks cannot be read; there are no attention facts');
  const busy = reporter(log, 'the database is busy; the writes are kept for the next look');
  const refused = reporter(log, 'a write failed and is dropped');
  const lookFailed = reporter(log, 'the look failed');
  const judgeFailed = reporter(log, 'the window ends could not be judged');
  const seenFailed = reporter(log, 'the seen could not be written');

  /** The marks from the store, once (only the server writes them). True when there are any. */
  const readMarks = (): boolean => {
    if (marksRead) return false;
    let rows: AttentionRow[];
    try {
      rows = store.attention();
    } catch (error) {
      if (isBusy(error)) {
        readBusy.failed(error); // tried again at the next look
      } else {
        // Ruled: a damaged table (one bad row, or no table at schema 2) gives no attention facts;
        // the look goes on with the live statuses, and the read is not tried again.
        marksRead = true;
        unreadable.failed(error);
      }
      return false;
    }
    marksRead = true;
    // Every stored row: also those of writes made before the read worked.
    for (const row of rows) marks.set(row.sessionId, row);
    return rows.length > 0;
  };

  /** The files of this look that are read whole, parsed and trusted (B4); one whose trust cannot be
   *  judged (/proc fails) is not read at this look. */
  const lookedFiles = (): LookedFile[] => {
    const looked: LookedFile[] = [];
    for (const file of readLiveFiles(files, places.claudeHome)) {
      let trusted: boolean;
      try {
        trusted = isLiveFileTrusted(file, proc);
      } catch {
        continue;
      }
      const { procStart } = file;
      if (!trusted || procStart === null) continue;
      looked.push({
        pid: file.pid,
        procStart,
        sessionId: file.sessionId,
        status: file.status,
        waitingFor: file.waitingFor,
        sinceNs: storable(file.statusUpdatedAtNs) ?? storable(file.updatedAtNs),
      });
    }
    return looked;
  };

  /** B4: the baselines' pids without a file at this look that /proc says have no process, or one
   *  with another start (an unreadable start is not this one's); a read that throws is not gone. */
  const goneOf = (looked: readonly LookedFile[]): Set<number> => {
    const read = new Set(looked.map((file) => file.pid));
    const gone = new Set<number>();
    for (const [pid, baseline] of baselines) {
      if (read.has(pid)) continue;
      try {
        const line = proc.stat(pid);
        if ((line === null ? null : procStartFromStat(line)) !== baseline.procStart) gone.add(pid);
      } catch {
        // Unknown is not gone (design 5.5).
      }
    }
    return gone;
  };

  /**
   * This look's turn ends, one write per session. Its time is the latest status time among that
   * session's idle baselines after the look (ruled on review 2), so always an after-file's
   * `sinceNs`, and never earlier than the one the row shows (B5 shows the first idle holder's): the
   * stale-turn rule of the view model compares the two for equality. It holds for two holders that
   * end at one look (the later time) and for one whose idle file a look missed and that is seen
   * ending later with an earlier time. None known: the clock, the time the server saw the change.
   */
  const turnEnds = (
    ends: readonly { sessionId: string }[],
    after: ReadonlyMap<number, LookedFile>,
  ): AttentionWrite[] =>
    [...new Set(ends.map((end) => end.sessionId))].map((sessionId) => {
      let latest: Ns | null = null;
      for (const baseline of after.values()) {
        const { sinceNs } = baseline;
        if (
          baseline.sessionId === sessionId &&
          baseline.status === 'idle' &&
          sinceNs !== null &&
          (latest === null || sinceNs > latest)
        ) {
          latest = sinceNs;
        }
      }
      return { sessionId, turnEndedNs: latest ?? clock.nowNs() };
    });

  /**
   * B9: a seen for each session being seen: in the last write of its end among `writes` (after the
   * end: B3), whatever the rows say (ruled on review 2: the end makes the row, so F6's reason does
   * not hold, and a turn that ends in front of the user is never finished); else one of its own,
   * for a session among the rows (F6), when the marks after the kept writes and `writes` will still
   * hold an unseen end — a write only when there is something to clear.
   */
  const addSeen = (writes: AttentionWrite[], taken: ReadonlySet<string>): void => {
    let rowIds: Set<string> | null = null;
    for (const sessionId of taken) {
      const own = writes.findLast((write) => write.sessionId === sessionId && hasEnd(write));
      if (own !== undefined) {
        own.seen = true;
        continue;
      }
      if (!unseenAfter(marks.get(sessionId), [...kept, ...writes], sessionId)) continue;
      rowIds ??= new Set(deps.rows().map((row) => row.id));
      if (rowIds.has(sessionId)) writes.push({ sessionId, seen: true });
    }
  };

  const stop = (reason: string): void => {
    stopped = true;
    kept = [];
    deps.storeNewer(reason);
  };

  /** One recordAttention of `queue`; the rows it returns replace their marks. True when written. */
  const record = (queue: AttentionWrite[]): boolean => {
    if (queue.length === 0) return false;
    let rows: AttentionRow[];
    try {
      rows = store.recordAttention(queue);
    } catch (error) {
      if (error instanceof StoreNewerError) {
        stop(error.message);
      } else if (isBusy(error)) {
        kept = queue;
        busy.failed(error);
      } else {
        refused.failed(error); // not kept (B2's limit, a damaged table)
      }
      return false;
    }
    busy.worked();
    refused.worked();
    for (const row of rows) marks.set(row.sessionId, row);
    return true;
  };

  /** Outside the look: behind the kept writes if there are any (the look tries them), else now. */
  const write = (writes: AttentionWrite[]): boolean => {
    if (kept.length === 0) return record(writes);
    for (const one of writes) kept = enqueue(kept, one);
    return false;
  };

  return {
    look() {
      if (stopped) return false;
      let changed = false;
      try {
        changed = readMarks();
        const looked = lookedFiles();
        const { baselines: next, ends } = lookAt(baselines, looked, goneOf(looked), first);
        first = false;
        baselines = next;
        const statuses = liveStatuses(baselines.values());
        if (!sameLive(live, statuses)) {
          live = statuses;
          changed = true;
        }
        const writes = turnEnds(ends, baselines);
        addSeen(writes, deps.seen.take());
        let queue = kept;
        for (const one of writes) queue = enqueue(queue, one);
        kept = [];
        changed = record(queue) || changed;
        lookFailed.worked();
      } catch (error) {
        lookFailed.failed(error);
      }
      return changed;
    },

    refreshed() {
      if (stopped || !marksRead) return false;
      try {
        const terminals = deps.hub.list();
        const listed = new Set(terminals.map((term) => term.id));
        for (const id of judgedTerminals) {
          if (!listed.has(id)) judgedTerminals.delete(id);
        }
        let rows: ReadonlyMap<string, ListRow> | null = null;
        const writes: AttentionWrite[] = [];
        for (const term of terminals) {
          const { exit } = term;
          if (
            judgedTerminals.has(term.id) ||
            (term.state !== 'ended' && term.state !== 'lost') ||
            exit === null ||
            exit.notStarted !== null
          ) {
            continue;
          }
          const sessionId = term.sessionId ?? term.expectedSessionId;
          rows ??= new Map(deps.rows().map((row) => [row.id, row]));
          const row = rows.get(sessionId);
          // Ruled (review 2): not judged while its row still runs — a lost keeper's program lives
          // on its SIGHUP for a moment — nor while the row's last holder lives (ruled 09:47Z: its
          // end event can be ingested before its exit, and `ended-unexpectedly` needs the holder
          // gone, design 6.3), but at the first refresh where neither holds.
          if (
            row !== undefined &&
            (row.state !== 'not-running' || row.session.lastHolding?.alive === true)
          ) {
            continue;
          }
          judgedTerminals.add(term.id);
          if (row === undefined || !row.marks.includes('ended-unexpectedly')) {
            continue; // it ended deliberately, or skydeck knows no such session
          }
          const atNs = BigInt(exit.atNs);
          // The same end (a server restart finds the keeper again) is never marked twice.
          if (marks.get(sessionId)?.windowEndNs === atNs) continue;
          writes.push({ sessionId, windowEndNs: atNs });
        }
        judged = true;
        judgeFailed.worked();
        if (writes.length === 0) return false;
        addSeen(writes, deps.seen.take());
        return write(writes);
      } catch (error) {
        judgeFailed.failed(error);
        return false;
      }
    },

    seenNow() {
      if (stopped) return false;
      try {
        const writes: AttentionWrite[] = [];
        addSeen(writes, deps.seen.take());
        const changed = write(writes);
        seenFailed.worked();
        return changed;
      } catch (error) {
        seenFailed.failed(error);
        return false;
      }
    },

    ready() {
      // Latched (ruled on review 2): also nothing kept, so that the first judgement holds the
      // window ends of that refresh even when a busy store kept them.
      wasReady ||= marksRead && judged && kept.length === 0;
      return wasReady;
    },

    facts: () => ({ marks, live }),
  };
}
