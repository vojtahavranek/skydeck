// Resume and new (design 7.6, 7.7): the guard that refuses a session that runs or cannot be
// resumed, the lock that keeps two resumes of one session apart (principle 7), the commands, and
// what the command line and restore share about starting one and about a launch that failed.
import { isAbsolute } from 'node:path';

import {
  buildNewCommand,
  buildResumeCommand,
  nameFlags,
  sessionPickingFlags,
  unknownFlags,
} from '../claude/launch.ts';
import type { FoundFlag } from '../claude/launch.ts';
import { isSessionId } from '../claude/live.ts';
import { ResumeRefusedError, UsageError } from '../platform/errors.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Files, Ns } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import type { KvKey } from '../store/types.ts';
import type { LaunchSpec, OpenResult, Terminal } from '../terminals/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { printableCommand } from '../text/shell.ts';
import type { Deck } from './deck.ts';
import { cleanGroup, cleanLabel } from './labels.ts';
import type { ListRow } from './list.ts';
import { describeError } from './problems.ts';

/** How long a resume lock holds when no `start` event for the session arrives. */
export const LOCK_TTL_NS: Ns = 60n * NS_PER_SECOND;

/**
 * How long before a lock's time a start event may be dated and still release the lock, when the lock
 * records an event id (and the start's id is greater: it was recorded after the lock). The wall clock
 * can step back between taking the lock and the claude's start — measured on one WSL machine, about
 * 1.7 to 1.9 s every 32 s — and the resume's own start would then be stamped before the lock. The id
 * says when a start was recorded, not when its process began: a start of another process that began
 * within this tolerance before the lock, is recorded only after it and is already gone releases the
 * lock too. That is accepted (design 7.6, D16): the guard still refuses while any holder lives.
 */
export const LOCK_START_TOLERANCE_NS: Ns = 5n * NS_PER_SECOND;

const LOCK_PREFIX = 'resume_lock:';

/**
 * The kv key of the session's resume lock, `resume_lock:<sessionId>` (D16). Throws RangeError for
 * anything but a session id (a lowercase UUID).
 */
export function lockKey(sessionId: string): `resume_lock:${string}` {
  if (!isSessionId(sessionId)) {
    throw new RangeError(`not a session id (a lowercase UUID): ${JSON.stringify(sessionId)}`);
  }
  return `${LOCK_PREFIX}${sessionId}`;
}

/** Without the boot id every recorded process looks dead (5.5), so no session is seen running. */
const BOOT_ID_UNKNOWN = 'cannot tell which sessions are running: the boot id could not be read';

/**
 * 7.6 refusals (ResumeRefusedError), in this order: the row was derived without a boot id → "cannot
 * tell which sessions are running: the boot id could not be read" (the row's own value, never a
 * second read that may have worked, so a failed read and a later successful one are not mixed);
 * running → "<short> is running (pid <p>[, pid <p>…])", holders latest first; no transcript →
 * "<short> has no transcript"; expired → "<short> has expired: its transcript is gone"; project
 * directory missing (or no longer a directory) → "<short>: directory <dir> no longer exists". A
 * directory that is not known, not absolute, or cannot be looked at is refused too, with a message
 * saying so. The directory checked is the session's own (`row.session.dir`); `row.dir` is display
 * text and only appears in messages.
 */
