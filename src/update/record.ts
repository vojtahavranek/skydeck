// What the window's check for a newer skydeck stores (F38; S2 10.2, 16.5): two `kv` entries.
// `window_update_check` is written by the server only and read by it and by doctor, which uses no
// network. `window_update_run` is the one update started from a window: `applying` written by the
// server that starts it, then the outcome of the merge written by `skydeck update --from-window`
// before the window is brought back, read (and removed) by the server that follows. Each entry
// names its checkout (`root`): one database serves every checkout of the user, and an entry of
// another checkout is none to a reader of this one. The readers are strict: a value that is not
// exactly such a record reads as none. The check's record is of version 2 (the notes of what is
// new, S2 16.5): one of version 1, the shape before, reads as none, and so does a version 2 one to
// the code before, which wants 1; the server then makes its own check, with no migration. Every line of git's or of a refusal is clipped to LINE_MAX
// (a run entry's to RUN_LINE_MAX) before it is stored, and sanitised and clipped again in the
// page's payload.
import type { Files } from '../platform/types.ts';
import type { Store } from '../store/store.ts';
import { sanitize } from '../text/sanitize.ts';
import type { UpdateCheckPayload } from '../window/protocol.ts';
import { clipLine } from './git.ts';
import { counted, LISTED } from './look.ts';
import { clipText, clipTitle, NOTES_SHOWN, runsOf } from './news.ts';
import type { Note } from './news.ts';

export const CHECK_KEY = 'window_update_check';
export const RUN_KEY = 'window_update_run';
/** The longest line a run entry keeps: the command's own lines are longer than git's. */
export const RUN_LINE_MAX = 600;

/** What the last look said. */
export type CheckOutcome =
  /** It could not tell: U2's line (no upstream, not a checkout, git missing …). */
  | { kind: 'cannot'; line: string }
  /** Nothing would come: `skydeck is up to date …` or `nothing new on …`. */
  | { kind: 'current'; line: string }
  /**
   * `count` commits on `upstream`, from HEAD's `from` to the newest, `to`; the notes of what is
   * new they bring and how many more, the subjects of the other changes (the commits that add no
   * note) and how many there are; whether they change the database's upgrade steps.
   */
  | {
      kind: 'available';
      upstream: string;
      count: number;
      from: string;
      to: string;
      notes: Note[];
      moreNotes: number;
      others: string[];
      otherCount: number;
      upgradesDatabase: boolean;
      /** Why it cannot be applied as it is (changes, ahead); null: nothing stands in the way. */
      blocked: string | null;
    };

