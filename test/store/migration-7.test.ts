// Migration 7 on a database in real use (the mark unread; S2 10.2, 12.4): a database as #207
// leaves it — schema 6, built from versions 2 to 6's own schema text, with sessions, events (one
// with an uptime), labels, a done time, a parking, pull requests, attention, a ticket and its status
// in it — migrates to schema 7 with every value kept: attention gains the two nullable columns
// `unread_seq` and `unread_ns`, NULL in every row, and nothing else changes but kv schema_version.
// The copy kept before it (F21) holds schema 6. A new database is made at 7 with no copy, a
// migration that fails half way leaves schema 6, and an older skydeck refuses the migrated
// database.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { Ns } from '../../src/platform/types.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import { T0, testPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { SCHEMA1, dumpDatabase, schemaDatabase, withUnreadColumns } from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

const TICKET = 'https://tickets.example.com/browse/ABC-12';
/** T0 (2026-11-12T09:00:00Z) as a copy's name writes it. */
const STAMP = '20261112T090000Z';
/** A mark's time, with nanoseconds that a number could not hold. */
const UNREAD_AT = SCHEMA1.t0 + 1_000_000_000_123n;

function clockAt(ns: Ns): { nowNs(): Ns } {
  return { nowNs: () => ns };
}

/**
 * A database at `path` as schema 6 leaves it: schemaDatabase's (migrations 2 to 6's own SQL, each
 * pinned to S2 10.2) with two attention rows (one seen after its turn end, one with a window end),
 * the counter, a ticket on S1 and its status, a parking of S2 and an event with an uptime besides,
 * written with node:sqlite directly (openStore would migrate it to the newest schema).
 */