export function checkResumable(row: ListRow, files: Files): void {
  const { session, shortId } = row;
  if (session.bootId === null) {
    throw new ResumeRefusedError(BOOT_ID_UNKNOWN);
  }
  if (session.holders.length > 0) {
    const pids = session.holders.map((holder) => `pid ${holder.process.pid}`).join(', ');
    throw new ResumeRefusedError(`${shortId} is running (${pids})`);
  }
  if (session.transcript === null) {
    throw new ResumeRefusedError(`${shortId} has no transcript`);
  }
  if (row.marks.includes('expired')) {
    throw new ResumeRefusedError(`${shortId} has expired: its transcript is gone`);
  }
  const dir = session.dir;
  if (dir === null) {
    throw new ResumeRefusedError(`${shortId}: its project directory is not known`);
  }
  if (!isAbsolute(dir)) {
    throw new ResumeRefusedError(`${shortId}: directory ${row.dir} is not an absolute path`);
  }
  let kind: string | null;
  try {
    kind = files.stat(dir)?.kind ?? null;
  } catch (error) {
    throw new ResumeRefusedError(
      `${shortId}: directory ${row.dir} cannot be checked (${describeError(error)})`,
    );
  }
  if (kind !== 'dir') {
    throw new ResumeRefusedError(`${shortId}: directory ${row.dir} no longer exists`);
  }
}

const STATE_CHANGED = "the session's state changed while preparing; run the command again";

/**
 * What a lock's kv value holds: the time it was taken, and the session's latest event id at that
 * moment (`<time>:<id>`; id 0 when the session had no event, which every event id exceeds). The time
 * alone is a lock an earlier skydeck wrote: it keeps the rule of that version (no id, exact time).
 */
interface LockValue {
  takenNs: Ns;
  /** Only a start event recorded after this one counts; null: a lock without an id, any. */
  afterEventId: number | null;
}

function lockValue({ takenNs, afterEventId }: LockValue): string {
  return afterEventId === null ? `${takenNs}` : `${takenNs}:${afterEventId}`;
}

/** The lock a kv value holds; null when it is not one skydeck writes. */
function parseLock(value: string): LockValue | null {
  const match = /^([0-9]{1,30})(?::([0-9]{1,15}))?$/.exec(value);
  if (match === null) {
    return null;
  }
  const [, taken = '', after] = match;
  return { takenNs: BigInt(taken), afterEventId: after === undefined ? null : Number(after) };
}

/**
 * The event id the lock value records (the session's latest event when the lock was taken; 0 when
 * the session had none): only a start event with a greater id, recorded after the lock, can release
 * it. Null for a lock an earlier skydeck wrote (the time alone) and for a value that is not a lock.
 */
export function lockEventId(value: string): number | null {
  return parseLock(value)?.afterEventId ?? null;
}

/**
 * Whether the claude a resume started has started: the session has a start event of a real process
 * (store.hasProcessStartSince) with an id greater than `afterEventId` (the latest event id the lock
 * records: the start was recorded after the lock) and dated at or after `sinceNs` — or, when
 * `afterEventId` is not null, at most LOCK_START_TOLERANCE_NS before it, because the clock may have
 * stepped back (the price of that tolerance is described there). With no id (a lock an earlier
 * version wrote) the rule stays exact. The lock (here) and restore's "started" use it.
 */
export function resumeStarted(
  store: Store,
  sessionId: string,
  sinceNs: Ns,
  afterEventId: number | null,
): boolean {
  const fromNs = afterEventId === null ? sinceNs : sinceNs - LOCK_START_TOLERANCE_NS;
  return store.hasProcessStartSince(sessionId, fromNs, afterEventId);
}

/** How old the lock with this value is at `nowNs`, when it still holds; null when it is stale. */
function freshAge(store: Store, sessionId: string, value: string, nowNs: Ns): Ns | null {
  const lock = parseLock(value);
  if (lock === null) {
    return null; // skydeck never wrote it
  }
  const ageNs = nowNs - lock.takenNs;
  // A lock from far in the future cannot be from this clock: it would block for as long. A start
  // releases the lock only when it was stored after the lock was taken: one stored before it, but
  // dated after it because the clock was ahead then, is not the resume's own (resumeStarted).
  if (
    ageNs >= LOCK_TTL_NS ||
    -ageNs >= LOCK_TTL_NS ||
    resumeStarted(store, sessionId, lock.takenNs, lock.afterEventId)
  ) {
    return null;
  }
  return ageNs;
}

/** What a decision to resume was based on: the highest id among the session's events, null for none. */
export interface SawEvents {
  latestEventId: number | null;
}

