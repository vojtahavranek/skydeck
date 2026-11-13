// Resume and new (design 7.6, 7.7): the guard that refuses a session that runs or cannot be
// resumed, the lock that keeps two resumes of one session apart (principle 7), and the commands.
import { isAbsolute, join } from 'node:path';

import { buildNewCommand, buildResumeCommand, unknownFlags } from '../claude/launch.ts';
import { isSessionId } from '../claude/live.ts';
import { ResumeRefusedError } from '../platform/errors.ts';
import type { Places } from '../platform/paths.ts';
import { NS_PER_SECOND } from '../platform/time.ts';
import type { Files, Ns } from '../platform/types.ts';
import { isDatabaseFailure } from '../store/store.ts';
import type { Deck } from './deck.ts';
import { cleanGroup, cleanLabel } from './labels.ts';
import type { ListRow } from './list.ts';
import { describeError } from './problems.ts';

/** How long a resume lock holds when no `start` event for the session arrives. */
export const LOCK_TTL_NS: Ns = 60n * NS_PER_SECOND;

const LOCK_SUFFIX = '.lock';

/**
 * <locksDir>/<sessionId>.lock. Throws RangeError for anything but a session id (a lowercase UUID):
 * the id becomes a file name, where `../` or `/` would lead elsewhere.
 */
export function lockPath(places: Places, sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw new RangeError(`not a session id (a lowercase UUID): ${JSON.stringify(sessionId)}`);
  }
  return join(places.locksDir, `${sessionId}${LOCK_SUFFIX}`);
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

/** The creation time a lock holds (2.10.4); null when its content is not one. */
function lockTimeOf(content: string): Ns | null {
  return /^[0-9]{1,30}\n?$/.test(content) ? BigInt(content.trim()) : null;
}

/** What `acquireLock` and `sweepLocks` know about one existing lock. */
interface ExistingLock {
  content: string;
  /** now − creation time; the creation time is the content, or the modification time when the content is not a time. */
  ageNs: Ns;
  stale: boolean;
}

/**
 * Reads the lock at `path`; null when it does not exist. Stale (D16): older than LOCK_TTL_NS, or the
 * session has a `start` event at or after the lock's time. A lock dated in the future by less than
 * LOCK_TTL_NS (the clock was set back a little) holds, one further ahead cannot be from this
 * clock and is stale. Content that is not a time is dated by the file's modification time, so a
 * damaged lock still holds for a minute and then goes.
 */
function readLock(deck: Deck, sessionId: string, path: string): ExistingLock | null {
  const { files, clock } = deck.platform;
  const content = files.readText(path);
  if (content === null) {
    return null;
  }
  let createdNs = lockTimeOf(content);
  if (createdNs === null) {
    const info = files.stat(path);
    if (info === null) {
      return null;
    }
    createdNs = info.mtimeNs;
  }
  const ageNs = clock.nowNs() - createdNs;
  const stale =
    ageNs >= LOCK_TTL_NS || -ageNs >= LOCK_TTL_NS || deck.store.hasStartSince(sessionId, createdNs);
  return { content, ageNs, stale };
}

/**
 * Removes the lock at `path` only if it still holds `content`. Two skydecks can find the same stale
 * lock; when one has replaced it with a fresh one, removing by name would remove that fresh lock and
 * let a third resume through. So the lock is renamed aside first (atomic: only one of them gets
 * it), and what was moved is checked: someone else's lock is put back. Returns whether the stale
 * lock is gone (also when it vanished meanwhile).
 */
function removeIfUnchanged(deck: Deck, path: string, content: string): boolean {
  const { files } = deck.platform;
  // Hidden, so that sweepLocks never takes it for a lock.
  const aside = join(deck.places.locksDir, `.${deck.platform.uuid()}.lock.stale`);
  try {
    files.rename(path, aside);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      return true; // gone already: another skydeck removed it
    }
    throw error;
  }
  try {
    const moved = files.readText(aside);
    if (moved === null || moved === content) {
      return true;
    }
    // A fresh lock of another resume: put it back as it was. When that fails, a lock was created
    // in between, and the name is taken either way.
    files.createExclusive(path, moved);
    return false;
  } finally {
    files.remove(aside);
  }
}

