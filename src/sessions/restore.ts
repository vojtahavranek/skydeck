// Restore (design 7.8): bring back the sessions that were open when the machine went down — which
// ones, and starting them a few at a time, each through the resume guard and its lock (principle
// 7), and only while there is memory to spare.
import { unknownFlags } from '../claude/launch.ts';
import { isSessionId } from '../claude/live.ts';
import { RefError, ResumeRefusedError, SkydeckError } from '../platform/errors.ts';
import { NS_PER_MINUTE, NS_PER_SECOND } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { EventRow } from '../store/types.ts';
import type { Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { shellQuote } from '../text/shell.ts';
import type { Deck } from './deck.ts';
import { ingestSpool } from './ingest.ts';
import { launchSpec } from './launch.ts';
import { buildList, flatRows } from './list.ts';
import type { ListRow } from './list.ts';
import { loadRows } from './load.ts';
import { refresh } from './refresh.ts';
import { prepareResumeById } from './resume-by-id.ts';
import {
  checkResumable,
  flagWarnings,
  isLockHeld,
  lockEventId,
  openSafely,
  readLock,
  releaseLock,
  renewLock,
  resumeStarted,
  settleFailedLaunch,
} from './resume.ts';
import type { PreparedLaunch } from './resume.ts';

export interface RestoreEntry {
  row: ListRow;
  bootId: string;
  /** null: no exit recorded. */
  endedAtNs: Ns | null;
  wasWorking: boolean;
  preselected: boolean;
}

/** An entry is preselected when it ended at most this long before the last event of its boot. */
const PRESELECT_WINDOW_NS = 2n * NS_PER_MINUTE;

/** How long restore waits between two looks for the start events of a batch. */
const START_CHECK_MS = 1000;

/** The latest earlier boot (design 7.8) and the time of its last event. */
export interface EarlierBoot {
  bootId: string;
  lastEventNs: Ns;
}

/**
 * Of each boot: its last event, and whether a session was held in it (a `start` or `observed`
 * event). `scripted` and `scripted-end` events (design 5.3) are left out of both: a scripted run is
 * not what the user had open, so it neither makes a boot the latest earlier one nor moves the last
 * event of its boot.
 */
function bootsOf(events: readonly EventRow[]): {
  lastEventOf: Map<string, Ns>;
  heldIn: Set<string>;
} {
  const lastEventOf = new Map<string, Ns>();
  const heldIn = new Set<string>();
  for (const event of events) {
    if (event.kind === 'scripted' || event.kind === 'scripted-end') {
      continue;
    }
    const last = lastEventOf.get(event.bootId);
    if (last === undefined || event.timeNs > last) {
      lastEventOf.set(event.bootId, event.timeNs);
    }
    if (event.kind === 'start' || event.kind === 'observed') {
      heldIn.add(event.bootId);
    }
  }
  return { lastEventOf, heldIn };
}

/**
 * Design 7.8's latest earlier boot: of the boots other than `currentBootId` in which a session was
 * held (a `start` or `observed` event), the one whose last event is the latest; `scripted` and
 * `scripted-end` events count for neither. null when there is none.
 */
export function latestEarlierBoot(
  events: readonly EventRow[],
  currentBootId: string | null,
): EarlierBoot | null {
  const { lastEventOf, heldIn } = bootsOf(events);
  let earlier: EarlierBoot | null = null;
  for (const bootId of [...heldIn].sort()) {
    const lastEventNs = lastEventOf.get(bootId) ?? 0n;
    if (bootId !== currentBootId && (earlier === null || lastEventNs > earlier.lastEventNs)) {
      earlier = { bootId, lastEventNs };
    }
  }
  return earlier;
}

/**
 * 7.8 set and preselection, in the order of `rows` (pass list order).
 *
 * The default set is the rows marked `ended-unexpectedly`, not done and not expired, whose last
 * holding was in the latest earlier boot (latestEarlierBoot); `all` takes such rows from every boot,
 * the current one included. An entry is preselected when no exit was recorded, or when it ended at
 * most two minutes before the last event of its own boot (D17). `scripted` and `scripted-end` events
 * (design 5.3) are left out of both: a scripted run neither makes a boot the latest earlier one nor
 * moves the last event of its boot.
 */
export function planRestore(
  rows: readonly ListRow[],
  events: readonly EventRow[],
  currentBootId: string | null,
  all: boolean,
): RestoreEntry[] {
  const earlierBoot = latestEarlierBoot(events, currentBootId)?.bootId ?? null;
  const { lastEventOf } = bootsOf(events);
  const entries: RestoreEntry[] = [];
  for (const row of rows) {
    const holding = row.session.lastHolding;
    if (
      holding === null ||
      !row.marks.includes('ended-unexpectedly') ||
      row.done ||
      row.marks.includes('expired')
    ) {
      continue;
    }
    const { bootId } = holding.process;
    if (!all && bootId !== earlierBoot) {
      continue;
    }
    const { endedAtNs } = holding;
    const bootLastNs = lastEventOf.get(bootId);
    entries.push({
      row,
      bootId,
      endedAtNs,
      wasWorking: row.marks.includes('was-working'),
      preselected:
        endedAtNs === null ||
        (bootLastNs !== undefined && endedAtNs >= bootLastNs - PRESELECT_WINDOW_NS),
    });
  }
  return entries;
}

export interface RestorePlan {
  entries: RestoreEntry[];
  earlier: EarlierBoot | null;
}

/**
 * The plan of a restore, shared by the command and the window's server (S2 11.1): planRestore over
 * `rows` (default loadRows(deck)) in list order (`ls --all`), with the boot id the rows were derived
 * with as the current one — never a second read, so a read that failed for the rows and one that
 * worked are not mixed (design 7.6) —, and the latest earlier boot. Without that boot id it refuses
 * (SkydeckError): every process would look dead, so this boot's running sessions would be offered,
 * and the guard could not see that they run (principle 7). No rows: no entries and no earlier boot.
 * Refreshes nothing: callers refresh first. The events are read once.
 */
export function restorePlan(
  deck: Deck,
  all: boolean,
  rows: readonly ListRow[] = loadRows(deck),
): RestorePlan {
  const [first] = rows;
  if (first === undefined) {
    return { entries: [], earlier: null };
  }
  const { bootId } = first.session;
  if (bootId === null) {
    throw new SkydeckError(
      'cannot read the boot id (/proc/sys/kernel/random/boot_id): restore cannot tell which sessions are still running',
    );
  }
  const inOrder = flatRows(
    buildList(rows, { showAll: true, filter: '', nowNs: deck.platform.clock.nowNs() }),
  );
  const events = deck.store.events();
  return {
    entries: planRestore(inOrder, events, bootId, all),
    earlier: latestEarlierBoot(events, bootId),
  };
}

/**
 * What the window's server adds to a restore (S2 11.1; plan C8, C23). The command passes none, and
 * without them a restore runs exactly as step 1's.
 */
export interface RestoreHooks {
  /**
   * Before prepareResumeById: a reason this session must not be resumed at all (the window's "this
   * session is already open in the window"); reported `failed <short>: <reason>`, nothing taken,
   * nothing opened.
   */
  refuse?(sessionId: string): string | null;
  /**
   * At every look of the wait, after the start check: a reason the session can no longer start from
   * this restore (its window terminals ended, were lost, were not started or were closed); reported
   * `failed <short>: <reason>` at once, its lock released with the value restore wrote last, and no
   * longer waited for.
   */
  gone?(sessionId: string): string | null;
  /**
   * Looked at before each batch, before each entry is prepared and after each look of the wait.
   * Once aborted, no further entry is prepared or opened and the wait ends at its next look; the
   * sessions still waited for are reported `timed out <short> <title>` (their locks stay, renewed
   * last: their terminals may still start them), then one line `stopped: <String(signal.reason)>`,
   * then `not started <short> <title>` for the entries not opened; outcome.stopped is true. But
   * the signal stops the run only when it is seen while the stop changes something — a session the
   * wait would still wait for, or an entry not opened; otherwise (every session started, or the
   * wait's time ran out at that look, with no entry left) the run ends as it would have.
   */
  signal?: AbortSignal;
  /**
   * C23: after a batch that opened at least one terminal and saw none of its sessions start, when
   * entries are left, the run stops as for the signal with the reason `no session of this batch
   * started`. A last (or only) batch that starts nothing ends the run as any run with failures.
   */
  stopAfterEmptyBatch?: boolean;
}

/**
 * The session a report line is about and what became of it: given with every line that records the
 * session in the outcome (`started`, `timed out`, `failed`, `not started`, the hand-off, each
 * printed command); header and warning lines (the flag warnings, `stopped: …`, `to resume these
 * yourself, run:`, the line that names a printed session) carry none.
 */
export type ReportOutcome = {
  sessionId: string;
  kind: 'started' | 'timed-out' | 'failed' | 'not-started' | 'handed-off' | 'printed';
};

export interface RestoreOutcome {
  /** Session ids with a start event in time. */
  started: string[];
  timedOut: string[];
  /** Refused (by the guard or the refuse hook), the terminal failed, or gone (the gone hook). */
  failed: { id: string; reason: string }[];
  /** Left out by a stop: the memory check, the signal, an empty batch. */
  notStarted: string[];
  /** Resumed --here (no tab adapter). */
  handedOff: string | null;
  /**
   * Lines printed for the user to run (no tab adapter): `skydeck resume <id> --here` for each session
   * restore does not start itself; the session's own command when its hand-off failed.
   */
  printed: string[];
  stoppedForMemory: boolean;
  /** Ended by the signal or by stopAfterEmptyBatch (RestoreHooks); not by the memory check. */
  stopped: boolean;
}

interface Run {
  deck: Deck;
  terminal: Terminal;
  report: (line: string, outcome?: ReportOutcome) => void;
  /** The caller's hooks (RestoreHooks). */
  hooks: RestoreHooks;
  outcome: RestoreOutcome;
}

/** C23's reason. */
const EMPTY_BATCH = 'no session of this batch started';

/**
 * 7.8 "Running it". With a terminal that opens tabs: batches of config.restoreBatch, each started
 * only when there is enough memory, and followed by a wait (one look a second, at most
 * config.restoreStartTimeoutSeconds) until each of its sessions has a start event (a tab whose
 * opening timed out is waited for too: it may have opened). Without one: the first session the
 * guard accepts is handed off here, and for each of the others that the guard would let through
 * now, `skydeck resume <id> --here` is printed (it runs the guard again when the user runs it).
 *
 * Every session goes through the resume guard on fresh state (a refresh just before it), so a
 * session another skydeck resumed meanwhile is refused, not resumed a second time (principle 7).
 * `report` gets one line per outcome, with the outcome it records (ReportOutcome); every foreign
 * string in it is sanitised. The hooks (RestoreHooks) are the window's server's; without them
 * nothing of this changes.
 */
export async function runRestore(
  deps: {
    deck: Deck;
    terminal: Terminal;
    report: (line: string, outcome?: ReportOutcome) => void;
  } & RestoreHooks,
  entries: readonly RestoreEntry[],
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = {
    started: [],
    timedOut: [],
    failed: [],
    notStarted: [],
    handedOff: null,
    printed: [],
    stoppedForMemory: false,
    stopped: false,
  };
  const run: Run = {
    deck: deps.deck,
    terminal: deps.terminal,
    report: deps.report,
    hooks: deps,
    outcome,
  };
  if (deps.terminal.opensTabs) {
    await runInTabs(run, entries);
  } else {
    await runHere(run, entries);
  }
  return outcome;
}

async function runInTabs(run: Run, entries: readonly RestoreEntry[]): Promise<void> {
  const { deck, outcome } = run;
  const size = deck.config.restoreBatch;
  let next = 0; // the first entry not prepared yet
  while (next < entries.length) {
    if (aborted(run)) {
      stopForSignal(run, entries.slice(next));
      return;
    }
    if (!enoughMemory(run, entries.slice(next))) {
      return;
    }
    const sinceNs = deck.platform.clock.nowNs();
    const startedBefore = outcome.started.length;
    const opened: Waiting[] = [];
    for (const entry of entries.slice(next, next + size)) {
      if (aborted(run)) {
        break;
      }
      next += 1;
      // Opening a tab can take its full timeout: the locks of the tabs already opened are renewed
      // before the refresh in prepare() could sweep them as stale.
      renewLocks(deck, opened);
      const taken = prepare(run, entry);
      if (taken === null) {
        continue;
      }
      const { prepared, lock, afterEventId } = taken;
      const result = await openSafely(run.terminal, launchSpec(prepared, lock));
      // A call that timed out may have opened the tab anyway: its session is waited for like the
      // others, so that no more than one batch is starting at a time.
      if (result.ok || result.timedOut) {
        opened.push({ row: entry.row, lock, afterEventId });
        continue;
      }
      fail(run, entry.row, result.error);
      // The tab definitely did not open, and restore prints no command for it: the lock would only
      // keep the user waiting.
      if (lock !== null) {
        releaseLock(deck, entry.row.id, lock);
      }
    }
    const cut = await awaitStarts(run, opened, sinceNs);
    if (cut || (aborted(run) && next < entries.length)) {
      stopForSignal(run, entries.slice(next));
      return;
    }
    if (
      run.hooks.stopAfterEmptyBatch === true &&
      opened.length > 0 &&
      outcome.started.length === startedBefore &&
      next < entries.length
    ) {
      stop(run, EMPTY_BATCH, entries.slice(next));
      return;
    }
  }
}

/** A session whose tab was opened and whose start event has not been seen yet. */
interface Waiting {
  row: ListRow;
  /** The value of its resume lock that restore wrote last; null once the lock is no longer restore's. */
  lock: string | null;
  /** The event id its lock records (lockEventId): only a start stored after it is this resume's. */
  afterEventId: number | null;
}

/**
 * Looks for the start events of `opened` once a second until all are there or the time is up. A
 * session has started by the rule of the lock (resumeStarted, D16), with `sinceNs` as its time: a
 * start event of a real process stored after restore took its lock, dated at or after `sinceNs` (or
 * up to LOCK_START_TOLERANCE_NS before it, the clock having stepped back). One stored before the
 * lock, but dated later because the clock was ahead then, is not the claude its tab started. At
 * every look the locks of the sessions still waited for are renewed, the last time when restore
 * gives up on them: the wait (default 120 s) is longer than a lock holds (60 s), and a tab that is
 * slow to start claude must not let another resume start it again.
 *
 * With the hooks: a session `gone` names is failed at that look and its lock given back; an abort of
 * the signal ends the wait after the look, and whether it cut the wait short (sessions were still
 * waited for) is returned.
 */
async function awaitStarts(run: Run, opened: readonly Waiting[], sinceNs: Ns): Promise<boolean> {
  const { deck, outcome, report } = run;
  const { clock } = deck.platform;
  const limitNs = BigInt(deck.config.restoreStartTimeoutSeconds) * NS_PER_SECOND;
  let waiting = [...opened];
  let cut = false;
  while (waiting.length > 0) {
    ingestSpool(deck);
    waiting = waiting.filter(({ row, lock, afterEventId }) => {
      if (resumeStarted(deck.store, row.id, sinceNs, afterEventId)) {
        // D16: a start removes the lock. Restore may have renewed it after the start (before it read
        // the start event), so the start alone would no longer make it stale: restore drops its own.
        if (lock !== null) {
          releaseLock(deck, row.id, lock);
        }
        outcome.started.push(row.id);
        report(`started ${row.shortId} ${row.title}`, { sessionId: row.id, kind: 'started' });
        return false;
      }
      const reason = run.hooks.gone?.(row.id) ?? null;
      if (reason === null) {
        return true;
      }
      // Nothing can start it from this restore any more: the lock would only keep the user waiting.
      if (lock !== null) {
        releaseLock(deck, row.id, lock);
      }
      fail(run, row, reason);
      return false;
    });
    renewLocks(deck, waiting);
    if (waiting.length === 0 || clock.nowNs() - sinceNs >= limitNs) {
      break;
    }
    if (aborted(run)) {
      cut = true;
      break;
    }
    await clock.sleep(START_CHECK_MS);
  }
  for (const { row } of waiting) {
    // Its tab may still start it: its lock, renewed just now, holds for another LOCK_TTL_NS.
    outcome.timedOut.push(row.id);
    report(`timed out ${row.shortId} ${row.title}`, { sessionId: row.id, kind: 'timed-out' });
  }
  return cut;
}

/** Renews the lock of each session (renewLock); one that is no longer restore's is not touched again. */
function renewLocks(deck: Deck, sessions: readonly Waiting[]): void {
  for (const session of sessions) {
    if (session.lock !== null) {
      session.lock = renewLock(deck, session.row.id, session.lock);
    }
  }
}

async function runHere(run: Run, entries: readonly RestoreEntry[]): Promise<void> {
  if (aborted(run)) {
    stopForSignal(run, entries);
    return;
  }
  if (!enoughMemory(run, entries)) {
    return;
  }
  let handoffTried = false;
  for (const [index, entry] of entries.entries()) {
    if (aborted(run)) {
      stopForSignal(run, entries.slice(index));
      return;
    }
    if (!handoffTried) {
      const taken = prepare(run, entry);
      if (taken === null) {
        continue; // refused: the next one is handed off instead
      }
      handoffTried = true;
      const { prepared, lock } = taken;
      const result = await openSafely(run.terminal, launchSpec(prepared, lock));
      if (result.ok) {
        run.outcome.handedOff = entry.row.id;
        run.report(`resuming ${entry.row.shortId} ${entry.row.title} in this terminal`, {
          sessionId: entry.row.id,
          kind: 'handed-off',
        });
        continue;
      }
      fail(run, entry.row, result.error);
      // As `resume` does when it cannot start the session (settleFailedLaunch): the command is
      // printed for the user to run, and the lock stays so that no other skydeck starts the session
      // meanwhile. After a timeout nothing is printed and the lock stays: the program may have
      // started. With nothing started and nothing printable, the lock is released.
      const command = settleFailedLaunch(run.deck, prepared, lock, result.timedOut);
      if (command !== null) {
        printLine(run, entry.row, command);
      } else if (!result.timedOut) {
        run.report(`${entry.row.shortId}: ${UNPRINTABLE}`);
      }
      continue;
    }
    const row = freshRow(run, entry);
    if (row === null) {
      continue;
    }
    try {
      checkResumable(row, run.deck.platform.files);
    } catch (error) {
      if (!(error instanceof ResumeRefusedError)) throw error;
      fail(run, row, error.message);
      continue;
    }
    // The guard's lock, read only: another skydeck is starting this session. Said now, rather than
    // a line printed that the guard would refuse when it is run.
    if (isLockHeld(run.deck, row.id)) {
      fail(run, row, `${row.shortId} is being resumed by another skydeck`);
      continue;
    }
    const launch = row.session.launch;
    warn(run, row, {
      flagsKnown: launch !== null,
      unknownFlags: launch === null ? [] : unknownFlags(launch),
    });
    printLine(run, row, resumeLine(row.id));
  }
}

/**
 * What restore prints for a session it does not start itself: not the session's own command, but a
 * resume of it. The user may paste the line minutes later, and the session may have been resumed
 * elsewhere meanwhile: `skydeck resume` runs the guard and takes the lock at the moment it is run,
 * where a raw `claude --resume` would start a second process on the transcript (principle 7). Only
 * a lowercase UUID is put into the line (RangeError otherwise, as buildResumeCommand does), so it is
 * always safe to print and paste.
 */
function resumeLine(sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw new RangeError(`not a session id (a lowercase UUID): ${JSON.stringify(sessionId)}`);
  }
  return `skydeck resume ${sessionId} --here`;
}