/**
 * D16. In one store transaction (BEGIN IMMEDIATE, which no two skydecks hold at once): reads the
 * session's lock; when it holds — younger than LOCK_TTL_NS (a time less than LOCK_TTL_NS in the
 * future counts as now), and no start event for the session that names a real process
 * (hasProcessStartSince: a pid that is not 0 and a process start time), is dated at or after the
 * lock and was stored after it (an id greater than the one the lock records) — throws
 * ResumeRefusedError "<short> is being resumed (<n> s ago); try again in <m> s" (n rounded down, m
 * rounded up). A value that is not a lock skydeck writes is stale.
 *
 * `saw` is what the decision to resume was made on, and is required so that no caller can skip the
 * check. Still inside the transaction and before the lock is written, the session's latest event id
 * is read again; when it is not the one `saw` names, another skydeck acted on the session since (it
 * may have resumed it, and a sweep may have removed its lock as stale once its start event was
 * ingested), and the call throws ResumeRefusedError "the session's state changed while preparing;
 * run the command again". Otherwise writes the lock: the clock's time and `saw.latestEventId`
 * (`<time>:<id>`, id 0 when it is null), so that only a start recorded after it releases it.
 */
export function acquireLock(deck: Deck, sessionId: string, saw: SawEvents): void {
  const key = lockKey(sessionId);
  const { store, platform } = deck;
  store.transaction(() => {
    const nowNs = platform.clock.nowNs();
    const value = store.getKv(key);
    const ageNs = value === null ? null : freshAge(store, sessionId, value, nowNs);
    if (ageNs !== null) {
      const ago = (ageNs > 0n ? ageNs : 0n) / NS_PER_SECOND;
      const wait = (LOCK_TTL_NS - ageNs + NS_PER_SECOND - 1n) / NS_PER_SECOND;
      throw new ResumeRefusedError(
        `${sessionId.slice(0, 8)} is being resumed (${ago} s ago); try again in ${wait} s`,
      );
    }
    if (store.latestEventIdOfSession(sessionId) !== saw.latestEventId) {
      throw new ResumeRefusedError(STATE_CHANGED);
    }
    // No event yet (a session known only from its transcript): 0, so that this lock is told apart
    // from an earlier version's and gets the same rule as any other lock with an id.
    store.setKv(key, lockValue({ takenNs: nowNs, afterEventId: saw.latestEventId ?? 0 }));
  });
}

/** The keys of the locks that are stale at `nowNs`. */
function staleLocks(store: Store, nowNs: Ns): KvKey[] {
  return store
    .kvEntries(LOCK_PREFIX)
    .filter(({ key, value }) => {
      const sessionId = key.slice(LOCK_PREFIX.length);
      return freshAge(store, sessionId, value, nowNs) === null;
    })
    .map(({ key }) => key);
}

/**
 * Removes the locks that are stale by the rules of acquireLock. Returns how many. It looks first
 * without a transaction: a refresh that finds no stale lock (most do) takes no write lock on the
 * database. When there are some, it reads again and deletes inside one store transaction, so a lock
 * another skydeck has just taken over is never deleted.
 */
export function sweepLocks(deck: Deck): number {
  const { store, platform } = deck;
  if (staleLocks(store, platform.clock.nowNs()).length === 0) {
    return 0;
  }
  return store.transaction(() => {
    const keys = staleLocks(store, platform.clock.nowNs());
    for (const key of keys) {
      store.deleteKv(key);
    }
    return keys.length;
  });
}

/**
 * The value of the session's resume lock, null when there is none. A caller that has just taken
 * the lock keeps it, to renew or release that lock later and no other (renewLock, releaseLock).
 */
export function readLock(deck: Deck, sessionId: string): string | null {
  return deck.store.getKv(lockKey(sessionId));
}

