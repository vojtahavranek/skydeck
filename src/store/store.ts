import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import { SkydeckError } from '../platform/errors.ts';
import { realClock } from '../platform/real.ts';
import { isoFromNs } from '../platform/time.ts';
import type { Clock, Ns } from '../platform/types.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import type {
  AttentionRow,
  AttentionWrite,
  EventKind,
  EventRow,
  KvKey,
  LinkKind,
  LinkRow,
  MetaPatch,
  NewEvent,
  PrChecks,
  PrFetchResult,
  PrOrigin,
  PrReview,
  PrRow,
  PrState,
  SessionMeta,
  SessionPrRow,
  TicketCategory,
  TicketStatusResult,
  TicketStatusRow,
  TranscriptRow,
} from './types.ts';
import { TICKET_CATEGORIES } from './types.ts';

/**
 * What an open did to a database that held a schema already (follow-up F21): the schema version it
 * brought the database to, and the copy of the database as it was that it wrote before its first
 * migration.
 */
export interface Migrated {
  version: number;
  copy: string;
}

export interface Store {
  readonly path: string;
  /**
   * F21: what this open migrated of a database that held a schema already, and where the copy it
   * kept first is; null when it migrated nothing (the database was at the code's version, another
   * process migrated it meanwhile, or it was new). The command says it (migratedLine).
   */
  readonly migrated: Migrated | null;
  /** Closes the connection; a second call does nothing. */
  close(): void;
  /**
   * PRAGMA data_version (added by fix 4): a number that differs from the one the previous call
   * returned when another connection — another skydeck — committed to the database in between;
   * this connection's own commits do not change it. The interactive list reads it to tell whether
   * the rows can have changed.
   */
  dataVersion(): number;
  /** The connection's PRAGMA values (they are per connection, so tests read them here). */
  connectionSettings(): {
    journalMode: string;
    synchronous: number;
    busyTimeout: number;
    foreignKeys: number;
  };
  /**
   * Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. Not re-entrant.
   * fn must be synchronous: the transaction ends when fn returns, not when a promise it returns settles.
   */
  transaction<T>(fn: () => T): T;

  // events (5.3, 5.4)
  /** INSERT OR IGNORE keyed by spool_name. Returns the new id, or null when that spool name exists. */
  insertEvent(event: NewEvent): number | null;
  insertLink(link: LinkRow): void;
  /** All events ordered by (time_ns, id). */
  events(): EventRow[];
  /**
   * The latest event (by time_ns, id) of the process (bootId, pid, procStart) with
   * time_ns <= beforeNs. procStart null matches proc_start IS NULL.
   */
  latestEventOfProcess(
    bootId: string,
    pid: number,
    procStart: number | null,
    beforeNs: Ns,
  ): EventRow | null;
  /** Whether any event of that process has a non-null argv. */
  processHasLaunch(bootId: string, pid: number, procStart: number | null): boolean;
  /**
   * Whether a 'start' event of a real process for the session exists with time_ns >= sinceNs and an
   * id greater than `afterEventId` (null: any id): one with a pid (not 0) and a process start time.
   * A start the hook wrote without them names no process that could hold the session, so it says
   * nothing about a resume that is under way. Ids grow in the order events are stored, whatever
   * their times, so a start stored before a given event is left out even when it is dated later
   * (the clock was ahead when it was written).
   */
  hasProcessStartSince(sessionId: string, sinceNs: Ns, afterEventId: number | null): boolean;
  /** The highest id among the events that name the session (whatever their time or kind); null when there is none. */
  latestEventIdOfSession(sessionId: string): number | null;
  /** All links ordered by time_ns. */
  links(): LinkRow[];

  // session_meta (7.1)
  meta(sessionId: string): SessionMeta | null;
  allMeta(): SessionMeta[];
  /** Creates the row (created_ns = updated_ns = nowNs) when absent; applies the patch; returns the row. */
  updateMeta(sessionId: string, patch: MetaPatch, nowNs: Ns): SessionMeta;
  /**
   * Deletes the session's row; whether there was one. Only for a row skydeck has just written for a
   * session that never started (`new`, 7.7): principle 6 keeps every other.
   */
  deleteMeta(sessionId: string): boolean;

  // transcripts (5.6)
  transcripts(): TranscriptRow[];
  /** INSERT OR REPLACE by path. */
  saveTranscript(row: TranscriptRow): void;

  // pull requests (7.3)
  /** INSERT OR IGNORE a prs row with only the key columns. */
  ensurePr(key: { url: string; owner: string; repo: string; number: number }): void;
  prs(): PrRow[];
  /** ok: sets title, state, review, checks, ok_at_ns = tried_at_ns = atNs, error = NULL.
   *  failure: sets tried_at_ns = atNs and error; leaves every other column unchanged. */
  savePrResult(url: string, result: PrFetchResult): void;
  /**
   * origin 'auto': INSERT OR IGNORE — never re-attaches a detached row, never downgrades 'manual'.
   * origin 'manual': upsert — origin = 'manual', detached_at_ns = NULL, first_seen_ns kept if present.
   * The prs row must exist (ensurePr first).
   */
  attachPr(sessionId: string, url: string, origin: PrOrigin, nowNs: Ns): void;
  /** Sets detached_at_ns; false when there is no such attached row. */
  detachPr(sessionId: string, url: string, nowNs: Ns): boolean;
  /** All session_prs rows, detached ones included. */
  sessionPrs(): SessionPrRow[];

