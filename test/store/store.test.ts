import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { SkydeckError } from '../../src/platform/errors.ts';
import { NS_PER_SECOND as SEC } from '../../src/platform/time.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import {
  StoreNewerError,
  isDatabaseFailure,
  openStore,
  prepareRead,
} from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import type {
  AttentionRow,
  AttentionWrite,
  EventRow,
  KvKey,
  NewEvent,
  PrFetchResult,
  SessionPrRow,
  TranscriptRow,
} from '../../src/store/types.ts';
import { sandbox } from '../helpers/sandbox.ts';
import { uncommittedWrite } from '../helpers/schema1.ts';

const T0 = 1_762_988_000_000_000_000n;
const BOOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const URL1 = 'https://github.com/o/r/pull/1';
const KEY1 = { url: URL1, owner: 'o', repo: 'r', number: 1 };

function ev(over: Partial<NewEvent> = {}): NewEvent {
  return {
    spoolName: 'a.ev',
    timeNs: T0,
    kind: 'start',
    detail: 'startup',
    rawDetail: 'startup',
    sessionId: S1,
    bootId: BOOT_A,
    pid: 4242,
    procStart: 51234567,
    cwd: '/w',
    argv: ['claude'],
    name: null,
    payload: '{}',
    ...over,
  };
}

function transcript(over: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    path: '/c/projects/p/11111111-1111-4111-8111-111111111111.jsonl',
    sessionId: S1,
    sizeRead: 1200,
    fileSize: 1300,
    mtimeNs: 1_762_988_000_123_456_789n,
    firstCwd: '/w',
    entrypoint: 'cli',
    aiTitle: 'ai',
    customTitle: 'custom',
    firstRecordNs: T0,
    lastRecordNs: T0 + 5n * SEC,
    lastUserNs: T0 + 4n * SEC,
    lastTurnRole: 'user',
    missingSinceNs: null,
    ...over,
  };
}

interface Opened {
  store: Store;
  path: string;
  /** Opens the same database again; every store opened here is closed when the test ends. */
  reopen: () => Store;
}

/** A store on a fresh database file in the sandbox. */
function fresh(t: TestContext): Opened {
  const path = join(sandbox(t).root, 'skydeck.db');
  const reopen = (): Store => {
    const store = openStore(path);
    t.after(() => {
      store.close();
    });
    return store;
  };
  return { store: reopen(), path, reopen };
}

/** Reads the database through a second connection that is not the store's. */
function rawRows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function sessionPr(store: Store, sessionId = S1, url = URL1): SessionPrRow | undefined {
  return store.sessionPrs().find((row) => row.sessionId === sessionId && row.url === url);
}

describe('migrations', () => {
  test('there are two migrations and the schema version is their count', () => {
    assert.equal(MIGRATIONS.length, 2);
    assert.equal(SCHEMA_VERSION, 2);
  });

  test('migration 1 is the SQL of design 9.2 character for character', () => {
    const design = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'design.md'), 'utf8');
    const match = /^Migration 1:\n\n```sql\n([\s\S]*?)\n```$/m.exec(design);
    assert.ok(match, 'design.md 9.2 has no "Migration 1" SQL block');
    assert.equal(MIGRATIONS[0], match[1]);
  });

  test('migration 2 is the SQL of design-step-2.md 10.2 character for character', () => {
    const design = readFileSync(
      join(import.meta.dirname, '..', '..', 'docs', 'design-step-2.md'),
      'utf8',
    );
    const match = /^\*\*Migration 2\*\* [^\n]*:\n\n```sql\n([\s\S]*?)\n```$/m.exec(design);
    assert.ok(match, 'design-step-2.md 10.2 has no "Migration 2" SQL block');
    assert.equal(MIGRATIONS[1], match[1]);
  });
});

describe('openStore', () => {
  test("busyTimeoutMs sets the connection's busy timeout (the server's 250 ms, ruled, task 23); the default stays 5000", (t) => {
    const { path } = fresh(t);
    const short = openStore(path, { busyTimeoutMs: 250 });
    t.after(() => {
      short.close();
    });
    assert.equal(short.connectionSettings().busyTimeout, 250);
    const plain = openStore(path);
    t.after(() => {
      plain.close();
    });
    assert.equal(plain.connectionSettings().busyTimeout, 5000);
  });

  test('busyTimeoutMs that is not a whole number 0 to 2^31 - 1 is a RangeError, and nothing is opened', (t) => {
    const { path } = fresh(t);
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 31]) {
      assert.throws(() => openStore(path, { busyTimeoutMs: bad }), RangeError, String(bad));
    }
  });

  test('a new database has the connection settings, mode 600, version 2 and every table', (t) => {
    const { store, path } = fresh(t);

    assert.equal(store.path, path);
    assert.deepEqual(store.connectionSettings(), {
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
      foreignKeys: 1,
    });
    assert.equal(mode(path), 0o600);
    assert.equal(store.getKv('schema_version'), '2');
    const tables = rawRows(
      path,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name);
    assert.deepEqual(tables, [
      'attention',
      'events',
      'kv',
      'links',
      'prs',
      'session_meta',
      'session_prs',
      'transcripts',
    ]);
  });

  test('dataVersion changes when another connection committed, not when this one did', (t) => {
    const { store, reopen } = fresh(t);
    const other = reopen();

    const first = store.dataVersion();
    store.setKv('first_scan_done', '1');
    const afterOwn = store.dataVersion();
    other.setKv('first_scan_done', '0');
    const afterOther = store.dataVersion();

    assert.equal(afterOwn, first, 'its own commit');
    assert.notEqual(afterOther, afterOwn, "another connection's commit");
    assert.equal(store.dataVersion(), afterOther, 'nothing since');
  });

  test('the write-ahead log files are as private as the database', (t) => {
    // SQLite gives -wal and -shm the mode the database file has when it creates them. Starting
    // from a file of mode 644 makes the test independent of the umask: were the file made 600
    // only after SQLite opened the log, the log would stay 644 even under umask 077.
    const path = join(sandbox(t).root, 'skydeck.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const store = openStore(path);
    t.after(() => {
      store.close();
    });

    store.insertEvent(ev());

    assert.equal(mode(`${path}-wal`), 0o600);
    assert.equal(mode(`${path}-shm`), 0o600);
  });

  test('a database file that exists with a looser mode is made 600', (t) => {
    const path = join(sandbox(t).root, 'skydeck.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);

    const store = openStore(path);
    t.after(() => {
      store.close();
    });

    assert.equal(mode(path), 0o600);
  });

  test('opening again runs no migration and keeps the data', (t) => {
    const { store, reopen } = fresh(t);
    store.insertEvent(ev());
    store.close();

    const second = reopen();

    assert.equal(second.getKv('schema_version'), '2');
    assert.equal(second.events().length, 1);
  });

  test('two connections open at once see each other', (t) => {
    const { store, reopen } = fresh(t);
    const second = reopen();

    store.insertEvent(ev());

    assert.equal(second.events().length, 1);
  });

  test('close twice does not throw', (t) => {
    const { store } = fresh(t);

    store.close();

    assert.doesNotThrow(() => {
      store.close();
    });
  });

  test('a database written by a newer skydeck is refused with exit code 1', (t) => {
    const { store, path, reopen } = fresh(t);
    store.setKv('schema_version', String(SCHEMA_VERSION + 1));
    store.close();

    assert.throws(reopen, (error) => {
      assert.ok(error instanceof SkydeckError);
      assert.equal(error.exitCode, 1);
      // The line docs/install.md quotes ("Updating").
      assert.equal(
        error.message,
        `the database ${path} was written by a newer skydeck (schema version ${SCHEMA_VERSION + 1}, this one knows ${SCHEMA_VERSION}); update skydeck`,
      );
      return true;
    });
  });

  const refusals: [what: string, version: string | null][] = [
    ['an empty text', ''],
    ['text that is not a whole number', 'abc'],
    ['a decimal with a fraction', '1.0'],
    ['a number with spaces', ' 1 '],
    ['a hexadecimal number', '0x1'],
    ['a negative number', '-1'],
    ['a number too large for a safe integer', '99999999999999999999'],
    ['no value at all', null],
  ];
  for (const [what, version] of refusals) {
    test(`a schema_version of ${what} is refused with exit code 1, and nothing is migrated`, (t) => {
      const { store, path, reopen } = fresh(t);
      store.insertEvent(ev());
      if (version === null) {
        store.deleteKv('schema_version');
      } else {
        store.setKv('schema_version', version);
      }
      store.close();

      assert.throws(reopen, (error) => {
        assert.ok(error instanceof SkydeckError);
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /schema version/);
        return true;
      });
      assert.equal(rawRows(path, 'SELECT count(*) AS n FROM events')[0]?.n, 1);
    });
  }

  test('a migration that fails part-way leaves nothing behind', (t) => {
    // Migration 1 creates `prs` after `events`, `session_meta`, `links` and `transcripts`; a
    // table of that name makes it fail there. All of its tables must go, as one transaction.
    const path = join(sandbox(t).root, 'skydeck.db');
    const other = new DatabaseSync(path);
    other.exec('CREATE TABLE prs (x)');
    other.close();

    assert.throws(() => openStore(path), /already exists/);

    const tables = rawRows(path, "SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.deepEqual(
      tables.map((row) => row.name),
      ['prs'],
    );
  });

  test('a file that is not a database is refused with exit code 1, naming the path', (t) => {
    const path = join(sandbox(t).root, 'skydeck.db');
    writeFileSync(path, 'this is plain text, not a SQLite database\n'.repeat(20));

    assert.throws(
      () => openStore(path),
      (error) => {
        assert.ok(error instanceof SkydeckError);
        assert.equal(error.exitCode, 1);
        assert.ok(error.message.includes(path), error.message);
        assert.match(error.message, /not a database/);
        assert.ok(error.cause instanceof Error, 'the SQLite error is kept as the cause');
        assert.match(error.cause.message, /not a database/);
        return true;
      },
    );
  });

  test('a database in a directory that does not exist is refused with exit code 1', (t) => {
    const path = join(sandbox(t).root, 'missing', 'skydeck.db');

    assert.throws(
      () => openStore(path),
      (error) => {
        assert.ok(error instanceof SkydeckError);
        assert.equal(error.exitCode, 1);
        assert.ok(error.message.includes(path), error.message);
        assert.ok(error.cause instanceof Error, 'the SQLite error is kept as the cause');
        assert.match(error.cause.message, /unable to open/);
        return true;
      },
    );
  });
});