const UNPRINTABLE = 'the command contains control characters and cannot be printed safely';

/**
 * A line for the user to run, to `printed` and `report`, after a header line the first time. Before
 * it, a line that names the session: `<short> <title> in <dir>:`, with the title and the directory
 * (sanitised in the row) quoted for a shell. With --yes no list was shown, and the command names only
 * an id. The name line sits right under "run:", so a user may paste it along with the command: quoted,
 * it is a command that does not exist and nothing else, where a title such as `notes -> README.md`
 * would truncate a file. Not a `#` comment after the command: zsh takes none in an interactive shell.
 * The command keeps a line of its own, so that it can be pasted alone.
 */
function printLine(run: Run, row: ListRow, line: string): void {
  if (run.outcome.printed.length === 0) {
    run.report('to resume these yourself, run:');
  }
  const where = row.dir === null ? '' : ` in ${shellQuote(row.dir)}`;
  run.report(`${row.shortId} ${shellQuote(row.title)}${where}:`);
  run.outcome.printed.push(line);
  run.report(line, { sessionId: row.id, kind: 'printed' });
}

/**
 * Before each batch (7.8): when the memory available is below config.restoreMinFreeMb (unknown
 * counts as enough), records `rest` as not started and says so; whether to go on.
 */
function enoughMemory(run: Run, rest: readonly RestoreEntry[]): boolean {
  const { deck, outcome, report } = run;
  const availableMb = deck.platform.proc.memAvailableMb();
  const minimumMb = deck.config.restoreMinFreeMb;
  if (availableMb === null || availableMb >= minimumMb) {
    return true;
  }
  outcome.stoppedForMemory = true;
  report(
    `stopped: only ${availableMb} MiB of memory available, less than restoreMinFreeMb (${minimumMb} MiB)`,
  );
  reportNotStarted(run, rest);
  return false;
}

