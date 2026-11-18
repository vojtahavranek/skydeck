// Migration 3 on a database in real use (follow-up F18, K5; S2 10.2): a database as stage B and
// the follow-ups up to F17 leave it — schema 2, built from version 2's own schema text, with
// sessions, labels, groups, notes, a done time, pull requests and attention in it — migrates to
// schema 3 with every value kept: session_meta gains the one nullable column `ticket_url` and
// nothing else changes but kv schema_version.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { openDeck } from '../../src/sessions/deck.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import { testPlatform } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { SCHEMA1, dumpDatabase, schema1Database } from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

/** The attention row the fixture adds to its schema-2 database. */
const ATTENTION_ROW = {
  session_id: SCHEMA1.s2,
  turn_ended_seq: 3n,
  turn_ended_ns: SCHEMA1.t0 + 905_000_000_000n,
  seen_seq: 2n,
  window_end_seq: null,
  window_end_ns: null,
};

/**
 * A database at `path` as schema 2 leaves it: schema1Database's rows, then migration 2's own SQL
 * (MIGRATIONS[1], pinned to S2 10.2 character for character), an attention row, the counter
 * `attention_seq` and kv schema_version '2', in one transaction, written with node:sqlite directly
 * (openStore would migrate it to the newest schema).
 */