export interface CheckRecord {
  v: 2;
  /** The checkout the look was of: checkoutRoot's answer. */
  root: string;
  /** When the look ended (ns, decimal). */
  lookedAtNs: string;
  /** When the last check (a look with the fetch) ended, whatever its result; null: none yet. */
  checkedAtNs: string | null;
  /** When the last fetch that worked ended; null: never. */
  fetchedAtNs: string | null;
  /**
   * The last check failed — its fetch, a git call of its look, or the check itself: when, and its
   * line; null once a check ends without a failure.
   */
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
/** A full commit id: 40 lower-case hexadecimal digits (SHA-1), or 64 (SHA-256). */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isNote(value: unknown): value is Note {
  if (!isObject(value) || !hasKeys(value, ['title', 'paragraphs'])) return false;
  const { title, paragraphs } = value;
  return (
    isText(title) && Array.isArray(paragraphs) && paragraphs.length > 0 && paragraphs.every(isText)
  );
}

function isOutcome(value: unknown): value is CheckOutcome {
  if (!isObject(value)) return false;
  switch (value['kind']) {
    case 'cannot':
    case 'current':
      return hasKeys(value, ['kind', 'line']) && isText(value['line']);
    case 'available': {
      const { upstream, count, from, to, notes, moreNotes, others, otherCount } = value;
      const { upgradesDatabase, blocked } = value;
      return (
        hasKeys(value, [
          'kind',
          'upstream',
          'count',
          'from',
          'to',
          'notes',
          'moreNotes',
          'others',
          'otherCount',
          'upgradesDatabase',
          'blocked',
        ]) &&
        isText(upstream) &&
        isCount(count) &&
        count > 0 &&
        isCommit(from) &&
        isCommit(to) &&
        Array.isArray(notes) &&
        notes.length <= NOTES_SHOWN &&
        notes.every(isNote) &&
        isCount(moreNotes) &&
        Array.isArray(others) &&
        others.length <= LISTED &&
        others.every(isText) &&
        isCount(otherCount) &&
        otherCount <= count &&
        typeof upgradesDatabase === 'boolean' &&
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
  const keys = [
    'v',
    'root',
    'lookedAtNs',
    'checkedAtNs',
    'fetchedAtNs',
    'failure',
    'head',
    'outcome',
  ];
  if (!hasKeys(value, keys)) {
    return null;
  }
  const { v, root, lookedAtNs, checkedAtNs, fetchedAtNs, failure, head, outcome } = value;
  const failureOk =
    failure === null ||
    (isObject(failure) &&
      hasKeys(failure, ['atNs', 'line']) &&
      isDecimal(failure['atNs']) &&
      isText(failure['line']));
  if (
    v !== 2 ||
    !isText(root) ||
    root === '' ||
    !isDecimal(lookedAtNs) ||
    !(checkedAtNs === null || isDecimal(checkedAtNs)) ||
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

/** A note within its limits (a stored one is read back as it was written). */
function clippedNote(note: Note): Note {
  return { title: clipTitle(note.title), paragraphs: clipText(note.paragraphs) };
}

/** `record` with every line clipped to LINE_MAX (a note to its limits), as it is stored. */
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
            notes: outcome.notes.map(clippedNote),
            others: outcome.others.map((line) => clipLine(line)),
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
        from: outcome.from,
        to: outcome.to,
        upstream: payloadText(outcome.upstream),
        // A note is sanitised and clipped again, and cut into its runs here: the page parses
        // nothing (S2 4.3).
        notes: outcome.notes.map((note) => {
          const { title, paragraphs } = clippedNote({
            title: sanitize(note.title),
            paragraphs: note.paragraphs.map(sanitize),
          });
          return { title: runsOf(title), paragraphs: paragraphs.map(runsOf) };
        }),
        moreNotes: outcome.moreNotes,
        others: outcome.others.map(payloadText),
        otherCount: outcome.otherCount,
        upgradesDatabase: outcome.upgradesDatabase,
        blocked: outcome.blocked === null ? null : payloadText(outcome.blocked),
      };
  }
}

/**
 * The one update started from a window (S2 16.5 "Update now"): `applying` while the updater
 * runs, then the outcome of its merge — `applied`, or `failed` with the command's line. `to` is
 * the commit the window listed; `atNs` when the entry was written.
 */
export type RunRecord =
  | { v: 1; root: string; state: 'applying' | 'applied'; to: string; atNs: string }
  | { v: 1; root: string; state: 'failed'; to: string; line: string; atNs: string };

/** `value` when it is exactly a RunRecord, else null. */
function asRun(value: unknown): RunRecord | null {
  if (!isObject(value)) return null;
  const { v, root, state, to, line, atNs } = value;
  const keys =
    state === 'failed'
      ? ['v', 'root', 'state', 'to', 'line', 'atNs']
      : ['v', 'root', 'state', 'to', 'atNs'];
  if (
    !hasKeys(value, keys) ||
    v !== 1 ||
    !isText(root) ||
    root === '' ||
    !(state === 'applying' || state === 'applied' || state === 'failed') ||
    !isCommit(to) ||
    (state === 'failed' && !isText(line)) ||
    !isDecimal(atNs)
  ) {
    return null;
  }
  return value as unknown as RunRecord;
}

/** The stored run entry whatever checkout it names; null: none, or not one. */
export function readRunEntry(store: Store): RunRecord | null {
  const text = store.getKv(RUN_KEY);
  if (text === null) return null;
  try {
    return asRun(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The stored run entry of the checkout `root` (checkoutRoot's answer); another checkout's is none. */
export function readRun(store: Store, root: string): RunRecord | null {
  const record = readRunEntry(store);
  return record !== null && record.root === root ? record : null;
}

/** Stores `record`, its line clipped to RUN_LINE_MAX; a store that fails throws (the caller catches). */
export function writeRun(store: Store, record: RunRecord): void {
  const stored: RunRecord =
    record.state === 'failed' ? { ...record, line: clipLine(record.line, RUN_LINE_MAX) } : record;
  store.setKv(RUN_KEY, JSON.stringify(stored));
}

/** Removes the run entry; a store that fails throws (the caller catches). */
export function clearRun(store: Store): void {
  store.deleteKv(RUN_KEY);
}
