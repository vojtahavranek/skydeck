// Migration 2 on a database in real use (stage B's plan, section 1b; S2 10.2, 16.5): a database as
// step 1 and stage A leave it migrates to schema 2 with nothing of migration 1 changed, also at the
// server's own open, and a connection opened before the migration keeps working after it. Since
// follow-up F18 the same open goes on with migration 3 (test/store/migration-3.test.ts), which adds
// the column ticket_url to session_meta: what migration 1 made is otherwise unchanged.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { SkydeckError } from '../../src/platform/errors.ts';
import { openDeck } from '../../src/sessions/deck.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { isDatabaseFailure, openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import { testPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import {
  SCHEMA1,
  dumpDatabase,
  schema1Database,
  uncommittedWrite,
  withoutTicketStatus,
} from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

const MIGRATION_1_TABLES = [
  'events',
  'kv',
  'links',
  'prs',
  'session_meta',
  'session_prs',
  'transcripts',
];

/** What migration 2 adds to sqlite_master: its table, and the index of its primary key. */
const ATTENTION_ENTRIES = [
  { type: 'index', name: 'sqlite_autoindex_attention_1', sql: null },
  // SQLite keeps the statement's text without its closing semicolon.
  { type: 'table', name: 'attention', sql: MIGRATIONS[1]?.replace(/;$/, '') ?? null },
];

function isAttention(entry: { name: string }): boolean {
  return ATTENTION_ENTRIES.some((added) => added.name === entry.name);
}

/** The newest schema version, as kv holds it. */
const NEWEST = String(SCHEMA_VERSION);

/** Migration 3 (F18) adds the column ticket_url to session_meta: its entry and its rows after it. */
function withMigration3(dump: DatabaseDump): DatabaseDump {
  return {
    schema: dump.schema.map((entry) =>
      entry.type === 'table' && entry.name === 'session_meta' && entry.sql !== null
        ? { ...entry, sql: entry.sql.replace(/\n\)$/, '\n, ticket_url TEXT)') }
        : entry,
    ),
    tables: {
      ...dump.tables,
      session_meta: (dump.tables['session_meta'] ?? []).map((row) => ({
        ...row,
        ticket_url: null,
      })),
    },
  };
}

/** A schema-1 database at a path in the sandbox. */
function schema1(t: TestContext): string {
  const path = join(sandbox(t).root, 'skydeck.db');
  schema1Database(path);
  return path;
}

/** What `pathsIn` writes for `root/`: none of the characters a text is split at. */
const ROOT = '<root>/';

/**
 * Every path a value of the dump names, with `root/` written as ROOT: each part of a text, split
 * at white space, `:`, quotes, `,` and `=`, that starts with ROOT or with one `/` (an address's
 * `//host/…` is none). `root/` is replaced before the split, so that a space or a `:` in it
 * splits nothing.
 */
