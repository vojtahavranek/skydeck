// Migration 5 on a database in real use (follow-up F44; S2 10.2): a database as F19 leaves it —
// schema 4, built from versions 2 to 4's own schema text, with sessions, labels, groups, notes, a
// done time, pull requests, attention, a ticket and its status in it — migrates to schema 5 with
// every value kept: session_meta gains the one nullable column `parked_at_ns`, NULL in every row,
// and nothing else changes but kv schema_version. The copy kept before it (F21) holds schema 4. A
// new database is made at 5 with no copy, and an older skydeck refuses the migrated database.
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
import { T0 } from '../helpers/platform.ts';
import { testPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import {
  PARKED_COLUMN_SQL,
  SCHEMA1,
  dumpDatabase,
  schemaDatabase,
  withoutParkedColumn,
} from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

const TICKET = 'https://tickets.example.com/browse/ABC-12';
/** T0 (2026-11-12T09:00:00Z) as a copy's name writes it. */
const STAMP = '20261112T090000Z';
/** A parking's time, with nanoseconds that a number could not hold. */
const PARKED_AT = SCHEMA1.t0 + 1_000_000_000_123n;

function clockAt(ns: Ns): { nowNs(): Ns } {
  return { nowNs: () => ns };
}

/**
 * A database at `path` as schema 4 leaves it: schemaDatabase's (migrations 2 to 4's own SQL, each
 * pinned to S2 10.2) with an attention row, the counter `attention_seq`, a ticket on S1 and its
 * status besides, so that every table holds a row; written with node:sqlite directly (openStore
 * would migrate it to the newest schema).
 */
function schema4Database(path: string): void {
  schemaDatabase(path, 4);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO attention (session_id, turn_ended_seq, turn_ended_ns, seen_seq) VALUES (?, ?, ?, ?)`,
    ).run(SCHEMA1.s2, 3n, SCHEMA1.t0 + 905_000_000_000n, 2n);
    db.prepare("INSERT INTO kv (key, value) VALUES ('attention_seq', '3')").run();
    db.prepare('UPDATE session_meta SET ticket_url = ? WHERE session_id = ?').run(
      TICKET,
      SCHEMA1.s1,
    );
    db.prepare(
      `INSERT INTO ticket_status (url, status, category, ok_at_ns, tried_at_ns, error)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(TICKET, 'In Progress', 'doing', SCHEMA1.t0, SCHEMA1.t0);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** A schema-4 database at `<sandbox>/data/skydeck.db`, in a folder of its own. */
function schema4(t: TestContext): { path: string; dir: string } {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, 'skydeck.db');
  schema4Database(path);
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

/**
 * `after` is `before` (a schema-4 database) migrated to 5: sqlite_master is as it was but for
 * session_meta's statement, which ends in the new column; every row of every table is as it was,
 * but each row of session_meta gains `parked_at_ns` NULL and kv schema_version is '5'.
 */
function assertMigrated(before: DatabaseDump, after: DatabaseDump): void {
  assert.deepEqual(
    after.schema,
    before.schema.map((entry) =>
      entry.type === 'table' && entry.name === 'session_meta' && entry.sql !== null
        ? { ...entry, sql: entry.sql.replace(/\)$/, PARKED_COLUMN_SQL) }
        : entry,
    ),
    'sqlite_master: only session_meta gains the column',
  );
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  for (const table of Object.keys(before.tables).filter(
    (name) => name !== 'kv' && name !== 'session_meta',
  )) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(
    after.tables['session_meta'],
    before.tables['session_meta']?.map((row) => ({ ...row, parked_at_ns: null })),
    'session_meta: every value kept, the new column NULL',
  );
  assert.deepEqual(
    withoutParkedColumn(after).tables['session_meta'],
    before.tables['session_meta'],
  );
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !isVersion(row)),
    before.tables['kv']?.filter((row) => !isVersion(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(isVersion), [{ key: 'schema_version', value: '4' }]);
  assert.deepEqual(after.tables['kv']?.filter(isVersion), [{ key: 'schema_version', value: '5' }]);
}

test('migration 5 is one ALTER TABLE that adds the nullable column parked_at_ns to session_meta', () => {
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(
    MIGRATIONS[4],
    'ALTER TABLE session_meta ADD COLUMN parked_at_ns INTEGER;  -- F44: when the user parked the session; NULL for none',
  );
});

test('the fixture is a schema-4 database with a row in every table, a ticket and its status', (t) => {
  const { path } = schema4(t);
  const dump = dumpDatabase(path);

  assert.deepEqual(dump.tables['kv']?.filter(isVersion), [{ key: 'schema_version', value: '4' }]);
  for (const [table, rows] of Object.entries(dump.tables)) {
    assert.ok(rows.length > 0, table);
  }
  assert.ok(!columnsOf(path, 'session_meta').includes('parked_at_ns'));
  assert.ok(
    dump.tables['session_meta']?.some((row) => row['done_at_ns'] !== null),
    'a done time to keep',
  );
});

test('openStore migrates a schema-4 database to 5: every value kept, the new column NULL in every row, the copy kept holding schema 4', (t) => {
  const { path, dir } = schema4(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  const copy = `${path}.schema4-${STAMP}`;
  assert.deepEqual(store.migrated, { version: 5, copy });
  assert.equal(store.getKv('schema_version'), '5');
  assertMigrated(before, dumpDatabase(path));
  assert.deepEqual(beside(dir), [basename(copy)]);
  assert.deepEqual(dumpDatabase(copy), before, 'the copy is the schema-4 database as it was');
  const s1 = store.meta(SCHEMA1.s1);
  assert.equal(s1?.label, 'Přehled – the old plan ✓');
  assert.equal(s1?.group, 'ABC-12');
  assert.equal(s1?.note, 'first line\nsecond line');
  assert.equal(s1?.doneAtNs, SCHEMA1.t0 + 700_000_000_000n);
  assert.equal(s1?.ticket, TICKET);
  assert.equal(s1?.parkedAtNs, null);
  assert.ok(store.allMeta().every((row) => row.parkedAtNs === null));
  assert.equal(store.ticketStatuses()[0]?.status, 'In Progress');
  assert.equal(store.attention().length, 1);
  assert.equal(store.sessionPrs().length, 2);
});

test('after the migration a parking is written and read; opening again changes nothing', (t) => {
  const { path, dir } = schema4(t);
  const store = opened(t, path);
  store.updateMeta(SCHEMA1.s1, { parkedAtNs: PARKED_AT, doneAtNs: null }, PARKED_AT);
  store.close();
  const migrated = dumpDatabase(path);
  const copies = beside(dir);

  const again = opened(t, path);

  assert.equal(again.migrated, null);
  assert.deepEqual(dumpDatabase(path), migrated);
  assert.deepEqual(beside(dir), copies, 'no second copy');
  const s1 = again.meta(SCHEMA1.s1);
  assert.equal(s1?.parkedAtNs, PARKED_AT);
  assert.equal(s1?.doneAtNs, null);
  assert.equal(s1?.label, 'Přehled – the old plan ✓');
  assert.equal(s1?.ticket, TICKET);
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-4 database and its guarded connection writes a parking", (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema4Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  deck.store.updateMeta(SCHEMA1.s2, { parkedAtNs: PARKED_AT }, PARKED_AT);
  assert.equal(deck.store.meta(SCHEMA1.s2)?.parkedAtNs, PARKED_AT);
});

test('a connection opened before the migration, as an old interactive list holds one, writes and reads after it', (t) => {
  const { path } = schema4(t);
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  const metaOf = old.prepare('SELECT * FROM session_meta WHERE session_id = ?');
  const rename = old.prepare('UPDATE session_meta SET label = ? WHERE session_id = ?');
  assert.equal(metaOf.get(SCHEMA1.s1)?.['ticket_url'], TICKET);

  const store = opened(t, path);
  store.updateMeta(SCHEMA1.s1, { parkedAtNs: PARKED_AT }, PARKED_AT);

  rename.run('renamed by the old list', SCHEMA1.s1);
  assert.equal(metaOf.get(SCHEMA1.s1)?.['label'], 'renamed by the old list');
  assert.equal(store.meta(SCHEMA1.s1)?.label, 'renamed by the old list');
  assert.equal(store.meta(SCHEMA1.s1)?.parkedAtNs, PARKED_AT);
});

test('a migration 5 that fails after its ALTER TABLE leaves schema 4 and every value as they were, and no copy', (t) => {
  const { path, dir } = schema4(t);
  const db = new DatabaseSync(path);
  // The schema_version update fails, after the column was added inside the same transaction.
  db.exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON kv WHEN NEW.key = 'schema_version'
           BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
  db.close();
  const before = dumpDatabase(path);

  assert.throws(() => openStore(path, { clock: clockAt(T0) }), /refused by the test/);

  assert.deepEqual(dumpDatabase(path), before);
  assert.ok(!columnsOf(path, 'session_meta').includes('parked_at_ns'));
  assert.deepEqual(beside(dir), [], 'the copy is removed again');
  const fix = new DatabaseSync(path);
  fix.exec('DROP TRIGGER refuse_version');
  fix.close();
  const unblocked = dumpDatabase(path);
  opened(t, path);
  assertMigrated(unblocked, dumpDatabase(path));
});

test('a new database is made at schema 5, with the column and no copy', (t) => {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir);
  const path = join(dir, 'skydeck.db');

  const store = opened(t, path);

  assert.equal(store.migrated, null);
  assert.equal(store.getKv('schema_version'), '5');
  assert.ok(columnsOf(path, 'session_meta').includes('parked_at_ns'));
  assert.deepEqual(beside(dir), []);
  assert.equal(store.updateMeta(SCHEMA1.s1, { parkedAtNs: T0 }, T0).parkedAtNs, T0);
});

test('a database stamped 6 is refused ("written by a newer skydeck"), and nothing in it changes', (t) => {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir);
  const path = join(dir, 'skydeck.db');
  const store = openStore(path, { clock: clockAt(T0) });
  store.setKv('schema_version', '6');
  store.close();
  const before = dumpDatabase(path);

  assert.throws(
    () => openStore(path, { clock: clockAt(T0) }),
    (error) => {
      assert.ok(error instanceof SkydeckError);
      assert.equal(error.exitCode, 1);
      assert.equal(
        error.message,
        `the database ${path} was written by a newer skydeck (schema version 6, this one knows 5); update skydeck`,
      );
      return true;
    },
  );

  assert.deepEqual(dumpDatabase(path), before);
  assert.deepEqual(beside(dir), []);
});