  // ticket statuses (follow-up F19; S2 10.2): one cached row per ticket address
  /** Every ticket_status row, ordered by url. */
  ticketStatuses(): TicketStatusRow[];
  /**
   * ok: makes or sets the row of `url`: status, category, ok_at_ns = tried_at_ns = atNs, error =
   * NULL. failure: makes or sets it with tried_at_ns = atNs and error; every other column of a row
   * that was there stays (the last known status and its age).
   */
  saveTicketStatus(url: string, result: TicketStatusResult): void;

  // attention (S2 10.2): the server's observations, ordered by a counter, never by a clock
  /** Every attention row, ordered by session id. */
  attention(): AttentionRow[];
  /**
   * S2 10.2 in ONE transaction (the guarded connection refuses it whole: StoreNewerError): for each
   * write in order, each observation takes the next value (B2) in B3's order — turn end, window
   * end, seen; a row is created when absent and never removed. Returns the rows it wrote, as
   * stored: one per session the writes name, in its state after them, ordered by session id. An
   * empty list writes nothing; a write with no observation is a RangeError and nothing is written.
   * B2: each value is one more than the larger of kv attention_seq — 0 unless it is a canonical
   * decimal whole number below 2^53 — and every *_seq of attention; attention_seq is left at the
   * last value given. A value that would pass 2^53 - 1 is a RangeError, and nothing is written.
   * Like transaction(), not to be called inside one.
   */
  recordAttention(writes: readonly AttentionWrite[]): AttentionRow[];

  // kv
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
  /** Treats a missing value as 0. */
  addToKv(key: KvKey, delta: number): void;
  /** Every entry whose key starts with `prefix` (compared literally, case included), ordered by key. */
  kvEntries(prefix: string): { key: KvKey; value: string }[];
}

/**
 * A guarded connection (openStore's `guardSchema`) refused a write: the store's schema is newer than
 * this skydeck knows — a command of an updated checkout migrated it (S2 10.1, 16.5). The store
 * throws it with STORE_NEWER.
 */
export class StoreNewerError extends SkydeckError {}

/**
 * openStore's refusal of a database whose schema version is newer than this skydeck knows (`the
 * database <path> was written by a newer skydeck (…); update skydeck`). A type of its own only so
 * that `skydeck update` can tell it apart from every other failure to open the database (F8: the
 * command the message asks for must still run then); its message, its exit code (1) and its name
 * (`SkydeckError`, which describeError prints) are those of the plain SkydeckError it was before,
 * so that every other caller sees what it saw.
 */
export class DatabaseNewerError extends SkydeckError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'SkydeckError';
  }
}

/** The message of the StoreNewerError the store throws, and the server's `bye` (S2 10.1). */
const STORE_NEWER = 'skydeck was updated; run skydeck window';

type Row = Record<string, SQLOutputValue>;

// The connection reads every INTEGER as a bigint (D1): a nanosecond time is ~1.8e18, which
// node:sqlite refuses to read as a number. These turn a column back into what the row types
// promise; a value of another type means the file is not ours, and is an error.

function column(row: Row, key: string): SQLOutputValue {
  const value = row[key];
  if (value === undefined) {
    throw new Error(`the query returned no column ${key}`);
  }
  return value;
}

function optStr(row: Row, key: string): string | null {
  const value = column(row, key);
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`column ${key} is not text`);
}

function reqStr(row: Row, key: string): string {
  const value = optStr(row, key);
  if (value === null) {
    throw new Error(`column ${key} is null`);
  }
  return value;
}

function optNs(row: Row, key: string): Ns | null {
  const value = column(row, key);
  if (value === null || typeof value === 'bigint') {
    return value;
  }
  throw new Error(`column ${key} is not an integer`);
}

function reqNs(row: Row, key: string): Ns {
  const value = optNs(row, key);
  if (value === null) {
    throw new Error(`column ${key} is null`);
  }
  return value;
}

function optInt(row: Row, key: string): number | null {
  const value = optNs(row, key);
  if (value === null) {
    return null;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`column ${key} does not fit a number`);
  }
  return Number(value);
}

function reqInt(row: Row, key: string): number {
  const value = optInt(row, key);
  if (value === null) {
    throw new Error(`column ${key} is null`);
  }
  return value;
}

/** A whole number bound as an exact integer; RangeError for NaN, a fraction or infinity. */
function int(value: number): bigint {
  return BigInt(value);
}

function optIntParam(value: number | null): bigint | null {
  return value === null ? null : int(value);
}

function mapEvent(row: Row): EventRow {
  const argv = optStr(row, 'argv');
  return {
    id: reqInt(row, 'id'),
    spoolName: optStr(row, 'spool_name'),
    timeNs: reqNs(row, 'time_ns'),
    kind: reqStr(row, 'kind') as EventKind,
    detail: reqStr(row, 'detail') as EventRow['detail'],
    rawDetail: optStr(row, 'raw_detail'),
    sessionId: reqStr(row, 'session_id'),
    bootId: reqStr(row, 'boot_id'),
    pid: reqInt(row, 'pid'),
    procStart: optInt(row, 'proc_start'),
    cwd: optStr(row, 'cwd'),
    argv: argv === null ? null : (JSON.parse(argv) as string[]),
    name: optStr(row, 'name'),
    payload: optStr(row, 'payload'),
  };
}

function mapLink(row: Row): LinkRow {
  return {
    eventId: reqInt(row, 'event_id'),
    fromSession: reqStr(row, 'from_session'),
    toSession: reqStr(row, 'to_session'),
    kind: reqStr(row, 'kind') as LinkKind,
    timeNs: reqNs(row, 'time_ns'),
  };
}

