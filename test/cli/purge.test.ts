// purgeDir and the lists of what skydeck writes (src/cli/purge.ts), directly on sandbox
// directories: each list's every entry is removed, each one missing from the list leaves the
// directory alone, and a path to a directory through a link (also with a trailing slash) is never
// followed. No SQLite file here is a database: they are only names.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { CONFIG_DIR, DATA_DIR, RUNTIME_DIR, purgeDir, stateDirSpec } from '../../src/cli/purge.ts';
import type { Spec } from '../../src/cli/purge.ts';
import type { Platform } from '../../src/platform/types.ts';
import { testPlatform } from '../helpers/platform.ts';

const STORE_ID = '0123abcd';
const SESSION = '0b5f3c1e-8d2a-4f6b-9c3d-2e1f0a9b8c7d';

/** A unix socket at `path`, closed when the test ends (it stays a socket file meanwhile). */
async function socketAt(t: TestContext, path: string): Promise<void> {
  const server = createServer();
  server.listen(path);
  await once(server, 'listening');
  t.after(() => server.close());
}

type Maker = (t: TestContext, dir: string) => Promise<void> | void;

const file =
  (rel: string): Maker =>
  (_t, dir) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), '');
  };
const link =
  (rel: string): Maker =>
  (_t, dir) => {
    symlinkSync(join(dir, 'nowhere'), join(dir, rel));
  };
const folder =
  (rel: string): Maker =>
  (_t, dir) => {
    mkdirSync(join(dir, rel), { recursive: true });
  };
const socket =
  (rel: string): Maker =>
  async (t, dir) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    await socketAt(t, join(dir, rel));
  };

/** Every entry each list allows, made as its writer makes it. */
const EVERYTHING: Record<string, { spec: Spec; entries: Record<string, Maker> }> = {
  data: {
    spec: DATA_DIR,
    entries: {
      'skydeck.db': file('skydeck.db'),
      'skydeck.db-wal': file('skydeck.db-wal'),
      'skydeck.db-shm': file('skydeck.db-shm'),
      'skydeck.db-journal': file('skydeck.db-journal'),
      'skydeck-hook': link('skydeck-hook'),
      node: link('node'),
      '.skydeck-hook.<hex>.tmp': link('.skydeck-hook.0123456789ab.tmp'),
      '.node.<hex>.tmp': link('.node.0123456789ab.tmp'),
    },
  },
  state: {
    spec: stateDirSpec(STORE_ID),
    entries: {
      'spool/<ev>': file('spool/1794474000000000000-4242-7.ev'),
      'spool/.<ev>.tmp': file('spool/.1794474000000000000-4242-8.ev.tmp'),
      'spool/bad/<ev>': file('spool/bad/1794474000000000000-0-9.ev'),
      'locks/': folder('locks'),
      'hook.log': file('hook.log'),
      'note-<id>.md': file(`note-${SESSION}.md`),
      '.note-<id>.md.<hex>.tmp': file(`.note-${SESSION}.md.0123456789ab.tmp`),
      'server.log': file('server.log'),
      'server.log.1': file('server.log.1'),
      '.server.log.1.tmp': file('.server.log.1.tmp'),
      'keepers.log': file('keepers.log'),
      'keepers.log.1': file('keepers.log.1'),
      '.keepers.log.1.tmp': file('.keepers.log.1.tmp'),
      'run-<store id>/server.json': file(`run-${STORE_ID}/server.json`),
      'run-<store id>/terms/<id>.sock': socket(`run-${STORE_ID}/terms/aaaaaaaaaaaa.sock`),
    },
  },
  config: {
    spec: CONFIG_DIR,
    entries: { 'config.json': file('config.json') },
  },
  runtime: {
    spec: RUNTIME_DIR,
    entries: {
      'server.json': file('server.json'),
      'server.pid': file('server.pid'),
      'server.sock': socket('server.sock'),
      'keepalive.pid': file('keepalive.pid'),
      'keepalive.interop': file('keepalive.interop'),
      interop: link('interop'),
      'keeper-<build>.py': file('keeper-0123456789abcdef.py'),
      '.server.json.<hex>.tmp': file('.server.json.0123456789ab.tmp'),
      '.keepalive.pid.<pid>.tmp': file('.keepalive.pid.4242.tmp'),
      '.interop.<hex>.tmp': link('.interop.0123456789ab.tmp'),
      'terms/<id>.pid': file('terms/aaaaaaaaaaaa.pid'),
      'terms/<id>.sock': socket('terms/bbbbbbbbbbbb.sock'),
      'terms/.<id>.<pid>.tmp': file('terms/.aaaaaaaaaaaa.4242.tmp'),
      'terms/.<id>.pid.<hex>.tmp': file('terms/.aaaaaaaaaaaa.pid.0123456789ab.tmp'),
    },
  },
};

