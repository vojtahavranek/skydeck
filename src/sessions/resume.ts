// Resume and new (design 7.6, 7.7): the guard that refuses a session that runs or cannot be
// resumed, the lock that keeps two resumes of one session apart (principle 7), and the commands.
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
import type { Deck } from './deck.ts';
import { cleanGroup, cleanLabel } from './labels.ts';
import type { ListRow } from './list.ts';
import { describeError } from './problems.ts';

/** How long a resume lock holds when no `start` event for the session arrives. */
export const LOCK_TTL_NS: Ns = 60n * NS_PER_SECOND;

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

/**
 * 7.6 refusals (ResumeRefusedError), in this order: running → "<short> is running (pid <p>[, pid
 * <p>…])", holders latest first; no transcript → "<short> has no transcript"; expired → "<short> has
 * expired: its transcript is gone"; project directory missing (or no longer a directory) →
 * "<short>: directory <dir> no longer exists". A directory that is not known, not absolute, or
 * cannot be looked at is refused too, with a message saying so. The directory checked is the
 * session's own (`row.session.dir`); `row.dir` is display text and only appears in messages.
 */
export function checkResumable(row: ListRow, files: Files): void {
  const { session, shortId } = row;
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

/** The time a lock holds (its kv value); null when the value is not one. */
function lockTimeOf(value: string): Ns | null {
  return /^[0-9]{1,30}$/.test(value) ? BigInt(value) : null;
}

/** How old a lock taken at `takenNs` is at `nowNs`, when it still holds; null when it is stale. */
function freshAge(store: Store, sessionId: string, takenNs: Ns | null, nowNs: Ns): Ns | null {
  if (takenNs === null) {
    return null; // not a time: skydeck never wrote it
  }
  const ageNs = nowNs - takenNs;
  // A lock from far in the future cannot be from this clock: it would block for as long.
  if (
    ageNs >= LOCK_TTL_NS ||
    -ageNs >= LOCK_TTL_NS ||
    store.hasProcessStartSince(sessionId, takenNs)
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
 * future counts as now), and no start event for the session at or after it that names a real
 * process (hasProcessStartSince: a pid that is not 0 and a process start time) — throws
 * ResumeRefusedError "<short> is being resumed (<n> s ago); try again in <m> s" (n rounded down, m
 * rounded up). A value that is not a time is stale.
 *
 * `saw` is what the decision to resume was made on, and is required so that no caller can skip the
 * check. Still inside the transaction and before the lock is written, the session's latest event id
 * is read again; when it is not the one `saw` names, another skydeck acted on the session since (it
 * may have resumed it, and a sweep may have removed its lock as stale once its start event was
 * ingested), and the call throws ResumeRefusedError "the session's state changed while preparing;
 * run the command again". Otherwise writes the lock with the clock's time.
 */
export function acquireLock(deck: Deck, sessionId: string, saw: SawEvents): void {
  const key = lockKey(sessionId);
  const { store, platform } = deck;
  store.transaction(() => {
    const nowNs = platform.clock.nowNs();
    const value = store.getKv(key);
    const ageNs = value === null ? null : freshAge(store, sessionId, lockTimeOf(value), nowNs);
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
    store.setKv(key, `${nowNs}`);
  });
}

/** The keys of the locks that are stale at `nowNs`. */
function staleLocks(store: Store, nowNs: Ns): KvKey[] {
  return store
    .kvEntries(LOCK_PREFIX)
    .filter(({ key, value }) => {
      const sessionId = key.slice(LOCK_PREFIX.length);
      return freshAge(store, sessionId, lockTimeOf(value), nowNs) === null;
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
 * wrote), sets it to the clock's time and returns the new value; otherwise — another skydeck took
 * the lock over after it went stale, or it is gone — changes nothing and returns null. A caller
 * that waits longer than LOCK_TTL_NS for the session to start renews its lock while it waits.
 */
export function renewLock(deck: Deck, sessionId: string, ours: string): string | null {
  const key = lockKey(sessionId);
  const { store, platform } = deck;
  return store.transaction(() => {
    if (store.getKv(key) !== ours) {
      return null;
    }
    const value = `${platform.clock.nowNs()}`;
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
    value !== null &&
    freshAge(deck.store, sessionId, lockTimeOf(value), deck.platform.clock.nowNs()) !== null
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

/** Without the boot id every recorded process looks dead (5.5), so no session is seen running. */
const BOOT_ID_UNKNOWN = 'cannot tell which sessions are running: the boot id could not be read';

/**
 * Refuses (ResumeRefusedError, first of all) when the row was derived without a boot id: the row's
 * own value is used, never a second read that may have worked, so a failed read and a later
 * successful one are not mixed. Then checkResumable, acquireLock (given the latest event id the
 * row was derived from, so a session that has been acted on since is refused),
 * buildResumeCommand(config.claudeCommand, row.session.launch, id, row.label) — in this order, so a
 * session that is refused takes no lock. `unknownFlags` is unknownFlags(row.session.launch) ([]
 * without a launch command).
 *
 * The row must come from rows loaded right after a refresh: a start event that is still a file in
 * the spool is not in the row, and the lock's check of the latest event only sees ingested events.
 * Callers go through `prepareResumeById` (resume-by-id.ts), which refreshes and loads first.
 */
export function prepareResume(deck: Deck, row: ListRow): PreparedLaunch {
  if (row.session.bootId === null) {
    throw new ResumeRefusedError(BOOT_ID_UNKNOWN);
  }
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
