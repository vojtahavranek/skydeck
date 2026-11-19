// Follow-up F21 at the window's server: its own open of the store migrates a database of an older
// schema as a command's does, keeping the copy first, and writes the line about it to its log; when
// the copy cannot be written it refuses to start, with the store's refusal, and changes nothing.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SkydeckError } from '../../src/platform/errors.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { T0 } from '../helpers/platform.ts';
import { dumpDatabase, schemaDatabase } from '../helpers/schema1.ts';
import { serverSandbox } from '../helpers/window.ts';
import type { ServerSandbox } from '../helpers/window.ts';

/** The sandbox's database replaced by one of schema 3, as an older skydeck left it. */
function oldDatabase(d: ServerSandbox): string {
  const path = d.deck.store.path;
  d.deck.store.close(); // the sandbox's own connection, of the newest schema
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  schemaDatabase(path, 3);
  return path;
}

function copiesOf(path: string): string[] {
  return readdirSync(join(path, '..'))
    .filter((name) => name.startsWith('skydeck.db.schema'))
    .sort();
}

test("the server's own open migrates a database of schema 3, keeps the copy first and writes the line to its log", async (t) => {
  const d = serverSandbox(t);
  const path = oldDatabase(d);

  const server = await d.start();

  const [copy, ...more] = copiesOf(path);
  assert.match(copy ?? '', /^skydeck\.db\.schema3-[0-9]{8}T[0-9]{6}Z$/);
  assert.deepEqual(more, []);
  const line = ` server: the database was brought to schema version ${SCHEMA_VERSION}; a copy of it as it was is at ${join(path, '..', copy ?? '')}`;
  assert.ok(
    server.logs().some((logged) => logged.endsWith(line)),
    server.logs().join('\n'),
  );
});

test('the server refuses to start when the copy cannot be written (its name taken): the store’s refusal, nothing migrated, no lock, no server.json', async (t) => {
  const d = serverSandbox(t);
  const path = oldDatabase(d);
  // Its clock stands still at T0 (2026-11-12T09:00:00Z), so the copy's name is known.
  const copy = `${path}.schema3-20261112T090000Z`;
  writeFileSync(copy, 'mine');
  const before = dumpDatabase(path);

  await assert.rejects(
    d.start({ platform: (p) => ({ ...p, clock: { ...p.clock, nowNs: () => T0 } }) }),
    (error: unknown) => {
      assert.ok(error instanceof SkydeckError, String(error));
      assert.equal(
        error.message,
        `the database ${path} was not upgraded: its copy ${copy} could not be written (something of that name is there already)`,
      );
      return true;
    },
  );

  assert.deepEqual(dumpDatabase(path), before, 'not migrated, and no lock taken');
  assert.equal(existsSync(d.files.serverJson), false);
  assert.deepEqual(copiesOf(path), ['skydeck.db.schema3-20261112T090000Z']);
});
