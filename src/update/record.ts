// What the window's check for a newer skydeck stores (F38; S2 10.2, 16.5): one `kv` entry,
// `window_update_check`, written by the server only and read by it and by doctor, which uses no
// network. The entry names its checkout (`root`): one database serves every checkout of the user,
// and an entry of another checkout is none to a reader of this one. The readers are strict: a
// value that is not exactly such a record reads as none. Every line of git's or of a refusal is
// clipped to LINE_MAX before it is stored, and sanitised and clipped again in the page's payload.
import type { Files } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import { sanitize } from '../text/sanitize.ts';
import type { UpdateCheckPayload } from '../window/protocol.ts';
import { clipLine } from './git.ts';
import { counted } from './look.ts';

export const CHECK_KEY = 'window_update_check';

/** What the last look said. */
export type CheckOutcome =
  /** It could not tell: U2's line (no upstream, not a checkout, git missing …). */
  | { kind: 'cannot'; line: string }
  /** Nothing would come: `skydeck is up to date …` or `nothing new on …`. */
  | { kind: 'current'; line: string }
  /** `count` commits on `upstream`, the newest `to`; `lines` are `skydeck update --check`'s. */
  | {
      kind: 'available';
      upstream: string;
      count: number;
      to: string;
      lines: string[];
      /** Why it cannot be applied as it is (changes, ahead); null: nothing stands in the way. */
      blocked: string | null;
    };

export interface CheckRecord {
  v: 1;
  /** The checkout the look was of: checkoutRoot's answer. */
  root: string;
  /** When the look ended (ns, decimal). */
  lookedAtNs: string;
  /** When the last fetch that worked ended; null: never. */
  fetchedAtNs: string | null;
  /** The last check's fetch failed: when, and its line; null once a check's fetch worked. */
  failure: { atNs: string; line: string } | null;
  /** HEAD's full id at the look; null when the look did not get that far. */
  head: string | null;
  outcome: CheckOutcome;
}

/**
 * The one name of a checkout in an entry, for every writer and reader of one (the server, the
 * updater, doctor): its real path, or the path itself when it does not resolve. A path through a
 * symbolic link and the one Node resolved for a process then cannot differ.
 */
export function checkoutRoot(files: Files, path: string): string {
  return files.realpath(path) ?? path;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` has exactly the keys `keys`. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isDecimal = (value: unknown): value is string => isText(value) && DECIMAL.test(value);
const isCommit = (value: unknown): value is string => isText(value) && COMMIT_ID.test(value);

function isOutcome(value: unknown): value is CheckOutcome {
  if (!isObject(value)) return false;
  switch (value['kind']) {
    case 'cannot':
    case 'current':
      return hasKeys(value, ['kind', 'line']) && isText(value['line']);
    case 'available': {
      const { upstream, count, to, lines, blocked } = value;
      return (
        hasKeys(value, ['kind', 'upstream', 'count', 'to', 'lines', 'blocked']) &&
        isText(upstream) &&
        typeof count === 'number' &&
        Number.isSafeInteger(count) &&
        count > 0 &&
        isCommit(to) &&
        Array.isArray(lines) &&
        lines.every(isText) &&
        (blocked === null || isText(blocked))
      );
    }
    default:
      return false;
  }
}

/** `value` when it is exactly a CheckRecord, else null. */
function asRecord(value: unknown): CheckRecord | null {
  if (!isObject(value)) return null;
  if (!hasKeys(value, ['v', 'root', 'lookedAtNs', 'fetchedAtNs', 'failure', 'head', 'outcome'])) {
    return null;
  }
  const { v, root, lookedAtNs, fetchedAtNs, failure, head, outcome } = value;
  const failureOk =
    failure === null ||
    (isObject(failure) &&
      hasKeys(failure, ['atNs', 'line']) &&
      isDecimal(failure['atNs']) &&
      isText(failure['line']));
  if (
    v !== 1 ||
    !isText(root) ||
    root === '' ||
    !isDecimal(lookedAtNs) ||
    !(fetchedAtNs === null || isDecimal(fetchedAtNs)) ||
    !failureOk ||
    !(head === null || isCommit(head)) ||
    !isOutcome(outcome)
  ) {
    return null;
  }
  return value as unknown as CheckRecord;
}

/** The stored entry whatever checkout it names (doctor says whose it is); null: none, or not one. */
export function readCheckEntry(store: Store): CheckRecord | null {
  const text = store.getKv(CHECK_KEY);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The stored entry of the checkout `root` (checkoutRoot's answer); another checkout's is none. */
export function readCheck(store: Store, root: string): CheckRecord | null {
  const record = readCheckEntry(store);
  return record !== null && record.root === root ? record : null;
}

/** `record` with every line clipped to LINE_MAX, as it is stored. */
export function clippedCheck(record: CheckRecord): CheckRecord {
  const { outcome } = record;
  return {
    ...record,
    failure:
      record.failure === null
        ? null
        : { atNs: record.failure.atNs, line: clipLine(record.failure.line) },
    outcome:
      outcome.kind === 'available'
        ? {
            ...outcome,
            upstream: clipLine(outcome.upstream),
            lines: outcome.lines.map((line) => clipLine(line)),
            blocked: outcome.blocked === null ? null : clipLine(outcome.blocked),
          }
        : { kind: outcome.kind, line: clipLine(outcome.line) },
  };
}

/** Stores `record` (clipped); a store that fails throws (the caller catches). */
export function writeCheck(store: Store, record: CheckRecord): void {
  store.setKv(CHECK_KEY, JSON.stringify(clippedCheck(record)));
}

/** A text as the page gets it: sanitised and clipped. */
export function payloadText(text: string): string {
  return clipLine(sanitize(text));
}

/** What the page is told of a record's outcome (UpdatePayload.check). */
export function checkPayload(record: CheckRecord): UpdateCheckPayload {
  const { outcome } = record;
  switch (outcome.kind) {
    case 'cannot':
    case 'current':
      return { state: outcome.kind, summary: payloadText(outcome.line) };
    case 'available':
      return {
        state: 'available',
        summary: payloadText(
          `${counted(outcome.count, 'new commit', 'new commits')} on ${outcome.upstream}`,
        ),
        to: outcome.to,
        lines: outcome.lines.map(payloadText),
        blocked: outcome.blocked === null ? null : payloadText(outcome.blocked),
      };
  }
}