function platformOf(t: TestContext): { platform: Platform; root: string } {
  const d = testPlatform(t);
  return { platform: d.platform, root: d.sandbox.root };
}

describe('purgeDir: every entry of each list is removed, with the directory', () => {
  for (const [name, { spec, entries }] of Object.entries(EVERYTHING)) {
    test(`${name}: all of ${Object.keys(entries).length} entries`, async (t) => {
      const { platform, root } = platformOf(t);
      const dir = join(root, name);
      mkdirSync(dir);
      for (const make of Object.values(entries)) await make(t, dir);

      assert.deepEqual(purgeDir(platform, dir, spec), { kind: 'removed' });
      assert.equal(existsSync(dir), false);
    });

    test(`${name}: each entry alone with a foreign file beside it: left alone, the entry kept`, async (t) => {
      for (const [entry, make] of Object.entries(entries)) {
        const { platform, root } = platformOf(t);
        const dir = join(root, name);
        mkdirSync(dir);
        await make(t, dir);
        writeFileSync(join(dir, 'mine.txt'), 'mine');

        const purged = purgeDir(platform, dir, spec);

        assert.deepEqual(
          purged,
          { kind: 'left', why: 'holds mine.txt, which skydeck did not write' },
          entry,
        );
        assert.ok(existsSync(join(dir, 'mine.txt')));
      }
    });
  }
});

describe('purgeDir: a link to a directory is never followed', () => {
  for (const [name, { spec }] of Object.entries(EVERYTHING)) {
    for (const suffix of ['', '/', '//']) {
      test(`${name} reached through a link${suffix === '' ? '' : ` with ${JSON.stringify(suffix)}`}: left alone, the target whole`, (t) => {
        const { platform, root } = platformOf(t);
        const target = join(root, 'target');
        mkdirSync(target);
        writeFileSync(join(target, 'config.json'), '{}');
        symlinkSync(target, join(root, 'link'));

        const purged = purgeDir(platform, `${join(root, 'link')}${suffix}`, spec);

        assert.equal(purged.kind, 'left');
        assert.ok(existsSync(join(target, 'config.json')), 'the target stays whole');
      });
    }
  }
});

describe('purgeDir: what it does not remove', () => {
  test('a directory that is not there: absent', (t) => {
    const { platform, root } = platformOf(t);
    assert.deepEqual(purgeDir(platform, join(root, 'none'), CONFIG_DIR), { kind: 'absent' });
  });

  test('a file where the directory should be: left alone', (t) => {
    const { platform, root } = platformOf(t);
    writeFileSync(join(root, 'config'), '');
    assert.deepEqual(purgeDir(platform, join(root, 'config'), CONFIG_DIR), {
      kind: 'left',
      why: 'is not a directory',
    });
  });

  test('a subdirectory of another user: left alone and named', (t) => {
    const { platform, root } = platformOf(t);
    const dir = join(root, 'state');
    mkdirSync(join(dir, 'spool'), { recursive: true });
    const files = {
      ...platform.files,
      lstat(path: string) {
        const info = platform.files.lstat(path);
        return path === join(dir, 'spool') && info !== null ? { ...info, uid: info.uid + 1 } : info;
      },
    };

    const purged = purgeDir({ ...platform, files }, dir, stateDirSpec(STORE_ID));

    assert.deepEqual(purged, {
      kind: 'left',
      why: `holds spool, which belongs to uid ${platform.uid + 1}`,
    });
    assert.ok(existsSync(join(dir, 'spool')));
  });

  test('an entry that appears after the look stays, and so does the directory: failed, saying so', (t) => {
    const { platform, root } = platformOf(t);
    const dir = join(root, 'config');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    let lists = 0;
    const files = {
      ...platform.files,
      list(path: string) {
        // The look lists the directory once; the removal lists it next: something arrives between.
        if (path === dir && ++lists === 2) writeFileSync(join(dir, 'late.txt'), 'mine');
        return platform.files.list(path);
      },
    };

    const purged = purgeDir({ ...platform, files }, dir, CONFIG_DIR);

    assert.equal(purged.kind, 'failed');
    assert.ok(existsSync(join(dir, 'late.txt')));
  });
});
