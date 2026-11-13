// What a refresh skipped, and why, kept in kv for `skydeck doctor` (design 8). A refresh never
// throws for one spool file, one live process or one transcript (it would make every command
// fail); it skips that one and records a line here instead. The lines name files, folders and
// processes, never their content (principle 4).
import type { Store } from '../store/store.ts';

export type ProblemKey = 'ingest_problems' | 'reconcile_problems' | 'scan_problems';

/** At most this many lines are kept per step; the rest is counted in the last one. */
const MAX_PROBLEMS = 20;
const MAX_REASON = 200;

/** The code of a system call's error (`EACCES`, `ENOENT`): it says all there is to say. */
const ERRNO_CODE = /^E[A-Z0-9]+$/;

/**
 * Why something failed, on one short line: the code of a system error (`EACCES`), else the
 * error's name and message (`SpoolParseError: v is not 1`). Other codes are not used: node:sqlite
 * gives every error `ERR_SQLITE_ERROR`, and the message is what tells them apart.
 */
export function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  let text: string;
  if (typeof code === 'string' && ERRNO_CODE.test(code)) {
    text = code;
  } else if (error instanceof Error) {
    text = `${error.name}: ${error.message}`;
  } else {
    text = String(error);
  }
  text = text.replace(/\s+/g, ' ');
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

/**
 * Replaces the lines kept under `key` by `problems` (a JSON array of strings; the key is removed
 * when there are none). Writes only when the value changes, so a refresh without news writes
 * nothing.
 */
export function recordProblems(store: Store, key: ProblemKey, problems: readonly string[]): void {
  const kept =
    problems.length > MAX_PROBLEMS
      ? [...problems.slice(0, MAX_PROBLEMS - 1), `… and ${problems.length - MAX_PROBLEMS + 1} more`]
      : problems;
  const value = kept.length === 0 ? null : JSON.stringify(kept);
  if (store.getKv(key) === value) {
    return;
  }
  if (value === null) {
    store.deleteKv(key);
  } else {
    store.setKv(key, value);
  }
}
