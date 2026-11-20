// Follow-up F33 (design 5.3 "Copies", 5.4): a session that began as a copy of another. Claude Code's
// background feature (agent view, `/bg`) starts `claude --fork-session --resume <the original>`,
// and a user can type it: a process whose first session is a NEW session, a copy of the original
// (`copiedSessionOf`). skydeck keeps only the original's id, as a link of kind `copy` on the
// process's first event, written once — by ingest from the hook's recorded command, and by
// reconcile from the command line of a process that still runs.
import type { ProcessKey } from '../claude/live.ts';
import type { Store } from '../store/store.ts';
import type { EventRow } from '../store/types.ts';

/**
 * The event the copy link to `copyOf` goes on: the process's first event — its session is the
 * earliest the process is known to have held: a `start`, an `observed` one, or an `end` when the
 * spool file of its first start was lost; never a scripted run's (5.3) — when it names another
 * session than `copyOf` and no copy link names its session yet (nor any link that event). null
 * when there is nothing to write — also for a process that cannot be told apart from another (no
 * pid, no process start: D7). Reads only.
 */
export function copyLinkTarget(store: Store, process: ProcessKey, copyOf: string): EventRow | null {
  if (process.pid === 0 || process.procStart === null) {
    return null;
  }
  const first = store.firstEventOfProcess(process.bootId, process.pid, process.procStart);
  if (
    first === null ||
    first.kind === 'scripted' ||
    first.kind === 'scripted-end' ||
    first.sessionId === copyOf
  ) {
    return null;
  }
  const linked = store
    .linksTo(first.sessionId)
    .some((link) => link.kind === 'copy' || link.eventId === first.id);
  return linked ? null : first;
}

/**
 * Writes the copy link `copyOf` → the session of the process's first event (`copyLinkTarget`),
 * with that event's id and time; whether it wrote one. Call it inside the store's transaction that
 * also wrote the process's event, or in one of its own: the check and the write must not be split.
 */
export function linkCopy(store: Store, process: ProcessKey, copyOf: string): boolean {
  const target = copyLinkTarget(store, process, copyOf);
  if (target === null) {
    return false;
  }
  store.insertLink({
    eventId: target.id,
    fromSession: copyOf,
    toSession: target.sessionId,
    kind: 'copy',
    timeNs: target.timeNs,
  });
  return true;
}
