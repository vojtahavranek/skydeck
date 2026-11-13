import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { SkydeckError } from '../../src/platform/errors.ts';
import { NS_PER_SECOND as SEC } from '../../src/platform/time.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { isDatabaseFailure, openStore } from '../../src/store/store.ts';
import type { Store } from '../../src/store/store.ts';
import type {
  EventRow,
  KvKey,
  NewEvent,
  PrFetchResult,
  SessionPrRow,
  TranscriptRow,
} from '../../src/store/types.ts';
import { sandbox } from '../helpers/sandbox.ts';

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
  test('there is one migration and the schema version is its count', () => {
    assert.equal(MIGRATIONS.length, 1);
    assert.equal(SCHEMA_VERSION, 1);
  });

  test('migration 1 is the SQL of design 9.2 character for character', () => {
    const design = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'design.md'), 'utf8');
    const match = /^Migration 1:\n\n```sql\n([\s\S]*?)\n```$/m.exec(design);
    assert.ok(match, 'design.md 9.2 has no "Migration 1" SQL block');
    assert.equal(MIGRATIONS[0], match[1]);
  });
});

describe('openStore', () => {
  test('a new database has the connection settings, mode 600, version 1 and every table', (t) => {
    const { store, path } = fresh(t);

    assert.equal(store.path, path);
    assert.deepEqual(store.connectionSettings(), {
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
      foreignKeys: 1,
    });
    assert.equal(mode(path), 0o600);
    assert.equal(store.getKv('schema_version'), '1');
    const tables = rawRows(
      path,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name);
    assert.deepEqual(tables, [
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

    assert.equal(second.getKv('schema_version'), '1');
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
    const { store, reopen } = fresh(t);
    store.setKv('schema_version', '2');
    store.close();

    assert.throws(reopen, (error) => {
      assert.ok(error instanceof SkydeckError);
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /newer/);
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