/**
 * In one store transaction: when the session's lock still holds `ours` (the value this process
 * wrote), sets its time to the clock's, keeping the event id it records (only a start stored after
 * the lock was first taken releases it), and returns the new value; otherwise — another skydeck
 * took the lock over after it went stale, or it is gone — changes nothing and returns null. A
 * caller that waits longer than LOCK_TTL_NS for the session to start renews its lock while it
 * waits.
 */
export function renewLock(deck: Deck, sessionId: string, ours: string): string | null {
  const key = lockKey(sessionId);
  const { store, platform } = deck;
  return store.transaction(() => {
    const lock = parseLock(ours);
    if (lock === null || store.getKv(key) !== ours) {
      return null;
    }
    const value = lockValue({ ...lock, takenNs: platform.clock.nowNs() });
    store.setKv(key, value);
    return value;
  });
}

/**
 * In one store transaction: removes the session's lock when it still holds `ours`; whether it did.
 * For a resume that definitely started nothing (the terminal refused, or is not installed): its lock
 * would only make the user wait. A timeout is not such a case: the program may have started.
 */
export function releaseLock(deck: Deck, sessionId: string, ours: string): boolean {
  const key = lockKey(sessionId);
  const { store } = deck;
  return store.transaction(() => {
    if (store.getKv(key) !== ours) {
      return false;
    }
    store.deleteKv(key);
    return true;
  });
}

/**
 * Whether a lock that holds by the rules of acquireLock exists for the session: another skydeck is
 * starting it. Reads only; takes no lock and no transaction.
 */
export function isLockHeld(deck: Deck, sessionId: string): boolean {
  const value = readLock(deck, sessionId);
  return (
    value !== null && freshAge(deck.store, sessionId, value, deck.platform.clock.nowNs()) !== null
  );
}

export interface PreparedLaunch {
  sessionId: string;
  cwd: string;
  argv: string[];
  flagsKnown: boolean;
  unknownFlags: string[];
  /** 'new': the session does not exist until claude starts, so there is nothing to resume yet. */
  kind: 'resume' | 'new';
}

/**
 * What a resume says before it starts the session, one line each, without a prefix (the command
 * line puts "skydeck: " before them, restore the session's short id): "original flags unknown;
 * resuming with defaults" when !flagsKnown; "started with flags skydeck does not know, not passed on
 * resume: <names>" (sanitised, joined by one space) when unknownFlags is not empty.
 */
export function flagWarnings(
  launch: Pick<PreparedLaunch, 'flagsKnown' | 'unknownFlags'>,
): string[] {
  const lines: string[] = [];
  if (!launch.flagsKnown) {
    lines.push('original flags unknown; resuming with defaults');
  }
  if (launch.unknownFlags.length > 0) {
    const names = launch.unknownFlags.map(sanitize).join(' ');
    lines.push(`started with flags skydeck does not know, not passed on resume: ${names}`);
  }
  return lines;
}

/** terminal.open, with a rejection (a write that failed, an empty argument list) turned into a failed open. */
export async function openSafely(terminal: Terminal, spec: LaunchSpec): Promise<OpenResult> {
  try {
    return await terminal.open(spec);
  } catch (error) {
    return {
      ok: false,
      error: `cannot open the terminal (${describeError(error)})`,
      timedOut: false,
    };
  }
}

/**
 * After an open that failed: the command line to print for the user to run instead
 * (printableCommand), or null — after a timeout (the program may have started: a command run by hand
 * could start the session twice) and when the directory or a word holds a control character. When
 * the launch definitely started nothing (not a timeout) and no command can be printed, nothing is
 * left to run by hand, so what was taken for it is given back: the lock (`lock`, the value read
 * before opening; released only while it is still that one) and, for kind 'new', the label and group
 * prepareNew stored (a session that will never exist). Otherwise both stay.
 */
export function settleFailedLaunch(
  deck: Deck,
  prepared: PreparedLaunch,
  lock: string | null,
  timedOut: boolean,
): string | null {
  if (timedOut) {
    return null;
  }
  const command = printableCommand(prepared.cwd, prepared.argv);
  if (command === null) {
    if (lock !== null) {
      releaseLock(deck, prepared.sessionId, lock);
    }
    if (prepared.kind === 'new') {
      deck.store.deleteMeta(prepared.sessionId);
    }
  }
  return command;
}