function mapMeta(row: Row): SessionMeta {
  return {
    sessionId: reqStr(row, 'session_id'),
    label: optStr(row, 'label'),
    group: optStr(row, 'group_name'),
    note: optStr(row, 'note'),
    doneAtNs: optNs(row, 'done_at_ns'),
    ticket: optStr(row, 'ticket_url'),
    createdNs: reqNs(row, 'created_ns'),
    updatedNs: reqNs(row, 'updated_ns'),
  };
}

function mapTranscript(row: Row): TranscriptRow {
  return {
    path: reqStr(row, 'path'),
    sessionId: reqStr(row, 'session_id'),
    sizeRead: reqInt(row, 'size_read'),
    fileSize: reqInt(row, 'file_size'),
    mtimeNs: reqNs(row, 'mtime_ns'),
    firstCwd: optStr(row, 'first_cwd'),
    entrypoint: optStr(row, 'entrypoint'),
    aiTitle: optStr(row, 'ai_title'),
    customTitle: optStr(row, 'custom_title'),
    firstRecordNs: optNs(row, 'first_record_ns'),
    lastRecordNs: optNs(row, 'last_record_ns'),
    lastUserNs: optNs(row, 'last_user_ns'),
    lastTurnRole: optStr(row, 'last_turn_role') as TranscriptRow['lastTurnRole'],
    missingSinceNs: optNs(row, 'missing_since_ns'),
  };
}

function mapPr(row: Row): PrRow {
  return {
    url: reqStr(row, 'url'),
    owner: reqStr(row, 'owner'),
    repo: reqStr(row, 'repo'),
    number: reqInt(row, 'number'),
    title: optStr(row, 'title'),
    state: optStr(row, 'state') as PrState | null,
    review: optStr(row, 'review') as PrReview | null,
    checks: optStr(row, 'checks') as PrChecks | null,
    okAtNs: optNs(row, 'ok_at_ns'),
    triedAtNs: optNs(row, 'tried_at_ns'),
    error: optStr(row, 'error'),
  };
}

/** F19: a category the row holds, or null for none — also for a word this skydeck does not know. */
function categoryOf(text: string | null): TicketCategory | null {
  return TICKET_CATEGORIES.find((category) => category === text) ?? null;
}

function mapTicketStatus(row: Row): TicketStatusRow {
  return {
    url: reqStr(row, 'url'),
    status: optStr(row, 'status'),
    category: categoryOf(optStr(row, 'category')),
    okAtNs: optNs(row, 'ok_at_ns'),
    triedAtNs: reqNs(row, 'tried_at_ns'),
    error: optStr(row, 'error'),
  };
}

function mapAttention(row: Row): AttentionRow {
  return {
    sessionId: reqStr(row, 'session_id'),
    turnEndedSeq: optInt(row, 'turn_ended_seq'),
    turnEndedNs: optNs(row, 'turn_ended_ns'),
    seenSeq: optInt(row, 'seen_seq'),
    windowEndSeq: optInt(row, 'window_end_seq'),
    windowEndNs: optNs(row, 'window_end_ns'),
  };
}

/**
 * B2: the value of kv attention_seq when it is a canonical decimal whole number that a number holds
 * exactly, else 0 — a damaged counter then gives way to the values stored in attention.
 */
function counterValue(text: string | null): number {
  if (text === null || !/^(0|[1-9][0-9]*)$/.test(text)) {
    return 0;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 0;
}

function mapSessionPr(row: Row): SessionPrRow {
  return {
    sessionId: reqStr(row, 'session_id'),
    url: reqStr(row, 'url'),
    origin: reqStr(row, 'origin') as PrOrigin,
    firstSeenNs: reqNs(row, 'first_seen_ns'),
    detachedAtNs: optNs(row, 'detached_at_ns'),
  };
}

/** BEGIN IMMEDIATE … COMMIT around fn; rolls back and rethrows when fn or the commit fails. */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}

/**
 * The schema version in kv; 0 only for a database that has no kv table yet (a new one). A kv table
 * without a usable version is not new, and running migration 1 on it would fail half way in.
 */
function schemaVersion(db: DatabaseSync, path: string): number {
  const table = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'")
    .get();
  if (table === undefined) {
    return 0;
  }
  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
  const text = row === undefined ? null : reqStr(row, 'value');
  const version = text !== null && /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new SkydeckError(
      `the database ${path} has no usable schema version (${text === null ? 'none' : JSON.stringify(text)})`,
      1,
    );
  }
  return version;
}

/**
 * Runs the migrations the database lacks, each in one transaction with the kv update. F21: before
 * the first one it runs on a database that held a schema when this open came to it (not a new one),
 * it keeps a copy of the database as it is (keepCopy), inside that migration's write lock; a copy
 * that cannot be written fails the open, the migration not run. Once that migration is committed,
 * older copies go (pruneCopies); when it fails, the database is as the copy is, and the copy is
 * removed again. Returns what it migrated of such a database, null when nothing. A database at the
 * code's version costs no more than reading its version once (every command opens the store).
 */
