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
  releaseLockOfTake,
  resumeStarted,
  sameTake,
} from '../sessions/resume.ts';
import type { DerivedSession } from '../sessions/types.ts';
import { sanitize } from '../text/sanitize.ts';
import { isBusy } from './busy.ts';
import type { KeeperHello } from './frames.ts';
import type { TerminalInfo } from './hub.ts';
import { lostProgramMayRun } from './mapping.ts';

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
 * session's lock in the store must still be of the hello's take (sameTake, C19): the hello's own
 * value or a renewal of it (restore renews while it waits) — not one another skydeck took over, and
 * not gone (no refresh has swept it as stale).
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
  const stored = readLock(deck, sessionId);
  if (stored === null || !sameTake(hello.lock, stored)) {
    return `${short(sessionId)}: its resume lock was taken over`;
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
 * refreshed row; for `new`, no live process holds the id) and the lock (still of the take of the
 * hello's `lock`: that value or a renewal of it, C19), and the deadline (the clock before
 * `startBy`, as the keeper itself checks it).
 *
 * Never throws: a refusal of the guard is the reason (its message); a failure while checking (the
 * store, /proc) is "cannot check whether <short> may start (<the failure>)" — nothing is started
 * on what could not be checked — except a busy or locked database (isBusy), which is `later`: not
 * refused, decided again (ruled, task 23's review 2). A hello whose program started or whose terminal ended already is
 * never started again. Every reason is sanitised (it is shown on the terminal, "not started: …").
 */
export function decideFoundKeeper(
  deck: Deck,
  hello: KeeperHello,
): { start: true } | { start: false; reason: string } | { start: 'later' } {
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
    // Ruled (task 23, review 2): a store another process keeps locked decides nothing — the
    // server decides again at its next refresh while the deadline allows.
    if (isBusy(error)) return { start: 'later' };
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
 * release the lock when it is still of the hello's take (releaseLockOfTake: the hello's value or a
 * renewal of it, C19), and for `new` delete the meta row prepareNew wrote (only while it is
 * unchanged since: its update time is still its creation time).
 *
 * For every exit of a terminal, started or not (ruled by the plan owner, task 21, review 2: what
 * the exit and the store say decide, not `hello.started`, which a hello from before T has false).
 * A resume whose hello carries no lock skydeck wrote took none: nothing is released; a lock another
 * skydeck took over is left alone. Unlike
 * settleFailedLaunch this does not depend on a printed command: the window shows none (S2 11.2,
 * ruled), and the ended terminal offers Resume itself (S2 7.8). Throws what the store throws.
 *
 * Plan task 82: an exit the server made up for a lost keeper is not the program's — nobody reaped
 * it. `terminal` is what the registry listed for the terminal when its exit came (null: not
 * known, settled as before). While its program may still run by task 57's rule
 * (`lostProgramMayRun`: alive by design 5.5 or not readable, the loss less than 60 s old by the
 * server's clock), nothing is settled — ruled: the whole of it, for a resume (its lock) as for a
 * `new` (its label and group): the program may yet report its start — and the answer is false, the
 * exit is left for a later call. Once the program is gone, or 60 s after the loss, it is settled as
 * above. True when it is settled (also when there was nothing to do).
 */
export function settleEndedTerminal(
  deck: Deck,
  hello: KeeperHello,
  terminal: Pick<TerminalInfo, 'state' | 'program' | 'exit'> | null = null,
): boolean {
  const { platform } = deck;
  if (terminal !== null && lostProgramMayRun(terminal, platform.proc, platform.clock.nowNs())) {
    return false; // its program may yet report its start: the lock is all the command line has
  }
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
    return true;
  }
  const lock = hello.lock;
  const takenNs = lock === null ? null : lockTakenNs(lock);
  if (lock === null || takenNs === null) {
    return true;
  }
  if (!resumeStarted(store, sessionId, takenNs, lockEventId(lock))) {
    releaseLockOfTake(deck, sessionId, lock);
  }
  return true;
}