/**
 * checkResumable (which refuses first a row derived without a boot id), acquireLock (given the
 * latest event id the row was derived from, so a session that has been acted on since is refused),
 * buildResumeCommand(config.claudeCommand, row.session.launch, id, row.label) — in this order, so a
 * session that is refused takes no lock. `unknownFlags` is unknownFlags(row.session.launch) ([]
 * without a launch command).
 *
 * The row must come from rows loaded right after a refresh: a start event that is still a file in
 * the spool is not in the row, and the lock's check of the latest event only sees ingested events.
 * Callers go through `prepareResumeById` (resume-by-id.ts), which refreshes and loads first.
 */
export function prepareResume(deck: Deck, row: ListRow): PreparedLaunch {
  checkResumable(row, deck.platform.files);
  const cwd = row.session.dir;
  if (cwd === null) {
    throw new Error('checkResumable let a session without a directory through'); // unreachable
  }
  acquireLock(deck, row.id, { latestEventId: row.session.lastEventId });
  const launch = row.session.launch;
  const command = buildResumeCommand({
    claudeCommand: deck.config.claudeCommand,
    launch,
    sessionId: row.id,
    label: row.label,
  });
  return {
    sessionId: row.id,
    cwd,
    argv: command.argv,
    flagsKnown: command.flagsKnown,
    unknownFlags: launch === null ? [] : unknownFlags(launch),
    kind: 'resume',
  };
}

/**
 * Refuses (UsageError naming it) a flag of `extra` that picks an existing session (7.7): `-r <id>`
 * or `-c` would resume one past the guard and the lock (principle 7). Refuses `--name` / `-n` too:
 * the label is given with `--label`, and skydeck passes it as the name itself. A cluster of short
 * flags is refused when any flag in it is (`-cp`). The flags that only say where or how a new
 * session starts (`--worktree`, `--tmux`, …) and arguments that are no flag, such as a prompt, pass.
 */
function refuseSessionFlags(extra: readonly string[]): void {
  const shown = ({ written, spec }: FoundFlag): string =>
    spec.names.includes(written) ? written : `${written} (${spec.names.at(-1)})`;
  const [picking] = sessionPickingFlags(extra);
  if (picking !== undefined) {
    throw new UsageError(
      `cannot pass ${shown(picking)} to claude: it picks an existing session; use skydeck resume`,
    );
  }
  const [name] = nameFlags(extra);
  if (name !== undefined) {
    throw new UsageError(
      `cannot pass ${shown(name)} to claude: the label is given with --label, and skydeck passes it as the name`,
    );
  }
}

/**
 * 7.7: platform.uuid(), stores label/group (cleaned) as meta, buildNewCommand, cwd = platform.cwd;
 * `flagsKnown` true, `unknownFlags` []. UsageError, and nothing stored, for a label or group that
 * cleanLabel/cleanGroup refuse and for an extra flag that refuseSessionFlags refuses. No
 * meta row is written when there is neither a label nor a group.
 */
export function prepareNew(
  deck: Deck,
  options: { label: string | null; group: string | null; extra: readonly string[] },
): PreparedLaunch {
  const label = options.label === null ? null : cleanLabel(options.label);
  const group = options.group === null ? null : cleanGroup(options.group);
  refuseSessionFlags(options.extra);
  const { platform } = deck;
  const cwd = platform.cwd;
  const sessionId = platform.uuid();
  const argv = buildNewCommand({
    claudeCommand: deck.config.claudeCommand,
    sessionId,
    label,
    extra: options.extra,
  });
  if (label !== null || group !== null) {
    deck.store.updateMeta(sessionId, { label, group }, platform.clock.nowNs());
  }
  return { sessionId, cwd, argv, flagsKnown: true, unknownFlags: [], kind: 'new' };
}