function pathsIn(dump: DatabaseDump, root: string): string[] {
  return Object.values(dump.tables)
    .flat()
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.replaceAll(`${root}/`, ROOT).split(/[\s:"',=]+/))
    .filter((part) => part.startsWith(ROOT) || (part.startsWith('/') && !part.startsWith('//')));
}

/** No value of the fixture names a path outside `root` (ruled on review 2: a MUST). */
function assertInside(dump: DatabaseDump, root: string): void {
  const paths = pathsIn(dump, root);
  // the events' and the transcript's working directories, the transcript, the settings backup,
  // the server's checkout, the runtime directory
  assert.ok(paths.length >= 9, String(paths.length));
  for (const path of paths) {
    assert.ok(path.startsWith(ROOT), path);
  }
}

function opened(t: TestContext, path: string, options?: { busyTimeoutMs?: number }): Store {
  const store = openStore(path, options);
  t.after(() => {
    store.close();
  });
  return store;
}

/**
 * `after` is `before` migrated: sqlite_master holds migration 1's entries unchanged (but
 * session_meta's, which migration 3 gives the column ticket_url) and migration 2's; every row of
 * every table of migration 1 is as it was (session_meta's with ticket_url NULL), but kv
 * schema_version, which is the newest; `attention` is empty.
 */
function assertMigrated(schema1Dump: DatabaseDump, newest: DatabaseDump): void {
  const before = withMigration3(schema1Dump);
  // F19: the open goes on with migration 4, which only adds the table ticket_status, empty.
  const after = withoutTicketStatus(newest);
  assert.deepEqual(
    after.schema.filter((entry) => !isAttention(entry)),
    before.schema,
    "migration 1's entries of sqlite_master",
  );
  assert.deepEqual(after.schema.filter(isAttention), ATTENTION_ENTRIES, "migration 2's entries");
  assert.deepEqual(Object.keys(after.tables).sort(), [...MIGRATION_1_TABLES, 'attention'].sort());
  for (const table of MIGRATION_1_TABLES.filter((name) => name !== 'kv')) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  const version = (row: Record<string, unknown>): boolean => row['key'] === 'schema_version';
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !version(row)),
    before.tables['kv']?.filter((row) => !version(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(version), [{ key: 'schema_version', value: '1' }]);
  assert.deepEqual(after.tables['kv']?.filter(version), [{ key: 'schema_version', value: NEWEST }]);
  assert.deepEqual(after.tables['attention'], []);
}

function journalMode(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
  } finally {
    db.close();
  }
}

test('schema1Database leaves a database as step 1 and stage A do: WAL, mode 600, schema 1, a row in every table', (t) => {
  const path = schema1(t);
  const dump = dumpDatabase(path);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(journalMode(path), 'wal');
  assert.deepEqual(
    dump.schema.filter((entry) => entry.type === 'table').map((entry) => entry.name),
    MIGRATION_1_TABLES,
  );
  for (const table of MIGRATION_1_TABLES) {
    assert.ok((dump.tables[table]?.length ?? 0) > 0, `a row in ${table}`);
  }
  assert.deepEqual(
    dump.tables['kv']?.map((row) => row['key']),
    [
      'doctor_probe',
      'dropped_scripted',
      'first_run_offered',
      'first_scan_done',
      `resume_lock:${SCHEMA1.s1}`,
      'scan_problems',
      'schema_version',
      'settings_backup',
      'settings_hash',
      'window_alarm',
      'window_launching',
      'window_runtime_dir',
      'window_secret',
      'window_server',
    ],
  );
  assert.deepEqual(
    [...new Set(dump.tables['events']?.map((row) => row['session_id']))],
    [SCHEMA1.s1, SCHEMA1.s2],
  );
  assert.deepEqual(
    dump.tables['session_prs']?.map((row) => [row['session_id'], row['detached_at_ns'] !== null]),
    [
      [SCHEMA1.s1, true],
      [SCHEMA1.s2, false],
    ],
    'attached to one session, detached from the other',
  );
  // Every path it stores lies under the database's directory, so that a command a later test runs
  // on it stays in the sandbox.
  assertInside(dump, dirname(path));
  const kv = (key: string): unknown =>
    dump.tables['kv']?.find((row) => row['key'] === key)?.['value'];
  assert.equal(
    String(kv('window_server')).split(':').slice(3).join(':'),
    join(dirname(path), 'checkout'),
  );
  assert.equal(kv('window_runtime_dir'), join(dirname(path), 'runtime'));
});

test('schema1Database refuses a path that is not absolute: its paths would not be in a sandbox', (t) => {
  // A relative path to a place in the sandbox, so that the database lands there, not in the
  // working directory, were the check ever removed.
  const inBox = join(sandbox(t).root, 'skydeck.db');
  const path = relative(process.cwd(), inBox);
  assert.equal(isAbsolute(path), false, path);
  assert.throws(() => schema1Database(path), {
    name: 'RangeError',
    message: /not an absolute path/,
  });
  assert.equal(existsSync(inBox), false);
});

test('schema1Database under a directory whose path holds a space and a `:`: every path is inside it', (t) => {
  const dir = join(sandbox(t).root, 'a b:c');
  mkdirSync(dir);
  const path = join(dir, 'skydeck.db');
  schema1Database(path);
  assertInside(dumpDatabase(path), dir);
});

test('openStore migrates a schema-1 database to 2 (and on to the newest): nothing of migration 1 changes, attention is empty', (t) => {
  const path = schema1(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  assert.equal(store.getKv('schema_version'), NEWEST);
  assertMigrated(before, dumpDatabase(path));
  assert.deepEqual(store.connectionSettings(), {
    journalMode: 'wal',
    synchronous: 2,
    busyTimeout: 5000,
    foreignKeys: 1,
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // The store reads what step 1 wrote.
  assert.equal(store.events().length, 4);
  assert.equal(store.meta(SCHEMA1.s1)?.label, 'Přehled – the old plan ✓');
  assert.equal(store.links()[0]?.toSession, SCHEMA1.s2);
  assert.equal(store.transcripts()[0]?.aiTitle, 'Plan the migration');
  assert.equal(store.prs()[0]?.checks, 'failing');
  assert.equal(store.sessionPrs().length, 2);
  assert.deepEqual(store.attention(), []);
});

test('opening a migrated database again changes nothing', (t) => {
  const path = schema1(t);
  opened(t, path).close();
  const migrated = dumpDatabase(path);

  const again = opened(t, path);
  const meanwhile = opened(t, path); // a second connection while the first is open

  assert.deepEqual(dumpDatabase(path), migrated);
  assert.equal(again.getKv('schema_version'), NEWEST);
  assert.equal(meanwhile.getKv('schema_version'), NEWEST);
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-1 database, and its guarded connection writes into it", (t) => {
  const { platform, places, sandbox: box } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema1Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);
  assertInside(before, box.root); // as tasks 52 and 54 build it: at the sandbox's places

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  assert.equal(deck.store.connectionSettings().busyTimeout, 250);
  deck.store.setKv('window_alarm', '1');
  assert.equal(deck.store.recordAttention([{ sessionId: SCHEMA1.s2, seen: true }]).length, 1);
  assert.equal(deck.store.getKv('attention_seq'), '1');
});

test('a connection opened before the migration, as an old interactive list holds one, writes and reads after it', (t) => {
  const path = schema1(t);
  // As step 1's store opens one (it is not guarded); its statements prepared before the migration.
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  old.exec('PRAGMA foreign_keys = ON');
  const insertEvent = old.prepare(
    `INSERT INTO events (spool_name, time_ns, kind, detail, raw_detail, session_id, boot_id, pid,
                         proc_start, cwd, argv, name, payload)
     VALUES ('later.ev', ?, 'end', 'exit', 'prompt_input_exit', ?, ?, 4242, 51234567, '/w', NULL,
             NULL, '{}')
     RETURNING id`,
  );
  const eventsOf = old.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY time_ns, id');
  assert.equal(eventsOf.all(SCHEMA1.s2).length, 2);

  const store = opened(t, path);
  assert.equal(store.getKv('schema_version'), NEWEST);

  const later = SCHEMA1.t0 + 3_600_000_000_000n;
  const [row] = insertEvent.all(later, SCHEMA1.s2, SCHEMA1.bootId);
  assert.equal(row?.['id'], 5n);
  old
    .prepare('UPDATE session_meta SET label = ? WHERE session_id = ?')
    .run('renamed by the old list', SCHEMA1.s2);
  assert.deepEqual(
    eventsOf.all(SCHEMA1.s2).map((event) => event['spool_name']),
    ['1762988600000000001-4242-c.ev', null, 'later.ev'],
  );

  const seen = store.events().find((event) => event.spoolName === 'later.ev');
  assert.equal(seen?.timeNs, later);
  assert.equal(seen?.sessionId, SCHEMA1.s2);
  assert.equal(store.meta(SCHEMA1.s2)?.label, 'renamed by the old list');
});

test('a migration waits for another connection that holds the write lock, and then migrates', async (t) => {
  const path = schema1(t);
  const before = dumpDatabase(path);
  // A command of step 1 in the middle of a write: the lock is held, schema_version stays '1'.
  const holder = new Worker(new URL('../fixtures/migrate-while-locked.ts', import.meta.url), {
    workerData: { path, version: 1, holdMs: 1000 },
  });
  await once(holder, 'message');
  const probe = new DatabaseSync(path);
  t.after(() => {
    probe.close();
  });
  probe.exec('PRAGMA busy_timeout = 0');
  assert.throws(() => probe.exec('BEGIN IMMEDIATE'), isDatabaseFailure, 'the lock is held');

  const store = opened(t, path);

  await once(holder, 'exit');
  assert.equal(store.getKv('schema_version'), NEWEST);
  assertMigrated(before, dumpDatabase(path));
});

test('two processes open a schema-1 database at once: the one that waited for the lock reads the version again, finds 2, runs no migration 2 again and goes on with migration 3', async (t) => {
  const path = schema1(t);
  // The other one in the middle of migration 2: its table made, the version set, not committed.
  const other = uncommittedWrite(
    path,
    `${MIGRATIONS[1]} UPDATE kv SET value = '2' WHERE key = 'schema_version';`,
    500,
  );
  await once(other, 'message');

  const store = opened(t, path); // reads 1, waits for the lock, reads 2 inside it

  await once(other, 'exit');
  assert.equal(store.getKv('schema_version'), NEWEST);
  assert.deepEqual(store.attention(), []);
  assert.equal(store.meta(SCHEMA1.s2)?.ticket, null, "migration 3's column is there");
  assert.deepEqual(
    dumpDatabase(path)
      .schema.filter(isAttention)
      .map((entry) => entry.name),
    ['sqlite_autoindex_attention_1', 'attention'],
  );
});

test("at the server's own open the migration waits the commands' 5 s, not the server's 250 ms", async (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema1Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);
  const holder = new Worker(new URL('../fixtures/migrate-while-locked.ts', import.meta.url), {
    workerData: { path: places.dbPath, version: 1, holdMs: 1000 },
  });
  await once(holder, 'message');

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  await once(holder, 'exit');
  assertMigrated(before, dumpDatabase(places.dbPath));
});

test('a migration that cannot have the write lock within the busy timeout fails with nothing changed; the next open migrates', (t) => {
  const path = schema1(t);
  const before = dumpDatabase(path);
  const holder = new DatabaseSync(path);
  holder.exec('BEGIN IMMEDIATE');

  assert.throws(
    () => openStore(path),
    (error: unknown) => {
      assert.ok(error instanceof SkydeckError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, `cannot open the database ${path}: database is locked`);
      return true;
    },
  );
  holder.exec('ROLLBACK');
  holder.close();

  assert.deepEqual(dumpDatabase(path), before);
  opened(t, path);
  assertMigrated(before, dumpDatabase(path));
});

test('a migration 2 that fails after its table is made leaves schema 1 and every row as they were', (t) => {
  const path = schema1(t);
  // The schema_version update of migration 2 fails, after its CREATE TABLE ran.
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON kv WHEN NEW.key = 'schema_version'
           BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
  db.close();
  const before = dumpDatabase(path);

  assert.throws(
    () => openStore(path),
    (error: unknown) =>
      error instanceof SkydeckError &&
      error.message === `cannot open the database ${path}: refused by the test`,
  );

  assert.deepEqual(dumpDatabase(path), before);
  const fix = new DatabaseSync(path);
  fix.exec('DROP TRIGGER refuse_version');
  fix.close();
  const unblocked = dumpDatabase(path);
  opened(t, path);
  assertMigrated(unblocked, dumpDatabase(path));
});