describe('events', () => {
  test('insertEvent returns the new id, and null for a spool name that exists', (t) => {
    const { store } = fresh(t);

    assert.equal(store.insertEvent(ev()), 1);
    assert.equal(store.insertEvent(ev()), null);

    assert.deepEqual(store.events(), [{ id: 1, ...ev() }] satisfies EventRow[]);
  });

  test('an event with every nullable field null comes back with nulls', (t) => {
    const { store } = fresh(t);
    const bare = ev({
      spoolName: null,
      kind: 'observed',
      detail: '',
      rawDetail: null,
      pid: 0,
      procStart: null,
      cwd: null,
      argv: null,
      payload: null,
    });

    store.insertEvent(bare);

    assert.deepEqual(store.events(), [{ id: 1, ...bare }]);
  });

  test('argv keeps empty strings, spaces and non-ASCII text', (t) => {
    const { store } = fresh(t);
    const argv = ['claude', '', 'two words', '--name', 'ž\u{1F600}"\\'];

    store.insertEvent(ev({ argv }));

    assert.deepEqual(store.events()[0]?.argv, argv);
  });

  test('a time above 2^53 round-trips exactly', (t) => {
    const { store } = fresh(t);

    store.insertEvent(ev({ timeNs: 1_762_988_000_123_456_789n }));

    assert.equal(store.events()[0]?.timeNs, 1_762_988_000_123_456_789n);
  });

  test('insertEvent throws when the commit fails, instead of returning an id for a lost row', (t) => {
    // Outside transaction() the INSERT commits by itself, and a failed commit (here: the file
    // size limit is hit) must surface; it was once swallowed when the row was read with get().
    const sb = sandbox(t);
    const path = join(sb.root, 'skydeck.db');
    // The database is made here, outside the limit: only the insert is under test, not the
    // migration.
    openStore(path).close();
    const child = `
      const [storeUrl, path, payload] = process.argv.slice(1);
      const { openStore } = await import(storeUrl);
      const store = openStore(path);
      const event = { spoolName: 'a.ev', timeNs: 1n, kind: 'start', detail: 'startup',
        rawDetail: 'startup', sessionId: 's', bootId: 'b', pid: 1, procStart: 1, cwd: null,
        argv: null, name: null, payload: 'x'.repeat(Number(payload)) };
      try {
        console.log('returned ' + store.insertEvent(event));
      } catch (error) {
        console.log('threw: ' + error.message);
      }
    `;
    // `ulimit -f 150` is 75 to 150 KB; the payload is 400 KB. A child that ignores SIGXFSZ gets
    // EFBIG from the write instead of being killed.
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        'trap "" XFSZ; ulimit -f 150; exec "$@"',
        'sh',
        process.execPath,
        '--input-type=module',
        '-e',
        child,
        new URL('../../src/store/store.ts', import.meta.url).href,
        path,
        '400000',
      ],
      { env: sb.env(), encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'threw: disk I/O error');
    const store = openStore(path);
    t.after(() => {
      store.close();
    });
    assert.deepEqual(store.events(), []);
  });

  test('observed events (no spool name) can be inserted twice', (t) => {
    const { store } = fresh(t);
    const observed = ev({ spoolName: null, kind: 'observed', detail: '' });

    assert.equal(store.insertEvent(observed), 1);
    assert.equal(store.insertEvent(observed), 2);

    assert.equal(store.events().length, 2);
  });

  test('events() is ordered by time, then id', (t) => {
    const { store } = fresh(t);

    store.insertEvent(ev({ spoolName: 'a.ev', timeNs: T0 + 2n * SEC }));
    store.insertEvent(ev({ spoolName: 'b.ev', timeNs: T0 }));
    store.insertEvent(ev({ spoolName: 'c.ev', timeNs: T0 }));

    assert.deepEqual(
      store.events().map((row) => row.id),
      [2, 3, 1],
    );
  });

  test('a transaction that throws rolls back and rethrows', (t) => {
    const { store } = fresh(t);

    assert.throws(
      () =>
        store.transaction(() => {
          store.insertEvent(ev({ spoolName: 'x.ev' }));
          throw new Error('no');
        }),
      /^Error: no$/,
    );

    assert.deepEqual(store.events(), []);
  });

  test('a transaction that succeeds commits and returns the value of its function', (t) => {
    const { store } = fresh(t);

    const result = store.transaction(() => {
      store.insertEvent(ev({ spoolName: 'x.ev' }));
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(store.events().length, 1);
  });

  test('a store is usable again after a transaction rolled back', (t) => {
    const { store } = fresh(t);
    assert.throws(() =>
      store.transaction(() => {
        throw new Error('no');
      }),
    );

    assert.equal(
      store.transaction(() => store.insertEvent(ev())),
      1,
    );
  });
});

describe('latestEventOfProcess', () => {
  test('is the latest event of the process at or before the given time', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', timeNs: T0 }));
    store.insertEvent(ev({ spoolName: 'b.ev', timeNs: T0 + 2n * SEC }));

    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0 + SEC)?.spoolName, 'a.ev');
    assert.equal(
      store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0 + 3n * SEC)?.spoolName,
      'b.ev',
    );
  });

  test('the given time is inclusive, and nothing earlier gives null', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ timeNs: T0 }));

    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0)?.id, 1);
    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0 - 1n), null);
  });

  test('events at the same time are told apart by id', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev' }));
    store.insertEvent(ev({ spoolName: 'b.ev', kind: 'end', detail: 'exit' }));

    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0)?.spoolName, 'b.ev');
  });

  test('a null process start matches only rows whose proc_start is NULL', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', procStart: 51234567 }));

    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, null, T0 + SEC), null);

    store.insertEvent(ev({ spoolName: 'b.ev', procStart: null }));

    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, null, T0 + SEC)?.spoolName, 'b.ev');
    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234567, T0 + SEC)?.spoolName, 'a.ev');
  });

  test('another boot, pid or process start gives null', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev());

    assert.equal(store.latestEventOfProcess(BOOT_B, 4242, 51234567, T0 + SEC), null);
    assert.equal(store.latestEventOfProcess(BOOT_A, 4243, 51234567, T0 + SEC), null);
    assert.equal(store.latestEventOfProcess(BOOT_A, 4242, 51234568, T0 + SEC), null);
  });
});

