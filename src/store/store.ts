import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { SkydeckError } from '../platform/errors.ts';
import type { Ns } from '../platform/types.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import type {
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
  TranscriptRow,
} from './types.ts';

export interface Store {
  readonly path: string;
  /** Closes the connection; a second call does nothing. */
  close(): void;
  /** The connection's PRAGMA values (they are per connection, so tests and doctor read them here). */
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
  /** Whether a 'start' event for the session exists with time_ns >= sinceNs. */
  hasStartSince(sessionId: string, sinceNs: Ns): boolean;
  /** All links ordered by time_ns. */
  links(): LinkRow[];

  // session_meta (7.1)
  meta(sessionId: string): SessionMeta | null;
  allMeta(): SessionMeta[];
  /** Creates the row (created_ns = updated_ns = nowNs) when absent; applies the patch; returns the row. */
  updateMeta(sessionId: string, patch: MetaPatch, nowNs: Ns): SessionMeta;

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

  // kv
  getKv(key: KvKey): string | null;
  setKv(key: KvKey, value: string): void;
  deleteKv(key: KvKey): void;
  /** Treats a missing value as 0. */
  addToKv(key: KvKey, delta: number): void;
}

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

/** Runs the migrations the database lacks, each in one transaction with the kv update. */
function migrate(db: DatabaseSync, path: string): void {
  const tooNew = (version: number): SkydeckError =>
    new SkydeckError(
      `the database ${path} was written by a newer skydeck (schema version ${version}, this one knows ${SCHEMA_VERSION}); update skydeck`,
      1,
    );
  const found = schemaVersion(db, path);
  if (found > SCHEMA_VERSION) {
    throw tooNew(found);
  }
  // The version is read again inside the write lock: a second process may have migrated meanwhile.
  while (schemaVersion(db, path) < SCHEMA_VERSION) {
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
      db.exec(sql);
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(version + 1),
      );
    });
  }
}

/**
 * Opens (creating when absent) the database at `path`; the directory must exist. Sets
 * journal_mode=WAL, synchronous=FULL, busy_timeout=5000, foreign_keys=ON, chmods the file 0600,
 * runs the missing migrations. Throws SkydeckError (exit 1) when kv schema_version is newer than
 * SCHEMA_VERSION ("the database was written by a newer skydeck"). Any other failure to open it (a
 * file that is not a database, a lock held for more than the busy timeout, a missing directory,
 * a failed migration) is a SkydeckError (exit 1) naming the path: it is a fact of the machine,
 * not a bug in skydeck.
 */
export function openStore(path: string): Store {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readBigInts: true });
    // First, so the -wal and -shm files that SQLite creates later take the mode of this file.
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, path);
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
  return new SqliteStore(db, path);
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
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.path = path;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params);
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params);
  }

  #run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
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
    return inTransaction(this.#db, fn);
  }

  insertEvent(event: NewEvent): number | null {
    // Not #get: outside transaction() this INSERT commits when its statement is finished, and
    // .get() stops after the first row and ignores a failure of that commit (a full disk), so an
    // id would be returned for a row that was rolled back. .all() runs the statement to the end.
    const [row] = this.#all(
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

  hasStartSince(sessionId: string, sinceNs: Ns): boolean {
    return (
      this.#get(
        `SELECT 1 AS found FROM events
         WHERE session_id = ? AND kind = 'start' AND time_ns >= ? LIMIT 1`,
        sessionId,
        sinceNs,
      ) !== undefined
    );
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