function schema6Database(path: string): void {
  schemaDatabase(path, 6);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO attention (session_id, turn_ended_seq, turn_ended_ns, seen_seq) VALUES (?, ?, ?, ?)`,
    ).run(SCHEMA1.s2, 3n, SCHEMA1.t0 + 905_000_000_000n, 4n);
    db.prepare(
      `INSERT INTO attention (session_id, window_end_seq, window_end_ns) VALUES (?, ?, ?)`,
    ).run(SCHEMA1.s1, 2n, SCHEMA1.t0 + 801_000_000_007n);
    db.prepare("INSERT INTO kv (key, value) VALUES ('attention_seq', '4')").run();
    db.prepare('UPDATE session_meta SET ticket_url = ? WHERE session_id = ?').run(
      TICKET,
      SCHEMA1.s1,
    );
    db.prepare(
      `INSERT INTO ticket_status (url, status, category, ok_at_ns, tried_at_ns, error)
       VALUES (?, 'In Progress', 'doing', 5, 5, NULL)`,
    ).run(TICKET);
    db.prepare('UPDATE session_meta SET parked_at_ns = ? WHERE session_id = ?').run(
      SCHEMA1.t0 + 800_000_000_000n,
      SCHEMA1.s2,
    );
    db.prepare(
      'UPDATE events SET uptime_cs = 11917407 WHERE id = (SELECT min(id) FROM events)',
    ).run();
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** A schema-6 database at `<sandbox>/data/skydeck.db`, in a folder of its own. */
function schema6(t: TestContext): { path: string; dir: string } {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, 'skydeck.db');
  schema6Database(path);
  return { path, dir };
}

function opened(t: TestContext, path: string): Store {
  const store = openStore(path, { clock: clockAt(T0) });
  t.after(() => {
    store.close();
  });
  return store;
}

/** The names in `dir` but the database and the two files SQLite keeps beside it, sorted. */
function beside(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !/^skydeck\.db(?:-wal|-shm)?$/.test(name))
    .sort();
}

function columnsOf(path: string, table: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all(table)
      .map((row) => String(row['name']));
  } finally {
    db.close();
  }
}

const isVersion = (row: Record<string, unknown>): boolean => row['key'] === 'schema_version';

/** The newest schema version, as kv holds it. */
const NEWEST = String(SCHEMA_VERSION);

/**
 * `after` is `before` (a schema-6 database) migrated to 7: sqlite_master is as it was but for
 * attention's statement, which ends in the two new columns; every row of every table is as it was,
 * but each row of attention gains `unread_seq` and `unread_ns` NULL and kv schema_version is the
 * newest.
 */
function assertMigrated(before: DatabaseDump, after: DatabaseDump): void {
  assert.deepEqual(
    after.schema,
    before.schema.map((entry) =>
      entry.type === 'table' && entry.name === 'attention'
        ? { ...entry, sql: withUnreadColumns(entry.sql) }
        : entry,
    ),
    'sqlite_master',
  );
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  for (const table of Object.keys(before.tables).filter(
    (name) => name !== 'kv' && name !== 'attention',
  )) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(
    after.tables['attention'],
    before.tables['attention']?.map((row) => ({ ...row, unread_seq: null, unread_ns: null })),
    'attention: every value kept, the new columns NULL',
  );
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !isVersion(row)),
    before.tables['kv']?.filter((row) => !isVersion(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(isVersion), [{ key: 'schema_version', value: '6' }]);
  assert.deepEqual(after.tables['kv']?.filter(isVersion), [
    { key: 'schema_version', value: NEWEST },
  ]);
}

test('migration 7 is two ALTER TABLEs that add the nullable columns unread_seq and unread_ns to attention', () => {
  assert.ok(SCHEMA_VERSION >= 7);
  assert.equal(
    MIGRATIONS[6],
    `ALTER TABLE attention ADD COLUMN unread_seq INTEGER;  -- order of the latest time the user marked the session unread (12.4); NULL for none
ALTER TABLE attention ADD COLUMN unread_ns INTEGER;  -- its time, for display only; NULL for none`,
  );
});

test('the fixture is a schema-6 database with a row in every table, two attention rows and an uptime', (t) => {
  const { path } = schema6(t);
  const dump = dumpDatabase(path);

  assert.deepEqual(dump.tables['kv']?.filter(isVersion), [{ key: 'schema_version', value: '6' }]);
  for (const [table, rows] of Object.entries(dump.tables)) {
    assert.ok(rows.length > 0, table);
  }
  assert.equal(dump.tables['attention']?.length, 2);
  assert.ok(!columnsOf(path, 'attention').includes('unread_seq'));
  assert.ok(dump.tables['events']?.some((row) => row['uptime_cs'] === 11_917_407n));
});

test('openStore migrates a schema-6 database to 7: every value kept, the new columns NULL in every row, the copy kept holding schema 6', (t) => {
  const { path, dir } = schema6(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  const copy = `${path}.schema6-${STAMP}`;
  assert.deepEqual(store.migrated, { version: SCHEMA_VERSION, copy });
  assert.equal(store.getKv('schema_version'), NEWEST);
  assertMigrated(before, dumpDatabase(path));
  assert.deepEqual(beside(dir), [basename(copy)]);
  assert.deepEqual(dumpDatabase(copy), before, 'the copy is the schema-6 database as it was');
  assert.deepEqual(
    store.attention().map((row) => [row.sessionId, row.unreadSeq, row.unreadNs]),
    [
      [SCHEMA1.s1, null, null],
      [SCHEMA1.s2, null, null],
    ],
  );
  assert.equal(store.attention()[1]?.seenSeq, 4);
  assert.equal(store.meta(SCHEMA1.s1)?.ticket, TICKET);
  assert.equal(store.ticketStatuses()[0]?.status, 'In Progress');
  assert.equal(store.meta(SCHEMA1.s2)?.parkedAtNs, SCHEMA1.t0 + 800_000_000_000n);
});

test('after the migration a mark is written later than every stored value and read back; opening again changes nothing', (t) => {
  const { path, dir } = schema6(t);
  const store = opened(t, path);

  assert.deepEqual(
    store.recordAttention([{ sessionId: SCHEMA1.s2, unreadNs: UNREAD_AT }]).map((row) => ({
      seen: row.seenSeq,
      unread: row.unreadSeq,
      at: row.unreadNs,
    })),
    [{ seen: 4, unread: 5, at: UNREAD_AT }],
  );
  store.close();
  const migrated = dumpDatabase(path);
  const copies = beside(dir);

  const again = opened(t, path);

  assert.equal(again.migrated, null);
  assert.deepEqual(dumpDatabase(path), migrated);
  assert.deepEqual(beside(dir), copies, 'no second copy');
  assert.equal(again.attention().find((row) => row.sessionId === SCHEMA1.s2)?.unreadNs, UNREAD_AT);
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-6 database and its guarded connection writes a mark", (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema6Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  const [row] = deck.store.recordAttention([{ sessionId: SCHEMA1.s1, unreadNs: UNREAD_AT }]);
  assert.equal(row?.unreadSeq, 5);
  assert.equal(row?.windowEndSeq, 2);
});

test('a connection opened before the migration, as an old interactive list holds one, reads attention after it', (t) => {
  const { path } = schema6(t);
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  const seenOf = old.prepare('SELECT seen_seq FROM attention WHERE session_id = ?');

  const store = opened(t, path);
  store.recordAttention([{ sessionId: SCHEMA1.s2, unreadNs: UNREAD_AT }]);

  assert.equal(seenOf.get(SCHEMA1.s2)?.['seen_seq'], 4n);
});

test('a migration 7 that fails after its ALTER TABLEs leaves schema 6 and every value as they were, and no copy', (t) => {
  const { path, dir } = schema6(t);
  const db = new DatabaseSync(path);
  // The schema_version update fails, after both columns were added inside the same transaction.
  db.exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON kv WHEN NEW.key = 'schema_version'
           BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
  db.close();
  const before = dumpDatabase(path);

  assert.throws(() => openStore(path, { clock: clockAt(T0) }), /refused by the test/);

  assert.deepEqual(dumpDatabase(path), before);
  assert.ok(!columnsOf(path, 'attention').includes('unread_seq'));
  assert.ok(!columnsOf(path, 'attention').includes('unread_ns'));
  assert.deepEqual(beside(dir), [], 'the copy is removed again');
  const fix = new DatabaseSync(path);
  fix.exec('DROP TRIGGER refuse_version');
  fix.close();
  const unblocked = dumpDatabase(path);
  opened(t, path);
  assertMigrated(unblocked, dumpDatabase(path));
});

test('a new database is made at the newest schema, with the columns and no copy', (t) => {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir);
  const path = join(dir, 'skydeck.db');

  const store = opened(t, path);

  assert.equal(store.migrated, null);
  assert.equal(store.getKv('schema_version'), NEWEST);
  assert.deepEqual(columnsOf(path, 'attention').slice(-2), ['unread_seq', 'unread_ns']);
  assert.deepEqual(beside(dir), []);
  assert.equal(store.recordAttention([{ sessionId: SCHEMA1.s1, unreadNs: T0 }])[0]?.unreadNs, T0);
});

test('a database stamped one above the newest, as this one is for the code before migration 7, is refused ("written by a newer skydeck"), and nothing in it changes', (t) => {
  const { path, dir } = schema6(t);
  opened(t, path).close();
  const copies = beside(dir);
  // To the code of schema 6, a database at 7 is what one at SCHEMA_VERSION + 1 is to this code.
  const stamped = new DatabaseSync(path);
  stamped
    .prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'")
    .run(String(SCHEMA_VERSION + 1));
  stamped.close();
  const before = dumpDatabase(path);

  assert.throws(
    () => openStore(path, { clock: clockAt(T0) }),
    (error) => {
      assert.ok(error instanceof SkydeckError);
      assert.equal(error.exitCode, 1);
      assert.equal(
        error.message,
        `the database ${path} was written by a newer skydeck (schema version ${SCHEMA_VERSION + 1}, this one knows ${SCHEMA_VERSION}); update skydeck`,
      );
      return true;
    },
  );

  assert.deepEqual(dumpDatabase(path), before);
  assert.deepEqual(beside(dir), copies);
});