describe('processHasLaunch', () => {
  test('is false while no event of the process has an argv, true once one has', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', kind: 'end', detail: 'exit', argv: null }));

    assert.equal(store.processHasLaunch(BOOT_A, 4242, 51234567), false);

    store.insertEvent(ev({ spoolName: 'b.ev', argv: ['claude'] }));

    assert.equal(store.processHasLaunch(BOOT_A, 4242, 51234567), true);
  });

  test('an argv of another process does not count', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', pid: 1, argv: ['claude'] }));
    store.insertEvent(ev({ spoolName: 'b.ev', procStart: 99, argv: ['claude'] }));
    store.insertEvent(ev({ spoolName: 'c.ev', bootId: BOOT_B, argv: ['claude'] }));

    assert.equal(store.processHasLaunch(BOOT_A, 4242, 51234567), false);
  });

  test('a null process start matches only rows whose proc_start is NULL', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', procStart: 51234567 }));

    assert.equal(store.processHasLaunch(BOOT_A, 4242, null), false);

    store.insertEvent(ev({ spoolName: 'b.ev', procStart: null }));

    assert.equal(store.processHasLaunch(BOOT_A, 4242, null), true);
  });
});

describe('hasProcessStartSince', () => {
  test('is true for a start at or after the given time only', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ timeNs: T0 }));

    assert.equal(store.hasProcessStartSince(S1, T0, null), true);
    assert.equal(store.hasProcessStartSince(S1, T0 + 1n, null), false);
  });

  test('an end event, an observed event or another session does not count', (t) => {
    const { store } = fresh(t);
    store.insertEvent(
      ev({ spoolName: 'a.ev', kind: 'end', detail: 'exit', timeNs: T0 + 5n * SEC, argv: null }),
    );
    store.insertEvent(ev({ spoolName: null, kind: 'observed', detail: '', timeNs: T0 + 6n * SEC }));
    store.insertEvent(ev({ spoolName: 'b.ev', sessionId: S2, timeNs: T0 + 7n * SEC }));

    assert.equal(store.hasProcessStartSince(S1, T0, null), false);
  });

  test('a start without a real process does not count: no pid, or no process start time', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'p0.ev', pid: 0, timeNs: T0 + SEC }));
    store.insertEvent(ev({ spoolName: 'ns.ev', procStart: null, timeNs: T0 + 2n * SEC }));
    store.insertEvent(ev({ spoolName: 'both.ev', pid: 0, procStart: null, timeNs: T0 + 3n * SEC }));

    assert.equal(store.hasProcessStartSince(S1, T0, null), false);

    store.insertEvent(ev({ spoolName: 'real.ev', timeNs: T0 + 4n * SEC }));
    assert.equal(store.hasProcessStartSince(S1, T0, null), true);
    assert.equal(store.hasProcessStartSince(S1, T0 + 5n * SEC, null), false);
  });

  test('a scripted or scripted-end event of a real process does not count: it is not a start', (t) => {
    const { store } = fresh(t);
    const before = store.insertEvent(ev({ spoolName: 'first.ev', timeNs: T0 - SEC }));
    assert.ok(before !== null);
    store.insertEvent(ev({ spoolName: 's.ev', kind: 'scripted', detail: '', timeNs: T0 + SEC }));
    store.insertEvent(
      ev({
        spoolName: 'e.ev',
        kind: 'scripted-end',
        detail: '',
        timeNs: T0 + 2n * SEC,
        argv: null,
      }),
    );

    assert.equal(store.hasProcessStartSince(S1, T0, null), false);
    assert.equal(store.hasProcessStartSince(S1, T0, before), false);
    assert.equal(store.latestEventIdOfSession(S1), before + 2); // they count as the latest event
  });

  test('counts only a start whose id is greater than the given one; null: any id', (t) => {
    const { store } = fresh(t);
    // Dated ten minutes ahead (the clock stepped back since), and stored first.
    const ahead = store.insertEvent(ev({ spoolName: 'ahead.ev', timeNs: T0 + 600n * SEC }));
    assert.ok(ahead !== null);

    assert.equal(store.hasProcessStartSince(S1, T0, ahead), false);
    assert.equal(store.hasProcessStartSince(S1, T0, ahead - 1), true);
    assert.equal(store.hasProcessStartSince(S1, T0, null), true);

    const next = store.insertEvent(ev({ spoolName: 'next.ev', timeNs: T0 + SEC }));
    assert.ok(next !== null && next > ahead);
    assert.equal(store.hasProcessStartSince(S1, T0, ahead), true);
    assert.equal(store.hasProcessStartSince(S1, T0 + 2n * SEC, ahead), false); // later than it
    assert.equal(store.hasProcessStartSince(S1, T0, next), false);
  });
});

describe('latestEventIdOfSession', () => {
  test('is null for a session without events', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ sessionId: S2 }));

    assert.equal(store.latestEventIdOfSession(S1), null);
  });

  test('is the highest id among the events of the session, whatever their times and kinds', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev', timeNs: T0 + 9n * SEC }));
    const later = store.insertEvent(
      ev({ spoolName: 'b.ev', kind: 'end', detail: 'exit', timeNs: T0, argv: null }),
    );
    store.insertEvent(ev({ spoolName: 'c.ev', sessionId: S2, timeNs: T0 + 20n * SEC }));

    assert.equal(store.latestEventIdOfSession(S1), later);
    const observed = store.insertEvent(
      ev({ spoolName: null, kind: 'observed', detail: '', timeNs: T0 - SEC }),
    );
    assert.equal(store.latestEventIdOfSession(S1), observed);
  });
});

describe('links', () => {
  test('a link comes back as it was inserted', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev());
    const link = { eventId: 1, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T0 } as const;

    store.insertLink(link);

    assert.deepEqual(store.links(), [link]);
  });

  test('links are ordered by time', (t) => {
    const { store } = fresh(t);
    store.insertEvent(ev({ spoolName: 'a.ev' }));
    store.insertEvent(ev({ spoolName: 'b.ev' }));

    store.insertLink({
      eventId: 1,
      fromSession: S1,
      toSession: S2,
      kind: 'fork',
      timeNs: T0 + SEC,
    });
    store.insertLink({ eventId: 2, fromSession: S2, toSession: S1, kind: 'switch', timeNs: T0 });

    assert.deepEqual(
      store.links().map((link) => link.eventId),
      [2, 1],
    );
  });

  test('a link whose event does not exist is refused', (t) => {
    const { store } = fresh(t);

    assert.throws(() => {
      store.insertLink({ eventId: 1, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T0 });
    }, /FOREIGN KEY/);
  });
});

