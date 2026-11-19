// Migration 4 on a database in real use (follow-up F19, T5; S2 10.2): a database as F18 leaves it —
// schema 3, built from versions 2 and 3's own schema text, with sessions, labels, groups, notes, a
// done time, pull requests, attention and a ticket in it — migrates to schema 4 with every value
// kept: the one new table `ticket_status`, empty, and nothing else changes but kv schema_version.
// An older skydeck refuses the migrated database (store.test.ts: "written by a newer skydeck").
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
import {
  SCHEMA1,
  TICKET_STATUS_ENTRIES,
  dumpDatabase,
  isTicketStatusEntry,
  schema1Database,
} from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

const TICKET = 'https://tickets.example.com/browse/ABC-12';

/**
 * A database at `path` as schema 3 leaves it: schema1Database's rows, then migrations 2 and 3's own
 * SQL (MIGRATIONS[1] and [2], each pinned to S2 10.2), an attention row, the counter `attention_seq`,
 * a ticket on S1 and kv schema_version '3', in one transaction, written with node:sqlite directly
 * (openStore would migrate it to the newest schema).
 */
function schema3Database(path: string): void {
  schema1Database(path);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(MIGRATIONS[1] ?? '');
    db.exec(MIGRATIONS[2] ?? '');
    db.prepare(
      `INSERT INTO attention (session_id, turn_ended_seq, turn_ended_ns, seen_seq) VALUES (?, ?, ?, ?)`,
    ).run(SCHEMA1.s2, 3n, SCHEMA1.t0 + 905_000_000_000n, 2n);
    db.prepare("INSERT INTO kv (key, value) VALUES ('attention_seq', '3')").run();
    db.prepare('UPDATE session_meta SET ticket_url = ? WHERE session_id = ?').run(
      TICKET,
      SCHEMA1.s1,
    );
    db.prepare("UPDATE kv SET value = '3' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function schema3(t: TestContext): string {
  const path = join(sandbox(t).root, 'skydeck.db');
  schema3Database(path);
  return path;
}

function opened(t: TestContext, path: string): Store {
  const store = openStore(path);
  t.after(() => {
    store.close();
  });
  return store;
}

/**
 * `after` is `before` (a schema-3 database) migrated to 4: sqlite_master is as it was and holds
 * migration 4's table and its key's index besides; every row of every table is as it was, but kv
 * schema_version, which is '4'; `ticket_status` is empty.
 */
function assertMigrated(before: DatabaseDump, after: DatabaseDump): void {
  assert.deepEqual(
    after.schema.filter((entry) => !isTicketStatusEntry(entry)),
    before.schema,
    'sqlite_master as it was',
  );
  assert.deepEqual(after.schema.filter(isTicketStatusEntry), TICKET_STATUS_ENTRIES);
  assert.deepEqual(
    Object.keys(after.tables).sort(),
    [...Object.keys(before.tables), 'ticket_status'].sort(),
  );
  for (const table of Object.keys(before.tables).filter((name) => name !== 'kv')) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(after.tables['ticket_status'], []);
  const version = (row: Record<string, unknown>): boolean => row['key'] === 'schema_version';
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !version(row)),
    before.tables['kv']?.filter((row) => !version(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(version), [{ key: 'schema_version', value: '3' }]);
  assert.deepEqual(after.tables['kv']?.filter(version), [{ key: 'schema_version', value: '4' }]);
}

test('migration 4 creates the table ticket_status and nothing else', () => {
  assert.equal(SCHEMA_VERSION, 4);
  // Its text without the comments: one statement, a CREATE TABLE and no other (no index, no
  // ALTER, no data).
  const sql = (MIGRATIONS[3] ?? '').replaceAll(/--[^\n]*/g, '');
  assert.match(sql, /^CREATE TABLE ticket_status \(/);
  assert.equal(sql.match(/;/g)?.length, 1);
  assert.ok(sql.endsWith(');'));
  assert.doesNotMatch(sql, /\b(?:ALTER|INSERT|UPDATE|DELETE|DROP|INDEX)\b/);
});

test('the fixture is a schema-3 database with a row in every table and a ticket', (t) => {
  const dump = dumpDatabase(schema3(t));

  assert.deepEqual(
    dump.tables['kv']?.find((row) => row['key'] === 'schema_version'),
    { key: 'schema_version', value: '3' },
  );
  for (const [table, rows] of Object.entries(dump.tables)) {
    assert.ok(rows.length > 0, table);
  }
  assert.equal(
    dump.tables['session_meta']?.find((row) => row['session_id'] === SCHEMA1.s1)?.['ticket_url'],
    TICKET,
  );
  assert.equal(dump.tables['ticket_status'], undefined);
});

test('openStore migrates a schema-3 database to 4: every value kept, ticket_status is new and empty', (t) => {
  const path = schema3(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  assert.equal(store.getKv('schema_version'), '4');
  assertMigrated(before, dumpDatabase(path));
  const s1 = store.meta(SCHEMA1.s1);
  assert.equal(s1?.label, 'Přehled – the old plan ✓');
  assert.equal(s1?.group, 'ABC-12');
  assert.equal(s1?.note, 'first line\nsecond line');
  assert.equal(s1?.doneAtNs, SCHEMA1.t0 + 700_000_000_000n);
  assert.equal(s1?.ticket, TICKET);
  assert.equal(store.meta(SCHEMA1.s2)?.label, 'the new plan');
  assert.equal(store.prs()[0]?.checks, 'failing');
  assert.equal(store.sessionPrs().length, 2);
  assert.equal(store.attention().length, 1);
  assert.deepEqual(store.ticketStatuses(), []);
});

test('after the migration a status is written and read; opening again changes nothing', (t) => {
  const path = schema3(t);
  const store = opened(t, path);
  store.saveTicketStatus(TICKET, { ok: true, atNs: 1n, status: 'In Progress', category: 'doing' });
  store.close();
  const migrated = dumpDatabase(path);

  const again = opened(t, path);

  assert.deepEqual(dumpDatabase(path), migrated);
  assert.equal(again.getKv('schema_version'), '4');
  assert.deepEqual(again.ticketStatuses(), [
    {
      url: TICKET,
      status: 'In Progress',
      category: 'doing',
      okAtNs: 1n,
      triedAtNs: 1n,
      error: null,
    },
  ]);
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-3 database and its guarded connection writes a status", (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema3Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  deck.store.saveTicketStatus(TICKET, { ok: false, atNs: 2n, error: 'gh is not installed' });
  assert.equal(deck.store.ticketStatuses()[0]?.error, 'gh is not installed');
});

test('a connection opened before the migration, as an old interactive list holds one, writes and reads after it', (t) => {
  const path = schema3(t);
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  const metaOf = old.prepare('SELECT * FROM session_meta WHERE session_id = ?');
  const rename = old.prepare('UPDATE session_meta SET label = ? WHERE session_id = ?');
  assert.equal(metaOf.get(SCHEMA1.s1)?.['ticket_url'], TICKET);

  const store = opened(t, path);
  store.saveTicketStatus(TICKET, { ok: true, atNs: 1n, status: 'Done', category: 'done' });

  rename.run('renamed by the old list', SCHEMA1.s1);
  assert.equal(metaOf.get(SCHEMA1.s1)?.['label'], 'renamed by the old list');
  assert.equal(store.meta(SCHEMA1.s1)?.label, 'renamed by the old list');
  assert.equal(store.ticketStatuses()[0]?.status, 'Done');
});

test('a migration 4 that fails after its CREATE TABLE leaves schema 3 and every value as they were', (t) => {
  const path = schema3(t);
  const db = new DatabaseSync(path);
  // The schema_version update fails, after the table was made inside the same transaction.
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
