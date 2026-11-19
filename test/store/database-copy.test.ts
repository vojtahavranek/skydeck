// Follow-up F21: before openStore migrates a database that already holds a schema, it writes a copy
// of the database as it is beside it — `<name>.schema<V>-<UTC time as yyyymmddThhmmssZ>`, `<V>` the
// version the copy holds — with SQLite's own VACUUM INTO, mode 600 from the moment it exists, never
// over a name that is taken; only then the migration runs, and of the copies the newest three stay.
// A copy that cannot be written stops the migration: the database is left as it was. A new database
// and one at the code's version are never copied. Every database here is a test's own.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { SkydeckError } from '../../src/platform/errors.ts';
import type { Ns } from '../../src/platform/types.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { openStore } from '../../src/store/store.ts';
import type { Migrated, Store } from '../../src/store/store.ts';
import { SEC, T0 } from '../helpers/platform.ts';
import { sandbox } from '../helpers/sandbox.ts';
import type { Sandbox } from '../helpers/sandbox.ts';
import { SCHEMA1, dumpDatabase, schemaDatabase } from '../helpers/schema1.ts';

/** T0 (2026-11-12T09:00:00Z) as a copy's name writes it. */
const STAMP = '20261112T090000Z';
const STORE_URL = new URL('../../src/store/store.ts', import.meta.url).href;
/** The whole name of a copy of skydeck.db, as a test reads it back: its version, its time. */
const COPY_NAME = /^skydeck\.db\.schema([1-9][0-9]*)-([0-9]{8}T[0-9]{6}Z)$/;

function clockAt(ns: Ns): { nowNs(): Ns } {
  return { nowNs: () => ns };
}

/** A database of schema `version` at `<sandbox>/data/skydeck.db`, in a folder of its own. */
function old(t: TestContext, version: number): { path: string; dir: string; sb: Sandbox } {
  const sb = sandbox(t);
  const dir = join(sb.root, 'data');
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, 'skydeck.db');
  schemaDatabase(path, version);
  return { path, dir, sb };
}

