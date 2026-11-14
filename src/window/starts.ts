/**
 * What the server decides about a keeper it did not just spawn, and after a terminal ended (S2
 * 7.3, 7.8; plan task 21). Both go through step 1's own rules (design 7.6): the refresh, the guard,
 * the lock and `resumeStarted`. The server (task 23) calls them from the registry's events: a hello
 * of origin 'late' or 'found' whose `started` is false, and an exit with the terminal's latest hello.
 */
import { RefError, ResumeRefusedError } from '../platform/errors.ts';
import type { Deck } from '../sessions/deck.ts';
import { ingestSpool } from '../sessions/ingest.ts';
import { SHORT_ID_LENGTH } from '../sessions/list.ts';
import { loadRows, loadSessions } from '../sessions/load.ts';
import { describeError } from '../sessions/problems.ts';
import { refresh } from '../sessions/refresh.ts';
import {
  checkResumable,
  lockEventId,
  lockTakenNs,
  readLock,
  releaseLock,
  resumeStarted,
} from '../sessions/resume.ts';
import type { DerivedSession } from '../sessions/types.ts';
import { sanitize } from '../text/sanitize.ts';
import type { KeeperHello } from './frames.ts';

/** The keeper's own words for the same case (bin/skydeck-keeper), so that both read alike. */
const DEADLINE_PASSED = 'the start deadline passed';
/** checkResumable's words, for the guard of a new session (design 5.5: no boot id, no one alive). */
const BOOT_ID_UNKNOWN = 'cannot tell which sessions are running: the boot id could not be read';

const short = (sessionId: string): string => sessionId.slice(0, SHORT_ID_LENGTH);

/** checkResumable's refusal of a running session, in its words: holders latest first. */
function runningText(session: DerivedSession): string {
  const pids = session.holders.map((holder) => `pid ${holder.process.pid}`).join(', ');
  return `${short(session.id)} is running (${pids})`;
}

/**
 * A resume (S2 7.3): the hello's lock must be one skydeck writes; then, on freshly refreshed rows
 * (prepareResumeById's refresh and lookup), checkResumable (it throws its refusal), and the
 * session's lock in the store must still be exactly the hello's — no other skydeck has taken it
 * over, and no refresh has swept it as stale. Ruled by the plan owner (task 21, review 2): the exact
 * value, also against a renewal — a renewal and a take-over of a stale lock with no new event have
 * the same shape. Restore, the one renewer, does not reach a window terminal in stage A (S2 7.3's
 * limit for the stage that brings it).
 */
function resumeRefusal(deck: Deck, hello: KeeperHello): string | null {
  const { sessionId } = hello.meta;
  if (hello.lock === null || lockTakenNs(hello.lock) === null) {
    return `${short(sessionId)}: this terminal holds no resume lock skydeck wrote`;
  }
  refresh(deck);
  const row = loadRows(deck).find((candidate) => candidate.id === sessionId);
  if (row === undefined) {
    throw new RefError(`no session matches '${sanitize(sessionId)}'`, []);
  }
  checkResumable(row, deck.platform.files);
  if (readLock(deck, sessionId) !== hello.lock) {
    return `${short(sessionId)}: its resume lock was renewed or taken over`;
  }
  return null;
}

/**
 * A new session (S2 7.3): on freshly refreshed sessions, no live process holds its id. Without a
 * boot id no process can be judged alive (design 5.5), so nothing could be seen holding it: that is
 * refused as checkResumable refuses it, with the session's own boot id when it is known.
 */
function newRefusal(deck: Deck, hello: KeeperHello): string | null {
  refresh(deck);
  const session = loadSessions(deck).find((candidate) => candidate.id === hello.meta.sessionId);
  const bootId = session === undefined ? deck.platform.proc.bootId() : session.bootId;
  if (bootId === null) {
    return BOOT_ID_UNKNOWN;
  }
  return session !== undefined && session.holders.length > 0 ? runningText(session) : null;
}

/**
 * S2 7.3: for a keeper found with started false — refresh, then the guard (checkResumable on the
 * refreshed row; for `new`, no live process holds the id) and the lock (still exactly the hello's
 * `lock`), and the deadline (the clock before `startBy`, as the keeper itself checks it).
 *
 * Never throws: a refusal of the guard is the reason (its message); a failure while checking (the
 * store, /proc) is "cannot check whether <short> may start (<the failure>)" — nothing is started
 * on what could not be checked. A hello whose program started or whose terminal ended already is
 * never started again. Every reason is sanitised (it is shown on the terminal, "not started: …").
 */
export function decideFoundKeeper(
  deck: Deck,
  hello: KeeperHello,
): { start: true } | { start: false; reason: string } {
  const sessionId = hello.meta.sessionId;
  if (hello.started) {
    return { start: false, reason: 'the program was started already' };
  }
  if (hello.exited !== null) {
    return { start: false, reason: 'the terminal has ended' };
  }
  let reason: string | null;
  try {
    reason = hello.meta.kind === 'new' ? newRefusal(deck, hello) : resumeRefusal(deck, hello);
    if (reason === null && deck.platform.clock.nowNs() >= BigInt(hello.startBy)) {
      reason = DEADLINE_PASSED;
    }
  } catch (error) {
    reason =
      error instanceof ResumeRefusedError || error instanceof RefError
        ? error.message
        : `cannot check whether ${short(sessionId)} may start (${describeError(error)})`;
  }
  return reason === null ? { start: true } : { start: false, reason: sanitize(reason) };
}

/**
 * S2 7.8: after an exit, when the session never reported a start for this launch (ingestSpool
 * first, then resumeStarted with the lock's time and event id; for `new`, no event of the id):
 * release the lock when it is still the hello's, and for `new` delete the meta row prepareNew wrote
 * (only while it is unchanged since: its update time is still its creation time).
 *
 * For every exit of a terminal, started or not (ruled by the plan owner, task 21, review 2: what
 * the exit and the store say decide, not `hello.started`, which a hello from before T has false).
 * A resume whose hello carries no lock skydeck wrote took none: nothing is released; a lock that is
 * no longer exactly the hello's (taken over, or renewed: S2 7.8's limit) is left alone. Unlike
 * settleFailedLaunch this does not depend on a printed command: the window shows none (S2 11.2,
 * ruled), and the ended terminal offers Resume itself (S2 7.8). Throws what the store throws.
 */
export function settleEndedTerminal(deck: Deck, hello: KeeperHello): void {
  ingestSpool(deck);
  const { sessionId, kind } = hello.meta;
  const { store } = deck;
  if (kind === 'new') {
    store.transaction(() => {
      // Only the row prepareNew wrote, untouched since (review 2, principle 6): one the user
      // changed meanwhile (a note, another label) is theirs and stays.
      const row = store.meta(sessionId);
      if (
        row !== null &&
        row.updatedNs === row.createdNs &&
        store.latestEventIdOfSession(sessionId) === null
      ) {
        store.deleteMeta(sessionId);
      }
    });
    return;
  }
  const lock = hello.lock;
  const takenNs = lock === null ? null : lockTakenNs(lock);
  if (lock === null || takenNs === null) {
    return;
  }
  if (!resumeStarted(store, sessionId, takenNs, lockEventId(lock))) {
    releaseLock(deck, sessionId, lock);
  }
}