describe('session_meta', () => {
  test('updateMeta creates the row, then changes only the fields in the patch', (t) => {
    const { store } = fresh(t);

    assert.deepEqual(store.updateMeta(S1, { label: 'x' }, T0), {
      sessionId: S1,
      label: 'x',
      group: null,
      note: null,
      doneAtNs: null,
      createdNs: T0,
      updatedNs: T0,
    });
    assert.deepEqual(store.updateMeta(S1, { group: 'G' }, T0 + SEC), {
      sessionId: S1,
      label: 'x',
      group: 'G',
      note: null,
      doneAtNs: null,
      createdNs: T0,
      updatedNs: T0 + SEC,
    });
  });

  test('a null field in the patch clears that field only', (t) => {
    const { store } = fresh(t);
    store.updateMeta(S1, { label: 'x', group: 'G', note: 'n', doneAtNs: T0 }, T0);

    const cleared = store.updateMeta(S1, { label: null }, T0 + SEC);

    assert.equal(cleared.label, null);
    assert.equal(cleared.group, 'G');
    assert.equal(cleared.note, 'n');
    assert.equal(cleared.doneAtNs, T0);
  });

  test('done is set and cleared through doneAtNs', (t) => {
    const { store } = fresh(t);

    assert.equal(
      store.updateMeta(S1, { doneAtNs: 1_762_988_000_123_456_789n }, T0).doneAtNs,
      1_762_988_000_123_456_789n,
    );
    assert.equal(store.updateMeta(S1, { doneAtNs: null }, T0 + SEC).doneAtNs, null);
  });

  test('a field that is undefined is left unchanged', (t) => {
    const { store } = fresh(t);
    store.updateMeta(S1, { label: 'x', note: 'n' }, T0);

    const row = store.updateMeta(S1, { label: undefined, note: 'm' }, T0 + SEC);

    assert.equal(row.label, 'x');
    assert.equal(row.note, 'm');
  });

  test('meta() is null for a session without a row, and allMeta() lists the rows', (t) => {
    const { store } = fresh(t);
    store.updateMeta(S1, { label: 'x' }, T0);

    assert.equal(store.meta(S2), null);
    assert.equal(store.meta(S1)?.label, 'x');
    assert.equal(store.allMeta().length, 1);
  });

  test('the group is stored in the column group_name', (t) => {
    const { store, path } = fresh(t);

    store.updateMeta(S1, { group: 'G' }, T0);

    assert.deepEqual(
      rawRows(path, 'SELECT group_name FROM session_meta').map((row) => row.group_name),
      ['G'],
    );
  });

  test('deleteMeta removes the row of that session only, and says whether there was one', (t) => {
    const { store } = fresh(t);
    store.updateMeta(S1, { label: 'x', group: 'G' }, T0);
    store.updateMeta(S2, { label: 'y' }, T0);

    assert.equal(store.deleteMeta(S1), true);
    assert.equal(store.meta(S1), null);
    assert.equal(store.meta(S2)?.label, 'y');
    assert.equal(store.deleteMeta(S1), false);
  });
});

describe('transcripts', () => {
  test('a saved transcript comes back equal, with its role in last_turn_role', (t) => {
    const { store, path } = fresh(t);
    const row = transcript();

    store.saveTranscript(row);

    assert.deepEqual(store.transcripts(), [row]);
    assert.deepEqual(
      rawRows(path, 'SELECT last_turn_role FROM transcripts').map((r) => r.last_turn_role),
      ['user'],
    );
  });

  test('saving the same path again replaces the row', (t) => {
    const { store } = fresh(t);
    store.saveTranscript(transcript());
    const changed = transcript({ sizeRead: 1300, lastTurnRole: 'assistant', missingSinceNs: T0 });

    store.saveTranscript(changed);

    assert.deepEqual(store.transcripts(), [changed]);
  });

  test('every nullable field round-trips as null', (t) => {
    const { store } = fresh(t);
    const row = transcript({
      firstCwd: null,
      entrypoint: null,
      aiTitle: null,
      customTitle: null,
      firstRecordNs: null,
      lastRecordNs: null,
      lastUserNs: null,
      lastTurnRole: null,
      missingSinceNs: null,
    });

    store.saveTranscript(row);

    assert.deepEqual(store.transcripts(), [row]);
  });

  test('two paths of one session are two rows', (t) => {
    const { store } = fresh(t);

    store.saveTranscript(transcript({ path: '/a/s.jsonl' }));
    store.saveTranscript(transcript({ path: '/b/s.jsonl' }));

    assert.equal(store.transcripts().length, 2);
  });
});

describe('pull requests', () => {
  test('ensurePr twice leaves one row with every other column null', (t) => {
    const { store } = fresh(t);

    store.ensurePr(KEY1);
    store.ensurePr(KEY1);

    assert.deepEqual(store.prs(), [
      {
        ...KEY1,
        title: null,
        state: null,
        review: null,
        checks: null,
        okAtNs: null,
        triedAtNs: null,
        error: null,
      },
    ]);
  });

  test('ensurePr does not touch a row that has been fetched', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    store.savePrResult(URL1, {
      ok: true,
      atNs: T0,
      title: 't',
      state: 'open',
      review: null,
      checks: null,
    });

    store.ensurePr(KEY1);

    assert.equal(store.prs()[0]?.title, 't');
  });

  test('a success sets the fields, a failure keeps them and records the error, a success clears it', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    const ok: PrFetchResult = {
      ok: true,
      atNs: T0,
      title: 't',
      state: 'open',
      review: null,
      checks: 'pending',
    };

    store.savePrResult(URL1, ok);

    assert.deepEqual(store.prs()[0], {
      ...KEY1,
      title: 't',
      state: 'open',
      review: null,
      checks: 'pending',
      okAtNs: T0,
      triedAtNs: T0,
      error: null,
    });

    store.savePrResult(URL1, { ok: false, atNs: T0 + SEC, error: 'boom' });

    assert.deepEqual(store.prs()[0], {
      ...KEY1,
      title: 't',
      state: 'open',
      review: null,
      checks: 'pending',
      okAtNs: T0,
      triedAtNs: T0 + SEC,
      error: 'boom',
    });

    store.savePrResult(URL1, {
      ok: true,
      atNs: T0 + 2n * SEC,
      title: 'u',
      state: 'merged',
      review: 'approved',
      checks: 'passing',
    });

    assert.deepEqual(store.prs()[0], {
      ...KEY1,
      title: 'u',
      state: 'merged',
      review: 'approved',
      checks: 'passing',
      okAtNs: T0 + 2n * SEC,
      triedAtNs: T0 + 2n * SEC,
      error: null,
    });
  });

  test('a failure on a pull request never fetched leaves the fetched fields null', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);

    store.savePrResult(URL1, { ok: false, atNs: T0, error: 'boom' });

    const row = store.prs()[0];
    assert.equal(row?.state, null);
    assert.equal(row?.okAtNs, null);
    assert.equal(row?.triedAtNs, T0);
    assert.equal(row?.error, 'boom');
  });
});