function migrate(db: DatabaseSync, path: string, clock: Pick<Clock, 'nowNs'>): Migrated | null {
  const tooNew = (version: number): DatabaseNewerError =>
    new DatabaseNewerError(
      `the database ${path} was written by a newer skydeck (schema version ${version}, this one knows ${SCHEMA_VERSION}); update skydeck`,
    );
  const found = schemaVersion(db, path);
  if (found > SCHEMA_VERSION) {
    throw tooNew(found);
  }
  if (found === SCHEMA_VERSION) {
    return null;
  }
  let copy: string | null = null;
  // The version is read again inside the write lock: a second process may have migrated meanwhile.
  while (schemaVersion(db, path) < SCHEMA_VERSION) {
    const step: { kept: string | null } = { kept: null };
    try {
      inTransaction(db, () => {
        const version = schemaVersion(db, path);
        if (version > SCHEMA_VERSION) {
          throw tooNew(version);
        }
        if (version === SCHEMA_VERSION) {
          return; // another process migrated while this one waited for the lock
        }
        const sql = MIGRATIONS[version];
        if (sql === undefined) {
          // Cannot happen while SCHEMA_VERSION is MIGRATIONS.length; stopping here keeps a mistake
          // in that from becoming a loop that never ends.
          throw new Error(`migration ${version + 1} is missing`);
        }
        if (found > 0 && copy === null) {
          // Inside the write lock, before anything is written: no other connection commits until
          // this one does, so the copy holds `version`, and whoever migrates has copied first.
          step.kept = keepCopy(path, version, clock.nowNs());
        }
        db.exec(sql);
        db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
          'schema_version',
          String(version + 1),
        );
      });
    } catch (error) {
      if (step.kept !== null) {
        removeQuietly(step.kept); // rolled back: the database is what the copy holds
      }
      throw error;
    }
    if (step.kept !== null) {
      copy = step.kept;
      pruneCopies(dirname(path), basename(path), basename(copy));
    }
  }
  return copy === null ? null : { version: SCHEMA_VERSION, copy };
}

/** Removes a file this open wrote, on a way that ends in an error anyway. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // It stays: a temporary is never taken for a copy (pruneCopies, purge.ts), a copy is a whole one.
  }
}

/** F21 C2: how many copies stay beside the database: the one just written and the newest others. */
const COPIES_KEPT = 3;

/** F21 C1: the time in a copy's name, the UTC time `yyyymmddThhmmssZ`. */
function copyStamp(ns: Ns): string {
  return isoFromNs(ns)
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/**
 * F21: the whole name of a copy of the database named `name` (`<name>.schema<V>-<stamp>`, V a
 * version as skydeck writes one), with V and the stamp as its groups.
 */
function copyPattern(name: string): RegExp {
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${literal}\\.schema([1-9][0-9]*)-([0-9]{8}T[0-9]{6}Z)$`);
}

/** Whether anything (a link too, followed or not) has the name `path`. */
function taken(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** What went wrong, for a refusal: SQLite's message; of a file error, `<code>: <what>` without its path. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    // Node.js says `<code>: <what>, <call> '<path>'`, and the path is the temporary's.
    return error.message.split(', ')[0] ?? code;
  }
  return error.message;
}

/**
 * F21 C1: writes a copy of the database `path` as it is — schema `version`, read by the caller
 * inside its write lock, which no commit can pass until the caller's — beside it as
 * `<path>.schema<version>-<stamp of nowNs>`, and returns that path. SQLite writes it (VACUUM INTO,
 * on a read-only connection of its own: VACUUM does not run inside a transaction), so it is a whole,
 * consistent database even while other connections have the database open. It is written into a
 * temporary `.<copy's name>.tmp`, created with mode 600 before anything is in it (the
 * copy holds the window's secret), and renamed to its name only once it is complete; a name that is
 * taken is never written over. When the copy cannot be written it is a SkydeckError naming the
 * database, the copy and the reason, the temporary removed.
 */
function keepCopy(path: string, version: number, nowNs: Ns): string {
  const dir = dirname(path);
  const copy = `${path}.schema${version}-${copyStamp(nowNs)}`;
  // No two processes write it at once: the caller holds the write lock.
  const temporary = join(dir, `.${basename(copy)}.tmp`);
  const refusal = (reason: string): SkydeckError =>
    new SkydeckError(
      `the database ${path} was not upgraded: its copy ${copy} could not be written (${reason})`,
      1,
    );
  const inTheWay = 'something of that name is there already';
  let made = false;
  try {
    if (taken(copy)) {
      throw refusal(inTheWay);
    }
    const fd = openSync(temporary, 'wx', 0o600);
    made = true;
    try {
      fchmodSync(fd, 0o600); // exactly 600, whatever the umask took away
    } finally {
      closeSync(fd);
    }
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout = 5000');
      reader.exec('PRAGMA synchronous = FULL'); // the copy is on the disk before the migration runs
      reader.prepare('VACUUM INTO ?').run(temporary);
    } finally {
      reader.close();
    }
    if (taken(copy)) {
      throw refusal(inTheWay);
    }
    renameSync(temporary, copy);
    made = false;
  } catch (error) {
    if (made) {
      removeQuietly(temporary);
    }
    throw error instanceof SkydeckError ? error : refusal(reasonOf(error));
  }
  syncDirectory(dir);
  return copy;
}

/** The copy's name on the disk before the migration's commit; a folder that cannot be synced is no refusal. */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some file systems refuse to sync a folder; the copy itself is synced.
  }
}

/**
 * F21 C2: of the copies of the database `name` in `dir` — the regular files whose whole name is a
 * copy's (copyPattern), never a link, a folder or a name that merely starts or ends alike — `written`
 * stays, and so do the newest others by the time in their names (not by their files' times), three
 * in all; the others are removed. Best effort: what cannot be listed or removed stays, and the
 * migration goes on.
 */
