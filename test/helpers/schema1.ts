// A database as step 1 and stage A leave one, for the tests of migration 2 (stage B's plan, task
// 50, section 1b): the user's store is in daily use when migration 2 reaches it, so its tests start
// from a database with data in it, never from one on the machine.
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import { MIGRATIONS } from '../../src/store/migrations.ts';

/** Two sessions (S1 was cleared into S2), on one boot; times above 2^53, as real ones are. */
export const SCHEMA1 = {
  s1: '11111111-1111-4111-8111-111111111111',
  s2: '22222222-2222-4222-8222-222222222222',
  bootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  t0: 1_762_988_000_000_000_000n,
  pr: 'https://github.com/o/r/pull/7',
  /** The event ids, in the order the fixture inserts them. */
  events: { s1Start: 1, s1End: 2, s2Start: 3, s2Observed: 4 },
} as const;

const SEC = 1_000_000_000n;

function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row));
}

/**
 * A database at `path` exactly as step 1 and stage A leave one: journal mode WAL, file mode 600,
 * MIGRATIONS[0] alone, kv schema_version '1', a row in every table of migration 1 — events of two
 * sessions, a link, session_meta with a label, a group, a note and a done time, a transcript, a
 * pull request attached to one session and detached from another — the kv entries `install`
 * leaves (settings_hash, settings_backup, first_run_offered) and stage A's (window_secret,
 * window_server, window_runtime_dir, window_alarm, window_launching, a resume lock,
 * first_scan_done), and step 1's other ones (dropped_scripted, doctor_probe, scan_problems).
 * Written with node:sqlite directly: openStore would migrate it.
 */
