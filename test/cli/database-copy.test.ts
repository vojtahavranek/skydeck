// Follow-up F21, C3 and C5 on the command line: the command whose open migrated the database says
// one line on stderr — never on stdout, so a `--json` answer stays whole — naming the copy kept
// first; one whose copy cannot be written fails with the store's refusal and changes nothing.
// `uninstall` says that the copies stay; `--purge` removes them with the database.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { run } from '../helpers/install.ts';
import { testPlatform } from '../helpers/platform.ts';
import type { TestPlatform } from '../helpers/platform.ts';
import { dumpDatabase, schemaDatabase } from '../helpers/schema1.ts';

/** T0 (2026-11-12T09:00:00Z), the test platform's clock, as a copy's name writes it. */
const STAMP = '20261112T090000Z';

/** A test platform whose database is one of schema 3, as an older skydeck left it. */
function withOldDatabase(t: Parameters<typeof testPlatform>[0]): TestPlatform & { copy: string } {
  const d = testPlatform(t);
  mkdirSync(d.places.dataDir, { recursive: true, mode: 0o700 });
  schemaDatabase(d.places.dbPath, 3);
  return { ...d, copy: `${d.places.dbPath}.schema3-${STAMP}` };
}

function said(copy: string): string {
  return `skydeck: the database was brought to schema version ${SCHEMA_VERSION}; a copy of it as it was is at ${copy}\n`;
}

/** The copies beside the database. */
function copies(d: TestPlatform): string[] {
  return readdirSync(d.places.dataDir)
    .filter((name) => name.startsWith('skydeck.db.schema'))
    .sort();
}

describe('the command that migrated says so (C3)', () => {
  test('ls --json on a database of schema 3: stdout is the whole JSON answer, stderr the one line that names the copy', async (t) => {
    const d = withOldDatabase(t);

    const r = await run(d.platform, ['ls', '--json']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, said(d.copy));
    assert.doesNotThrow(() => JSON.parse(r.stdout), r.stdout);
    assert.deepEqual(copies(d), [`skydeck.db.schema3-${STAMP}`]);
  });

  test('the next command finds the database at its version: it says nothing of it and copies nothing', async (t) => {
    const d = withOldDatabase(t);
    await run(d.platform, ['ls', '--json']);
    d.clock.advanceMs(60_000);

    const r = await run(d.platform, ['ls', '--json']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(copies(d), [`skydeck.db.schema3-${STAMP}`]);
  });

  test('a copy that cannot be written (its name taken): the command fails with the refusal, prints nothing on stdout, and the database is not migrated', async (t) => {
    const d = withOldDatabase(t);
    writeFileSync(d.copy, 'mine');
    const before = dumpDatabase(d.places.dbPath);

    const r = await run(d.platform, ['ls', '--json']);

    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(
      r.stderr,
      `skydeck: the database ${d.places.dbPath} was not upgraded: its copy ${d.copy} could not be written (something of that name is there already)\n`,
    );
    assert.deepEqual(dumpDatabase(d.places.dbPath), before);
  });

  test('doctor, which opens the database itself, says the line on stderr; its report stays on stdout', async (t) => {
    const d = withOldDatabase(t);

    const r = await run(d.platform, ['doctor']);

    assert.equal(r.stderr, said(d.copy));
    assert.doesNotMatch(r.stdout, /brought to schema version/);
    assert.deepEqual(copies(d), [`skydeck.db.schema3-${STAMP}`]);
  });

  test('uninstall, which opens the database itself, says the line on stderr', async (t) => {
    const d = withOldDatabase(t);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, said(d.copy));
    assert.doesNotMatch(r.stdout, /brought to schema version/);
  });
});

describe('uninstall and the copies (C5)', () => {
  test('its usage says that the database and its copies stay', async (t) => {
    const d = testPlatform(t);

    const r = await run(d.platform, ['uninstall', '--help']);

    assert.match(
      r.stdout,
      /The database and its copies \(skydeck\.db\.schema<V>-<time>, kept before an\nupgrade\) stay\./,
    );
  });

  test('a plain uninstall leaves the copies; --purge removes them with the database and the folder', async (t) => {
    const d = withOldDatabase(t);
    await run(d.platform, ['ls', '--json']);
    // A temporary of a copy that was cut off is skydeck's too.
    writeFileSync(join(d.places.dataDir, `.skydeck.db.schema2-${STAMP}.tmp`), '');

    const plain = await run(d.platform, ['uninstall']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(copies(d), [`skydeck.db.schema3-${STAMP}`]);

    const purged = await run(d.platform, ['uninstall', '--purge']);
    assert.equal(purged.code, 0, purged.stderr);
    assert.ok(purged.stdout.includes(`removed ${d.places.dataDir}\n`), purged.stdout);
  });
});