/** How often acquireLock goes round when other skydecks keep changing the lock under it. */
const ACQUIRE_ATTEMPTS = 5;

/**
 * Creates the lock exclusively (content: now ns + "\n"). If it exists: when it is older than
 * LOCK_TTL_NS or the session has a start event at or after its time (hasStartSince), it is
 * replaced; otherwise ResumeRefusedError "<short> is being resumed (<n> s ago); try again in <m> s"
 * (n rounded down, m rounded up).
 */
export function acquireLock(deck: Deck, sessionId: string): void {
  const path = lockPath(deck.places, sessionId);
  const { files, clock } = deck.platform;
  const shortId = sessionId.slice(0, 8);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (files.createExclusive(path, `${clock.nowNs()}\n`)) {
      return;
    }
    const lock = readLock(deck, sessionId, path);
    if (lock === null) {
      continue; // removed since: try to create it again
    }
    if (!lock.stale) {
      const ageNs = lock.ageNs > 0n ? lock.ageNs : 0n;
      const ago = ageNs / NS_PER_SECOND;
      const wait = (LOCK_TTL_NS - lock.ageNs + NS_PER_SECOND - 1n) / NS_PER_SECOND;
      throw new ResumeRefusedError(
        `${shortId} is being resumed (${ago} s ago); try again in ${wait} s`,
      );
    }
    removeIfUnchanged(deck, path, lock.content);
  }
  throw new ResumeRefusedError(`${shortId}: its resume lock keeps changing; try again`);
}

/**
 * Removes locks that are stale by the same two rules as acquireLock. Returns how many. Only names
 * `<session id>.lock` are locks: the directory also holds hidden temporary files. One lock that
 * cannot be read or removed is skipped (the sweep runs in every refresh, which must not fail for
 * it); a failure of the database as a whole is thrown.
 */
export function sweepLocks(deck: Deck): number {
  let names: string[];
  try {
    names = deck.platform.files.list(deck.places.locksDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const sessionId = name.endsWith(LOCK_SUFFIX) ? name.slice(0, -LOCK_SUFFIX.length) : '';
    if (!isSessionId(sessionId)) {
      continue;
    }
    try {
      const path = lockPath(deck.places, sessionId);
      const lock = readLock(deck, sessionId, path);
      if (lock !== null && lock.stale && removeIfUnchanged(deck, path, lock.content)) {
        removed++;
      }
    } catch (error) {
      if (isDatabaseFailure(error)) {
        throw error;
      }
      // skipped: acquireLock looks at this lock again when the session is resumed
    }
  }
  return removed;
}

export interface PreparedLaunch {
  sessionId: string;
  cwd: string;
  argv: string[];
  flagsKnown: boolean;
  unknownFlags: string[];
}

/**
 * checkResumable, acquireLock, buildResumeCommand(config.claudeCommand, row.session.launch, id,
 * row.label) — in this order, so a session that is refused takes no lock. `unknownFlags` is
 * unknownFlags(row.session.launch) ([] without a launch command).
 */
export function prepareResume(deck: Deck, row: ListRow): PreparedLaunch {
  checkResumable(row, deck.platform.files);
  const cwd = row.session.dir;
  if (cwd === null) {
    throw new Error('checkResumable let a session without a directory through'); // unreachable
  }
  acquireLock(deck, row.id);
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
  };
}

/**
 * 7.7: platform.uuid(), stores label/group (cleaned) as meta, buildNewCommand, cwd = platform.cwd;
 * `flagsKnown` true, `unknownFlags` []. A label or group that cleanLabel/cleanGroup refuses is a
 * UsageError, and nothing is stored. No meta row is written when there is neither.
 */
export function prepareNew(
  deck: Deck,
  options: { label: string | null; group: string | null; extra: readonly string[] },
): PreparedLaunch {
  const label = options.label === null ? null : cleanLabel(options.label);
  const group = options.group === null ? null : cleanGroup(options.group);
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
  return { sessionId, cwd, argv, flagsKnown: true, unknownFlags: [] };
}
