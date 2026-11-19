// `skydeck install` on a system skydeck cannot work on (follow-up F23): with no boot id
// (/proc/sys/kernel/random/boot_id, design 5.5), as on macOS, no hook event would be recorded and no
// session would show as running. Install says so in one line and ends with exit 1 before it asks,
// reads or changes anything. It is decided by the boot id, not by the system's name: these tests
// run on Linux with the fake /proc's boot id taken away.
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../../../src/cli/main.ts';
import { SkydeckError } from '../../../src/platform/errors.ts';
import type { Platform } from '../../../src/platform/types.ts';
import { capture } from '../../helpers/capture.ts';
import { run, settingsFile } from '../../helpers/install.ts';
import { testPlatform } from '../../helpers/platform.ts';
import type { TestPlatform } from '../../helpers/platform.ts';

const REFUSAL =
  'skydeck works on Linux and on Windows with WSL2 (run inside WSL) only: this system has no ' +
  '/proc/sys/kernel/random/boot_id (macOS is not supported yet); nothing was changed\n';

/** A settings file in other formatting than skydeck's, so that any write of it changes bytes. */
const SETTINGS = '{ "model": "opus",\n  "hooks": {} }';

/** A made-up global config file of Claude Code's with its ← shortcut on (install would ask). */
const GLOBAL_CONFIG = '{\n  "numStartups": 3\n}\n';

/**
 * Every entry under the sandbox's root: its kind, mode and modification time, a file's bytes and a
 * link's target. A directory's time changes when an entry is created in it, even one removed again.
 */
function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      const head = `${info.mode.toString(8)} ${info.mtimeNs}`;
      if (info.isSymbolicLink()) {
        entries[path] = `${head} -> ${readlinkSync(path)}`;
      } else if (info.isDirectory()) {
        entries[path] = `${head} dir`;
        walk(path);
      } else {
        entries[path] = `${head} ${readFileSync(path).toString('base64')}`;
      }
    }
  };
  entries[root] = `${lstatSync(root, { bigint: true }).mtimeNs}`;
  walk(root);
  return entries;
}

/** A run of install that also records every read of standard input: a question or a key reader. */
async function install(
  platform: Platform,
  argv: string[] = ['install'],
): Promise<{ code: number; stdout: string; stderr: string; reads: string[] }> {
  const captured = capture({ lines: ['y', 'y', 'y'], keys: ['y'] });
  const reads: string[] = [];
  const io = {
    ...captured.io,
    readLine: (prompt: string) => {
      reads.push(`readLine ${prompt}`);
      return captured.io.readLine(prompt);
    },
    keys: () => {
      reads.push('keys');
      return captured.io.keys();
    },
  };
  const code = await main(argv, { io, platform });
  return { code, stdout: captured.stdout(), stderr: captured.stderr(), reads };
}

/** A sandbox where install, if it went ahead, would ask, link, write and offer. */
function machine(t: Parameters<typeof testPlatform>[0], withSettings: boolean): TestPlatform {
  const d = testPlatform(t);
  if (withSettings) {
    writeFileSync(settingsFile(d.places), SETTINGS);
  }
  writeFileSync(d.places.claudeGlobalConfig, GLOBAL_CONFIG);
  return d;
}

describe('install: a system without a boot id is refused before anything', () => {
  for (const [what, withSettings] of [
    ['a settings file', true],
    ['no settings file', false],
  ] as const) {
    test(`with ${what}: the one line, exit 1; nothing asked, read, started, created or changed`, async (t) => {
      const d = machine(t, withSettings);
      d.proc.setBootId(null);
      const before = tree(d.sandbox.root);

      const r = await install(d.platform);

      assert.equal(r.code, 1);
      assert.equal(r.stderr, REFUSAL);
      assert.equal(r.stdout, '');
      assert.deepEqual(r.reads, []);
      assert.deepEqual(d.runner.calls, []);
      assert.deepEqual(d.runner.interactiveCalls, []);
      assert.deepEqual(d.processes.calls, []);
      assert.deepEqual(tree(d.sandbox.root), before);
      if (withSettings) {
        assert.equal(readFileSync(settingsFile(d.places), 'utf8'), SETTINGS);
      }
      assert.deepEqual(readdirSync(d.sandbox.skydeckHome), []);
    });

    test(`with ${what} and a boot id: install goes ahead as before (the control)`, async (t) => {
      const d = machine(t, withSettings);
      const before = tree(d.sandbox.root);

      const r = await install(d.platform);

      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stderr.includes('WSL2'), r.stderr);
      assert.ok(r.reads.includes('readLine Add them? [y/N] '), r.reads.join('\n'));
      assert.notDeepEqual(tree(d.sandbox.root), before);
      assert.notEqual(readFileSync(settingsFile(d.places), 'utf8'), SETTINGS);
    });
  }

  test('the refusal comes before config.json is read: a broken one is not what it says', async (t) => {
    const d = machine(t, true);
    const config = join(d.sandbox.skydeckHome, 'config', 'config.json');
    mkdirSync(join(d.sandbox.skydeckHome, 'config'));
    writeFileSync(config, '{');
    d.proc.setBootId(null);
    const before = tree(d.sandbox.root);

    const r = await install(d.platform);

    assert.equal(r.code, 1);
    assert.equal(r.stderr, REFUSAL);
    assert.deepEqual(r.reads, []);
    assert.deepEqual(tree(d.sandbox.root), before);
  });

  test('a boot id that cannot be read (EACCES): exit 1 naming the file and the cause; nothing changed', async (t) => {
    const d = machine(t, true);
    const platform: Platform = {
      ...d.platform,
      proc: {
        ...d.platform.proc,
        bootId: () => {
          // What the real /proc reader throws for a failure other than "not there".
          throw Object.assign(
            new SkydeckError('cannot read /proc/sys/kernel/random/boot_id (EACCES)'),
            { code: 'EACCES' },
          );
        },
      },
    };
    const before = tree(d.sandbox.root);

    const r = await install(platform);

    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      'skydeck: cannot read /proc/sys/kernel/random/boot_id (EACCES), which skydeck needs to ' +
        'tell which sessions are running; nothing was changed\n',
    );
    assert.equal(r.stdout, '');
    assert.deepEqual(r.reads, []);
    assert.deepEqual(d.runner.calls, []);
    assert.deepEqual(tree(d.sandbox.root), before);
  });

  test('install --help still prints the usage with no boot id', async (t) => {
    const d = machine(t, false);
    d.proc.setBootId(null);

    const r = await run(d.platform, ['install', '--help']);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /^skydeck install\n/);
    assert.equal(r.stderr, '');
  });
});