export function schema1Database(path: string): void {
  const { s1, s2, bootId, t0, pr } = SCHEMA1;
  const db = new DatabaseSync(path);
  try {
    // As openStore: the mode first, so that the -wal and -shm files SQLite creates take it.
    chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    const migration1 = MIGRATIONS[0];
    if (migration1 === undefined) {
      throw new Error('there is no migration 1');
    }
    db.exec(migration1);
    insert(db, 'kv', { key: 'schema_version', value: '1' });

    const event = {
      boot_id: bootId,
      pid: 4242,
      proc_start: 51_234_567,
      cwd: '/home/you/projects/app',
      name: null,
    };
    insert(db, 'events', {
      ...event,
      spool_name: '1762988000000000000-4242-a.ev',
      time_ns: t0,
      kind: 'start',
      detail: 'startup',
      raw_detail: 'startup',
      session_id: s1,
      argv: JSON.stringify(['claude', '--model', 'opus']),
      payload: JSON.stringify({ session_id: s1, source: 'startup' }),
    });
    insert(db, 'events', {
      ...event,
      spool_name: '1762988600000000000-4242-b.ev',
      time_ns: t0 + 600n * SEC,
      kind: 'end',
      detail: 'clear',
      raw_detail: 'clear',
      session_id: s1,
      argv: null,
      payload: JSON.stringify({ session_id: s1, reason: 'clear' }),
    });
    insert(db, 'events', {
      ...event,
      spool_name: '1762988600000000001-4242-c.ev',
      time_ns: t0 + 600n * SEC + 1n,
      kind: 'start',
      detail: 'clear',
      raw_detail: 'clear',
      session_id: s2,
      argv: JSON.stringify(['claude', '--model', 'opus']),
      payload: JSON.stringify({ session_id: s2, source: 'clear' }),
    });
    insert(db, 'events', {
      ...event,
      spool_name: null,
      time_ns: t0 + 900n * SEC,
      kind: 'observed',
      detail: '',
      raw_detail: null,
      session_id: s2,
      argv: JSON.stringify(['claude', '--model', 'opus']),
      payload: null,
    });
    insert(db, 'links', {
      event_id: SCHEMA1.events.s1End,
      from_session: s1,
      to_session: s2,
      kind: 'clear',
      time_ns: t0 + 600n * SEC,
    });
    insert(db, 'session_meta', {
      session_id: s1,
      label: 'Přehled – the old plan ✓',
      group_name: 'ABC-12',
      note: 'first line\nsecond line',
      done_at_ns: t0 + 700n * SEC,
      created_ns: t0 + 60n * SEC,
      updated_ns: t0 + 700n * SEC,
    });
    insert(db, 'session_meta', {
      session_id: s2,
      label: 'the new plan',
      group_name: null,
      note: null,
      done_at_ns: null,
      created_ns: t0 + 610n * SEC,
      updated_ns: t0 + 610n * SEC,
    });
    insert(db, 'transcripts', {
      path: `/home/you/.claude/projects/-home-you-projects-app/${s2}.jsonl`,
      session_id: s2,
      size_read: 48_211,
      file_size: 48_211,
      mtime_ns: t0 + 905n * SEC + 123_456_789n,
      first_cwd: '/home/you/projects/app',
      entrypoint: 'cli',
      ai_title: 'Plan the migration',
      custom_title: null,
      first_record_ns: t0 + 601n * SEC,
      last_record_ns: t0 + 905n * SEC,
      last_user_ns: t0 + 880n * SEC,
      last_turn_role: 'assistant',
      missing_since_ns: null,
    });
    insert(db, 'prs', {
      url: pr,
      owner: 'o',
      repo: 'r',
      number: 7,
      title: 'Add the thing',
      state: 'open',
      review: 'approved',
      checks: 'failing',
      ok_at_ns: t0 + 800n * SEC,
      tried_at_ns: t0 + 860n * SEC,
      error: 'gh: HTTP 502',
    });
    insert(db, 'session_prs', {
      session_id: s2,
      url: pr,
      origin: 'auto',
      first_seen_ns: t0 + 620n * SEC,
      detached_at_ns: null,
    });
    insert(db, 'session_prs', {
      session_id: s1,
      url: pr,
      origin: 'manual',
      first_seen_ns: t0 + 300n * SEC,
      detached_at_ns: t0 + 640n * SEC,
    });

    const kv: Record<string, string> = {
      // install
      settings_hash: 'f'.repeat(64),
      settings_backup: '/home/you/.claude/settings.json.skydeck-backup-1762987000',
      first_run_offered: '1',
      // stage A
      window_secret: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString(
        'base64url',
      ),
      window_server: `5150:61234567:${bootId}:/home/you/projects/mine/skydeck`,
      window_runtime_dir: '/run/user/1000/skydeck-0123456789abcdef',
      window_alarm: String(t0 + 500n * SEC),
      window_launching: `0123456789abcdef ${t0 + 100n * SEC} 5151 61234999 ${bootId}`,
      [`resume_lock:${s1}`]: `${t0 + 400n * SEC}:${SCHEMA1.events.s1Start}`,
      first_scan_done: '1',
      // step 1's other entries
      dropped_scripted: '3',
      doctor_probe: String(t0 + 200n * SEC),
      scan_problems: JSON.stringify(['a transcript folder could not be read: EACCES']),
    };
    for (const [key, value] of Object.entries(kv)) {
      insert(db, 'kv', { key, value });
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

export interface DatabaseDump {
  schema: { type: string; name: string; sql: string | null }[];
  tables: Record<string, Record<string, unknown>[]>;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * sqlite_master's entries (type, name, sql) and every table's rows in a fixed order: the entries
 * by type and name, a table's rows by every column in their order. Read through a read-only
 * connection of its own, integers as bigints, rows as plain objects.
 */
export function dumpDatabase(path: string): DatabaseDump {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    const schema = db
      .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
      .all()
      .map((row) => ({
        type: String(row['type']),
        name: String(row['name']),
        sql: row['sql'] === null ? null : String(row['sql']),
      }));
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const { name } of schema.filter((entry) => entry.type === 'table')) {
      const columns = db
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(name)
        .map((row) => quoted(String(row['name'])));
      tables[name] = db
        .prepare(`SELECT * FROM ${quoted(name)} ORDER BY ${columns.join(', ')}`)
        .all()
        .map((row) => ({ ...row }));
    }
    return { schema, tables };
  } finally {
    db.close();
  }
}