/** Records `rest` as not started, one line each. */
function reportNotStarted(run: Run, rest: readonly RestoreEntry[]): void {
  for (const { row } of rest) {
    run.outcome.notStarted.push(row.id);
    run.report(`not started ${row.shortId} ${row.title}`, {
      sessionId: row.id,
      kind: 'not-started',
    });
  }
}

/** Whether the caller's signal (RestoreHooks) has been aborted. */
function aborted(run: Run): boolean {
  return run.hooks.signal?.aborted === true;
}

/** A stop of the run (RestoreHooks): `stopped: <reason>`, then `rest` not started. */
function stop(run: Run, reason: string, rest: readonly RestoreEntry[]): void {
  run.outcome.stopped = true;
  run.report(`stopped: ${sanitize(reason)}`);
  reportNotStarted(run, rest);
}

/** The signal's stop, with its reason. */
function stopForSignal(run: Run, rest: readonly RestoreEntry[]): void {
  stop(run, String(run.hooks.signal?.reason), rest);
}

/**
 * The entry's row as it is now, for a session whose resume is printed rather than started (no lock): a
 * refresh and the rows read again, as prepareResumeById does, so that the check sees what happened
 * since the entries were planned. A session the deck no longer knows is a failure (null).
 */
function freshRow(run: Run, entry: RestoreEntry): ListRow | null {
  refresh(run.deck);
  const row = loadRows(run.deck).find((candidate) => candidate.id === entry.row.id);
  if (row === undefined) {
    fail(run, entry.row, 'no longer known');
    return null;
  }
  return row;
}