function pruneCopies(dir: string, name: string, written: string): void {
  const pattern = copyPattern(name);
  try {
    const others = readdirSync(dir)
      .flatMap((entry) => {
        const match = entry === written ? null : pattern.exec(entry);
        return match === null ? [] : [{ entry, stamp: match[2] ?? '' }];
      })
      .filter(({ entry }) => lstatSync(join(dir, entry), { throwIfNoEntry: false })?.isFile())
      .sort((a, b) =>
        a.stamp === b.stamp ? (b.entry < a.entry ? -1 : 1) : b.stamp < a.stamp ? -1 : 1,
      );
    for (const { entry } of others.slice(COPIES_KEPT - 1)) {
      try {
        unlinkSync(join(dir, entry));
      } catch {
        // It stays; the next copy tries again.
      }
    }
  } catch {
    // The folder could not be listed, or an entry looked at: nothing more is removed.
  }
}

/**
 * F21 C3: what is said of a migration, by a command on stderr after `skydeck: `, by the server in
 * its log.
 */
export function migratedLine(migrated: Migrated): string {
  return `the database was brought to schema version ${migrated.version}; a copy of it as it was is at ${migrated.copy}`;
}

/**
 * Opens (creating when absent) the database at `path`; the directory must exist. Sets
 * journal_mode=WAL, synchronous=FULL, busy_timeout=5000, foreign_keys=ON, chmods the file 0600,
 * runs the missing migrations. Throws DatabaseNewerError (a SkydeckError, exit 1) when kv
 * schema_version is newer than SCHEMA_VERSION ("the database was written by a newer skydeck"). Any
 * other failure to open it (a
 * file that is not a database, a lock held for more than the busy timeout, a missing directory,
 * a failed migration) is a SkydeckError (exit 1) naming the path: it is a fact of the machine,
 * not a bug in skydeck.
 *
 * `guardSchema` (the server's connection only, S2 10.1): the server outlives the commands, and a
 * command of an updated checkout may migrate the store under it. With it, every write transaction
 * and every single-statement write outside a transaction reads kv schema_version first, holding
 * the write lock (BEGIN IMMEDIATE, so no migration commits between the check and the write), and
 * throws StoreNewerError, writing nothing, when it is newer than SCHEMA_VERSION. A single-statement
 * write therefore runs in a transaction of its own on such a connection. Reads are never refused.
 * The store's read helpers refuse anything but a SELECT (prepareRead), and a test over this file
 * checks that only its write helpers prepare SQL themselves: that guards against the usual mistake,
 * a write sent through a read helper. A function handed the database object directly is not
 * covered (pragma() builds its statement from a name it is given: only fixed names may reach it).
 * Commands do not pass it: a command that migrates is the newer one.
 *
 * `busyTimeoutMs` (the server's connection, 250 ms; ruled, plan task 23): the connection's busy
 * timeout once it is open, so that a store another process keeps locked fails a piece of the
 * server's work quickly instead of freezing it for 5 s; the migrations at open still wait 5000.
 * Default 5000, the commands' value. A value that is not a whole number 0–2^31−1 is a RangeError.
 *
 * Follow-up F21: before it migrates a database that holds a schema already, it writes a copy of the
 * database as it is beside it (`<path>.schema<V>-<yyyymmddThhmmssZ>`, the UTC time of `clock`, the
 * platform's real clock by default: design 11) and keeps the newest three; `migrated` says what it did. When the copy cannot
 * be written the migration does not run, and the open fails with a SkydeckError naming the database,
 * the copy and the reason (`the database <path> was not upgraded: its copy <copy> could not be
 * written (<reason>)`). A new database and one at SCHEMA_VERSION are never copied.
 */
export function openStore(
  path: string,
  options: { guardSchema?: boolean; busyTimeoutMs?: number; clock?: Pick<Clock, 'nowNs'> } = {},
): Store {
  const busyTimeoutMs = options.busyTimeoutMs;
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2 ** 31 - 1)
  ) {
    throw new RangeError(`not a busy timeout in ms: ${busyTimeoutMs}`);
  }
  let db: DatabaseSync | undefined;
  let migrated: Migrated | null;
  try {
    db = new DatabaseSync(path, { readBigInts: true });
    // First, so the -wal and -shm files that SQLite creates later take the mode of this file.
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrated = migrate(db, path, options.clock ?? realClock());
    if (busyTimeoutMs !== undefined) {
      // After the migrations, which wait the full 5 s for a command that holds the lock.
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    }
  } catch (error) {
    db?.close();
    if (error instanceof SkydeckError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    const refusal = new SkydeckError(`cannot open the database ${path}: ${reason}`, 1);
    refusal.cause = error; // SkydeckError has no options argument; the stack of the SQLite error stays
    throw refusal;
  }
  return new SqliteStore(db, path, options.guardSchema === true, migrated);
}

/**
 * The primary result codes of a failure of the database as a whole, never of one row: BUSY,
 * LOCKED, READONLY, IOERR, CORRUPT, FULL, CANTOPEN, NOTADB.
 */
const DATABASE_FAILURES: ReadonlySet<number> = new Set([5, 6, 8, 10, 11, 13, 14, 26]);