function opened(t: TestContext, path: string, options?: Parameters<typeof openStore>[1]): Store {
  const store = openStore(path, options);
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

/** What one PRAGMA or query answers on a read-only connection of its own. */
function readOne(path: string, sql: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

function versionOf(path: string): unknown {
  return readOne(path, "SELECT value FROM kv WHERE key = 'schema_version'");
}

function integrityOf(path: string): unknown {
  return readOne(path, 'PRAGMA integrity_check');
}

function refusal(path: string, copy: string, reason: string): string {
  return `the database ${path} was not upgraded: its copy ${copy} could not be written (${reason})`;
}

function regexText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// C1: the copy

test('before it migrates a database of every older schema version, openStore writes a copy of it as it was beside it: its name, mode 600, its version, every row', (t) => {
  assert.ok(SCHEMA_VERSION > 1, 'there is an older version to copy');
  for (let version = 1; version < SCHEMA_VERSION; version++) {
    const { path, dir } = old(t, version);
    const before = dumpDatabase(path);

    const store = opened(t, path, { clock: clockAt(T0) });

    const copy = `${path}.schema${version}-${STAMP}`;
    assert.deepEqual(store.migrated, { version: SCHEMA_VERSION, copy }, `from ${version}`);
    assert.equal(store.getKv('schema_version'), String(SCHEMA_VERSION));
    assert.deepEqual(beside(dir), [basename(copy)], 'the copy and nothing else: no temporary');
    assert.ok(lstatSync(copy).isFile());
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.equal(integrityOf(copy), 'ok');
    assert.equal(versionOf(copy), String(version));
    assert.deepEqual(dumpDatabase(copy), before, 'every entry of sqlite_master and every row');
  }
});

test('an older skydeck finds in the copy what it found in the database: put in its place (install.md, "Going back") it is the database as it was, which openStore migrates again as it did the first time', (t) => {
  const { path, dir } = old(t, 3);
  const before = dumpDatabase(path);
  const first = openStore(path, { clock: clockAt(T0) });
  const copy = first.migrated?.copy;
  const migrated = dumpDatabase(path);
  first.close();
  assert.ok(copy !== undefined);
  // skydeck's connection, the last to close the database, removed the two files SQLite keeps
  // beside it while it is open (the guide's steps look for them).
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);

  renameSync(path, join(dir, 'set-aside.db'));
  copyFileSync(copy, path);

  assert.deepEqual(dumpDatabase(path), before);
  const again = opened(t, path, { clock: clockAt(T0 + 60n * SEC) });
  assert.deepEqual(again.migrated, {
    version: SCHEMA_VERSION,
    copy: `${path}.schema3-20261112T090100Z`,
  });
  assert.deepEqual(dumpDatabase(path), migrated);
  assert.equal(again.meta(SCHEMA1.s1)?.label, 'Přehled – the old plan ✓');
});

test('a new database is made with no copy', (t) => {
  const dir = join(sandbox(t).root, 'data');
  mkdirSync(dir);
  const path = join(dir, 'skydeck.db');

  const store = opened(t, path, { clock: clockAt(T0) });

  assert.equal(store.migrated, null);
  assert.equal(store.getKv('schema_version'), String(SCHEMA_VERSION));
  assert.deepEqual(beside(dir), []);
});

test("a database at the code's version is never copied: opening it again writes nothing beside it and removes no older copy", (t) => {
  const { path, dir } = old(t, 1);
  openStore(path, { clock: clockAt(T0) }).close();
  // More copies than are kept, all older: only a migration's copy removes any.
  for (const day of ['01', '02', '03', '04']) {
    writeFileSync(join(dir, `skydeck.db.schema1-202001${day}T000000Z`), 'an old copy');
  }
  const listed = beside(dir);

  const again = opened(t, path, { clock: clockAt(T0 + 3600n * SEC) });

  assert.equal(again.migrated, null);
  assert.deepEqual(beside(dir), listed);
});

test('the copy has mode 600 from the moment it exists: another thread that looks at it the whole time it is written never finds another mode', async (t) => {
  const { path, dir } = old(t, 3);
  // Large enough that writing its copy takes a while: 24 notes of 1 MB.
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    'INSERT INTO session_meta (session_id, note, created_ns, updated_ns) VALUES (?, ?, 1, 1)',
  );
  for (let i = 0; i < 24; i++) insert.run(`big-${i}`, String(i).repeat(1_000_000));
  db.close();
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const looker = new Worker(
    `const { lstatSync, readdirSync } = require('node:fs');
     const { join } = require('node:path');
     const { parentPort, workerData } = require('node:worker_threads');
     const stop = new Int32Array(workerData.stop);
     const seen = new Map();
     parentPort.postMessage('looking');
     while (Atomics.load(stop, 0) === 0) {
       for (const name of readdirSync(workerData.dir)) {
         if (!name.includes('.schema')) continue;
         try {
           const info = lstatSync(join(workerData.dir, name));
           const key = name + ' ' + (info.mode & 0o777).toString(8);
           seen.set(key, Math.max(seen.get(key) ?? 0, info.size));
         } catch {}
       }
     }
     parentPort.postMessage([...seen]);`,
    { eval: true, workerData: { dir, stop: stop.buffer } },
  );
  t.after(() => looker.terminate());
  await once(looker, 'message');

  const store = opened(t, path, { clock: clockAt(T0) });
  Atomics.store(stop, 0, 1);
  const [seen] = (await once(looker, 'message')) as [[string, number][]];

  assert.ok(store.migrated !== null);
  const looks = seen.map(([key, size]) => ({
    name: key.split(' ')[0],
    mode: key.split(' ')[1],
    size,
  }));
  // Written as its temporary `.<the copy's name>.tmp`, beside the database.
  assert.ok(
    looks.some((look) => look.name === `.skydeck.db.schema3-${STAMP}.tmp` && look.size > 0),
    `the copy was seen while it was written: ${JSON.stringify(looks)}`,
  );
  for (const look of looks) assert.equal(look.mode, '600', JSON.stringify(look));
});

/** Runs `node -e <code> <args>` in the sandbox's environment; its exit code and output. */
async function child(
  sb: Sandbox,
  code: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
    env: sb.env(),
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  proc.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  const [status] = (await once(proc, 'exit')) as [number | null];
  return { status, stdout, stderr };
}

/** A skydeck that opens the store at a given moment (ms since the epoch) and prints `migrated`. */
const OPEN_AT = `
  const [storeUrl, path, startAt] = process.argv.slice(1);
  const { openStore } = await import(storeUrl);
  const wait = Number(startAt) - Date.now();
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  const store = openStore(path);
  process.stdout.write(JSON.stringify(store.migrated));
  store.close();
`;