describe('attachPr and detachPr', () => {
  test('an automatic attachment is recorded once and never changed by another one', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);

    store.attachPr(S1, URL1, 'auto', T0);
    store.attachPr(S1, URL1, 'auto', T0 + SEC);

    assert.deepEqual(store.sessionPrs(), [
      { sessionId: S1, url: URL1, origin: 'auto', firstSeenNs: T0, detachedAtNs: null },
    ]);
  });

  test('a detached automatic attachment stays detached when seen again', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    store.attachPr(S1, URL1, 'auto', T0);

    assert.equal(store.detachPr(S1, URL1, T0 + 2n * SEC), true);
    assert.equal(sessionPr(store)?.detachedAtNs, T0 + 2n * SEC);

    store.attachPr(S1, URL1, 'auto', T0 + 3n * SEC);

    assert.equal(sessionPr(store)?.detachedAtNs, T0 + 2n * SEC);
  });

  test('a manual attachment re-attaches, keeps first_seen and is not downgraded by an automatic one', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    store.attachPr(S1, URL1, 'auto', T0);
    store.detachPr(S1, URL1, T0 + 2n * SEC);

    store.attachPr(S1, URL1, 'manual', T0 + 4n * SEC);

    assert.deepEqual(sessionPr(store), {
      sessionId: S1,
      url: URL1,
      origin: 'manual',
      firstSeenNs: T0,
      detachedAtNs: null,
    });

    store.attachPr(S1, URL1, 'auto', T0 + 5n * SEC);

    assert.equal(sessionPr(store)?.origin, 'manual');
  });

  test('a manual attachment of a new pair starts at the given time', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);

    store.attachPr(S1, URL1, 'manual', T0 + SEC);

    assert.deepEqual(sessionPr(store), {
      sessionId: S1,
      url: URL1,
      origin: 'manual',
      firstSeenNs: T0 + SEC,
      detachedAtNs: null,
    });
  });

  test('one pull request attached to two sessions gives two rows, and detaching one leaves the other', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    store.attachPr(S1, URL1, 'auto', T0);
    store.attachPr(S2, URL1, 'auto', T0);

    store.detachPr(S1, URL1, T0 + SEC);

    assert.equal(store.sessionPrs().length, 2);
    assert.equal(sessionPr(store, S1)?.detachedAtNs, T0 + SEC);
    assert.equal(sessionPr(store, S2)?.detachedAtNs, null);
  });

  test('detachPr is false for a pair never attached and for one already detached', (t) => {
    const { store } = fresh(t);
    store.ensurePr(KEY1);
    store.attachPr(S1, URL1, 'auto', T0);

    assert.equal(store.detachPr(S2, URL1, T0 + SEC), false);

    assert.equal(store.detachPr(S1, URL1, T0 + 2n * SEC), true);
    assert.equal(store.detachPr(S1, URL1, T0 + 9n * SEC), false);
    assert.equal(sessionPr(store)?.detachedAtNs, T0 + 2n * SEC);
  });

  test('attaching a pull request that has no prs row is refused, automatic or manual', (t) => {
    const { store } = fresh(t);

    assert.throws(() => {
      store.attachPr(S1, URL1, 'auto', T0);
    }, /FOREIGN KEY/);
    assert.throws(() => {
      store.attachPr(S1, URL1, 'manual', T0);
    }, /FOREIGN KEY/);
    assert.deepEqual(store.sessionPrs(), []);
  });
});

describe('kv', () => {
  test('a key that was never set is null', (t) => {
    const { store } = fresh(t);

    assert.equal(store.getKv('doctor_probe'), null);
  });

  test('setKv sets and replaces a value', (t) => {
    const { store } = fresh(t);

    store.setKv('settings_hash', 'abc');
    store.setKv('settings_hash', 'def');

    assert.equal(store.getKv('settings_hash'), 'def');
  });

  test('addToKv treats a missing value as 0 and adds as whole numbers', (t) => {
    const { store } = fresh(t);

    store.addToKv('dropped_scripted', 2);
    store.addToKv('dropped_scripted', 2);

    assert.equal(store.getKv('dropped_scripted'), '4');

    store.addToKv('dropped_scripted', -1);

    assert.equal(store.getKv('dropped_scripted'), '3');
  });

  test('addToKv refuses a delta that is not a whole number', (t) => {
    const { store } = fresh(t);

    assert.throws(() => {
      store.addToKv('dropped_scripted', 1.5);
    }, RangeError);
    assert.equal(store.getKv('dropped_scripted'), null);
  });

  test('deleteKv removes the key, and a key that is absent is no error', (t) => {
    const { store } = fresh(t);
    store.setKv('doctor_probe', '1');

    store.deleteKv('doctor_probe');
    store.deleteKv('doctor_probe');

    assert.equal(store.getKv('doctor_probe'), null);
  });

  test('kvEntries gives the entries whose key starts with the prefix, ordered by key', (t) => {
    const { store } = fresh(t);
    store.setKv('resume_lock:b', '2');
    store.setKv('resume_lock:a', '1');
    store.setKv('settings_hash', 'x');

    assert.deepEqual(store.kvEntries('resume_lock:'), [
      { key: 'resume_lock:a', value: '1' },
      { key: 'resume_lock:b', value: '2' },
    ]);
    assert.deepEqual(store.kvEntries('nothing:'), []);
  });

  test('kvEntries reads the prefix literally: no LIKE wildcards, and case counts', (t) => {
    const { store } = fresh(t);
    // In LIKE, `_` matches any character and `%` any text, and ASCII letters match in any case.
    store.setKv('resume_lockXa' as KvKey, '1');
    store.setKv('RESUME_LOCK:b' as KvKey, '2');
    store.setKv('resume_lock:%', '3');

    assert.deepEqual(store.kvEntries('resume_lock:'), [{ key: 'resume_lock:%', value: '3' }]);
    assert.deepEqual(store.kvEntries('resume_lock:%'), [{ key: 'resume_lock:%', value: '3' }]);
    assert.deepEqual(store.kvEntries('resume_lock:%x'), []);
  });
});

describe('isDatabaseFailure', () => {
  test('a locked database is a failure of the database as a whole', (t) => {
    const s = sandbox(t);
    const path = join(s.root, 'locked.db');
    const store = openStore(path);
    t.after(() => {
      store.close();
    });
    const other = new DatabaseSync(path);
    t.after(() => {
      other.close();
    });
    other.exec('PRAGMA busy_timeout = 0');
    store.transaction(() => {
      assert.throws(
        () => other.exec('INSERT INTO kv (key, value) VALUES (1, 2)'),
        (error: unknown) => isDatabaseFailure(error),
      );
    });
  });

  test('busy, locked, read-only, I/O, corrupt, full, cannot open and not a database count; extended codes too', () => {
    const sqlite = (errcode: number) =>
      Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode });
    for (const errcode of [5, 6, 8, 10, 11, 13, 14, 26, 517, 1546]) {
      assert.equal(isDatabaseFailure(sqlite(errcode)), true, String(errcode));
    }
    for (const errcode of [1, 19, 20, 25, 2067]) {
      assert.equal(isDatabaseFailure(sqlite(errcode)), false, String(errcode));
    }
  });

  test('an error one row causes, or one that is not from SQLite, does not count', (t) => {
    const s = sandbox(t);
    const store = openStore(join(s.root, 'skydeck.db'));
    t.after(() => {
      store.close();
    });
    assert.throws(
      () => store.insertEvent(ev({ timeNs: 2n ** 64n })),
      (error: unknown) => !isDatabaseFailure(error),
    );
    assert.equal(isDatabaseFailure(Object.assign(new Error('x'), { errcode: 5 })), false);
    assert.equal(isDatabaseFailure(Object.assign(new Error('x'), { code: 'EACCES' })), false);
    assert.equal(isDatabaseFailure('database is locked'), false);
    assert.equal(isDatabaseFailure(null), false);
  });
});