/**
 * Whether `error`, thrown by a Store method, is a failure of the database as a whole (locked,
 * read-only, I/O, corrupt, full, cannot open, not a database, or a store newer than a guarded
 * connection may write: StoreNewerError) rather than of the one row being written. A caller that
 * records and skips the errors of one item must rethrow these at once: caught per item, every item
 * would wait out the busy timeout or be refused the same way, and none could be saved anyway.
 */
export function isDatabaseFailure(error: unknown): boolean {
  if (error instanceof StoreNewerError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  // An extended result code keeps the primary one in its low byte (SQLITE_BUSY_SNAPSHOT = 517).
  return (
    code === 'ERR_SQLITE_ERROR' &&
    typeof errcode === 'number' &&
    DATABASE_FAILURES.has(errcode & 0xff)
  );
}

/**
 * What the read helpers accept: a SELECT (any case, after leading whitespace). Not WITH, which can
 * stand before a write, nor PRAGMA, which can assign; prepare() takes the first statement only.
 */
const READ_STATEMENT = /^\s*SELECT\b/i;

/**
 * Prepares `sql` for a read. Throws (a bug in skydeck) when it is not a SELECT: writes go through
 * the store's write helpers, where a guarded connection checks the schema version (S2 10.1), and
 * this keeps one from going round that check through a read helper. Exported for its test.
 */
export function prepareRead(db: DatabaseSync, sql: string): StatementSync {
  if (!READ_STATEMENT.test(sql)) {
    throw new Error(`not a read statement: ${JSON.stringify(sql.trim().slice(0, 40))}`);
  }
  return db.prepare(sql);
}

/** One value out of a PRAGMA's single result row. */
function pragma(db: DatabaseSync, name: string): SQLOutputValue {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (value === undefined) {
    throw new Error(`PRAGMA ${name} returned nothing`);
  }
  return value;
}

class SqliteStore implements Store {
  readonly path: string;
  readonly migrated: Migrated | null;
  readonly #db: DatabaseSync;
  readonly #guardSchema: boolean;

  constructor(db: DatabaseSync, path: string, guardSchema: boolean, migrated: Migrated | null) {
    this.#db = db;
    this.path = path;
    this.#guardSchema = guardSchema;
    this.migrated = migrated;
  }

  // Reads go through #all and #get, which refuse anything but a SELECT (prepareRead); writes through
  // #run and #runReturning, where a guarded connection checks the schema version (#write). A test
  // over this file checks that no other method prepares or runs SQL itself.

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return prepareRead(this.#db, sql).all(...params);
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return prepareRead(this.#db, sql).get(...params);
  }

  /** A write statement: the number of rows it changed. */
  #run(sql: string, ...params: SQLInputValue[]): number {
    return this.#write(() => Number(this.#db.prepare(sql).run(...params).changes));
  }

  /**
   * A write statement with RETURNING: its rows. .all(), not .get(): outside a transaction the
   * statement commits when it is finished, and .get() stops after the first row and ignores a
   * failure of that commit (a full disk), so a row would be returned that was rolled back.
   */
  #runReturning(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#write(() => this.#db.prepare(sql).all(...params));
  }

  /**
   * A write of one statement. On a guarded connection outside a transaction it runs in a
   * transaction of its own, which checks the schema version first (transaction()); inside one the
   * check was made when it began. Otherwise it runs as it is.
   */
  #write<T>(fn: () => T): T {
    return this.#guardSchema && !this.#db.isTransaction ? this.transaction(fn) : fn();
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  dataVersion(): number {
    return Number(pragma(this.#db, 'data_version'));
  }

  connectionSettings(): {
    journalMode: string;
    synchronous: number;
    busyTimeout: number;
    foreignKeys: number;
  } {
    return {
      journalMode: String(pragma(this.#db, 'journal_mode')),
      synchronous: Number(pragma(this.#db, 'synchronous')),
      busyTimeout: Number(pragma(this.#db, 'busy_timeout')),
      foreignKeys: Number(pragma(this.#db, 'foreign_keys')),
    };
  }

  transaction<T>(fn: () => T): T {
    return inTransaction(this.#db, () => {
      // Inside BEGIN IMMEDIATE: a migration either committed before this or waits until it ends.
      if (this.#guardSchema && schemaVersion(this.#db, this.path) > SCHEMA_VERSION) {
        throw new StoreNewerError(STORE_NEWER);
      }
      return fn();
    });
  }

  insertEvent(event: NewEvent): number | null {
    const [row] = this.#runReturning(
      `INSERT INTO events (spool_name, time_ns, kind, detail, raw_detail, session_id, boot_id,
                           pid, proc_start, cwd, argv, name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (spool_name) DO NOTHING
       RETURNING id`,
      event.spoolName,
      event.timeNs,
      event.kind,
      event.detail,
      event.rawDetail,
      event.sessionId,
      event.bootId,
      int(event.pid),
      optIntParam(event.procStart),
      event.cwd,
      event.argv === null ? null : JSON.stringify(event.argv),
      event.name,
      event.payload,
    );
    return row === undefined ? null : reqInt(row, 'id');
  }

  insertLink(link: LinkRow): void {
    this.#run(
      `INSERT INTO links (event_id, from_session, to_session, kind, time_ns) VALUES (?, ?, ?, ?, ?)`,
      int(link.eventId),
      link.fromSession,
      link.toSession,
      link.kind,
      link.timeNs,
    );
  }

  events(): EventRow[] {
    return this.#all('SELECT * FROM events ORDER BY time_ns, id').map(mapEvent);
  }

  latestEventOfProcess(
    bootId: string,
    pid: number,
    procStart: number | null,
    beforeNs: Ns,
  ): EventRow | null {
    const row = this.#get(
      `SELECT * FROM events
       WHERE boot_id = ? AND pid = ? AND proc_start IS ? AND time_ns <= ?
       ORDER BY time_ns DESC, id DESC LIMIT 1`,
      bootId,
      int(pid),
      optIntParam(procStart),
      beforeNs,
    );
    return row === undefined ? null : mapEvent(row);
  }

  processHasLaunch(bootId: string, pid: number, procStart: number | null): boolean {
    return (
      this.#get(
        `SELECT 1 AS found FROM events
         WHERE boot_id = ? AND pid = ? AND proc_start IS ? AND argv IS NOT NULL LIMIT 1`,
        bootId,
        int(pid),
        optIntParam(procStart),
      ) !== undefined
    );
  }

  hasProcessStartSince(sessionId: string, sinceNs: Ns, afterEventId: number | null): boolean {
    return (
      this.#get(
        `SELECT 1 AS found FROM events
         WHERE session_id = ? AND kind = 'start' AND time_ns >= ? AND (? IS NULL OR id > ?)
           AND pid <> 0 AND proc_start IS NOT NULL LIMIT 1`,
        sessionId,
        sinceNs,
        afterEventId,
        afterEventId,
      ) !== undefined
    );
  }

  latestEventIdOfSession(sessionId: string): number | null {
    const row = this.#get('SELECT MAX(id) AS id FROM events WHERE session_id = ?', sessionId);
    return row === undefined ? null : optInt(row, 'id');
  }

  links(): LinkRow[] {
    return this.#all('SELECT * FROM links ORDER BY time_ns, event_id').map(mapLink);
  }

  meta(sessionId: string): SessionMeta | null {
    const row = this.#get('SELECT * FROM session_meta WHERE session_id = ?', sessionId);
    return row === undefined ? null : mapMeta(row);
  }

  allMeta(): SessionMeta[] {
    return this.#all('SELECT * FROM session_meta ORDER BY session_id').map(mapMeta);
  }

  updateMeta(sessionId: string, patch: MetaPatch, nowNs: Ns): SessionMeta {
    // Only the fields the patch names are written; undefined counts as absent.
    const columns: [column: string, value: string | Ns | null][] = [];
    if (patch.label !== undefined) {
      columns.push(['label', patch.label]);
    }
    if (patch.group !== undefined) {
      columns.push(['group_name', patch.group]);
    }
    if (patch.note !== undefined) {
      columns.push(['note', patch.note]);
    }
    if (patch.doneAtNs !== undefined) {
      columns.push(['done_at_ns', patch.doneAtNs]);
    }
    if (patch.ticket !== undefined) {
      columns.push(['ticket_url', patch.ticket]);
    }
    const names = columns.map(([name]) => name);
    this.#run(
      `INSERT INTO session_meta (session_id, created_ns, updated_ns${names.map((n) => `, ${n}`).join('')})
       VALUES (?, ?, ?${', ?'.repeat(columns.length)})
       ON CONFLICT (session_id) DO UPDATE SET
         updated_ns = excluded.updated_ns${names.map((n) => `, ${n} = excluded.${n}`).join('')}`,
      sessionId,
      nowNs,
      nowNs,
      ...columns.map(([, value]) => value),
    );
    const row = this.meta(sessionId);
    if (row === null) {
      throw new Error(`session_meta row of ${sessionId} is missing after the update`);
    }
    return row;
  }

  deleteMeta(sessionId: string): boolean {
    return this.#run('DELETE FROM session_meta WHERE session_id = ?', sessionId) > 0;
  }

  transcripts(): TranscriptRow[] {
    return this.#all('SELECT * FROM transcripts ORDER BY path').map(mapTranscript);
  }

  saveTranscript(row: TranscriptRow): void {
    this.#run(
      `INSERT OR REPLACE INTO transcripts
         (path, session_id, size_read, file_size, mtime_ns, first_cwd, entrypoint, ai_title,
          custom_title, first_record_ns, last_record_ns, last_user_ns, last_turn_role,
          missing_since_ns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.path,
      row.sessionId,
      int(row.sizeRead),
      int(row.fileSize),
      row.mtimeNs,
      row.firstCwd,
      row.entrypoint,
      row.aiTitle,
      row.customTitle,
      row.firstRecordNs,
      row.lastRecordNs,
      row.lastUserNs,
      row.lastTurnRole,
      row.missingSinceNs,
    );
  }

  ensurePr(key: { url: string; owner: string; repo: string; number: number }): void {
    this.#run(
      `INSERT INTO prs (url, owner, repo, number) VALUES (?, ?, ?, ?)
       ON CONFLICT (url) DO NOTHING`,
      key.url,
      key.owner,
      key.repo,
      int(key.number),
    );
  }

  prs(): PrRow[] {
    return this.#all('SELECT * FROM prs ORDER BY url').map(mapPr);
  }

  savePrResult(url: string, result: PrFetchResult): void {
    if (result.ok) {
      this.#run(
        `UPDATE prs SET title = ?, state = ?, review = ?, checks = ?,
                        ok_at_ns = ?, tried_at_ns = ?, error = NULL
         WHERE url = ?`,
        result.title,
        result.state,
        result.review,
        result.checks,
        result.atNs,
        result.atNs,
        url,
      );
    } else {
      this.#run(
        'UPDATE prs SET tried_at_ns = ?, error = ? WHERE url = ?',
        result.atNs,
        result.error,
        url,
      );
    }
  }

  attachPr(sessionId: string, url: string, origin: PrOrigin, nowNs: Ns): void {
    // The conflict target names the one conflict that is expected (an existing pair), so any other
    // violation is still an error: a missing prs row fails the foreign key, and a NULL is refused
    // where OR IGNORE would skip the row silently.
    const conflict =
      origin === 'manual' ? "DO UPDATE SET origin = 'manual', detached_at_ns = NULL" : 'DO NOTHING';
    this.#run(
      `INSERT INTO session_prs (session_id, url, origin, first_seen_ns, detached_at_ns)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (session_id, url) ${conflict}`,
      sessionId,
      url,
      origin,
      nowNs,
    );
  }

  detachPr(sessionId: string, url: string, nowNs: Ns): boolean {
    return (
      this.#run(
        `UPDATE session_prs SET detached_at_ns = ?
         WHERE session_id = ? AND url = ? AND detached_at_ns IS NULL`,
        nowNs,
        sessionId,
        url,
      ) > 0
    );
  }

  sessionPrs(): SessionPrRow[] {
    return this.#all('SELECT * FROM session_prs ORDER BY first_seen_ns, session_id, url').map(
      mapSessionPr,
    );
  }

  ticketStatuses(): TicketStatusRow[] {
    return this.#all('SELECT * FROM ticket_status ORDER BY url').map(mapTicketStatus);
  }

  saveTicketStatus(url: string, result: TicketStatusResult): void {
    if (result.ok) {
      this.#run(
        `INSERT INTO ticket_status (url, status, category, ok_at_ns, tried_at_ns, error)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (url) DO UPDATE SET status = excluded.status, category = excluded.category,
           ok_at_ns = excluded.ok_at_ns, tried_at_ns = excluded.tried_at_ns, error = NULL`,
        url,
        result.status,
        result.category,
        result.atNs,
        result.atNs,
      );
    } else {
      this.#run(
        `INSERT INTO ticket_status (url, tried_at_ns, error) VALUES (?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET tried_at_ns = excluded.tried_at_ns, error = excluded.error`,
        url,
        result.atNs,
        result.error,
      );
    }
  }

  attention(): AttentionRow[] {
    return this.#all('SELECT * FROM attention ORDER BY session_id').map(mapAttention);
  }

  recordAttention(writes: readonly AttentionWrite[]): AttentionRow[] {
    for (const write of writes) {
      if (
        write.turnEndedNs === undefined &&
        write.windowEndNs === undefined &&
        write.seen !== true
      ) {
        throw new RangeError(`an attention write for ${write.sessionId} has no observation`);
      }
    }
    if (writes.length === 0) {
      return [];
    }
    return this.transaction(() => {
      // Inside the write lock, so that no other connection takes a value in between (B2).
      const stored = this.#get(
        `SELECT max(coalesce(max(turn_ended_seq), 0), coalesce(max(seen_seq), 0),
                    coalesce(max(window_end_seq), 0)) AS top
         FROM attention`,
      );
      let seq = Math.max(
        counterValue(this.getKv('attention_seq')),
        stored === undefined ? 0 : reqInt(stored, 'top'),
      );
      const next = (): bigint => {
        if (seq >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError('the attention counter is at 2^53 - 1 and cannot go on');
        }
        seq += 1;
        return int(seq);
      };
      for (const write of writes) {
        // B3's order: turn end, window end, seen.
        const columns: [column: string, value: bigint][] = [];
        if (write.turnEndedNs !== undefined) {
          columns.push(['turn_ended_seq', next()], ['turn_ended_ns', write.turnEndedNs]);
        }
        if (write.windowEndNs !== undefined) {
          columns.push(['window_end_seq', next()], ['window_end_ns', write.windowEndNs]);
        }
        if (write.seen === true) {
          columns.push(['seen_seq', next()]);
        }
        const names = columns.map(([name]) => name);
        this.#run(
          `INSERT INTO attention (session_id${names.map((n) => `, ${n}`).join('')})
           VALUES (?${', ?'.repeat(columns.length)})
           ON CONFLICT (session_id) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(', ')}`,
          write.sessionId,
          ...columns.map(([, value]) => value),
        );
      }
      this.setKv('attention_seq', String(seq));
      return this.#all(
        `SELECT * FROM attention WHERE session_id IN (SELECT value FROM json_each(?))
         ORDER BY session_id`,
        JSON.stringify(writes.map((write) => write.sessionId)),
      ).map(mapAttention);
    });
  }

  getKv(key: KvKey): string | null {
    const row = this.#get('SELECT value FROM kv WHERE key = ?', key);
    return row === undefined ? null : reqStr(row, 'value');
  }

  setKv(key: KvKey, value: string): void {
    this.#run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
  }

  deleteKv(key: KvKey): void {
    this.#run('DELETE FROM kv WHERE key = ?', key);
  }

  kvEntries(prefix: string): { key: KvKey; value: string }[] {
    // substr, not LIKE: in LIKE `_` and `%` are wildcards and ASCII letters match in any case.
    return this.#all(
      'SELECT key, value FROM kv WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key',
      prefix,
    ).map((row) => ({ key: reqStr(row, 'key') as KvKey, value: reqStr(row, 'value') }));
  }

  addToKv(key: KvKey, delta: number): void {
    const amount = int(delta);
    this.#run(
      `INSERT INTO kv (key, value) VALUES (?, CAST(? AS TEXT))
       ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
      key,
      amount,
      amount,
    );
  }
}
