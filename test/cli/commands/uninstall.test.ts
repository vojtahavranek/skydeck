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
import type { Files } from '../../../src/platform/types.ts';
import { backupAtT0, backups, run, settingsFile, withStore } from '../../helpers/install.ts';
import { SEC, T0, testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';

const backupOf = (d: TestPlatform): string => backupAtT0(d.places);

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
    assert.deepEqual(backups(d.places), []);
    for (const link of links(d)) {
      assert.equal(exists(link), false, link);
    }
    assert.ok(existsSync(d.places.dbPath));
    withStore(d.places, (store) => {
      assert.equal(store.getKv('settings_hash'), null);
      assert.equal(store.getKv('settings_backup'), null);
    });
  });

  test('after an install over a file: the file is back as it was; the backup is kept and named', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"opus"}');
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    assert.ok(r.stdout.includes(backupOf(d)), r.stdout);
  });

  test('an older backup is not what gets restored: the one of the last install that changed the file is', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    // The user takes skydeck's entries out by hand and changes settings; a day later, install again.
    writeFileSync(settingsFile(d.places), '{"model":"sonnet","theme":"dark"}');
    d.clock.setNs(T0 + 86_400n * SEC);
    await installed(d, null);

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), '{"model":"sonnet","theme":"dark"}');
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
    assert.equal(backups(d.places).length, 2);
    for (const backup of backups(d.places)) {
      assert.ok(r.stdout.includes(backup), r.stdout);
    }
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

  test('--purge removes the data, state and configuration directories, not the backups', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    writeFileSync(d.places.configPath, '{}');

    const r = await run(d.platform, ['uninstall', '--purge']);

    assert.equal(r.code, 0, r.stderr);
    for (const dir of [d.places.dataDir, d.places.stateDir, d.places.configDir]) {
      assert.equal(exists(dir), false, dir);
    }
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
  });

  test('it creates nothing: state and configuration folders the user removed stay removed', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    rmSync(d.places.stateDir, { recursive: true });
    rmSync(d.places.configDir, { recursive: true });

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(exists(d.places.stateDir), false);
    assert.equal(exists(d.places.configDir), false);
    withStore(d.places, (store) => assert.equal(store.getKv('settings_hash'), null));
  });

  test('a settings file that cannot be written: a plain error naming it; what install recorded stays', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    const written = readFileSync(settingsFile(d.places), 'utf8');
    const real = d.platform.files;
    const files: Files = {
      ...real,
      writeText(path: string, text: string, mode?: number): void {
        if (path === settingsFile(d.places)) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        real.writeText(path, text, mode);
      },
    };

    const r = await run({ ...d.platform, files }, ['uninstall']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot write .*settings\.json \(EACCES\)/);
    assert.doesNotMatch(r.stderr, /internal error/);
    assert.equal(readFileSync(settingsFile(d.places), 'utf8'), written);
    // Nothing recorded is forgotten, so uninstall can restore the backup once the file can be written.
    withStore(d.places, (store) => assert.notEqual(store.getKv('settings_hash'), null));
  });

  test('a link that cannot be removed: a plain error naming it', async (t) => {
    const d = testPlatform(t);
    await installed(d, null);
    const real = d.platform.files;
    const files: Files = {
      ...real,
      remove(path: string): void {
        if (path === d.places.binLink) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        real.remove(path);
      },
    };

    const r = await run({ ...d.platform, files }, ['uninstall']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot remove .*\.local\/bin\/skydeck \(EACCES\)/);
    assert.doesNotMatch(r.stderr, /internal error/);
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

  test('a recorded backup is never restored over a file without the recorded hash', async (t) => {
    const d = testPlatform(t);
    await installed(d, '{"model":"opus"}');
    // A setting changed after install: the file no longer has the recorded hash.
    const settings = JSON.parse(readFileSync(settingsFile(d.places), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(settingsFile(d.places), JSON.stringify({ ...settings, model: 'sonnet' }));

    const r = await run(d.platform, ['uninstall']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      readFileSync(settingsFile(d.places), 'utf8'),
      `${JSON.stringify({ model: 'sonnet' }, null, 2)}\n`,
    );
    assert.equal(readFileSync(backupOf(d), 'utf8'), '{"model":"opus"}');
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

    // The first backup is still there under the same second's name, so this one is `-2`.
    assert.equal(readFileSync(`${backupOf(d)}-2`, 'utf8'), '{"model":"opus"}');
    withStore(d.places, (store) =>
      assert.equal(store.getKv('settings_backup'), `${backupOf(d)}-2`),
    );
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