test('processes that open an old database at the same moment: one migrated database, a copy of it as it was, and no copy whose name states another version than it holds', async (t) => {
  for (let round = 0; round < 3; round++) {
    const { path, dir, sb } = old(t, 1);
    const before = dumpDatabase(path);
    // The same database migrated once, in this process, to compare with.
    const reference = join(dir, 'reference.db');
    schemaDatabase(reference, 1);
    openStore(reference).close();
    const migratedOnce = dumpDatabase(reference);
    const startAt = String(Date.now() + 2000);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => child(sb, OPEN_AT, [STORE_URL, path, startAt])),
    );

    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(versionOf(path), String(SCHEMA_VERSION));
    assert.deepEqual(dumpDatabase(path), migratedOnce, 'migrated once');
    const copies = beside(dir).filter((name) => !name.startsWith('reference.db'));
    for (const name of copies) {
      const match = COPY_NAME.exec(name);
      assert.ok(match !== null, `${name}: a copy, no temporary`);
      assert.equal(versionOf(join(dir, name)), match[1], name);
      assert.equal(integrityOf(join(dir, name)), 'ok', name);
    }
    assert.ok(
      copies.some((name) => {
        if (!name.startsWith('skydeck.db.schema1-')) return false;
        assert.deepEqual(dumpDatabase(join(dir, name)), before, name);
        return true;
      }),
      `a copy of the database as it was: ${copies.join(', ')}`,
    );
    const said = results
      .map((result) => JSON.parse(result.stdout) as { version: number; copy: string } | null)
      .filter((migrated) => migrated !== null);
    assert.ok(said.length >= 1, 'one of them migrated');
    for (const migrated of said) {
      assert.equal(migrated.version, SCHEMA_VERSION);
      assert.ok(copies.includes(basename(migrated.copy)), migrated.copy);
    }
  }
});