describe('the schema guard of the server (S2 10.1)', () => {
  const REFUSAL = 'skydeck was updated; run skydeck window';

  function refused(error: unknown): boolean {
    return error instanceof StoreNewerError && error.message === REFUSAL;
  }

  /** Every row of every table, read through a connection that is not the store's. */
  function dump(path: string): Record<string, unknown[]> {
    const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
    try {
      const tables = [
        'events',
        'links',
        'session_meta',
        'transcripts',
        'prs',
        'session_prs',
        'kv',
        'attention',
      ];
      return Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
      );
    } finally {
      db.close();
    }
  }

  /** What another skydeck's migration does to the store: a newer schema version. */
  function makeNewer(path: string): void {
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION + 1),
      );
    } finally {
      db.close();
    }
  }

  /** A database with one row in every table, and a store on it opened with `options`. */
  function seeded(t: TestContext, options?: { guardSchema?: boolean }): Opened {
    const { path } = fresh(t);
    const seed = openStore(path);
    seed.insertEvent(ev());
    seed.insertLink({ eventId: 1, fromSession: S1, toSession: S2, kind: 'clear', timeNs: T0 });
    seed.updateMeta(S1, { label: 'old' }, T0);
    seed.saveTranscript(transcript());
    seed.ensurePr(KEY1);
    seed.attachPr(S1, URL1, 'auto', T0);
    seed.setKv('first_scan_done', '1');
    seed.close();
    const reopen = (): Store => {
      const store = openStore(path, options);
      t.after(() => {
        store.close();
      });
      return store;
    };
    return { store: reopen(), path, reopen };
  }

  /** Each write of the Store interface that is a single statement. */
  const WRITES: [name: string, write: (store: Store) => unknown][] = [
    ['setKv', (store) => store.setKv('window_secret', 'x')],
    ['deleteKv', (store) => store.deleteKv('first_scan_done')],
    ['addToKv', (store) => store.addToKv('dropped_scripted', 1)],
    ['insertEvent', (store) => store.insertEvent(ev({ spoolName: 'b.ev', sessionId: S2 }))],
    [
      'insertLink',
      (store) => {
        store.insertLink({ eventId: 2, fromSession: S2, toSession: S1, kind: 'fork', timeNs: T0 });
      },
    ],
    ['updateMeta', (store) => store.updateMeta(S1, { label: 'new' }, T0 + SEC)],
    ['deleteMeta', (store) => store.deleteMeta(S1)],
    ['saveTranscript', (store) => store.saveTranscript(transcript({ sizeRead: 1300 }))],
    [
      'ensurePr',
      (store) => store.ensurePr({ ...KEY1, url: 'https://github.com/o/r/pull/2', number: 2 }),
    ],
    [
      'savePrResult',
      (store) => store.savePrResult(URL1, { ok: false, atNs: T0, error: 'gh failed' }),
    ],
    ['attachPr', (store) => store.attachPr(S2, URL1, 'manual', T0)],
    ['detachPr', (store) => store.detachPr(S1, URL1, T0)],
  ];

  test('a guarded store refuses every write into a newer store and writes nothing; reads still work', (t) => {
    const { store, path } = seeded(t, { guardSchema: true });
    makeNewer(path);
    const before = dump(path);
    for (const [name, write] of WRITES) {
      assert.throws(() => write(store), refused, name);
      assert.deepEqual(dump(path), before, name);
    }
    let called = false;
    assert.throws(
      () =>
        store.transaction(() => {
          called = true;
          store.setKv('window_server', 'x');
        }),
      refused,
    );
    assert.equal(called, false);
    assert.deepEqual(dump(path), before);

    assert.equal(store.getKv('schema_version'), String(SCHEMA_VERSION + 1));
    assert.equal(store.meta(S1)?.label, 'old');
    assert.deepEqual(
      store.events().map((event) => event.spoolName),
      ['a.ev'],
    );
    assert.equal(store.latestEventIdOfSession(S1), 1);
    assert.equal(store.transcripts().length, 1);
    assert.equal(sessionPr(store)?.detachedAtNs, null);
    assert.deepEqual(store.kvEntries('first_'), [{ key: 'first_scan_done', value: '1' }]);
  });

  test('a refused write leaves no transaction open: another connection can write at once', (t) => {
    const { store, path } = seeded(t, { guardSchema: true });
    makeNewer(path);
    assert.throws(() => store.setKv('window_alarm', '1'), refused);
    assert.throws(() => store.transaction(() => 0), refused);
    const other = new DatabaseSync(path);
    t.after(() => {
      other.close();
    });
    other.exec('PRAGMA busy_timeout = 0');
    other.exec("INSERT INTO kv (key, value) VALUES ('doctor_probe', '1')");
    assert.equal(store.getKv('doctor_probe'), '1');
  });

  test('without the option the same writes go into a newer store: a command migrates, it does not refuse', (t) => {
    const { store, path } = seeded(t);
    makeNewer(path);
    for (const [name, write] of WRITES) {
      assert.doesNotThrow(() => write(store), name);
    }
    assert.equal(
      store.transaction(() => {
        store.setKv('window_server', 'x');
        return 7;
      }),
      7,
    );
    assert.equal(store.getKv('window_secret'), 'x');
    assert.equal(store.getKv('window_server'), 'x');
    assert.equal(store.meta(S1), null); // updateMeta, then deleteMeta
  });

  test('a guarded store writes into a store of its own version, inside a transaction and outside', (t) => {
    const { store, path } = seeded(t, { guardSchema: true });
    for (const [name, write] of WRITES) {
      assert.doesNotThrow(() => write(store), name);
    }
    assert.equal(
      rawRows(path, "SELECT value FROM kv WHERE key = 'window_secret'")[0]?.['value'],
      'x',
    );
    const result = store.transaction(() => {
      store.setKv('window_server', 'a');
      store.updateMeta(S2, { group: 'G' }, T0);
      store.insertEvent(ev({ spoolName: 'c.ev', sessionId: S2 }));
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(store.getKv('window_server'), 'a');
    assert.equal(store.meta(S2)?.group, 'G');
    assert.equal(store.latestEventIdOfSession(S2), 3);
  });

  test('the version is read inside the write lock: a migration that commits while a write waits is seen', async (t) => {
    const { store, path } = seeded(t, { guardSchema: true });
    for (const write of [
      () => store.setKv('window_alarm', '1'),
      () => store.transaction(() => store.setKv('window_alarm', '1')),
    ]) {
      makeOlderAgain(path);
      const migrator = new Worker(new URL('../fixtures/migrate-while-locked.ts', import.meta.url), {
        workerData: { path, version: SCHEMA_VERSION + 1, holdMs: 300 },
      });
      await once(migrator, 'message'); // it holds the write lock, the new version not yet committed
      assert.throws(write, refused); // waits for the lock (busy timeout), then reads the new version
      await once(migrator, 'exit');
      assert.equal(store.getKv('window_alarm'), null);
    }
  });

  /** Back to this skydeck's version, for the next case of a test. */
  function makeOlderAgain(path: string): void {
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    } finally {
      db.close();
    }
  }

  test('StoreNewerError is a failure of the database as a whole: a refresh must not skip it per item', () => {
    assert.equal(isDatabaseFailure(new StoreNewerError(REFUSAL)), true);
  });

  test('StoreNewerError is a SkydeckError constructed as one (contract 2.6): message, exit code', () => {
    const error = new StoreNewerError('m');
    assert.ok(error instanceof SkydeckError);
    assert.equal(error.name, 'StoreNewerError');
    assert.equal(error.message, 'm');
    assert.equal(error.exitCode, 1);
    assert.equal(new StoreNewerError('m', 5).exitCode, 5);
  });

  test('the read helpers prepare only a SELECT: a write cannot go round the guard through them', (t) => {
    const { path } = fresh(t);
    const db = new DatabaseSync(path);
    t.after(() => {
      db.close();
    });
    for (const sql of ['SELECT value FROM kv', '  select 1', '\n\tSelect 2']) {
      assert.doesNotThrow(() => prepareRead(db, sql).all(), sql);
    }
    // WITH and PRAGMA are refused too: a WITH clause can stand before a write, a PRAGMA can assign.
    for (const sql of [
      '\n\tWITH x AS (SELECT 1) SELECT * FROM x',
      "WITH x AS (SELECT 1) INSERT INTO kv (key, value) VALUES ('doctor_probe', '1')",
      "WITH x AS (SELECT 1) DELETE FROM kv WHERE key = 'schema_version' RETURNING key",
      'PRAGMA data_version',
      'PRAGMA user_version = 7',
      'PRAGMA journal_mode = DELETE',
      "INSERT INTO kv (key, value) VALUES ('doctor_probe', '1')",
      "  insert or replace into kv (key, value) VALUES ('doctor_probe', '1')",
      "UPDATE kv SET value = '9' WHERE key = 'schema_version'",
      'DELETE FROM kv',
      "REPLACE INTO kv (key, value) VALUES ('doctor_probe', '1')",
      'CREATE TABLE x (a)',
      'SELECTED',
      '',
    ]) {
      assert.throws(() => prepareRead(db, sql), /^Error: not a read statement/, sql);
    }
    assert.deepEqual(
      rawRows(path, 'SELECT key FROM kv').map((row) => row['key']),
      ['schema_version'],
    );
    assert.equal(rawRows(path, 'PRAGMA user_version')[0]?.['user_version'], 0);
    assert.equal(rawRows(path, 'PRAGMA journal_mode')[0]?.['journal_mode'], 'wal');
  });

  test('inside the store only the two write helpers prepare a statement themselves (S2 10.1)', () => {
    // Every other method reads through #all / #get (prepareRead) or writes through #run /
    // #runReturning (#write, the guard): a method that prepared or ran SQL on its own could write
    // round the schema guard.
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'store', 'store.ts'),
      'utf8',
    );
    const body = source.slice(source.indexOf('class SqliteStore'));
    assert.equal(body.match(/this\.#db\.prepare\(/g)?.length, 2);
    assert.equal(body.match(/this\.#db\.exec\(/g), null);
    assert.equal(body.match(/prepareRead\(this\.#db, sql\)/g)?.length, 2);
    for (const helper of ['#run(', '#runReturning(']) {
      const start = body.indexOf(`  ${helper}sql: string`);
      assert.ok(start > 0, helper);
      assert.match(
        body.slice(start, body.indexOf('\n  }\n', start)),
        /this\.#write\(\(\) => [^\n]*this\.#db\.prepare\(/,
        helper,
      );
    }
  });

  test("the window's keys are kv keys (S2 10.2)", (t) => {
    const { store } = fresh(t);
    const keys: KvKey[] = [
      'window_secret',
      'window_server',
      'window_runtime_dir',
      'window_alarm',
      'window_launching',
    ];
    for (const key of keys) {
      store.setKv(key, `value of ${key}`);
    }
    assert.deepEqual(
      store.kvEntries('window_'),
      [...keys].sort().map((key) => ({ key, value: `value of ${key}` })),
    );
  });
});

describe('attention (S2 10.2; stage B, B2 and B3)', () => {
  const S3 = '33333333-3333-4333-8333-333333333333';
  /** Times with nanosecond digits, above 2^53. */
  const TURN = T0 + 1_234_567_891n;
  const LATER_TURN = T0 + 9n * SEC + 7n;
  const WINDOW_END = T0 + 5n * SEC + 3n;

  function row(over: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
    return {
      turnEndedSeq: null,
      turnEndedNs: null,
      seenSeq: null,
      windowEndSeq: null,
      windowEndNs: null,
      ...over,
    };
  }

  /** attention and the counter, read through a connection that is not the store's. */
  function stored(path: string): { rows: Record<string, unknown>[]; counter: unknown } {
    const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
    try {
      return {
        rows: db
          .prepare('SELECT * FROM attention ORDER BY session_id')
          .all()
          .map((r) => ({ ...r })),
        counter: db.prepare("SELECT value FROM kv WHERE key = 'attention_seq'").get()?.['value'],
      };
    } finally {
      db.close();
    }
  }

  function makeNewer(path: string): void {
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE kv SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION + 1),
      );
    } finally {
      db.close();
    }
  }

  test('a new store has no attention row and no counter', (t) => {
    const { store } = fresh(t);
    assert.deepEqual(store.attention(), []);
    assert.equal(store.getKv('attention_seq'), null);
  });

  test('a turn end, then a seen in a later write: the seen is later than the turn end', (t) => {
    const { store } = fresh(t);
    const turn = row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: TURN });

    assert.deepEqual(store.recordAttention([{ sessionId: S1, turnEndedNs: TURN }]), [turn]);
    assert.deepEqual(store.recordAttention([{ sessionId: S1, seen: true }]), [
      { ...turn, seenSeq: 2 },
    ]);
    assert.deepEqual(store.attention(), [{ ...turn, seenSeq: 2 }]);
  });

  test('a turn end and a seen of one session in one write: the seen is the turn end + 1 (B3)', (t) => {
    const { store } = fresh(t);
    assert.deepEqual(store.recordAttention([{ sessionId: S1, seen: true, turnEndedNs: TURN }]), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: TURN, seenSeq: 2 }),
    ]);
  });

  test('a window end and a seen of one session in one write: the seen is later (B3)', (t) => {
    const { store } = fresh(t);
    assert.deepEqual(
      store.recordAttention([{ sessionId: S1, seen: true, windowEndNs: WINDOW_END }]),
      [row({ sessionId: S1, windowEndSeq: 1, windowEndNs: WINDOW_END, seenSeq: 2 })],
    );
  });

  test("all three of one session in one write take the values in B3's order: turn end, window end, seen", (t) => {
    const { store } = fresh(t);
    assert.deepEqual(
      store.recordAttention([
        { sessionId: S1, seen: true, windowEndNs: WINDOW_END, turnEndedNs: TURN },
      ]),
      [
        row({
          sessionId: S1,
          turnEndedSeq: 1,
          turnEndedNs: TURN,
          windowEndSeq: 2,
          windowEndNs: WINDOW_END,
          seenSeq: 3,
        }),
      ],
    );
    assert.equal(store.getKv('attention_seq'), '3');
  });

  test('values grow across writes and sessions, in the order the writes are given; the counter keeps the last', (t) => {
    const { store } = fresh(t);
    store.recordAttention([
      { sessionId: S2, turnEndedNs: TURN },
      { sessionId: S1, turnEndedNs: LATER_TURN },
    ]);
    store.recordAttention([
      { sessionId: S1, seen: true },
      { sessionId: S2, seen: true },
    ]);
    assert.deepEqual(store.attention(), [
      row({ sessionId: S1, turnEndedSeq: 2, turnEndedNs: LATER_TURN, seenSeq: 3 }),
      row({ sessionId: S2, turnEndedSeq: 1, turnEndedNs: TURN, seenSeq: 4 }),
    ]);
    assert.equal(store.getKv('attention_seq'), '4');
  });

  test('a row is made at its first observation and kept; a later write changes only its own columns; times are stored exactly', (t) => {
    const { store, path } = fresh(t);
    store.recordAttention([{ sessionId: S1, seen: true }]);
    assert.deepEqual(store.attention(), [row({ sessionId: S1, seenSeq: 1 })]);

    store.recordAttention([{ sessionId: S1, windowEndNs: WINDOW_END }]);
    store.recordAttention([{ sessionId: S1, turnEndedNs: TURN }]);
    store.recordAttention([{ sessionId: S1, turnEndedNs: LATER_TURN }]);
    store.recordAttention([{ sessionId: S2, seen: true }]);

    const s1 = row({
      sessionId: S1,
      seenSeq: 1,
      windowEndSeq: 2,
      windowEndNs: WINDOW_END,
      turnEndedSeq: 4,
      turnEndedNs: LATER_TURN,
    });
    assert.deepEqual(store.attention(), [s1, row({ sessionId: S2, seenSeq: 5 })]);
    assert.deepEqual(stored(path).rows[0], {
      session_id: S1,
      turn_ended_seq: 4n,
      turn_ended_ns: LATER_TURN,
      seen_seq: 1n,
      window_end_seq: 2n,
      window_end_ns: WINDOW_END,
    });
  });

  test('attention() is ordered by session id', (t) => {
    const { store } = fresh(t);
    store.recordAttention([
      { sessionId: S3, seen: true },
      { sessionId: S1, seen: true },
      { sessionId: S2, seen: true },
    ]);
    assert.deepEqual(
      store.attention().map((r) => r.sessionId),
      [S1, S2, S3],
    );
  });

  test('the rows returned are the rows written as stored: one per session, by session id, the last state of each', (t) => {
    const { store } = fresh(t);
    store.recordAttention([{ sessionId: S3, turnEndedNs: TURN }]);

    const written = store.recordAttention([
      { sessionId: S2, turnEndedNs: TURN },
      { sessionId: S1, seen: true },
      { sessionId: S2, seen: true },
    ]);

    assert.deepEqual(written, [
      row({ sessionId: S1, seenSeq: 3 }),
      row({ sessionId: S2, turnEndedSeq: 2, turnEndedNs: TURN, seenSeq: 4 }),
    ]);
    assert.deepEqual(
      written,
      store.attention().filter((r) => r.sessionId !== S3),
    );
  });

  /** Rows whose largest *_seq is 3, the counter at 3. */
  function threeStored(store: Store): void {
    store.recordAttention([
      { sessionId: S1, turnEndedNs: TURN },
      { sessionId: S1, windowEndNs: WINDOW_END },
      { sessionId: S2, seen: true },
    ]);
    assert.equal(store.getKv('attention_seq'), '3');
  }

  const damaged: [what: string, damage: (store: Store) => void][] = [
    ['deleted', (store) => store.deleteKv('attention_seq')],
    ['set to abc', (store) => store.setKv('attention_seq', 'abc')],
    ['set lower than a stored seq', (store) => store.setKv('attention_seq', '1')],
    ['set to 0', (store) => store.setKv('attention_seq', '0')],
    ['empty', (store) => store.setKv('attention_seq', '')],
    ['with a leading zero', (store) => store.setKv('attention_seq', '09')],
    ['with a sign', (store) => store.setKv('attention_seq', '+9')],
    ['negative', (store) => store.setKv('attention_seq', '-9')],
    ['with a fraction', (store) => store.setKv('attention_seq', '9.0')],
    ['with spaces', (store) => store.setKv('attention_seq', ' 9 ')],
    ['in exponent form', (store) => store.setKv('attention_seq', '1e3')],
    ['hexadecimal', (store) => store.setKv('attention_seq', '0x9')],
    ['too large for a number', (store) => store.setKv('attention_seq', '99999999999999999999')],
  ];
  for (const [what, damage] of damaged) {
    test(`B2: with the counter ${what}, the next value is still one more than every stored one`, (t) => {
      const { store } = fresh(t);
      threeStored(store);
      damage(store);

      assert.deepEqual(store.recordAttention([{ sessionId: S3, seen: true }]), [
        row({ sessionId: S3, seenSeq: 4 }),
      ]);
      assert.equal(store.getKv('attention_seq'), '4');
    });
  }

  test('B2: a counter above every stored value gives the value after it', (t) => {
    const { store } = fresh(t);
    threeStored(store);
    store.setKv('attention_seq', '100');
    store.recordAttention([{ sessionId: S3, seen: true }]);
    assert.equal(store.attention()[2]?.seenSeq, 101);
    assert.equal(store.getKv('attention_seq'), '101');
  });

  for (const column of ['turn_ended_seq', 'seen_seq', 'window_end_seq']) {
    test(`B2: the largest stored value counts in whichever column it is (${column})`, (t) => {
      const { store, path } = fresh(t);
      threeStored(store);
      const db = new DatabaseSync(path);
      db.prepare(`UPDATE attention SET ${column} = 50 WHERE session_id = ?`).run(S1);
      db.close();
      store.deleteKv('attention_seq');

      store.recordAttention([{ sessionId: S3, turnEndedNs: TURN }]);
      assert.equal(store.attention()[2]?.turnEndedSeq, 51);
    });
  }

  test('B2: the last value is 2^53 - 1; past it the write is a RangeError and nothing is written', (t) => {
    const { store, path } = fresh(t);
    store.setKv('attention_seq', String(Number.MAX_SAFE_INTEGER - 1));
    assert.deepEqual(store.recordAttention([{ sessionId: S1, seen: true }]), [
      row({ sessionId: S1, seenSeq: Number.MAX_SAFE_INTEGER }),
    ]);
    const before = stored(path);
    assert.equal(before.counter, String(Number.MAX_SAFE_INTEGER));

    assert.throws(() => store.recordAttention([{ sessionId: S2, turnEndedNs: TURN }]), {
      name: 'RangeError',
      message: 'the attention counter is at 2^53 - 1 and cannot go on',
    });
    assert.deepEqual(stored(path), before);
  });

  test('B2: the next value is read inside the write lock: what another connection commits while this write waits counts', async (t) => {
    const { store, path } = fresh(t);
    store.recordAttention([{ sessionId: S1, seen: true }]); // seen_seq 1, the counter '1'
    // Another writer gives the values up to 50 and commits while this one waits for the lock.
    const other = uncommittedWrite(
      path,
      `UPDATE attention SET seen_seq = 50; UPDATE kv SET value = '50' WHERE key = 'attention_seq';`,
      500,
    );
    await once(other, 'message');

    const written = store.recordAttention([{ sessionId: S2, turnEndedNs: TURN }]);

    await once(other, 'exit');
    assert.deepEqual(written, [row({ sessionId: S2, turnEndedSeq: 51, turnEndedNs: TURN })]);
    assert.equal(store.getKv('attention_seq'), '51');
  });

  test('an empty list writes nothing: no row, no counter', (t) => {
    const { store, path } = fresh(t);
    assert.deepEqual(store.recordAttention([]), []);
    assert.deepEqual(stored(path), { rows: [], counter: undefined });
  });

  test('a write with no observation is a RangeError, and nothing is written, also of the writes before it', (t) => {
    const { store, path } = fresh(t);
    const empty: AttentionWrite = { sessionId: S2 };
    assert.throws(
      () => store.recordAttention([{ sessionId: S1, turnEndedNs: TURN }, empty]),
      RangeError,
    );
    assert.deepEqual(stored(path), { rows: [], counter: undefined });
  });

  test('on a guarded connection with the store one version newer: StoreNewerError, nothing written', (t) => {
    const { store, path } = fresh(t);
    store.recordAttention([{ sessionId: S1, turnEndedNs: TURN }]);
    const guarded = openStore(path, { guardSchema: true });
    t.after(() => {
      guarded.close();
    });
    makeNewer(path);
    const before = stored(path);

    assert.throws(
      () =>
        guarded.recordAttention([
          { sessionId: S1, seen: true },
          { sessionId: S2, turnEndedNs: TURN },
        ]),
      (error: unknown) =>
        error instanceof StoreNewerError &&
        error.message === 'skydeck was updated; run skydeck window',
    );
    assert.deepEqual(stored(path), before);
  });

  test("with another connection holding the write lock (the server's 250 ms): a failure of the database as a whole, nothing written", (t) => {
    const { path } = fresh(t);
    const server = openStore(path, { guardSchema: true, busyTimeoutMs: 250 });
    t.after(() => {
      server.close();
    });
    const other = new DatabaseSync(path);
    t.after(() => {
      other.close();
    });
    other.exec('BEGIN IMMEDIATE');

    assert.throws(
      () => server.recordAttention([{ sessionId: S1, turnEndedNs: TURN }]),
      (error: unknown) => isDatabaseFailure(error),
    );
    other.exec('ROLLBACK');
    assert.deepEqual(stored(path), { rows: [], counter: undefined });

    assert.deepEqual(server.recordAttention([{ sessionId: S1, turnEndedNs: TURN }]), [
      row({ sessionId: S1, turnEndedSeq: 1, turnEndedNs: TURN }),
    ]);
  });
});
