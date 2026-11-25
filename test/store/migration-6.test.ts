// Migration 6 on a database in real use (issue #207; S2 10.2): a database as F44 leaves it — schema
// 5, built from versions 2 to 5's own schema text, with sessions, events, labels, a done time, a
// parking, pull requests, attention, a ticket and its status in it — migrates to schema 6 with
// every value kept: events gain the one nullable column `uptime_cs`, NULL in every row, and nothing
// else changes but kv schema_version. An older skydeck refuses the migrated database (store.test.ts:
// "written by a newer skydeck").
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
  dumpDatabase,
  schemaDatabase,
  withUptimeColumn,
  withoutUnread,
} from '../helpers/schema1.ts';
import type { DatabaseDump } from '../helpers/schema1.ts';

const TICKET = 'https://tickets.example.com/browse/ABC-12';

/**
 * A database at `path` as schema 5 leaves it: schemaDatabase's (migrations 2 to 5's own SQL, each
 * pinned to S2 10.2) with an attention row, a ticket on S1, its status and a parking of S2
 * besides, written with node:sqlite directly (openStore would migrate it to the newest schema).
 */
function schema5Database(path: string): void {
  schemaDatabase(path, 5);
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
       VALUES (?, 'In Progress', 'doing', 5, 5, NULL)`,
    ).run(TICKET);
    db.prepare('UPDATE session_meta SET parked_at_ns = ? WHERE session_id = ?').run(
      SCHEMA1.t0 + 800_000_000_000n,
      SCHEMA1.s2,
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function schema5(t: TestContext): string {
  const path = join(sandbox(t).root, 'skydeck.db');
  schema5Database(path);
  return path;
}

function opened(t: TestContext, path: string): Store {
  const store = openStore(path);
  t.after(() => {
    store.close();
  });
  return store;
}

/** The newest schema version, as kv holds it. */
const NEWEST = String(SCHEMA_VERSION);

/**
 * `after` is `before` (a schema-5 database) migrated to 6: sqlite_master is as it was but for
 * events' statement, which ends in the new column; every row of every table is as it was, but each
 * row of events gains `uptime_cs` NULL and kv schema_version is the newest.
 */
function assertMigrated(before: DatabaseDump, newest: DatabaseDump): void {
  // An open goes on with migration 7, whose two nullable columns of attention are left out here.
  const after = withoutUnread(newest);
  assert.deepEqual(
    after.schema,
    before.schema.map((entry) =>
      entry.type === 'table' && entry.name === 'events'
        ? { ...entry, sql: withUptimeColumn(entry.sql) }
        : entry,
    ),
    'sqlite_master',
  );
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  for (const table of Object.keys(before.tables).filter(
    (name) => name !== 'kv' && name !== 'events',
  )) {
    assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(
    after.tables['events'],
    before.tables['events']?.map((row) => ({ ...row, uptime_cs: null })),
    'events: every value kept, the new column NULL',
  );
  const version = (row: Record<string, unknown>): boolean => row['key'] === 'schema_version';
  assert.deepEqual(
    after.tables['kv']?.filter((row) => !version(row)),
    before.tables['kv']?.filter((row) => !version(row)),
    'no kv entry changed but schema_version',
  );
  assert.deepEqual(before.tables['kv']?.filter(version), [{ key: 'schema_version', value: '5' }]);
  assert.deepEqual(after.tables['kv']?.filter(version), [{ key: 'schema_version', value: NEWEST }]);
}

test('migration 6 is one ALTER TABLE that adds the nullable column uptime_cs to events', () => {
  assert.ok(SCHEMA_VERSION >= 6);
  assert.equal(
    MIGRATIONS[5],
    "ALTER TABLE events ADD COLUMN uptime_cs INTEGER;  -- #207: /proc/uptime at the event in centiseconds, which orders one process's events; NULL for none",
  );
});

test('the fixture is a schema-5 database with a row in every table and a parking', (t) => {
  const dump = dumpDatabase(schema5(t));

  assert.deepEqual(
    dump.tables['kv']?.find((row) => row['key'] === 'schema_version'),
    { key: 'schema_version', value: '5' },
  );
  for (const [table, rows] of Object.entries(dump.tables)) {
    assert.ok(rows.length > 0, table);
  }
  assert.equal(dump.tables['events']?.length, 4);
  assert.equal(
    dump.tables['events']?.some((row) => 'uptime_cs' in row),
    false,
  );
});

test('openStore migrates a schema-5 database to 6: every value kept, every event without an uptime', (t) => {
  const path = schema5(t);
  const before = dumpDatabase(path);

  const store = opened(t, path);

  assert.equal(store.getKv('schema_version'), NEWEST);
  assertMigrated(before, dumpDatabase(path));
  const events = store.events();
  assert.equal(events.length, 4);
  assert.equal(
    events.some((event) => 'uptimeCs' in event),
    false,
    'an event without an uptime has no uptimeCs',
  );
  assert.equal(store.meta(SCHEMA1.s1)?.ticket, TICKET);
  assert.equal(store.ticketStatuses()[0]?.status, 'In Progress');
  assert.equal(store.attention().length, 1);
  assert.equal(store.meta(SCHEMA1.s2)?.parkedAtNs, SCHEMA1.t0 + 800_000_000_000n);
});

test('after the migration an event with an uptime is written and read back; opening again changes nothing', (t) => {
  const path = schema5(t);
  const store = opened(t, path);
  const id = store.insertEvent({
    spoolName: 'with-uptime.ev',
    timeNs: SCHEMA1.t0 + 990_000_000_000n,
    uptimeCs: 11_917_407n,
    kind: 'start',
    detail: 'startup',
    rawDetail: 'startup',
    sessionId: SCHEMA1.s2,
    bootId: 'boot-b',
    pid: 7,
    procStart: 70,
    cwd: '/w',
    argv: null,
    name: null,
    payload: null,
  });
  assert.ok(id !== null);
  assert.equal(store.events().find((event) => event.id === id)?.uptimeCs, 11_917_407n);
  store.close();
  const migrated = dumpDatabase(path);

  const again = opened(t, path);

  assert.deepEqual(dumpDatabase(path), migrated);
  assert.equal(again.getKv('schema_version'), NEWEST);
});

test("the server's own open (openDeck, guardSchema, 250 ms) migrates a schema-5 database and its guarded connection writes an event", (t) => {
  const { platform, places } = testPlatform(t);
  mkdirSync(places.dataDir, { recursive: true, mode: 0o700 });
  schema5Database(places.dbPath);
  const before = dumpDatabase(places.dbPath);

  const deck = openDeck(platform, { guardSchema: true, busyTimeoutMs: 250 });
  t.after(() => {
    deck.store.close();
  });

  assertMigrated(before, dumpDatabase(places.dbPath));
  const id = deck.store.insertEvent({
    spoolName: null,
    timeNs: SCHEMA1.t0 + 991_000_000_000n,
    uptimeCs: 5n,
    kind: 'observed',
    detail: '',
    rawDetail: null,
    sessionId: SCHEMA1.s1,
    bootId: 'boot-b',
    pid: 8,
    procStart: 80,
    cwd: null,
    argv: null,
    name: null,
    payload: null,
  });
  assert.equal(deck.store.events().find((event) => event.id === id)?.uptimeCs, 5n);
});

test('a connection opened before the migration, as an old interactive list holds one, writes an event and reads after it', (t) => {
  const path = schema5(t);
  const old = new DatabaseSync(path, { readBigInts: true });
  t.after(() => {
    old.close();
  });
  old.exec('PRAGMA busy_timeout = 5000');
  // The insert of schema 5, which names no uptime_cs.
  const insert = old.prepare(
    `INSERT INTO events (spool_name, time_ns, kind, detail, raw_detail, session_id, boot_id, pid,
                         proc_start, cwd, argv, name, payload)
     VALUES ('old.ev', 1, 'end', 'exit', 'prompt_input_exit', ?, 'boot-a', 9, 90, NULL, NULL, NULL, NULL)`,
  );

  const store = opened(t, path);
  insert.run(SCHEMA1.s1);

  const written = store.events().find((event) => event.spoolName === 'old.ev');
  assert.equal(written?.kind, 'end');
  assert.equal(written !== undefined && 'uptimeCs' in written, false);
  assert.equal(
    old.prepare("SELECT uptime_cs FROM events WHERE spool_name = 'old.ev'").get()?.['uptime_cs'],
    null,
  );
});

test('a migration 6 that fails after its ALTER TABLE leaves schema 5 and every value as they were', (t) => {
  const path = schema5(t);
  const db = new DatabaseSync(path);
  // The schema_version update fails, after the column was added inside the same transaction.
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