test('an open that waited for the write lock while another skydeck migrated a step copies what it finds inside the lock, under that version’s name', async (t) => {
  assert.ok(SCHEMA_VERSION >= 3, 'a step is left for the opener after the holder’s');
  const { path, dir, sb } = old(t, 1);
  // The test holds the write lock, as a skydeck in the middle of its migration does.
  const holder = new DatabaseSync(path);
  holder.exec('BEGIN IMMEDIATE');
  const code = `
    const [storeUrl, path] = process.argv.slice(1);
    const { openStore } = await import(storeUrl);
    process.stdout.write('opening\\n');
    const store = openStore(path);
    process.stdout.write(JSON.stringify(store.migrated));
    store.close();
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, STORE_URL, path], {
    env: sb.env(),
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  proc.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  const exited = once(proc, 'exit');
  while (!stdout.includes('opening\n')) await sleep(20);
  // By now it has most likely read schema 1 and waits for the lock (its busy timeout is 5 s); one
  // that reads only after the commit below finds 2 at once, and must copy the same.
  await sleep(500);
  holder.exec(MIGRATIONS[1] ?? '');
  holder.prepare("UPDATE kv SET value = '2' WHERE key = 'schema_version'").run();
  holder.exec('COMMIT');
  holder.close();
  const [status] = (await exited) as [number | null];

  assert.equal(status, 0, stderr);
  const migrated = JSON.parse(stdout.slice('opening\n'.length)) as Migrated;
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.match(basename(migrated.copy), /^skydeck\.db\.schema2-[0-9]{8}T[0-9]{6}Z$/);
  assert.equal(versionOf(migrated.copy), '2');
  assert.deepEqual(beside(dir), [basename(migrated.copy)]);
  assert.equal(versionOf(path), String(SCHEMA_VERSION));
});

test('a name in the way of the copy (a file, a folder, a link): the migration does not run, the error names the database, the copy and the reason, and nothing is changed', (t) => {
  const makers: Record<string, (path: string) => void> = {
    file: (path) => writeFileSync(path, 'mine'),
    folder: (path) => mkdirSync(path),
    link: (path) => symlinkSync(join(path, '..', 'nowhere'), path),
  };
  for (const [what, make] of Object.entries(makers)) {
    const { path, dir } = old(t, 3);
    const copy = `${path}.schema3-${STAMP}`;
    make(copy);
    const before = dumpDatabase(path);
    const listed = beside(dir);

    assert.throws(
      () => openStore(path, { clock: clockAt(T0) }),
      (error: unknown) => {
        assert.ok(error instanceof SkydeckError, `${what}: ${String(error)}`);
        assert.equal(error.exitCode, 1);
        assert.equal(error.message, refusal(path, copy, 'something of that name is there already'));
        return true;
      },
    );

    assert.deepEqual(dumpDatabase(path), before, what);
    assert.deepEqual(beside(dir), listed, `${what}: nothing written beside it`);
    if (what === 'file') assert.equal(readFileSync(copy, 'utf8'), 'mine');
    if (what === 'folder') assert.deepEqual(readdirSync(copy), []);
    if (what === 'link') {
      assert.equal(readlinkSync(copy), join(dir, 'nowhere'));
      assert.equal(existsSync(join(dir, 'nowhere')), false, 'nothing written through the link');
    }
    // A second later the name is free: the copy is written, and the migration runs.
    const store = opened(t, path, { clock: clockAt(T0 + SEC) });
    assert.equal(store.migrated?.copy, `${path}.schema3-20261112T090001Z`);
  }
});

test('a folder the copy cannot be written into: the migration does not run, the error names the copy and the reason, and nothing is changed', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root writes into any folder');
    return;
  }
  const { path, dir } = old(t, 3);
  const before = dumpDatabase(path);
  // A connection of the test's keeps the two files of a WAL database (-wal, -shm) there, so that
  // the database itself still opens in a folder that is not writable.
  const holder = new DatabaseSync(path);
  holder.prepare('SELECT 1 FROM kv').get();
  chmodSync(dir, 0o500);
  try {
    assert.throws(
      () => openStore(path, { clock: clockAt(T0) }),
      (error: unknown) => {
        assert.ok(error instanceof SkydeckError, String(error));
        assert.equal(
          error.message,
          refusal(path, `${path}.schema3-${STAMP}`, 'EACCES: permission denied'),
        );
        return true;
      },
    );
  } finally {
    chmodSync(dir, 0o700);
    holder.close();
  }

  assert.deepEqual(dumpDatabase(path), before);
  assert.deepEqual(beside(dir), []);
});

test('no room for the copy (a limit on the size of a file stands in for a full disk): the migration does not run, and nothing is left of the copy', (t) => {
  const { path, dir, sb } = old(t, 3);
  // Larger than the limit below, which the -shm file (32 KiB) is not.
  const db = new DatabaseSync(path);
  db.prepare('UPDATE session_meta SET note = ? WHERE session_id = ?').run(
    'x'.repeat(1_000_000),
    SCHEMA1.s1,
  );
  db.close();
  const before = dumpDatabase(path);
  const code = `
    const [storeUrl, path] = process.argv.slice(1);
    const { openStore } = await import(storeUrl);
    try {
      openStore(path).close();
      console.log('opened');
    } catch (error) {
      console.log('threw: ' + error.message);
    }
  `;

  // `ulimit -f 150` is 75 to 150 KB. A child that ignores SIGXFSZ gets EFBIG from the write
  // instead of being killed (as in store.test.ts).
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      'trap "" XFSZ; ulimit -f 150; exec "$@"',
      'sh',
      process.execPath,
      '--input-type=module',
      '-e',
      code,
      STORE_URL,
      path,
    ],
    { env: sb.env(), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout.trim(),
    new RegExp(
      `^threw: ${regexText(`the database ${path} was not upgraded: its copy ${path}.schema3-`)}[0-9]{8}T[0-9]{6}Z could not be written \\((?:disk I/O error|database or disk is full)\\)$`,
    ),
  );
  assert.deepEqual(dumpDatabase(path), before);
  assert.deepEqual(beside(dir), []);
});

// ---------------------------------------------------------------------------------------------
// C2: at most three copies

test('after a copy, the copies beyond the newest three by the time in their names are removed — not by their order as names, nor by their files’ times', (t) => {
  const { path, dir } = old(t, 3);
  const fakes = [
    'skydeck.db.schema9-20200101T000000Z', // the last name, the oldest time
    'skydeck.db.schema1-20260601T000000Z', // the first name, the newest time of these
    'skydeck.db.schema2-20260301T000000Z',
    'skydeck.db.schema3-20251201T120000Z',
  ];
  for (const [i, name] of fakes.entries()) {
    writeFileSync(join(dir, name), name);
    const time = new Date(Date.UTC(2026, 10, 1 + i)); // the files' own times in another order
    utimesSync(join(dir, name), time, time);
  }

  opened(t, path, { clock: clockAt(T0) });

  assert.deepEqual(beside(dir), [
    'skydeck.db.schema1-20260601T000000Z',
    'skydeck.db.schema2-20260301T000000Z',
    `skydeck.db.schema3-${STAMP}`,
  ]);
});

test('only regular files whose whole name is a copy’s are removed: a link, a folder, a name that merely starts or ends alike and a copy of another database stay', (t) => {
  const { path, dir } = old(t, 3);
  const kept = [
    'skydeck.db.schema3-20261001T000000Z',
    'skydeck.db.schema3-20261002T000000Z',
    'skydeck.db.schema3-20261003T000000Z',
  ];
  for (const name of kept) writeFileSync(join(dir, name), name);
  const target = join(dir, 'what-the-link-points-at');
  writeFileSync(target, 'mine');
  symlinkSync(target, join(dir, 'skydeck.db.schema1-20200101T000000Z'));
  symlinkSync(join(dir, 'nowhere'), join(dir, 'skydeck.db.schema1-20200101T000001Z'));
  mkdirSync(join(dir, 'skydeck.db.schema1-20200102T000000Z'));
  writeFileSync(join(dir, 'skydeck.db.schema1-20200102T000000Z', 'inside'), 'mine');
  const alike = [
    'skydeck.db.schema1-20200103T000000Z.bak',
    'skydeck.db.schema1-20200103T000000Z-wal',
    'skydeck.db.schema1-20200103T000000Z~',
    'skydeck.db.schema1-20200103T000000Z\n',
    'skydeck.db.schema01-20200103T000000Z',
    'skydeck.db.schema0-20200103T000000Z',
    'skydeck.db.schema-20200103T000000Z',
    'skydeck.db.schemax-20200103T000000Z',
    'skydeck.db.schema1-2020013T000000Z',
    'skydeck.db.schema1-20200103T000000',
    'skydeck.db.schema1-20200103t000000z',
    'skydeck.db.schema1_20200103T000000Z',
    'skydeck.db.Schema1-20200103T000000Z',
    'xskydeck.db.schema1-20200103T000000Z',
    'skydeck-db.schema1-20200103T000000Z',
    'skydeck.dbxschema1-20200103T000000Z',
    '.skydeck.db.schema1-20200103T000000Z.0123456789ab.tmp',
    'other.db.schema1-20200103T000000Z',
  ];
  for (const name of alike) writeFileSync(join(dir, name), 'mine');
  const others = beside(dir).filter((name) => !kept.includes(name));

  opened(t, path, { clock: clockAt(T0) });

  assert.deepEqual(
    beside(dir),
    [...others, kept[1], kept[2], `skydeck.db.schema3-${STAMP}`].sort(),
    'the oldest copy is removed, and nothing else',
  );
  assert.equal(readFileSync(target, 'utf8'), 'mine');
  for (const name of alike) assert.equal(readFileSync(join(dir, name), 'utf8'), 'mine', name);
  assert.equal(
    readFileSync(join(dir, 'skydeck.db.schema1-20200102T000000Z', 'inside'), 'utf8'),
    'mine',
  );
});

test('the copy just written stays when the clock is behind the times in the other names; the newest two of those stay with it', (t) => {
  const { path, dir } = old(t, 3);
  for (const month of ['01', '02', '03', '04']) {
    writeFileSync(join(dir, `skydeck.db.schema3-2030${month}01T000000Z`), month);
  }

  const store = opened(t, path, { clock: clockAt(T0) });

  assert.equal(store.migrated?.copy, `${path}.schema3-${STAMP}`);
  assert.deepEqual(beside(dir), [
    `skydeck.db.schema3-${STAMP}`,
    'skydeck.db.schema3-20300301T000000Z',
    'skydeck.db.schema3-20300401T000000Z',
  ]);
});

test('a migration that fails after its copy: the copy is removed again (the database is what it holds), and no older copy is removed', (t) => {
  const { path, dir } = old(t, 3);
  for (const day of ['01', '02', '03', '04']) {
    writeFileSync(join(dir, `skydeck.db.schema2-202601${day}T000000Z`), 'an older copy');
  }
  const db = new DatabaseSync(path);
  // The schema_version update fails, after the migration's own statement ran.
  db.exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON kv WHEN NEW.key = 'schema_version'
           BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
  db.close();
  const before = dumpDatabase(path);
  const listed = beside(dir);

  assert.throws(() => openStore(path, { clock: clockAt(T0) }), /refused by the test/);

  assert.deepEqual(dumpDatabase(path), before);
  assert.deepEqual(beside(dir), listed);
});
