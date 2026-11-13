// Restore (design 7.8): bring back the sessions that were open when the machine went down — which
// ones, and starting them a few at a time, each through the resume guard and its lock (principle
// 7), and only while there is memory to spare.
import { buildResumeCommand, unknownFlags } from '../claude/launch.ts';
import { RefError, ResumeRefusedError } from '../platform/errors.ts';
import { NS_PER_MINUTE, NS_PER_SECOND } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { EventRow } from '../store/types.ts';
import type { OpenResult, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { printableCommand } from '../text/shell.ts';
import type { Deck } from './deck.ts';
import { ingestSpool } from './ingest.ts';
import type { ListRow } from './list.ts';
import { loadRows } from './load.ts';
import { describeError } from './problems.ts';
import { refresh } from './refresh.ts';
import { prepareResumeById } from './resume-by-id.ts';
import { checkResumable, isLockHeld, readLock, releaseLock, renewLock } from './resume.ts';
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

/**
 * 7.8 set and preselection, in the order of `rows` (pass list order).
 *
 * The latest earlier boot is the boot other than `currentBootId` whose last event is the latest,
 * among the boots that have a `start` or `observed` event (a session was held in it). The default
 * set is the rows marked `ended-unexpectedly`, not done and not expired, whose last holding was in
 * that boot; `all` takes such rows from every boot, the current one included. An entry is
 * preselected when no exit was recorded, or when it ended at most two minutes before the last
 * event of its own boot (D17).
 */
export function planRestore(
  rows: readonly ListRow[],
  events: readonly EventRow[],
  currentBootId: string | null,
  all: boolean,
): RestoreEntry[] {
  const lastEventOf = new Map<string, Ns>();
  const heldIn = new Set<string>();
  for (const event of events) {
    const last = lastEventOf.get(event.bootId);
    if (last === undefined || event.timeNs > last) {
      lastEventOf.set(event.bootId, event.timeNs);
    }
    if (event.kind === 'start' || event.kind === 'observed') {
      heldIn.add(event.bootId);
    }
  }
  let earlierBoot: string | null = null;
  let earlierLastNs = 0n;
  for (const bootId of [...heldIn].sort()) {
    const lastNs = lastEventOf.get(bootId) ?? 0n;
    if (bootId !== currentBootId && (earlierBoot === null || lastNs > earlierLastNs)) {
      earlierBoot = bootId;
      earlierLastNs = lastNs;
    }
  }

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

export interface RestoreOutcome {
  /** Session ids with a start event in time. */
  started: string[];
  timedOut: string[];
  /** Refused by the guard, or the terminal failed. */
  failed: { id: string; reason: string }[];
  /** Left out by the memory stop. */
  notStarted: string[];
  /** Resumed --here (no tab adapter). */
  handedOff: string | null;
  /** Command lines printed instead (no tab adapter). */
  printed: string[];
  stoppedForMemory: boolean;
}

interface Run {
  deck: Deck;
  terminal: Terminal;
  report: (line: string) => void;
  outcome: RestoreOutcome;
}

/**
 * 7.8 "Running it". With a terminal that opens tabs: batches of config.restoreBatch, each started
 * only when there is enough memory, and followed by a wait (one look a second, at most
 * config.restoreStartTimeoutSeconds) until each of its sessions has a start event (a tab whose
 * opening timed out is waited for too: it may have opened). Without one: the first session the
 * guard accepts is handed off here, and the commands of the others are printed.
 *
 * Every session goes through the resume guard on fresh state (a refresh just before it), so a
 * session another skydeck resumed meanwhile is refused, not resumed a second time (principle 7).
 * `report` gets one line per outcome; every foreign string in it is sanitised.
 */
export async function runRestore(
  deps: { deck: Deck; terminal: Terminal; report: (line: string) => void },
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
  };
  const run: Run = { ...deps, outcome };
  if (deps.terminal.opensTabs) {
    await runInTabs(run, entries);
  } else {
    await runHere(run, entries);
  }
  return outcome;
}

async function runInTabs(run: Run, entries: readonly RestoreEntry[]): Promise<void> {
  const { deck } = run;
  const size = deck.config.restoreBatch;
  for (let first = 0; first < entries.length; first += size) {
    if (!enoughMemory(run, entries.slice(first))) {
      return;
    }
    const sinceNs = deck.platform.clock.nowNs();
    const opened: Waiting[] = [];
    for (const entry of entries.slice(first, first + size)) {
      // Opening a tab can take its full timeout: the locks of the tabs already opened are renewed
      // before the refresh in prepare() could sweep them as stale.
      renewLocks(deck, opened);
      const taken = prepare(run, entry);
      if (taken === null) {
        continue;
      }
      const result = await openSafely(run.terminal, taken.prepared);
      // A call that timed out may have opened the tab anyway: its session is waited for like the
      // others, so that no more than one batch is starting at a time.
      if (result.ok || result.timedOut) {
        opened.push({ row: entry.row, lock: taken.lock });
      } else {
        startedNothing(run, entry.row, taken.lock);
        fail(run, entry.row, result.error);
      }
    }
    await awaitStarts(run, opened, sinceNs);
  }
}

/** A session whose tab was opened and whose start event has not been seen yet; `lock`: the value of its resume lock that restore wrote last. */
interface Waiting {
  row: ListRow;
  lock: string | null;
}

/**
 * Looks for the start events of `opened` (at or after `sinceNs`) once a second until all are there
 * or the time is up. At every look the locks of the sessions still waited for are renewed, the
 * last time when restore gives up on them: the wait (default 120 s) is longer than a lock holds
 * (60 s), and a tab that is slow to start claude must not let another resume start it again.
 */
async function awaitStarts(run: Run, opened: readonly Waiting[], sinceNs: Ns): Promise<void> {
  const { deck, outcome, report } = run;
  const { clock } = deck.platform;
  const limitNs = BigInt(deck.config.restoreStartTimeoutSeconds) * NS_PER_SECOND;
  let waiting = [...opened];
  while (waiting.length > 0) {
    ingestSpool(deck);
    waiting = waiting.filter(({ row, lock }) => {
      if (!deck.store.hasProcessStartSince(row.id, sinceNs)) {
        return true;
      }
      // D16: a start removes the lock. Restore may have renewed it after the start (before it read
      // the start event), so the start alone would no longer make it stale: restore drops its own.
      if (lock !== null) {
        releaseLock(deck, row.id, lock);
      }
      outcome.started.push(row.id);
      report(`started ${row.shortId} ${row.title}`);
      return false;
    });
    renewLocks(deck, waiting);
    if (waiting.length === 0 || clock.nowNs() - sinceNs >= limitNs) {
      break;
    }
    await clock.sleep(START_CHECK_MS);
  }
  for (const { row } of waiting) {
    // Its tab may still start it: its lock, renewed just now, holds for another LOCK_TTL_NS.
    outcome.timedOut.push(row.id);
    report(`timed out ${row.shortId} ${row.title}`);
  }
}

/** Renews the lock of each session (renewLock); one that is no longer restore's is not touched again. */
function renewLocks(deck: Deck, sessions: readonly Waiting[]): void {
  for (const session of sessions) {
    if (session.lock !== null) {
      session.lock = renewLock(deck, session.row.id, session.lock);
    }
  }
}

/**
 * A launch that definitely started nothing (the terminal refused, is not installed, or the open
 * rejected; not a timeout) and for which no command is printed: the lock restore took would only
 * keep the user waiting, so it goes, if it is still that lock.
 */
function startedNothing(run: Run, row: ListRow, lock: string | null): void {
  if (lock !== null) {
    releaseLock(run.deck, row.id, lock);
  }
}

async function runHere(run: Run, entries: readonly RestoreEntry[]): Promise<void> {
  if (!enoughMemory(run, entries)) {
    return;
  }
  let handoffTried = false;
  for (const entry of entries) {
    if (!handoffTried) {
      const taken = prepare(run, entry);
      if (taken === null) {
        continue; // refused: the next one is handed off instead
      }
      handoffTried = true;
      const { prepared } = taken;
      const result = await openSafely(run.terminal, prepared);
      if (result.ok) {
        run.outcome.handedOff = entry.row.id;
        run.report(`resuming ${entry.row.shortId} ${entry.row.title} in this terminal`);
        continue;
      }
      fail(run, entry.row, result.error);
      // As `resume` does when it cannot start the session: the command is printed for the user to
      // run, and the lock stays so that no other skydeck starts the session meanwhile. Not after a
      // timeout, when the program may have started anyway (the lock stays then too).
      if (!result.timedOut && !print(run, prepared.cwd, prepared.argv)) {
        run.report(`${entry.row.shortId}: ${UNPRINTABLE}`);
        startedNothing(run, entry.row, taken.lock); // nothing to run by hand: nothing to protect
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
    // The guard's lock, read only: another skydeck is starting this session, and a command run by
    // hand now would start it twice.
    if (isLockHeld(run.deck, row.id)) {
      fail(run, row, `${row.shortId} is being resumed by another skydeck`);
      continue;
    }
    const launch = row.session.launch;
    const command = buildResumeCommand({
      claudeCommand: run.deck.config.claudeCommand,
      launch,
      sessionId: row.id,
      label: row.label,
    });
    warn(run, row, command.flagsKnown, launch === null ? [] : unknownFlags(launch));
    const dir = row.session.dir;
    if (dir === null) {
      throw new Error('checkResumable let a session without a directory through'); // unreachable
    }
    if (!print(run, dir, command.argv)) {
      fail(run, row, UNPRINTABLE);
    }
  }
}

const UNPRINTABLE = 'the command contains control characters and cannot be printed safely';

/**
 * Prints "cd -- <q dir> && <q argv…>" (to `printed` and `report`), after a header line the first
 * time; false, and nothing printed, when the directory or a word holds anything sanitize() would
 * change: such a line could act on the terminal, or break when it is pasted.
 */
function print(run: Run, dir: string, argv: readonly string[]): boolean {
  const line = printableCommand(dir, argv);
  if (line === null) {
    return false;
  }
  if (run.outcome.printed.length === 0) {
    run.report('to resume these yourself, run:');
  }
  run.outcome.printed.push(line);
  run.report(line);
  return true;
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
  for (const { row } of rest) {
    outcome.notStarted.push(row.id);
    report(`not started ${row.shortId} ${row.title}`);
  }
  return false;
}

/**
 * The entry's row as it is now, for a command that is printed rather than started (no lock): a
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
 * to renew or release that lock and no other.
 */
function prepare(
  run: Run,
  entry: RestoreEntry,
): { prepared: PreparedLaunch; lock: string | null } | null {
  const { row } = entry;
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
  warn(run, row, prepared.flagsKnown, prepared.unknownFlags);
  return { prepared, lock: readLock(run.deck, row.id) };
}

/** What `resume` says before it starts a session, as one line each, naming the session. */
function warn(run: Run, row: ListRow, flagsKnown: boolean, unknown: readonly string[]): void {
  if (!flagsKnown) {
    run.report(`${row.shortId}: original flags unknown; resuming with defaults`);
  }
  if (unknown.length > 0) {
    run.report(
      `${row.shortId}: started with flags skydeck does not know, not passed on resume: ${unknown.map(sanitize).join(' ')}`,
    );
  }
}

/** terminal.open, with a rejection turned into a failed open. */
async function openSafely(terminal: Terminal, prepared: PreparedLaunch): Promise<OpenResult> {
  try {
    return await terminal.open({ cwd: prepared.cwd, argv: prepared.argv });
  } catch (error) {
    return {
      ok: false,
      error: `cannot open the terminal (${describeError(error)})`,
      timedOut: false,
    };
  }
}

function fail(run: Run, row: ListRow, reason: string): void {
  const shown = sanitize(reason);
  run.outcome.failed.push({ id: row.id, reason: shown });
  run.report(`failed ${row.shortId}: ${shown}`);
}
