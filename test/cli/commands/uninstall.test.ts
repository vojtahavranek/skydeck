import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { command } from '../../../src/cli/commands/uninstall.ts';
import { hookEntry } from '../../../src/claude/settings.ts';
import { run, settingsFile, withStore } from '../../helpers/install.ts';
import { testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';

const backupOf = (d: TestPlatform): string => `${settingsFile(d.places)}.skydeck-backup`;

/** `skydeck install`, answered y, with `settings` as the settings file before it (null: none). */
async function installed(d: TestPlatform, settings: string | null): Promise<void> {
  if (settings !== null) {
    writeFileSync(settingsFile(d.places), settings);
  }
  const r = await run(d.platform, ['install'], { lines: ['y'] });
  assert.equal(r.code, 0, r.stderr);
}

const links = (d: TestPlatform): string[] => [
  d.places.hookPath,
  d.places.binLink,
  d.places.nodeLink,
];

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

describe('uninstall', () => {
  test('after an install with no settings file: the file, the links and the kv keys go, the database stays', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(exists(settingsFile(d.places)), false);
    assert.equal(exists(backupOf(d)), false);
    for (const link of links(d)) {
      assert.equal(exists(link), false, link);
    }
    assert.ok(existsSync(d.places.dbPath));
    withStore(d.places, (store) => {
      assert.equal(store.getKv('settings_hash'), null);
      assert.equal(store.getKv('settings_backup'), null);
    });
  });

  test('after an install over a file: the file is back as it was, and the backup is gone', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"opus"}');
    assert.equal(exists(backupOf(d)), false);
  });

  test('a file the user changed after install keeps every change; only the entries naming the hook go', async (t) => {
    const d = testPlatform(t);
    const foreign = { hooks: [{ type: 'command', command: '/opt/other/hook end' }] };
    await installed(d, JSON.stringify({ model: 'opus', hooks: { SessionEnd: [foreign] } }));
    const settings = JSON.parse(readFileSync(settingsFile(d.places), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(settingsFile(d.places), JSON.stringify({ ...settings, theme: 'dark' }));

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(d.places), 'utf8')), {
      model: 'opus',
      hooks: { SessionEnd: [foreign] },
      theme: 'dark',
    });
    // The backup was not used, so it is not removed: it is the user's to look at.
    assert.equal(
      readFileSync(backupOf(d), 'utf8'),
      JSON.stringify({ model: 'opus', hooks: { SessionEnd: [foreign] } }),
    );
  });

  test('a link that now points elsewhere is left alone; the others are removed', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    rmSync(d.places.binLink);
    symlinkSync('/elsewhere', d.places.binLink);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readlinkSync(d.places.binLink), '/elsewhere');
    assert.equal(exists(d.places.hookPath), false);
    assert.equal(exists(d.places.nodeLink), false);
  });

  test('a regular file where a link was is left alone', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    rmSync(d.places.binLink);
    writeFileSync(d.places.binLink, 'mine');

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(d.places.binLink, 'utf8'), 'mine');
  });

  test('--purge removes the data, state and configuration directories', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    writeFileSync(d.places.configPath, '{}');

    const r = await run(d.platform, ['uninstall', '--purge']);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of [d.places.dataDir, d.places.stateDir, d.places.configDir]) {
      assert.equal(exists(dir), false, dir);
    }
  });

  test('with nothing installed: exit 0, and no directory, database or file is created', async (t) => {
    const d = testPlatform(t);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(d.sandbox.skydeckHome), []);
    assert.equal(exists(join(d.sandbox.home, '.local')), false);
    assert.equal(exists(settingsFile(d.places)), false);
  });

  test('with nothing installed, the entries naming the hook are still removed from the settings', async (t) => {
    const d = testPlatform(t);
    const foreign = { hooks: [{ type: 'command', command: '/opt/other/hook' }] };
    writeFileSync(
      settingsFile(d.places),
      JSON.stringify({
        hooks: { SessionStart: [foreign, hookEntry(d.places.hookPath, 'SessionStart')] },
      }),
    );

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(d.places), 'utf8')), {
      hooks: { SessionStart: [foreign] },
    });
    assert.deepEqual(readdirSync(d.sandbox.skydeckHome), []);
  });

  test('the recorded backup is gone: the entries are removed instead', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    rmSync(backupOf(d));

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(d.places), 'utf8')), { model: 'opus' });
  });

  test('a settings file that is a symbolic link stays one when the backup is restored', async (t) => {
    const d = testPlatform(t);
    const dotfiles = join(d.sandbox.root, 'dotfiles');
    mkdirSync(dotfiles);
    const real = join(dotfiles, 'claude-settings.json');
    writeFileSync(real, '{"model":"opus"}');
    symlinkSync(real, settingsFile(d.places));
    await installed(d, null);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readlinkSync(settingsFile(d.places)), real);
    assert.equal(readFileSync(real, 'utf8'), '{"model":"opus"}');
  });

  test('a settings file the user removed after install stays removed', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    rmSync(settingsFile(d.places));

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(exists(settingsFile(d.places)), false);
  });

  test('an install after an uninstall works again from the start', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    await run(d.platform, ['uninstall']);

    await installed(d, null);

    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    withStore(d.places, (store) => assert.equal(store.getKv('settings_backup'), backupOf(d)));
  });
});

describe('uninstall: arguments', () => {
  test('--help prints the usage and exits 0', async (t) => {
    const d = testPlatform(t);
    const r = await run(d.platform, ['uninstall', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^skydeck uninstall \[--purge\]\n/);
  });

  test('an argument is a usage error: exit 2, nothing removed', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    const r = await run(d.platform, ['uninstall', 'all']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /skydeck uninstall \[--purge\]/);
    assert.ok(exists(d.places.hookPath));
  });

  test('name and summary are those of the plan', () => {
    assert.equal(command.name, 'uninstall');
    assert.equal(command.summary, 'Remove the hooks and links');
  });
});