/**
 * prepareResumeById (a refresh, the rows read again, then the guard and the lock), and the lines
 * about its flags; null when refused or no longer known. `lock` is the value of the lock it took,
 * to renew or release that lock and no other; `afterEventId` the event id that lock records.
 */
function prepare(
  run: Run,
  entry: RestoreEntry,
): { prepared: PreparedLaunch; lock: string | null; afterEventId: number | null } | null {
  const { row } = entry;
  const refusal = run.hooks.refuse?.(row.id) ?? null;
  if (refusal !== null) {
    fail(run, row, refusal);
    return null;
  }
  let prepared: PreparedLaunch;
  try {
    prepared = prepareResumeById(run.deck, row.id);
  } catch (error) {
    if (error instanceof RefError) {
      fail(run, row, 'no longer known');
      return null;
    }
    if (!(error instanceof ResumeRefusedError)) throw error;
    fail(run, row, error.message);
    return null;
  }
  warn(run, row, prepared);
  const lock = readLock(run.deck, row.id);
  return { prepared, lock, afterEventId: lock === null ? null : lockEventId(lock) };
}

/** What `resume` says before it starts a session (flagWarnings), one line each, naming the session. */
function warn(
  run: Run,
  row: ListRow,
  launch: Pick<PreparedLaunch, 'flagsKnown' | 'unknownFlags'>,
): void {
  for (const line of flagWarnings(launch)) {
    run.report(`${row.shortId}: ${line}`);
  }
}

function fail(run: Run, row: ListRow, reason: string): void {
  const shown = sanitize(reason);
  run.outcome.failed.push({ id: row.id, reason: shown });
  run.report(`failed ${row.shortId}: ${shown}`, { sessionId: row.id, kind: 'failed' });
}