function schema2Database(path: string): void {
  schema1Database(path);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(MIGRATIONS[1] ?? '');
    db.prepare(
      `INSERT INTO attention (session_id, turn_ended_seq, turn_ended_ns, seen_seq, window_end_seq,
                              window_end_ns) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(...Object.values(ATTENTION_ROW));
    db.prepare("INSERT INTO kv (key, value) VALUES ('attention_seq', '3')").run();
    db.prepare("UPDATE kv SET value = '2' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function schema2(t: TestContext): string {
  const path = join(sandbox(t).root, 'skydeck.db');
  schema2Database(path);
  return path;
}

function opened(t: TestContext, path: string): Store {
  const store = openStore(path);
  t.after(() => {
    store.close();
  });
  return store;
}

/** session_meta's entry of sqlite_master as SQLite writes it after migration 3's ALTER TABLE. */
function withTicketColumn(sql: string | null): string | null {
  return sql === null ? null : sql.replace(/\n\)$/, '\n, ticket_url TEXT)');
}

/**
 * `after` is `before` (a schema-2 database) migrated to 3: sqlite_master is as it was but for
 * session_meta's statement, which ends in the new column; every row of every table is as it was,
 * but each row of session_meta gains `ticket_url` NULL and kv schema_version is '3'.
 */
function assertMigrated(before: DatabaseDump, after: DatabaseDump): void {
  assert.deepEqual(
    after.schema,
    before.schema.map((entry) =>
      entry.type === 'table' && entry.name === 'session_meta'
        ? { ...entry, sql: withTicketColumn(entry.sql) }
        : entry,
    ),
    'sqlite_master',
  );
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  for (const table of Object.keys(before.tables).filter(
    (name) => name !== 'kv' && name !== 'session_meta',
  )) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(
    after.tables['session_meta'],
    before.tables['session_meta']?.map((row) => ({ ...row, ticket_url: null })),
    'session_meta: every value kept, the new column NULL',
  );
  const version = (row: Record<string, unknown>): boolean => row['key'] === 'schema_version';
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !version(row)),
    before.tables['kv']?.filter((row) => !version(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(version), [{ key: 'schema_version', value: '2' }]);
  assert.deepEqual(after.tables['kv']?.filter(version), [{ key: 'schema_version', value: '3' }]);
}

test('migration 3 is one ALTER TABLE that adds the nullable column ticket_url to session_meta', () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(
    MIGRATIONS[2],
    'ALTER TABLE session_meta ADD COLUMN ticket_url TEXT;  -- F18: the ticket the user set, its address; NULL for none',
  );
});

test('the fixture is a schema-2 database with a row in every table', (t) => {
  const dump = dumpDatabase(schema2(t));

  assert.deepEqual(
    dump.tables['kv']?.find((row) => row['key'] === 'schema_version'),
    {
      key: 'schema_version',
      value: '2',
    },
  );
  for (const [table, rows] of Object.entries(dump.tables)) {
    assert.ok(rows.length > 0, table);
  }
  assert.deepEqual(dump.tables['attention'], [ATTENTION_ROW]);
  assert.ok(
    !(dump.schema.find((entry) => entry.name === 'session_meta')?.sql ?? '').includes('ticket'),
  );
});

test('openStore migrates a schema-2 database to 3: every value kept, session_meta gains ticket_url', (t) => {
  const path = schema2(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  assert.equal(store.getKv('schema_version'), '3');
  assertMigrated(before, dumpDatabase(path));
  // The store reads what was there, and no session has a ticket.
  const s1 = store.meta(SCHEMA1.s1);
  assert.equal(s1?.label, 'Přehled – the old plan ✓');
  assert.equal(s1?.group, 'ABC-12');
  assert.equal(s1?.note, 'first line\nsecond line');
  assert.equal(s1?.doneAtNs, SCHEMA1.t0 + 700_000_000_000n);
  assert.equal(s1?.ticket, null);
  assert.equal(store.meta(SCHEMA1.s2)?.label, 'the new plan');
  assert.deepEqual(
    store.allMeta().map((meta) => meta.ticket),
    [null, null],
  );
  assert.equal(store.prs()[0]?.checks, 'failing');
  assert.equal(store.sessionPrs().length, 2);
  assert.equal(store.attention().length, 1);
});

test('after the migration a ticket is written and read; the other fields of its row stay', (t) => {
  const path = schema2(t);
  const store = opened(t, path);

  const meta = store.updateMeta(SCHEMA1.s1, { ticket: 'https://example.com/browse/ABC-123' }, 1n);

  assert.equal(meta.ticket, 'https://example.com/browse/ABC-123');
  assert.equal(meta.label, 'Přehled – the old plan ✓');
  assert.equal(meta.note, 'first line\nsecond line');
  assert.equal(store.updateMeta(SCHEMA1.s1, { label: 'renamed' }, 2n).ticket, meta.ticket);
  assert.equal(store.updateMeta(SCHEMA1.s1, { ticket: null }, 3n).ticket, null);
  assert.equal(store.meta(SCHEMA1.s1)?.label, 'renamed');
});

test('opening a migrated database again changes nothing', (t) => {
  const path = schema2(t);
  opened(t, path).close();
  const migrated = dumpDatabase(path);

  const again = opened(t, path);

  assert.deepEqual(dumpDatabase(path), migrated);
  assert.equal(again.getKv('schema_version'), '3');
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-2 database and its guarded connection writes a ticket", (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema2Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  deck.store.updateMeta(SCHEMA1.s2, { ticket: 'https://example.com/browse/ABC-123' }, 1n);
  assert.equal(deck.store.meta(SCHEMA1.s2)?.ticket, 'https://example.com/browse/ABC-123');
});

test('a connection opened before the migration, as an old interactive list holds one, writes and reads after it', (t) => {
  const path = schema2(t);
  // As an older store opens one (not guarded), its statements prepared before the migration.
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  const metaOf = old.prepare('SELECT * FROM session_meta WHERE session_id = ?');
  const rename = old.prepare('UPDATE session_meta SET label = ? WHERE session_id = ?');
  assert.equal(metaOf.get(SCHEMA1.s2)?.['label'], 'the new plan');

  const store = opened(t, path);
  store.updateMeta(SCHEMA1.s2, { ticket: 'https://example.com/browse/ABC-123' }, 1n);

  rename.run('renamed by the old list', SCHEMA1.s2);
  const row = metaOf.get(SCHEMA1.s2);
  assert.equal(row?.['label'], 'renamed by the old list');
  assert.equal(row?.['ticket_url'], 'https://example.com/browse/ABC-123');
  assert.equal(store.meta(SCHEMA1.s2)?.label, 'renamed by the old list');
  assert.equal(store.meta(SCHEMA1.s2)?.ticket, 'https://example.com/browse/ABC-123');
});

test('a migration 3 that fails after its ALTER TABLE leaves schema 2 and every value as they were', (t) => {
  const path = schema2(t);
  // The schema_version update fails, after the column was added inside the same transaction.
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON kv WHEN NEW.key = 'schema_version'
           BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
  db.close();
  const before = dumpDatabase(path);

  assert.throws(() => openStore(path), /refused by the test/);

  assert.deepEqual(dumpDatabase(path), before);
  const fix = new DatabaseSync(path);
  fix.exec('DROP TRIGGER refuse_version');
  fix.close();
  const unblocked = dumpDatabase(path);
  opened(t, path);
  assertMigrated(unblocked, dumpDatabase(path));
});
