/**
 * A store that another process keeps write-locked (S2 14; ruled, plan task 23's review 2): the
 * server's own connection waits at most 250 ms for the lock, and the work that met it is given up
 * for now and tried again — never taken for a refusal, a wrong proof or a failure of the database.
 */

/** SQLite's primary result codes BUSY and LOCKED (an extended code keeps them in its low byte). */
const BUSY_CODES = new Set([5, 6]);

/** Whether `error` is node:sqlite's "the database is busy" or "locked". Never throws. */
export function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  return (
    code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && BUSY_CODES.has(errcode & 0xff)
  );
}
